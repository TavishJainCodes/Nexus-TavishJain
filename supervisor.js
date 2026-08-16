// supervisor.js
// The circuit breaker for workers (Section 3.4). Watches workers in
// state 'dead', decides whether to restart (growing backoff) or give up
// (out_of_service — visible, reversible only by explicit operator
// action). Also owns "earning" recovered status: restart_count only
// resets after a worker stays healthy for a full settling period, not
// the instant it comes back up. This is specifically what prevents
// INC-2291's "70 restarts in 70 minutes."
//
// Deliberately does NOT clear crash_on_start/crash_mid_task on restart —
// those flags represent an underlying bug, and a bare restart doesn't
// fix bugs. Clearing them is a separate, explicit action (simulating
// "the bad release got rolled back"), same as returnToService is
// separate from a scheduled restart.

import { db, now, withTransaction } from "./db.js";
import { logEvent } from "./events.js";

export const MAX_RESTARTS = 5; // stated limit, R-04
const RESTART_BACKOFF_BASE_MS = 2000;
const RESTART_BACKOFF_MAX_MS = 60_000;
export const SETTLE_PERIOD_MS = 10_000; // how long a worker must stay
// healthy to "earn" a reset budget

function restartBackoffFor(restartCount) {
  return Math.min(
    RESTART_BACKOFF_MAX_MS,
    RESTART_BACKOFF_BASE_MS * 2 ** restartCount,
  );
}

const deadWorkers = db.prepare(`SELECT * FROM workers WHERE state = 'dead'`);
const restartingWorkers = db.prepare(
  `SELECT * FROM workers WHERE state = 'restarting'`,
);
const settledCandidates = db.prepare(`
  SELECT * FROM workers WHERE state IN ('idle','busy') AND restart_count > 0
`);

const scheduleRestart = db.prepare(`
  UPDATE workers SET state = 'restarting', next_restart_at = @nextRestartAt WHERE id = @id
`);
const takeOutOfService = db.prepare(`
  UPDATE workers SET state = 'out_of_service', next_restart_at = NULL WHERE id = @id
`);
const performRestart = db.prepare(`
  UPDATE workers
  SET state = 'idle', restart_count = restart_count + 1, last_restart_at = @ts,
      settled_since = @ts, next_restart_at = NULL
  WHERE id = @id
`);
const resetBudget = db.prepare(
  `UPDATE workers SET restart_count = 0 WHERE id = ?`,
);
const manualReturn = db.prepare(`
  UPDATE workers SET state = 'idle', restart_count = 0, settled_since = @ts,
    next_restart_at = NULL, crash_on_start = 0, crash_mid_task = 0
  WHERE id = @id
`);

/**
 * One supervisor pass. Call repeatedly (main.js loop), same pattern as
 * dispatcher.tick(). Three transitions per pass:
 *  1. dead -> restarting (schedule) OR out_of_service (budget exhausted)
 *  2. restarting -> idle, once the scheduled backoff has elapsed
 *  3. idle/busy with a nonzero budget used -> reset to 0, once settled
 */
export function tick() {
  const ts = now();

  for (const worker of deadWorkers.all()) {
    if (worker.restart_count >= MAX_RESTARTS) {
      withTransaction(() => {
        takeOutOfService.run({ id: worker.id });
        logEvent({
          subjectType: "worker",
          subjectId: worker.id,
          event: "taken_out_of_service",
          reason:
            `exhausted restart budget (${MAX_RESTARTS} attempts). ` +
            `Stopped receiving work. Only returnToService() brings it back.`,
          relatedReleaseId: worker.current_release_id,
        });
      });
      continue;
    }

    const nextRestartAt = ts + restartBackoffFor(worker.restart_count);
    withTransaction(() => {
      scheduleRestart.run({ id: worker.id, nextRestartAt });
      logEvent({
        subjectType: "worker",
        subjectId: worker.id,
        event: "restart_scheduled",
        reason: `attempt ${worker.restart_count + 1}/${MAX_RESTARTS}, waiting ${nextRestartAt - ts}ms`,
        relatedReleaseId: worker.current_release_id,
      });
    });
  }

  for (const worker of restartingWorkers.all()) {
    if (worker.next_restart_at !== null && ts >= worker.next_restart_at) {
      withTransaction(() => {
        performRestart.run({ id: worker.id, ts });
        logEvent({
          subjectType: "worker",
          subjectId: worker.id,
          event: "restarted",
          reason:
            `restart attempt ${worker.restart_count + 1} — not yet "recovered", ` +
            `must stay healthy ${SETTLE_PERIOD_MS}ms to earn a budget reset`,
          relatedReleaseId: worker.current_release_id,
        });
      });
    }
  }

  for (const worker of settledCandidates.all()) {
    if (
      worker.settled_since !== null &&
      ts - worker.settled_since >= SETTLE_PERIOD_MS
    ) {
      withTransaction(() => {
        resetBudget.run(worker.id);
        logEvent({
          subjectType: "worker",
          subjectId: worker.id,
          event: "recovery_earned",
          reason: `stayed healthy ${SETTLE_PERIOD_MS}ms since last restart, budget reset to 0`,
          relatedReleaseId: worker.current_release_id,
        });
      });
    }
  }
}

/** Explicit operator action — the "visible and reversible" half of
 *  Section 3.4. Only path back to service; never automatic. Also clears
 *  chaos flags, since bringing a worker back into service is the point
 *  where we're asserting "whatever was wrong is fixed now." */
export function returnToService(id) {
  const ts = now();
  withTransaction(() => {
    manualReturn.run({ id, ts });
    logEvent({
      subjectType: "worker",
      subjectId: id,
      event: "manually_returned_to_service",
      reason:
        "operator action — restart budget reset to 0, chaos flags cleared, worker set idle",
    });
  });
}

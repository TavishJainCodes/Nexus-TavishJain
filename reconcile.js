// reconcile.js
// Runs once at boot, before the dispatcher starts ticking. Its job: find
// anything left in a state that only makes sense while the process is
// alive (work in_flight, workers busy/restarting) and decide what that
// means now that the process wasn't alive a moment ago.
//
// Deliberately does NOT touch workers in state 'dead' — a crashed worker
// staying dead across a platform restart is correct: reviving it is an
// earned, explicit action (supervisor.js), not something a bare process
// restart should quietly grant. Healing dead workers for free here would
// undermine the whole circuit-breaker/"earn recovered" design in Section 3.4.

import { db, now, withTransaction } from "./db.js";
import { logEvent } from "./events.js";

const orphanedInFlight = db.prepare(
  `SELECT * FROM work_items WHERE state = 'in_flight'`,
);
const requeueItem = db.prepare(`
  UPDATE work_items
  SET state = 'pending', worker_id = NULL, next_attempt_at = @ts, updated_at = @ts
  WHERE id = @id
`);

const strandedWorkers = db.prepare(
  `SELECT * FROM workers WHERE state IN ('busy', 'restarting')`,
);
const resetWorker = db.prepare(
  `UPDATE workers SET state = 'idle' WHERE id = ?`,
);

/**
 * Call once, at boot, before the dispatcher's tick() loop starts.
 * Returns a small summary so main.js can log/print what it found —
 * useful for a reviewer watching startup output, and matches "fail
 * loudly / show what it's doing" rather than fixing things silently.
 */
export function reconcileOnBoot() {
  const ts = now();
  const summary = { requeuedItems: [], resetWorkers: [] };

  const stuckItems = orphanedInFlight.all();
  for (const item of stuckItems) {
    withTransaction(() => {
      requeueItem.run({ ts, id: item.id });
      logEvent({
        subjectType: "work_item",
        subjectId: item.id,
        event: "orphaned_by_restart",
        // attempt_count is NOT reset here — it was already incremented
        // when dispatched, and the doc is explicit that a restart must
        // not "hand everything a fresh budget." This attempt still
        // counts even though we never learned its outcome.
        reason:
          `was in_flight on worker ${item.worker_id ?? "unknown"} when the platform died; ` +
          `requeued at attempt_count=${item.attempt_count}, outcome of that attempt is unknown`,
      });
    });
    summary.requeuedItems.push(item.id);
  }

  const stuckWorkers = strandedWorkers.all();
  for (const worker of stuckWorkers) {
    withTransaction(() => {
      resetWorker.run(worker.id);
      logEvent({
        subjectType: "worker",
        subjectId: worker.id,
        event: "reset_after_restart",
        reason:
          `was '${worker.state}' when the platform died; reset to idle. ` +
          `restart_count and settled_since left untouched — this is not a recovery, ` +
          `just clearing a state that can't survive a process death.`,
        relatedReleaseId: worker.current_release_id,
      });
    });
    summary.resetWorkers.push(worker.id);
  }

  return summary;
}

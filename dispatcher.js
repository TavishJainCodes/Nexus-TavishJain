// dispatcher.js
// Moves pending work to idle workers, tracks attempts, applies backoff,
// and dead-letters items that exhaust their retry budget.
// R-02 (every item ends processed or visibly stuck), R-03 (the in_flight
// lock means no two workers can ever be assigned the same item), and
// R-04 (retries have a stated, enforced limit) all live here.

import { db, now, withTransaction } from "./db.js";
import { logEvent } from "./events.js";
import { idleWorkers, runTask } from "./workers.js";

// Stated limits — R-04 requires these to be stated, not just present.
export const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

function backoffFor(attemptCount) {
  return Math.min(MAX_BACKOFF_MS, RETRY_BASE_MS * 2 ** (attemptCount - 1));
}

const pickPending = db.prepare(`
  SELECT * FROM work_items
  WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
  ORDER BY created_at ASC
  LIMIT @limit
`);
const markInFlight = db.prepare(`
  UPDATE work_items
  SET state = 'in_flight', worker_id = @workerId, attempt_count = attempt_count + 1, updated_at = @ts
  WHERE id = @id
`);
const markDone = db.prepare(`
  UPDATE work_items SET state = 'done', worker_id = NULL, updated_at = @ts WHERE id = @id
`);
const markDead = db.prepare(`
  UPDATE work_items SET state = 'dead', worker_id = NULL, updated_at = @ts WHERE id = @id
`);
const markRetry = db.prepare(`
  UPDATE work_items
  SET state = 'pending', worker_id = NULL, next_attempt_at = @nextAttemptAt, updated_at = @ts
  WHERE id = @id
`);
const getItem = db.prepare(`SELECT * FROM work_items WHERE id = ?`);

/**
 * One dispatch pass. Safe to call repeatedly (e.g. from setInterval in
 * main.js later) — only touches items currently 'pending' and due, so
 * a rapid double-call can't double-assign the same item.
 */
export function tick() {
  const workers = idleWorkers();
  if (workers.length === 0) return;

  const ts = now();
  const dueItems = pickPending.all({ now: ts, limit: workers.length });

  dueItems.forEach((item, i) => {
    const worker = workers[i];

    withTransaction(() => {
      markInFlight.run({ workerId: worker.id, ts, id: item.id });
      logEvent({
        subjectType: "work_item",
        subjectId: item.id,
        event: "dispatched",
        reason: `assigned to ${worker.id}, attempt ${item.attempt_count + 1}`,
        relatedReleaseId: worker.current_release_id,
      });
    });

    runTask(worker.id, (outcome) => handleOutcome(item.id, worker, outcome));
  });
}

function handleOutcome(itemId, worker, outcome) {
  const item = getItem.get(itemId);
  const ts = now();

  if (outcome === "done") {
    withTransaction(() => {
      markDone.run({ ts, id: itemId });
      logEvent({
        subjectType: "work_item",
        subjectId: itemId,
        event: "completed",
        reason: `finished by ${worker.id} on attempt ${item.attempt_count}`,
        relatedReleaseId: worker.current_release_id,
      });
    });
    return;
  }

  // worker.js already marked the worker dead and logged its own event.
  // Here we only decide the item's fate.
  if (item.attempt_count >= MAX_ATTEMPTS) {
    withTransaction(() => {
      markDead.run({ ts, id: itemId });
      logEvent({
        subjectType: "work_item",
        subjectId: itemId,
        event: "dead_lettered",
        reason: `exhausted ${MAX_ATTEMPTS} attempts, last outcome: ${outcome} on ${worker.id}`,
        relatedReleaseId: worker.current_release_id,
      });
    });
    return;
  }

  const nextAttemptAt = ts + backoffFor(item.attempt_count);
  withTransaction(() => {
    markRetry.run({ nextAttemptAt, ts, id: itemId });
    logEvent({
      subjectType: "work_item",
      subjectId: itemId,
      event: "retry_scheduled",
      reason: `outcome: ${outcome} on ${worker.id}, attempt ${item.attempt_count}/${MAX_ATTEMPTS}, next try in ${nextAttemptAt - ts}ms`,
      relatedReleaseId: worker.current_release_id,
    });
  });
}

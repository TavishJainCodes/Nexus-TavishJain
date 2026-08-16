import { db, now } from "./db.js";

const insertEvent = db.prepare(`
  INSERT INTO events (ts, subject_type, subject_id, event, reason, related_release_id)
  VALUES (@ts, @subjectType, @subjectId, @event, @reason, @relatedReleaseId)
`);

export function logEvent({
  subjectType,
  subjectId,
  event,
  reason = null,
  relatedReleaseId = null,
}) {
  if (!subjectType || !subjectId || !event) {
    throw new Error("logEvent requires subjectType, subjectId, event");
  }
  insertEvent.run({
    ts: now(),
    subjectType,
    subjectId,
    event,
    reason,
    relatedReleaseId,
  });
}

/** Everything about one subject, in order — "group records by subject". */
const bySubject = db.prepare(`
  SELECT * FROM events WHERE subject_type = ? AND subject_id = ? ORDER BY ts ASC
`);
export function eventsForSubject(subjectType, subjectId) {
  return bySubject.all(subjectType, subjectId);
}

/** One flat timeline across everything in a time window — "put changes
 *  on the same timeline as effects." This is what the dashboard's
 *  timeline view and R-12 both read from. */
const inWindow = db.prepare(`
  SELECT * FROM events WHERE ts >= ? ORDER BY ts ASC
`);
export function recentEvents(sinceTs) {
  return inWindow.all(sinceTs);
}

/** Earliest event still in the log — lets callers distinguish "nothing
 *  happened in that window" from "we don't keep history that far back."
 *  This is the fix for R-05's empty-result trap. */
const oldestStmt = db.prepare(`SELECT MIN(ts) as oldest_ts FROM events`);
export function retentionFloor() {
  const row = oldestStmt.get();
  return row.oldest_ts; // null if the log is empty (fresh boot, not a prune artifact)
}

/** Retention: stated (24h) and enforced, per R-05. The prune itself is
 *  logged, so "we deleted history" is a fact you can find, not a silent
 *  event. Never deletes the log entry it's about to create for itself. */
const deleteOlderThan = db.prepare(`DELETE FROM events WHERE ts < ?`);
export function pruneEventsOlderThan(cutoffTs) {
  const result = deleteOlderThan.run(cutoffTs);
  if (result.changes > 0) {
    logEvent({
      subjectType: "worker",
      subjectId: "platform",
      event: "events_pruned",
      reason: `removed ${result.changes} events older than ${new Date(cutoffTs).toISOString()}`,
    });
  }
  return result.changes;
}

// Display helper, used by the dashboard API layer later, not by smoke tests
// directly — but we're using it in the smoke test now to compare shapes.
export function formatEvent(e) {
  return {
    at: new Date(e.ts).toISOString(),
    subject: `${e.subject_type}:${e.subject_id}`,
    event: e.event,
    reason: e.reason,
    relatedRelease: e.related_release_id,
  };
}

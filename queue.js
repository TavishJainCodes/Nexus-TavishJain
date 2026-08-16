import { db, now, withTransaction } from "./db.js";
import { logEvent } from "./events.js";

const insertWorkItem = db.prepare(`
  INSERT INTO work_items (id, type, body, state, attempt_count, created_at, updated_at, next_attempt_at)
  VALUES (@id, @type, @body, 'pending', 0, @ts, @ts, @ts)
`);

const getWorkItem = db.prepare(`SELECT * FROM work_items WHERE id = ?`);

export function submitWork({ id, type, body }) {
  if (!id || !type) {
    throw new Error("submitWork requires id and type");
  }

  const existing = getWorkItem.get(id);
  if (existing) {
    // Not an error. The sender doesn't know (and shouldn't have to know)
    // whether their previous attempt at sending this actually landed —
    // that's exactly the "did the platform take it?" ambiguity the doc
    // calls out. Returning the current row lets them proceed either way.
    return { accepted: true, item: existing, duplicate: true };
  }

  const ts = now();
  const item = {
    id,
    type,
    body: JSON.stringify(body ?? {}),
    ts,
  };

  withTransaction(() => {
    insertWorkItem.run(item);
    logEvent({
      subjectType: "work_item",
      subjectId: id,
      event: "accepted",
      reason: `type=${type}`,
    });
  });

  return { accepted: true, item: getWorkItem.get(id), duplicate: false };
}

/** Read-only lookup, used by the HTTP layer and dashboard. */
export function getWork(id) {
  return getWorkItem.get(id);
}

/** All items in a given state, oldest first — this is what "how old is
 *  the oldest waiting item" (Section 3.1, operator view requirement)
 *  reads from. */
const listByState = db.prepare(`
  SELECT * FROM work_items WHERE state = ? ORDER BY created_at ASC
`);
export function listWork(state) {
  return listByState.all(state);
}

/** Backlog summary for the dashboard: count + age of oldest, per state. */
const backlogStmt = db.prepare(`
  SELECT state, COUNT(*) as count, MIN(created_at) as oldest_created_at
  FROM work_items
  GROUP BY state
`);
export function backlogSummary() {
  return backlogStmt.all();
}

// workers.js
// Worker pool state + simulated task execution. Workers are in-process
// objects, not real OS processes (see ACCOUNT.md Decisions) — "crashing"
// a worker means marking it dead and refusing further work until the
// supervisor (supervisor.js, not built yet) restarts it, not killing a
// real process.
//
// This module owns worker rows and the *simulation* of running a task.
// It does NOT own work_item state — that's dispatcher.js's job. Keeping
// that split means a worker crashing and a work item's fate are two
// separate, explicit decisions, not tangled together.

import { db } from "./db.js";
import { logEvent } from "./events.js";

const BASE_TASK_DURATION_MS = 300; // baseline; slow_factor scales this

const insertWorker = db.prepare(`
  INSERT OR IGNORE INTO workers (id, service, state, restart_count, crash_on_start, crash_mid_task, slow_factor)
  VALUES (@id, @service, 'idle', 0, 0, 0, 1.0)
`);
const getWorkerStmt = db.prepare(`SELECT * FROM workers WHERE id = ?`);
const listWorkersStmt = db.prepare(`SELECT * FROM workers ORDER BY id`);
const idleWorkersStmt = db.prepare(
  `SELECT * FROM workers WHERE state = 'idle' ORDER BY id`,
);
const setStateStmt = db.prepare(`UPDATE workers SET state = ? WHERE id = ?`);
const setChaosStmt = db.prepare(`
  UPDATE workers SET crash_on_start = @crashOnStart, crash_mid_task = @crashMidTask, slow_factor = @slowFactor
  WHERE id = @id
`);

export function registerWorker(id, service) {
  insertWorker.run({ id, service });
  return getWorkerStmt.get(id);
}

export function getWorker(id) {
  return getWorkerStmt.get(id);
}

export function listWorkers() {
  return listWorkersStmt.all();
}

/** No service filtering yet — one shared pool for now. Revisit if we
 *  ever need per-service routing; not required by anything in scope. */
export function idleWorkers() {
  return idleWorkersStmt.all();
}

/** Chaos controls (R-15). Takes effect on the worker's *next* task
 *  start, not retroactively on one already running. */
export function setChaos(id, { crashOnStart, crashMidTask, slowFactor }) {
  const current = getWorkerStmt.get(id);
  if (!current) throw new Error(`no such worker: ${id}`);
  setChaosStmt.run({
    id,
    crashOnStart: (crashOnStart ?? current.crash_on_start) ? 1 : 0,
    crashMidTask: (crashMidTask ?? current.crash_mid_task) ? 1 : 0,
    slowFactor: slowFactor ?? current.slow_factor,
  });
  logEvent({
    subjectType: "worker",
    subjectId: id,
    event: "chaos_flag_set",
    reason: JSON.stringify({ crashOnStart, crashMidTask, slowFactor }),
  });
}

export function setWorkerState(id, state) {
  setStateStmt.run(state, id);
}

/**
 * Simulate running one task on a worker. Does NOT touch work_items —
 * the caller (dispatcher) decides what a 'crashed' or 'done' outcome
 * means for the item. Calls back with one of:
 *   'done' | 'crashed_on_start' | 'crashed_mid_task'
 *
 * crash_on_start fires immediately — no partial work happened, safe to
 * retry with no ambiguity. crash_mid_task fires partway through the
 * simulated duration — this is the "worker finishes but dies before
 * saying done" case from Section 3.1, the actually hard one.
 */
export function runTask(workerId, onOutcome) {
  const worker = getWorkerStmt.get(workerId);
  if (!worker || worker.state !== "idle") {
    throw new Error(`worker ${workerId} not available to run a task`);
  }

  setStateStmt.run("busy", workerId);

  if (worker.crash_on_start) {
    setStateStmt.run("dead", workerId);
    logEvent({
      subjectType: "worker",
      subjectId: workerId,
      event: "crashed_on_start",
      reason: "chaos flag crash_on_start was set",
      relatedReleaseId: worker.current_release_id,
    });
    onOutcome("crashed_on_start");
    return;
  }

  const duration = BASE_TASK_DURATION_MS * worker.slow_factor;

  if (worker.crash_mid_task) {
    setTimeout(() => {
      setStateStmt.run("dead", workerId);
      logEvent({
        subjectType: "worker",
        subjectId: workerId,
        event: "crashed_mid_task",
        reason:
          "chaos flag crash_mid_task was set — work may be partially done",
        relatedReleaseId: worker.current_release_id,
      });
      onOutcome("crashed_mid_task");
    }, duration / 2);
    return;
  }

  setTimeout(() => {
    setStateStmt.run("idle", workerId);
    onOutcome("done");
  }, duration);
}

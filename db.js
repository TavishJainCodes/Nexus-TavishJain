// db.js
// Single source of truth for schema + the one SQLite connection.
// Everything else (queue.js, workers.js, dispatcher.js, supervisor.js,
// releases.js, events.js) imports `db` and `now` from here — nobody else
// opens a connection or calls Date.now() directly. That's what keeps
// Rule 04 (same inputs, same behaviour) honest.

import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH =
  process.env.NEXUS_DB_PATH || path.join(process.cwd(), "nexus.db");

export const db = new Database(DB_PATH);

// WAL mode: readers (dashboard polling) don't block writers (dispatcher),
// and it's what actually gives us crash-safe durability on accept (R-01) —
// a committed transaction survives the process dying immediately after.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = FULL"); // don't trade durability for speed here

// ---- Injectable clock (Rule 04) --------------------------------------
// Real time by default. Tests / demos can override via setClock() to get
// deterministic backoff/settling behaviour instead of racing real timers.
let _clockFn = () => Date.now();
export function now() {
  return _clockFn();
}
export function setClock(fn) {
  _clockFn = fn;
}

// ---- Schema -------------------------------------------------------------

db.exec(`
CREATE TABLE IF NOT EXISTS work_items (
  id              TEXT PRIMARY KEY,       -- sender-supplied idempotency key
  type            TEXT NOT NULL,
  body            TEXT NOT NULL,          -- opaque JSON, platform never reads inside it
  state           TEXT NOT NULL CHECK (state IN ('pending','in_flight','done','dead')),
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  worker_id       TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  next_attempt_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_work_items_state_next
  ON work_items (state, next_attempt_at);

CREATE TABLE IF NOT EXISTS workers (
  id                 TEXT PRIMARY KEY,
  service            TEXT NOT NULL,
  current_release_id TEXT,
  state              TEXT NOT NULL CHECK (state IN ('idle','busy','restarting','dead','out_of_service')),
  restart_count      INTEGER NOT NULL DEFAULT 0,
  last_restart_at    INTEGER,
  settled_since      INTEGER,
  next_restart_at    INTEGER,           -- when a scheduled restart should actually happen
  crash_on_start     INTEGER NOT NULL DEFAULT 0,
  crash_mid_task     INTEGER NOT NULL DEFAULT 0,
  slow_factor        REAL NOT NULL DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS releases (
  id                  TEXT PRIMARY KEY,
  service             TEXT NOT NULL,
  version             TEXT NOT NULL,
  previous_release_id TEXT,
  state               TEXT NOT NULL CHECK (state IN ('watching','confirmed','rolled_back')),
  pushed_at           INTEGER NOT NULL,
  watch_until         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 INTEGER NOT NULL,
  subject_type       TEXT NOT NULL CHECK (subject_type IN ('work_item','worker','release')),
  subject_id         TEXT NOT NULL,
  event              TEXT NOT NULL,
  reason             TEXT,
  related_release_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_subject ON events (subject_type, subject_id);
`);

// ---- Transaction helper --------------------------------------------------
// Wraps better-sqlite3's synchronous transaction API so every module writes
// state-change + attempt-count + event-log-row as one atomic unit (point of
// failure #3 from our schema review). Usage:
//   withTransaction(() => { ...multiple db.prepare(...).run(...) calls... });
export function withTransaction(fn) {
  return db.transaction(fn)();
}

// ---- Startup sanity check --------------------------------------------
// Rule: "fail loudly at startup when misconfigured rather than quietly later."
const check = db.pragma("integrity_check");
if (!(check.length === 1 && check[0].integrity_check === "ok")) {
  throw new Error(
    `nexus.db failed integrity_check on startup: ${JSON.stringify(check)}`,
  );
}

console.log(`[db] opened ${DB_PATH}, WAL mode, integrity ok`);

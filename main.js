// main.js
// Boots the platform: opens DB (via db.js side effect), reconciles state
// left over from any previous crash, registers the demo worker pool,
// starts the dispatcher/supervisor tick loops, and starts the HTTP API.
// This is "the platform" as a single running process (Rule 01).

import "./db.js"; // side effect: opens connection, runs schema, integrity check
import { now } from "./db.js";
import { reconcileOnBoot } from "./reconcile.js";
import { registerWorker, listWorkers } from "./workers.js";
import { tick as dispatcherTick } from "./dispatcher.js";
import { tick as supervisorTick } from "./supervisor.js";
import { pruneEventsOlderThan } from "./events.js";
import { createServer } from "./server.js";

const DISPATCH_INTERVAL_MS = 200;
const SUPERVISOR_INTERVAL_MS = 500;
const PRUNE_INTERVAL_MS = 60_000; // check once a minute
const RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h, matches ACCOUNT.md
const PORT = process.env.PORT || 3000;
const WORKER_POOL_SIZE = Number(process.env.WORKER_POOL_SIZE || 3);

console.log("[main] booting nexus platform...");

const reconcileSummary = reconcileOnBoot();
console.log(
  `[main] reconciliation: requeued ${reconcileSummary.requeuedItems.length} item(s), ` +
    `reset ${reconcileSummary.resetWorkers.length} worker(s)`,
);

// Seed a small fixed worker pool if one doesn't already exist. Existing
// workers (from a prior run against the same DB) are left alone —
// registerWorker uses INSERT OR IGNORE, so this is safe every boot.
for (let i = 1; i <= WORKER_POOL_SIZE; i++) {
  registerWorker(`worker-${i}`, "demo-service");
}
console.log(`[main] worker pool: ${listWorkers().length} worker(s)`);

const intervals = [];
intervals.push(setInterval(dispatcherTick, DISPATCH_INTERVAL_MS));
intervals.push(setInterval(supervisorTick, SUPERVISOR_INTERVAL_MS));
intervals.push(
  setInterval(() => {
    pruneEventsOlderThan(now() - RETENTION_WINDOW_MS);
  }, PRUNE_INTERVAL_MS),
);

const app = createServer();
const httpServer = app.listen(PORT, () => {
  console.log(`[main] HTTP API listening on http://localhost:${PORT}`);
});

// Graceful shutdown: stop ticking and close cleanly. Rule 01/05: the
// platform should stop without corrupting state, not just die — an
// item left in_flight here is exactly what reconcileOnBoot() is for on
// the *next* boot, so there's no need to try to "finish" anything here.
function shutdown(signal) {
  console.log(`[main] received ${signal}, shutting down...`);
  intervals.forEach(clearInterval);
  httpServer.close(() => {
    console.log("[main] HTTP server closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref(); // don't hang forever
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

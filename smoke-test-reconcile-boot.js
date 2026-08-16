// smoke-test-reconcile-boot.js
import { reconcileOnBoot } from "./reconcile.js";
import { getWork } from "./queue.js";
import { getWorker } from "./workers.js";
import { eventsForSubject, formatEvent } from "./events.js";

console.log("before reconcile:", getWork("job-stuck"));
console.log("worker before:", getWorker("worker-1"));

const summary = reconcileOnBoot();
console.log("reconcile summary:", summary);

console.log("item after reconcile:", getWork("job-stuck"));
console.log("worker after reconcile:", getWorker("worker-1"));
console.log("event trail:");
eventsForSubject("work_item", "job-stuck")
  .map(formatEvent)
  .forEach((e) => console.log(" ", e));

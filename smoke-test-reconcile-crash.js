// smoke-test-reconcile-crash.js
import { submitWork } from "./queue.js";
import { registerWorker, setChaos } from "./workers.js";
import { tick } from "./dispatcher.js";

registerWorker("worker-1", "notifications");
// slow_factor high enough that the setTimeout in workers.js won't fire
// before we exit — simulating "the process died mid-task."
setChaos("worker-1", { slowFactor: 1000 });

submitWork({ id: "job-stuck", type: "send_notification", body: {} });
tick(); // moves it to in_flight, schedules a setTimeout that will never run

console.log("item is now in_flight, exiting before it resolves...");
process.exit(0); // hard exit — no graceful shutdown, no chance for the timer to fire

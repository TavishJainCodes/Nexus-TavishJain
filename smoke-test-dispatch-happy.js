// smoke-test-dispatch-happy.js
import { submitWork, getWork } from "./queue.js";
import { registerWorker } from "./workers.js";
import { tick } from "./dispatcher.js";

registerWorker("worker-1", "notifications");
submitWork({ id: "job-1", type: "send_notification", body: { to: "a@b.com" } });

tick();
console.log("right after tick:", getWork("job-1")); // expect state: in_flight

setTimeout(() => {
  console.log("after task duration:", getWork("job-1")); // expect state: done
}, 500);

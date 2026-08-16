// smoke-test-supervisor-budget.js
import { setClock } from "./db.js";
import { registerWorker, setChaos, getWorker } from "./workers.js";
import { submitWork } from "./queue.js";
import { tick as dispatchTick } from "./dispatcher.js";
import {
  tick as supervisorTick,
  returnToService,
  MAX_RESTARTS,
} from "./supervisor.js";
import { eventsForSubject, formatEvent } from "./events.js";

let virtualNow = 1_000_000;
setClock(() => virtualNow);

registerWorker("worker-bad", "notifications");
setChaos("worker-bad", { crashOnStart: 1 });

let jobCounter = 0;
function submitFreshJob() {
  jobCounter++;
  submitWork({ id: `job-${jobCounter}`, type: "noop", body: {} });
}

submitFreshJob();
dispatchTick(); // worker-bad picks it up, crashes on start -> 'dead'
console.log("after first crash:", getWorker("worker-bad"));

for (let round = 1; round <= MAX_RESTARTS + 2; round++) {
  supervisorTick();
  let w = getWorker("worker-bad");
  console.log(`round ${round}: ${w.state}, restart_count=${w.restart_count}`);

  if (w.state === "out_of_service") break;

  if (w.state === "restarting") {
    virtualNow = w.next_restart_at; // jump straight to restart time
    supervisorTick(); // performs the restart -> idle
    w = getWorker("worker-bad");
    console.log(
      `round ${round} after restart: ${w.state}, restart_count=${w.restart_count}`,
    );

    submitFreshJob();
    dispatchTick(); // crash_on_start still set -> crashes again
    console.log(
      `round ${round} after re-dispatch: ${getWorker("worker-bad").state}`,
    );
  }
}

console.log("\nfinal:", getWorker("worker-bad"));
console.log("event trail:");
eventsForSubject("worker", "worker-bad")
  .map(formatEvent)
  .forEach((e) => console.log(" ", e));

console.log("\n--- manual revival ---");
returnToService("worker-bad");
console.log("after returnToService:", getWorker("worker-bad"));

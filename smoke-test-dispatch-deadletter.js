// smoke-test-dispatch-deadletter.js
import { setClock } from "./db.js";
import { submitWork, getWork } from "./queue.js";
import { registerWorker, setChaos, setWorkerState } from "./workers.js";
import { tick, MAX_ATTEMPTS } from "./dispatcher.js";
import { eventsForSubject, formatEvent } from "./events.js";

let virtualNow = 1_000_000;
setClock(() => virtualNow);

registerWorker("worker-bad", "notifications");
setChaos("worker-bad", { crashOnStart: 1 });
submitWork({ id: "job-2", type: "send_notification", body: {} });

for (let round = 1; round <= MAX_ATTEMPTS + 1; round++) {
  setWorkerState("worker-bad", "idle");
  setChaos("worker-bad", { crashOnStart: 1 }); // stays bad every round

  tick(); // crash_on_start is synchronous — no real waiting needed

  const item = getWork("job-2");
  console.log(
    `round ${round}: state=${item.state} attempts=${item.attempt_count}`,
  );

  if (item.state === "dead") break;

  // jump the virtual clock straight to whatever backoff was just scheduled
  virtualNow = item.next_attempt_at;
}

console.log("final:", getWork("job-2"));
console.log("event history:");
eventsForSubject("work_item", "job-2")
  .map(formatEvent)
  .forEach((e) => console.log(" ", e));

// smoke-test-queue.js — run with: node smoke-test-queue.js
import { submitWork, getWork, backlogSummary } from "./queue.js";
import { eventsForSubject, formatEvent, retentionFloor } from "./events.js";

const r1 = submitWork({
  id: "order-123",
  type: "send_notification",
  body: { customerId: 42 },
});
console.log("first submit:", r1);

const r2 = submitWork({
  id: "order-123",
  type: "send_notification",
  body: { customerId: 42 },
});
console.log("duplicate submit:", r2); // should show duplicate: true, same item, no error

console.log("fetched:", getWork("order-123"));
console.log("backlog:", backlogSummary());
console.log(
  "events for order-123 (raw):",
  eventsForSubject("work_item", "order-123"),
);
console.log(
  "events for order-123 (operator-facing):",
  eventsForSubject("work_item", "order-123").map(formatEvent),
);

# Account

## Scope

Building: durable accept/dispatch/retry (R-01–R-04), event log (R-05),
release + one-action rollback (R-06, R-07), operator dashboard (R-12),
chaos triggers for 4 named failure modes (R-15).

Not building: drift detection between copies (R-08), cache age/TTL (R-09,
R-10), speed-limited recovery (R-11, stretch only), order-provenance
(R-13), self-introspection (R-14).

## Decisions

- Node.js + better-sqlite3 (WAL mode) for storage — single-file, no
  external service, synchronous API keeps failure-injection ordering
  predictable.
- Workers are in-process simulated objects, not real OS processes —
  faster to build correctly in the time available; failure modes
  (crash-on-start, crash-mid-task, slow) are explicit flags rather than
  actual process kills.
- Idempotency key is sender-supplied, not derived from body — matches
  the actual hard case in the incident report (finished-but-died-before-
  saying-so), which a body-hash can't distinguish from "never ran."
- Dashboard is static HTML/JS polling a JSON API, no server-rendering,
  no build step.
- RNG/timing seeded and controllable, per Rule 04.

- Event log retention is stated, not unbounded: 24h window, enforced by
  a prune call (not yet wired to a timer as of this commit). Pruning
  itself is logged as an event, and a `retentionFloor()` query exposes
  the oldest event still kept — so "no events in this window" and "we
  don't keep history that far back" are distinguishable, per R-05's
  requirement not to let those look the same.
- Event log writes happen inside the same transaction as the state
  change they explain (queue.js `submitWork`), never after — if the
  write isn't durable, the explanation shouldn't look durable either.
- Duplicate submission of an already-seen idempotency key returns
  `{accepted: true, duplicate: true}`, not an error — the sender should
  never have to special-case a resubmit.

## Failure behaviour

- Resubmitting a known work item id: returns success with `duplicate: true`,
  same underlying row, exactly one `accepted` event logged (not two).
  Verified via smoke-test-queue.js.
- Process killed and restarted after accept: work item and its `accepted`
  event both survive, confirmed by rerunning smoke-test-queue.js against
  the same nexus.db without clearing it first.

## Limits

- Event history older than 24h is pruned and not recoverable. Anyone
  asking about older activity gets told the retention floor, not a
  silent empty result — but the data itself is genuinely gone.
- Retention window (24h) is not yet enforced automatically — prune
  function exists but isn't wired to a timer yet (planned for main.js).

## Confidence

(fill in near the end)

## Next

(fill in near the end)

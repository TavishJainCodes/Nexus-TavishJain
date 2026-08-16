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
  - Retry backoff is exponential (1s base, doubling, capped at 30s) and
    capped at MAX_ATTEMPTS=5 total attempts before dead-lettering — both
    constants live in dispatcher.js and are the "stated limit" R-04 asks
    for.

- Dead workers are never silently reused by the dispatcher — a worker
  that crashed stays out of the idle pool until something (supervisor,
  not built yet, or a human) explicitly revives it. Retrying a failed
  item therefore requires _another_ idle worker or a revived one, never
  the same crashed one by accident.
- Backoff/retry correctness is verified using the injectable clock
  (setClock in db.js) rather than real-time waits — tests jump the
  virtual clock directly to next_attempt_at instead of sleeping, so the
  proof is fast and deterministic (Rule 04).

## Failure behaviour

- Resubmitting a known work item id: returns success with `duplicate: true`,
  same underlying row, exactly one `accepted` event logged (not two).
  Verified via smoke-test-queue.js.
- Process killed and restarted after accept: work item and its `accepted`
  event both survive, confirmed by rerunning smoke-test-queue.js against
  the same nexus.db without clearing it first.
  - Worker crashes on start (crash_on_start flag): item is retried with
    growing backoff (1s, 2s, 4s, 8s, 16s) across 5 attempts, then
    dead-lettered. Verified via smoke-test-dispatch-deadletter.js using a
    virtual clock — full event trail (dispatched → retry_scheduled ×4 →
    dead_lettered) confirmed correct.

- Happy path (no chaos flags): item goes pending → in_flight → done in
  one dispatch cycle. Verified via smoke-test-dispatch-happy.js.
- Not yet handled: crash_mid_task outcome isn't separately tested yet
  (code path exists in workers.js/dispatcher.js, only crash_on_start has
  been exercised so far).

## Limits

- Event history older than 24h is pruned and not recoverable. Anyone
  asking about older activity gets told the retention floor, not a
  silent empty result — but the data itself is genuinely gone.
- Retention window (24h) is not yet enforced automatically — prune
  function exists but isn't wired to a timer yet (planned for main.js).
  - MAX_ATTEMPTS (5) and backoff curve (1s→30s cap) are fixed constants,
    not configurable per work-item-type. A type that legitimately needs a
    different retry policy isn't supported.

- No supervisor yet: a crashed worker stays dead until manually revived
  (setWorkerState call). Until supervisor.js exists, "the platform
  brings itself back" (Section 3.4) isn't actually true — currently an
  operator/test script has to do it by hand.

## Confidence

backoff/retry logic verified with a controlled virtual clock, not real-time waits — real-time behavior was tested once and matched expectations but isn't what the automated proof relies on." That's a stronger claim to a reviewer than "we watched it happen once in a terminal.

## Next

(fill in near the end)

# Account

## Scope

Built: durable accept + restart-safe queue (R-01), dispatch with retry/backoff/dead-letter (R-02–R-04), boot-time reconciliation of orphaned work and stranded workers, supervisor circuit breaker with restart budget/backoff/settle-period (Section 3.4), event log grouped by subject with stated 24h retention, enforced by a timer (R-05), operator dashboard with a plain-language status banner and grouped timeline (R-12, best-effort), chaos triggers for 4 named failure modes wired to dashboard buttons (R-15).

Not built, deliberately, for time: R-06/R-07 (release + one-action rollback, and linking releases to what followed) — the schema has columns reserved for this (`releases` table, `current_release_id` on workers) but no `releases.js` and no rollback logic exist. R-08 (drift detection between copies) — no second copy of any fact exists to drift. R-09/R-10 (cache age/honest degrading) — no cache layer built. R-11 (speed-limited recovery) — stretch goal, not reached. R-13/R-14 (EXTENDED) — skipped entirely, no penalty per the doc's own rules.

## Decisions

- Node.js + better-sqlite3 (WAL mode) — single file, synchronous API, no external service (Rule 01/02).
- Workers are in-process simulated objects with explicit chaos flags (`crash_on_start`, `crash_mid_task`, `slow_factor`), not real OS processes — faster to build correctly in the time available.
- Idempotency key is sender-supplied (`id` field), not derived from body — matches the actual hard case (finished-but-died-before-saying-so), which a body-hash can't distinguish from "never ran."
- Duplicate submission of a known id returns `{accepted: true, duplicate: true}`, not an error, per R-03.
- Retry backoff: exponential, 1s base doubling to a 30s cap, 5 attempts max before dead-lettering. Restart backoff (separate budget): 2s base doubling to a 60s cap, 5 restarts max before `out_of_service`. Both are stated constants, matching R-04's requirement for a stated, enforced limit.
- A worker only "earns" a restart-budget reset after staying healthy for a 10s settle period — starting is not recovering, directly addressing INC-2291's 70-restarts-in-70-minutes failure mode.
- Boot-time reconciliation requeues orphaned `in_flight` items (preserving `attempt_count` — a restart must not grant a fresh budget) and resets stranded workers to `idle`, but deliberately leaves workers already `dead` alone — reviving those is an earned supervisor action, not something a bare restart should grant for free.
- Dispatcher/supervisor loops run on real `setInterval` (200ms/500ms) in the live process; a separate injectable clock (`setClock`) is used only in smoke tests, so backoff/settle-period logic is verified deterministically without racing real timers (Rule 04).
- Dashboard groups the event log by subject and collapses by default, most-recently-active first — addresses R-05's "group records by subject" and R-12's 90-second requirement more directly than a flat table.
- Dashboard leads with a plain-language status banner ("all clear" vs "N workers down, N dead-lettered") rather than raw counts, per R-12/Section 3.6's "say what is wrong, do not imply it."
- `/admin/clear-db` endpoint exists for reviewer/dev convenience during testing — not part of the platform's core promises, and not linked from the failure-triggering flows.

## Failure behaviour

- Worker `crash_on_start`: fires immediately on next task assignment, worker → `dead`, item retried on a different worker; verified via smoke test (virtual clock) and manually via dashboard.
- Worker `crash_mid_task`: fires partway through the simulated task duration, same downstream handling; code path exists and is exercised manually via dashboard, not yet covered by a dedicated automated smoke test.
- Worker crash-loop: after 5 restart attempts (each with growing backoff), worker moves to `out_of_service`, visible on dashboard, stops receiving work; reversible only via explicit `Return to service` action, which also clears chaos flags. Verified via smoke test + manual dashboard use.
- Platform restart mid-flight: `reconcileOnBoot()` requeues anything left `in_flight` with `attempt_count` preserved, resets stranded workers to `idle`. Verified with two separate process invocations against the same `nexus.db` (smoke tests) and manually (`Ctrl+C` / `npm start` against a live backlog).
- Duplicate delivery: resubmitting a known id returns `duplicate: true`, no second row, one `accepted` event. Verified via smoke test and the dashboard's dedicated resubmit button.
- Slow worker: `slow_factor` scales task duration; item stays `in_flight` proportionally longer, visible via growing oldest-item age in Backlog. The platform does not itself detect or flag "this worker is slow" as a fault state — it only shows the effect (an aging backlog), not a diagnosis. This is a known gap, see Limits.

## Limits

- No release/rollback mechanism exists at all — R-06/R-07 are unimplemented, not partially implemented.
- No cache layer, so R-09/R-10 don't apply — there's nothing to carry an age or degrade.
- No second copy of any fact exists, so R-08 (drift detection) has nothing to compare.
- Recovery from a cleared backlog is not speed-limited (R-11) — reconciliation and dispatch both run at full speed with no throttle.
- Slow workers are simulated but not detected as a distinct problem state by the platform — an operator has to infer "this looks slow" from a growing backlog age themselves, rather than being told.
- Event retention is 24h, enforced by a real timer (checks every 60s); anything older is genuinely gone, and `retentionFloor()` distinguishes "no events in this window" from "we don't keep history that far back."
- `MAX_ATTEMPTS` (5) and both backoff curves are fixed constants, not configurable per work-item-type or per-service.
- `/admin/clear-db` has no auth and no confirmation beyond a browser `confirm()` — fine for a single-reviewer local run, not meant as a production pattern.

## Confidence

- Core state-machine logic (dispatch, retry/backoff, dead-lettering, restart budget/backoff/settle-period, boot reconciliation) is verified with smoke tests using an injectable virtual clock, not real-time waits — this is a stronger claim than "watched it happen once in a terminal," since it's deterministic and repeatable.
- Duplicate handling, crash-on-start circuit breaking, platform-restart reconciliation, and slow-worker backlog growth were also manually re-verified end-to-end through the dashboard, not just at the code level.
- The dashboard UI itself and the chaos HTTP endpoints (`/workers/:id/chaos`, `/workers/:id/return-to-service`) were exercised manually, not covered by automated tests.
- `crash_mid_task` specifically has less automated coverage than `crash_on_start` — behavior was observed manually but not pinned down by a dedicated smoke test the way the crash-on-start path was.

## Next

In order, if given another six hours: (1) `releases.js` — version pointer + previous version per service, one-action rollback, watch window, linked into the same event log (R-06/R-07), since the schema already reserves space for it. (2) A dedicated smoke test for `crash_mid_task` to close the coverage gap noted above. (3) Speed-limited recovery (R-11) — rate-limit the reconciliation/redelivery loop, cheap to bolt onto the existing dispatcher. (4) A minimal cache layer with stated max-age per fact, to make R-09/R-10 meaningful rather than vacuous. (5) Drift detection (R-08) — only worth building once there are two copies of something to compare, i.e. after (4).

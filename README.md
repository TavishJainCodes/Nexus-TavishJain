# NEXUS — local submission

## Start

Requirements: Node.js 18+ (built/tested on v24.14.1). No other dependencies, no network access needed, no accounts.

```bash
git clone <this-repo>
cd nexus-tavishjain
npm install
npm start
```

Success looks like:
[db] opened .../nexus.db, WAL mode, integrity ok
[main] booting nexus platform...
[main] reconciliation: requeued 0 item(s), reset 0 worker(s)
[main] worker pool: 3 worker(s)
[main] HTTP API listening on http://localhost:3000

First run creates `nexus.db` automatically — nothing to configure. To start completely fresh again later, stop the process and delete `nexus.db`, `nexus.db-wal`, `nexus.db-shm`.

## Use

1. Open `http://localhost:3000/dashboard.html`
2. Click **Submit 1 random job** — watch it in the Tasks table go `pending → in_flight → done` within about a second.
3. Or via curl:

```bash
curl -X POST localhost:3000/work -H "content-type: application/json" -d "{\"id\":\"job-1\",\"type\":\"demo\",\"body\":{}}"
curl localhost:3000/work/job-1
```

## Break

All triggers are buttons on the dashboard, next to each worker or in the Submit Work section.

| Failure                            | How to trigger                                                                                            | What to watch                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker dies mid-task               | Submit a job, then click **Crash mid-task** on the worker it's assigned to (or set it first, then submit) | Worker row turns red (`dead`), item gets retried on another worker, event log for that worker shows `crashed_mid_task`                            |
| Worker crash-loops, never recovers | Click **Kill on start** repeatedly (stays set — every future task on that worker fails immediately)       | `restart_count` climbs each cycle; after 5 attempts, worker flips to `out_of_service` and stops receiving work; **Return to service** reverses it |
| Platform restarts mid-flight       | Submit several jobs, `Ctrl+C` the server while items are `in_flight`, then `npm start` again              | Startup log shows `reconciliation: requeued N item(s)`; those items go back to `pending` with `attempt_count` preserved, not reset                |
| Slow worker (not dead)             | Click **Make slow** on an idle worker, then submit work to it                                             | Task stays `in_flight` longer, oldest-item age in Backlog visibly grows. Not flagged as a fault state by the platform — see ACCOUNT.md Limits     |
| Duplicate delivery                 | Submit a job, then click **Resubmit last job**                                                            | Banner reads "Duplicate detected — no new row created"; Tasks table shows no new row, only one `accepted` event exists for that id                |

**Not handled** (declared, not attempted): bad release + rollback, cache/copy disagreement detection, total dependency removal. See ACCOUNT.md → Scope.

## Look

Dashboard: `http://localhost:3000/dashboard.html`

- **Top banner** — plain statement of whether anything is wrong right now (dead/out-of-service workers, dead-lettered items), not raw numbers.
- **Backlog** — count and oldest-item age per state.
- **Tasks** — every item, its state, attempt count, assigned worker (collapsible).
- **Workers** — state, restart count, live chaos-flag values, action buttons.
- **Event Log** — grouped by subject (worker/item/id), collapsed by default, most recently active subject first. Expand one to see its full reasoned history in order.

What to notice first: the banner, then which worker/item rows are red, then expand that subject's event group for why.

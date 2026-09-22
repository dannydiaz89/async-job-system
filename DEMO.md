# Running and demonstrating the system

Operational guide. For the design itself, see [README.md](README.md).

## Quick start

Two ways to run it. **Docker Compose** runs everything in containers and is the only mode that restarts crashed workers, so use it for demonstrations. **Local development** runs PostgreSQL in Docker and everything else on your machine with hot reload, so use it while writing code.

### Prerequisites

**Docker with Compose, with its daemon running.** Both modes need it. The Compose stack runs every component in a container, and local development still runs PostgreSQL in one: `pnpm db:up` calls `docker compose up -d postgres` before applying migrations.

Local development additionally needs **Node 24** (`.nvmrc`) and **pnpm 10.28.2** (the root `packageManager` field). The Compose stack needs neither on the host; even the smoke tests can run inside the API container.

If you would rather use a PostgreSQL you already have, point `DATABASE_URL` at it, skip `pnpm db:up`, and run `pnpm migrate` instead. Everything except the Compose stack works that way.

### Docker Compose

```sh
docker compose up --build
```

> **Stop a local `pnpm dev` first.** Both bind `127.0.0.1:3000`, and Compose will fail to start the API if a local one is already listening. Either `Ctrl+C` the local processes, or give Compose different ports: `API_PORT=3010 WEB_PORT=8090 docker compose up --build`.

| What | Where |
| --- | --- |
| Status page | [localhost:8080](http://localhost:8080) |
| API | [localhost:3000](http://localhost:3000) |
| Readiness | [localhost:3000/health](http://localhost:3000/health) |
| Swagger UI | [localhost:3000/docs/](http://localhost:3000/docs/) |

`/health` returns `200` after a successful PostgreSQL query, or `503` if the database is unreachable. It also reports `chaosEnabled`, so you can confirm the chaos gate without guessing.

nginx serves the Vite build and proxies `/api/*` to Express, so the browser uses one origin.

Scale workers independently:

```sh
docker compose up -d --scale worker=5
```

Workers have no fixed container names or published ports. Each logs `worker_started` with a hostname and a fresh UUID, then logs every claim and outcome as structured JSON.

Stop with `docker compose down`. PostgreSQL data persists in a named volume; `docker compose down -v` deletes it too.

### Local development

```sh
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:up
pnpm dev
```

`pnpm db:up` starts only PostgreSQL and applies pending migrations. `pnpm dev` runs Express on 3000, a worker, and Vite on [localhost:5173](http://localhost:5173). React and CSS use HMR; API and worker edits restart those processes. Edits under `packages/database/src` restart both backend processes against TypeScript source with no build step.

Restart after changing `.env`, configuration, or package manifests. `pnpm migrate` is safe to rerun and applies only new files. If the full Compose stack is running, `docker compose down` first.

> **One worker, no restarts.** `pnpm dev` starts a single worker, and `tsx watch` does not restart a process that exits on its own; it starts one and waits for a file change. Any `crash_worker` job permanently costs you that worker. For crash demonstrations, use Compose or start extra workers manually.

### Configuration

Compose uses local-only defaults and needs no `.env`. Overrides in `.env.example`:

| Variable | Default | Notes |
| --- | --- | --- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `jobs` | Changing these does not alter an existing volume |
| `POSTGRES_PORT` | `5432` | |
| `API_PORT` | `3000` | Compose keeps the API's internal port at 3000 |
| `WEB_PORT` | `8080` | |
| `WORKER_POLL_INTERVAL_MS` | `500` | 50–10,000 |
| `WORKER_LEASE_DURATION_MS` | `30000` | 1,000–300,000; renewed every third |
| `ENABLE_CHAOS` | `false` | Required for `fail_task` and `crash_worker` |

Local Node processes also need `DATABASE_URL` consistent with those settings; Compose builds its own from the internal `postgres:5432` address. Passwords containing URI-reserved characters need URL encoding.

## Tests

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm scaling        # measured worker-count comparison; see Scaling below
pnpm overhead       # where a worker's per-job time goes
```

`pnpm test` runs everything in `tests/` and needs only PostgreSQL.

Integration tests run against real PostgreSQL because mocks cannot reproduce row-lock behavior, `FOR UPDATE SKIP LOCKED`, or lease expiry evaluated in database time. `tests/support/database.ts` gives each test its own freshly created database and drops it afterwards, so tests never contend with each other or with your development data, and a failure cannot leave state behind. `tests/support/workers.ts` starts real worker subprocesses, separate OS processes sharing nothing but the database, which is the only way claim contention and crash recovery mean anything.

The heaviest coverage is `batch-fleet.test.ts`: four workers draining a batch with every job completing on exactly one attempt, a batch surviving a worker killed mid-drain, and partial cancellation leaving the rest to finish. Smoke tests skip automatically when the Compose stack is not running.

For the smoke tests, start the stack first:

```sh
docker compose up -d --build --wait
pnpm test:smoke
```

They verify readiness directly and through the nginx proxy, delivery of the built page and its JavaScript, and JSON 404 handling. Set `TEST_API_URL` and `TEST_WEB_URL` for custom ports.

These are the only tests that touch nginx and the Compose topology, so they are also a quick check that the stack is healthy before a demo.

---

## Job configuration

Every job carries the same validated configuration. Zod checks bounds and cross-field coherence in the contracts package, and attempt numbers start at 1.

| Field | Range | Meaning |
| --- | --- | --- |
| `durationMs` | 100 to 3,600,000 | How long the job occupies a worker |
| `maxAttempts` | 1 to 10 | Attempt budget, counting claims |
| `failUntilAttempt` | 0 to 10 | Fail every attempt up to this number, then succeed. `2` fails attempts 1 and 2 |
| `chaosType` | `none`, `fail_task`, `crash_worker` | Fault injection. See below |
| `chaosOnAttempt` | 1 to 10, or null | Which attempt the chaos fires on. Null exactly when `chaosType` is `none` |

Batches add `jobCount`, from 1 to 1,000.

`fail_task` fails only its configured attempt. `crash_worker` exits the worker process on its configured attempt without recording an outcome, which is what makes lease recovery observable.

Chaos is fault injection for demonstrations, so it is gated at admission: `POST /jobs` and `POST /batches` reject any `chaosType` other than `none` with `403` unless the API runs with `ENABLE_CHAOS=true`. Workers execute whatever a job row already carries, so the trust boundary is what may *become* a job row, not what a worker is willing to run. `failUntilAttempt` is deliberately not gated, so retry behavior stays demonstrable with chaos off.

## Schema and migrations

Three tables: `batches`, `jobs`, and `schema_migrations`. Constraints require a JSON-object configuration, a positive attempt limit, `attempts <= max_attempts`, a lease plus `started_at` for `RUNNING`, and a completion timestamp for terminal states. Partial indexes support the two hot queries: claiming eligible work, and finding expired leases.

Those constraints protect durable state at the row level, and the API and worker add guarded transition rules on top. Both matter: the constraints are what make a logic bug fail loudly instead of silently corrupting a job.

Migrations are ordered SQL files applied by a small runner that takes a PostgreSQL advisory lock, then runs each unapplied file and its history record in one transaction. Concurrent invocations serialise, and a failed migration is never marked complete. Applied migrations are immutable, so any schema change is a new numbered file.

Listings default to 25 results and cap at 100. Missing records return `404`; malformed IDs, query parameters, JSON, and job configuration return `400`.

## Demonstrations

Each scenario below is self-contained. Submit work from the dashboard, through [Swagger UI](http://localhost:3000/docs/), or with `curl`.

The dashboard has three panels: **Submit work** (one set of configuration fields driving both single jobs and batches), **Batches** (select a recent batch, watch progress and derived metrics), and **Jobs** (filterable, paginated table with per-row cancellation and an expandable detail row). Chaos controls stay disabled until the API reports `chaosEnabled`, so the UI follows the same gate the API enforces.

Polling is every 1 to 2 seconds per panel, and each panel schedules its next request only after the previous one settles, so requests never overlap. A failed poll keeps the last good data on screen with the error beside it, so the dashboard degrades rather than blanking. The **Database outage** scenario below shows that directly.

Polling also gets out of the way when there is nothing to watch. A panel stops entirely once its data is final, which is why a finished batch issues no further requests; polling pauses while the browser tab is hidden and resumes on return; and the interval backs off while consecutive responses are identical, resetting the moment anything changes or you submit work. Idle traffic is about 0.7 requests per second rather than 3, and zero in a background tab. The readiness poll is deliberately exempt from backoff, since its value is noticing an outage quickly.

### Concurrent claiming

Run PostgreSQL, the API, and Vite in one terminal, without the default worker:

```sh
pnpm db:up
pnpm --parallel --filter @async-jobs/api --filter @async-jobs/web dev
```

Then start two workers, each in its own terminal:

```sh
WORKER_POLL_INTERVAL_MS=100 pnpm --filter @async-jobs/worker dev
```

Submit several jobs with `durationMs` around 3000. Worker logs show each `job_claimed` going to a distinct `workerId`, with no job claimed twice. This is `FOR UPDATE SKIP LOCKED` doing its job: neither worker blocks waiting for the other.

### Retries

```json
{ "durationMs": 200, "failUntilAttempt": 2, "maxAttempts": 3, "chaosType": "none", "chaosOnAttempt": null }
```

`GET /jobs/{id}` passes through `RETRYING` after attempts 1 and 2, then reaches `COMPLETED` with `attempts: 3`. The worker logs two `job_failure_resolved` events, then `job_completed`.

Set `failUntilAttempt` and `maxAttempts` both to `2` to see exhaustion instead: `FAILED`, carrying the last error.

No chaos flag needed, because `failUntilAttempt` is not gated.

### Cancellation

Submit a long job (`durationMs: 10000`), poll `GET /jobs/{id}` until it is `RUNNING`, then:

```sh
curl -X POST localhost:3000/jobs/{id}/cancel
```

Returns `202` (intent recorded, worker still running), and the next `GET` within about 250 ms shows `CANCELLED`. Cancelling before a worker claims it returns `200` and is terminal immediately.

### Crash recovery

Needs `ENABLE_CHAOS=true` and at least two workers. With Compose:

```sh
ENABLE_CHAOS=true WORKER_LEASE_DURATION_MS=3000 docker compose up -d --wait --scale worker=2
```

Confirm the gate with `GET /health` (`chaosEnabled: true`), then submit:

```json
{ "durationMs": 400, "failUntilAttempt": 0, "maxAttempts": 2, "chaosType": "crash_worker", "chaosOnAttempt": 1 }
```

The job reaches `COMPLETED` with `attempts: 2`. `docker compose logs worker` tells the whole story:

```
worker-1 | {"event":"worker_crashing","attempt":1,...}
worker-1 | {"event":"worker_started",...}              <- Compose restarted it, new identity
worker-2 | {"event":"expired_lease_recovered","attempt":1,"status":"RETRYING",...}
worker-2 | {"event":"job_completed","attempt":2,...}
```

With `maxAttempts: 1` the same job ends `FAILED` after recovery, because no attempts remain.

A short lease keeps the demonstration quick. The 30-second default is the realistic setting; 3 seconds just avoids waiting.

**Without chaos configuration at all**, kill a worker directly:

```sh
docker compose ps --format '{{.Name}}' | grep worker | head -1 | xargs docker kill
```

Nothing in the application coordinates that, which makes it the more convincing version. `crash_worker` is the deterministic one, useful in tests and for crashing on an exact attempt number.

**A hand-killed container does not come back on its own**, and that is Docker's behavior rather than a misconfiguration: `restart: unless-stopped` treats `docker kill` and `docker stop` as deliberate manual stops. A container that exits *by itself*, which is what `crash_worker` causes, is restarted, and its replacement logs `worker_started` with a fresh identity. Bring a hand-killed worker back with `docker compose up -d --scale worker=<n>`. Either way the job is recovered by lease expiry; only the fleet's capacity differs.

### Database outage

Shows that a worker losing its database does not die. With the stack running and workers idle or busy:

```sh
docker compose pause postgres
```

Workers log `worker_poll_failed` with `backoffMs` doubling from the poll interval, and keep running. Container restart counts do not change:

```sh
for c in $(docker compose ps -q worker); do docker inspect -f '{{.Name}} restarts={{.RestartCount}}' $c; done
```

Restore it:

```sh
docker compose unpause postgres
```

Workers log `worker_poll_recovered` and resume. Any job held through the outage is recovered by lease expiry.

On the dashboard, each panel shows its own error while the outage lasts but keeps the rows and metrics it last read, and all three clear themselves once the database returns, no reload needed.

This is the strongest single demonstration of the recovery model: the same mechanism covers a crashed worker and a worker that merely lost its database, with no separate handling for either.

### Batches and metrics

```json
{ "durationMs": 1000, "failUntilAttempt": 0, "maxAttempts": 3, "chaosType": "none", "chaosOnAttempt": null, "jobCount": 10 }
```

`GET /batches/{id}` starts at `total: 10`, `pending: 10`, `queueDepth: 10`, zero progress. As workers drain it, totals, `startedAt`, queue depth, and `terminalProgress` move. Once every job is terminal, `completedAt` is set and `throughputPerSecond` reports completed jobs over elapsed batch seconds.

`GET /batches` lists recent submissions; `GET /jobs?limit=100` shows their `batchId` values.

Every metric is derived from current job rows in one query against a consistent snapshot. There are no stored counters, so nothing can drift from job state:

| Metric | Definition |
| --- | --- |
| Queue depth | `PENDING + RETRYING` |
| Terminal progress | `(COMPLETED + FAILED + CANCELLED) / total`, defined at zero jobs |
| Start | Earliest first-attempt start, preserved across retries; null if nothing started |
| Completion | Latest terminal timestamp, set only once every job is terminal |
| Elapsed | Creation to now, or to completion once finished. Includes queue wait and retry delay, because that is the latency a user actually experiences |
| Throughput | Completed jobs over elapsed seconds. An average since submission rather than an instantaneous rate |

These are deliberate about edge cases: a batch cancelled before any processing has a null start, and progress is defined when the batch has no jobs.

### Scaling

`pnpm scaling` runs the same workload at several worker counts and reports what actually happened:

```bash
pnpm scaling --jobs 60 --duration 1000 --workers 1,5
```

It creates its own database, so no competing work exists and nothing touches your development data. For each worker count it starts that many real worker processes, drains a throwaway warm-up batch so process startup is excluded from the measurement, then submits a fresh batch and waits for every job to reach a terminal state. Elapsed time comes from the batch metrics the API derives, so the reported number is the same one the dashboard shows; wall-clock time is recorded alongside it as a cross-check.

**Measured on 2026-09-21.** 10 logical CPUs, PostgreSQL 17.10 in Docker, workers and database on one machine, one run per worker count:

60 jobs x 1000 ms (60s of work):

| Workers | Elapsed | Throughput | Ideal | Efficiency | Speedup |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 61.6s | 0.97/s | 60.0s | 97% | 1.00x |
| 5 | 12.4s | 4.83/s | 12.0s | 97% | 4.96x |

60 jobs x 500 ms (30s of work), extended to show the curve:

| Workers | Elapsed | Throughput | Ideal | Efficiency | Speedup |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 31.5s | 1.91/s | 30.0s | 95% | 1.00x |
| 2 | 15.8s | 3.80/s | 15.0s | 95% | 1.99x |
| 5 | 6.5s | 9.29/s | 6.0s | 93% | 4.87x |
| 10 | 3.3s | 18.43/s | 3.0s | 92% | 9.67x |

Scaling is near-linear through ten workers.

**The efficiency drift in that second table is not contention.** Holding the workload per worker constant instead of the total (12 jobs each), efficiency is flat:

| Workers | Jobs | Elapsed | Throughput | Efficiency |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 12 | 6.2s | 1.92/s | 96% |
| 5 | 60 | 6.3s | 9.51/s | 95% |
| 10 | 120 | 6.3s | 18.90/s | 95% |

Ten workers do ten times the work in the same wall-clock time at the same efficiency. The 95%→92% drift in the fixed-60-job table is an artifact of that fixture: with ten workers each does only six jobs, so one-time startup latency is amortized over six jobs instead of sixty.

### Where the missing few percent goes

`pnpm overhead` decomposes it from the database's own timestamps, using one worker so jobs run serially and the gap between them is unambiguous:

```bash
pnpm overhead
```

| Duration | Slices | In-job overhead | Per slice | Between jobs | Total | Efficiency |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 250 ms | 1 | 9.3 ms | 9.3 ms | 6.3 ms | 15.6 ms | 94.1% |
| 500 ms | 2 | 12.2 ms | 6.1 ms | 6.1 ms | 18.2 ms | 96.5% |
| 1000 ms | 4 | 19.4 ms | 4.9 ms | 6.2 ms | 25.6 ms | 97.5% |
| 2000 ms | 8 | 32.5 ms | 4.1 ms | 5.8 ms | 38.3 ms | 98.1% |

Two components, neither of them contention:

- **Between jobs: ~6 ms, flat.** The recovery pass, the claim transaction, and the completion write. Measured directly against this PostgreSQL instance, those queries cost about 2.4 ms combined (claim transaction 1.31 ms, recovery pass 0.80 ms, completion 0.24 ms, against a 0.22 ms round-trip floor); the remainder is pool and event-loop scheduling.
- **In-job: ~6 ms fixed plus ~3.4 ms per 250 ms slice.** Each job is cut into slices so cancellation can be observed during work. Every slice is a timer wakeup plus one cancellation query. The query is 0.24 ms, so roughly 3 ms of each slice is Node timer granularity and event-loop latency, not database work.

**So efficiency here is a function of job duration, not of scale.** A 250 ms job spends 15.6 ms on overhead and lands at 94%; a 2-second job pays about the same fixed cost and lands at 98%. It does not keep climbing, though: the fixed cost amortizes away with longer jobs, but the per-slice term does not, because slice count scales with duration. At 3.4 ms per 250 ms slice that term is a constant 1.36% of runtime, so efficiency approaches roughly 98.6% and no further. A one-minute job measures 98.6%, the same as a ten-second one.

That per-slice cost is the price of cancellation responsiveness, and it is the same tradeoff described in [the README's third design decision](README.md#3-cancellation-races-everything-else): a single long sleep would be cheaper and would also make a running job uncancellable for its full duration.

**What none of this shows.** Synthetic jobs sleep rather than compute, so ten workers on ten CPUs never compete for CPU, and 19 jobs/s is far below what one PostgreSQL instance will serve. This measures whether *claiming* becomes a bottleneck at this scale, it does not. A workload that used real CPU or a downstream service would hit those limits long before the claim query became the constraint. Where that constraint eventually is appears in [the README](README.md#what-this-design-does-not-do).

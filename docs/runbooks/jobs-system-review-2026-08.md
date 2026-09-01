# Jobs system review — August 2026

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

A review of the pg-boss jobs system and the Jobs dashboard, and the changes that
came out of it. Every claim here was verified against either the pg-boss 10.3.2
source in `.yarn/cache` or the live appliance database (`companion@localhost:5432`,
`pgboss` schema version 24), on 2026-08-17. Numbers are query results.

---

## 1. How the jobs system works

```
send()/sendMany()          route by listener            worker loop
  │                          │                            │
  ├─ EventListenerRegistry ──┤                            │
  │  (built from @OnEvent    │                            │
  │   decorator side effects)│                            │
  ▼                          ▼                            ▼
pgboss.job  ──── fetch(batchSize) ──── executeJob ──── complete()
(partitioned                │                │              │
 by queue name)             │                │              └─ failure → fail(output)
                            │                │                    │
                    per-queue + global       │              retries exhausted
                     p-limit semaphores      │                    │
                                             │                    ▼
                                    EventEmitter2 emits    pgboss.job (dead-letter queue,
                                    `${event}:${queue}`     state `created`)
                                                                  │
                                                    DeadLetterReaperListener (every 2 min)
                                                                  │ copies, never consumes
                                                                  ▼
                                                       ci.pipeline_dead_letters
```

Queues are **discovered**, not declared: `@OnEvent(event, { queue })` registers
into a static `EventListenerRegistry` at decorator-evaluation time, and
`onModuleInit` creates every discovered queue under an advisory lock, wiring each
to the shared `dead-letter` queue.

**23 queues** exist (22 listener queues + `dead-letter`), carrying **85 `@OnEvent`
registrations**. Recurring work is **~34 NestJS `@Cron` methods** — there is not
one call to `boss.schedule()` anywhere, so `pgboss.schedule` is empty.

Live distribution at review time:

| Queue | Listeners |
|---|---|
| `search-index` | 42 |
| `default` | 16 |
| `pipeline-index` | 4 |
| `pipeline-enrich`, `pipeline-embed`, `etl`, `feed-queue` | 2 each |
| 15 others | 1 each |

---

## 2. What was wrong

### 2.1 Three ways the worker loop could take down the API

`PGBossEventService.work()` had two un-awaited edges and one over-broad `try`.

| | Before | Consequence |
|---|---|---|
| `boss.fetch()` | unguarded inside `while (this.running)` | A throw escaped the loop and rejected the promise parked in `stopTasks`, which nothing awaits until shutdown → unhandled rejection. Had the process survived, **that queue would have had no worker for the rest of its life** while every other queue kept running. |
| `perQueueSemaphore(...)` | called without `await` or `.catch()` | A `boss.fail()` that itself failed became an unhandled rejection — one job error escalating into `process.exit(1)`. |
| `boss.complete()` | inside the same `try` as the listener | A job whose listener **succeeded** got marked failed and retried when the acknowledgement round trip errored — burning retries on finished work until it dead-lettered. |

All three are reached by ordinary transient database trouble. "The DB hiccupped"
must not mean "the appliance restarted".

### 2.2 `userId` never reached any job's execution context

```ts
const userId = (job as { userId?: string }).userId;   // ← always undefined
```

`pgboss.job` has no `userId` column. Its columns are `id, name, priority, data,
state, retry_limit, retry_count, retry_delay, retry_backoff, start_after,
started_on, singleton_key, singleton_on, expire_in, created_on, completed_on,
keep_until, output, dead_letter, policy`. The user id travels in the **payload**:

```sql
select count(*) from pgboss.job where data ? 'userId';   -- 36,923
```

So `ContextService.getUserId()` returned `null` inside every background job, and
the "Executing job" log line never carried a user id.

### 2.3 The dashboard counted dead-lettered jobs twice

pg-boss inserts a dead-lettered job onto the `dead-letter` queue **in state
`created`** — indistinguishable, by state alone, from work waiting to run. The
summary counted `state = 'created'` across every queue.

| Tile | Reported | Actual |
|---|---|---|
| Pending | 13,907 | **12,716** (12,710 image-description + 6 search-index) |
| Failed | 1,191 | 1,191 — *the same jobs*, counted again |

`dead-letter` was also the second-largest entry in "Active jobs by queue",
presenting jobs that had already given up as live workload.

### 2.4 Failure diagnostics were fetched and thrown away

`JobMonitorService` selects `pgboss.job.output`, the worker writes
`{ message, stack, failedAt }` into it on every failure, and the DTO carried it
all the way to the browser — where `JobsPage` never rendered it.

What was sitting in that column, unread:

| Failures | Cause |
|---|---|
| 628 × `file-preview-generation` | `Cannot find ffmpeg` |
| 941 × `file.uploaded` (dead-lettered) | — |
| 141 × `python.function.run` (dead-lettered) | — |
| 40 × `smart.rotation.work` | `column fq.metadata does not exist` |

The page could say "Failed: 1,191" and nothing about why, while the answer was
one property away in memory.

### 2.5 The Schedules column could never show anything

It rendered `pgboss.schedule`, which has **0 rows** and always will — nothing
calls `boss.schedule()`. Meanwhile ~34 real `@Cron` schedules ran invisibly.
`summary.scheduled` was permanently 0.

### 2.6 The summary was six sequential scans on a 15-second poll

`pgboss.job` is partitioned by queue name, so every count over it is an `Append`
of a `Seq Scan` per partition. `pgboss.archive` is created as
`CREATE TABLE archive (LIKE job)` (`plans.js:355`) — it inherits **no indexes**,
and the only one added is `archive_i1 ON archive(archived_on)` (`plans.js:363`).
There is no index on `state`, so archive counts are always a full scan.

Measured (`EXPLAIN ANALYZE`, 41.5k job rows / 88.7k archive rows / 39 MB):

| | Before | After |
|---|---|---|
| job side | 4 counts, 6.9 + 13.9 + 30.2 + 10.7 = **61.7 ms** | 1 grouped scan, **14.7 ms** |
| archive side | 2 counts, **~43 ms** | 1 grouped scan, **22.7 ms** |
| total | **~105 ms** | **~37 ms** |

...while returning *more* states than before.

### 2.7 `retentionDays: 30` on the dead-letter queue was silently discarded

The live queue row carries `retention_minutes = NULL`. Traced through pg-boss
10.3.2:

- `attorney.js:238-249` folds `retentionDays` into a `keepUntil` interval string and never sets `retentionMinutes`;
- `manager.js:538-562` destructures only `retentionMinutes` from those options;
- `plans.js:226-256` (`create_queue`) reads only `options->>'retentionMinutes'`.

The requested 30 days never reached the database.

### 2.8 The dashboard served other users' job payloads

`getDashboard` checks only that *a* user context exists, then returns the 25
newest job rows and 25 newest archive rows **with no owner predicate**,
serialising `data` and `output` verbatim. Job payloads are user content:
`graph.person.created` carries name, email, phone and bio;
`search.embed.entity` carries the entity's searchable text. Any signed-in user
opening `/jobs` saw the most recent jobs of whoever generated them — the one
owner-scoping invariant the rest of the codebase enforces everywhere.

### 2.9 An orphaned rejection in the ETL sweep, once a minute

`SyncOrchestrator.orchestrateSyncJobs` (`@Cron(EVERY_MINUTE)`) ran async
callbacks inside `Array.prototype.forEach`, at four sites. `forEach` discards
the promise an async callback returns, so a rejection inside the body reaches
neither the caller, nor the `@Cron` wrapper, nor Nest's own scheduler catch — it
surfaces as a genuine unhandled rejection, and `application.ts` turns those into
`process.exit(1)`. The body makes six awaited database calls, so one pool
timeout restarted the API.

### 2.10 Smaller correctness bugs in the page

- **Active Jobs** filtered on `state !== 'completed'`, so `failed` and `cancelled` jobs appeared under "Jobs waiting to run or currently executing".
- **A failing refresh after the first success was swallowed entirely.** The page kept auto-refreshing and kept showing frozen numbers, so a dead API looked exactly like a quiet queue.
- The `retry` and `cancelled` states had no tile, so a queue entirely in retry read as idle.
- Every empty column said "No data available", which reads as a fetch problem rather than an idle queue.
- Polling continued in hidden tabs.

---

## 3. What changed

### Backend

| File | Change |
|---|---|
| `domains/events/services/PGBossEventService.ts` | `boss.fetch()` guarded — logs, backs off, keeps polling. Per-job work moved into `runJob()`, launched as `void …catch(…)` so nothing can escape as an unhandled rejection, and each `work()` promise now carries a terminal `.catch` before it is parked in `stopTasks`. `boss.complete()` split out of the listener's `try`: a completion failure is logged and the job left `active` for pg-boss's expiration, never re-failed. New `failJobQuietly()` so a failing `fail()` cannot crash the worker. `userId` now read from `job.data`. DLQ retention expressed in `retentionMinutes`, plus an `updateQueue` so existing appliances get it. |
| `domains/etl/listeners/SyncOrchestrator.ts` | Four async `forEach` callbacks converted to `for…of`, so a rejection reaches the scheduler's catch instead of the process. The two `return`s inside the converted loop became `continue` — under `forEach` they skipped one endpoint; under `for…of` they would have abandoned the rest of the sweep. |
| `domains/events/constants.ts` | `DEAD_LETTER_QUEUE` exported, so the monitor's exclusions and the queue's creation cannot drift apart. |
| `domains/events/services/JobMonitorService.ts` | `getSummary()` rewritten as two grouped scans. Dead letters excluded from `pending` and reported as `deadLettered`; `retry` and `cancelled` added. Dead-letter queue excluded from both live-work distributions. New `getCronSchedules()` reads Nest's live `SchedulerRegistry`. **`toJobRecord` no longer returns `data` or `output`** — it projects to `event`, `workType`, `payloadBytes` and a parsed `failure`, which is exactly what the UI reads, so the redaction is lossless on screen. A deferred completion's success payload projects to `failure: null` rather than leaking through that path. |
| `common/schedule/decorators/Cron.ts` | Catches and logs with the class, method and traceId. **Not** a crash fix — `@nestjs/schedule` v6 already contains rejecting ticks (`SchedulerRegistry.wrapFunctionInTryCatchBlocks`); it just logs them with no indication of which schedule failed. |

### Frontend

| File | Change |
|---|---|
| `pages/JobsPage/JobsPage.tsx` | New `JobFailureDetail` renders the message, stack and time of a failure, collapsed in a `<details>`. New **Failures** column (failed jobs + dead letters). Active Jobs restricted to `created`/`active`/`retry` and excludes the dead-letter queue. Schedules column now renders real crons. Six summary tiles. Per-column empty messages. `StaleBanner`; `role="alert"`/`role="status"` on both banners. `getJobDisplay` reads the projected `event`/`workType` and falls back to the queue name instead of "Unnamed job". |
| `pages/JobsPage/useJobsDashboard.ts` | Tracks `staleSince` and `updatedAt`; a failing refresh after first load now surfaces instead of being swallowed. Skips polling in hidden tabs. Types extended for `crons`, the new summary states, and the projected job record. |

---

## 3b. The dashboard rebuild

The fixes above made the dashboard *correct*. It was still five fixed card
columns showing 25 server-chosen rows each, with no way to change them — so
"why did that job fail?" was answerable only if the job happened to be one of
the 125 on screen. Three things replaced it.

### Job types are named

`domains/events/taxonomy.ts` maps every event the codebase can emit to a label,
a category and a one-line description. The queue is named after its mechanism
and the event after its trigger, so a dashboard built from raw names could tell
you `file.uploaded` was on `image-description` — two facts that together still
do not say what the appliance is doing. Now a row reads **"Embed for semantic
search"**, not `search.embed.entity`.

Nine categories: `search`, `ingest`, `enrich`, `graph`, `pipeline`, `import`,
`llm`, `personalization`, `maintenance`. `smart.rotation.work` — one event
covering eleven unrelated activities — resolves through its `workType`, so it
shows as "Enrich graph entities" rather than as itself eleven times.

Served at `GET /api/jobs/types` so the labels and the category filter come from
one source rather than a second copy in the frontend.

### History exists at all

pg-boss keeps no history: terminal jobs move to `pgboss.archive` after twelve
hours and are deleted twelve hours after that, so the observable past was ~36
hours of working set with nothing to compare against. "Is the backlog draining?"
had no answer.

`ci.job_metrics` (migration `20260817030000`) is sampled every five minutes by
`JobMetricsCollector`: per-queue depth **gauges** (pending/active/retry/dead-lettered)
and **deltas** over the interval (completed/failed, plus mean and p95 duration).
Two grouped queries per tick. 30-day retention, purged daily.

Deltas rather than cumulative counters because a running total cannot be
reconstructed from pg-boss — the rows it would count are deleted out from under
it.

`db/postgres/scripts/backfill_job_metrics.sql` seeds the table from the history
pg-boss still holds, so the charts are populated on first deploy rather than
after a day of sampling. On the appliance this was written against that produced
**1,012 real samples across 20 queues**. Depth is left at zero for backfilled
buckets — a gauge leaves no trace once the rows drain, and inventing one would
be a lie.

### One table, with filters

`GET /api/jobs` replaces the fixed dump: filters on state, queue, category and a
search across event name, queue name and failure message, with pagination and
per-state counts. All of it in SQL — `pgboss.job` routinely holds tens of
thousands of rows during an import, so client-side filtering would be both wrong
and slow.

`GET /api/jobs/history` serves the charts, bucketed by window (5 min under 6h,
30 min under 48h, 3 h beyond).

The page is now: clickable summary tiles → three charts (backlog area,
throughput bars, duration line with p95) → the filterable table → schedules.
Rows expand to the description, timings, payload size and the full failure stack.

**What this makes visible.** On the live appliance, the twelve most recent
failures were four distinct causes that the old UI showed as an undifferentiated
count of 1,191: `Cannot find ffmpeg`, `Invalid model specified:
qwen/qwen3-vl-30b`, `column gd.user_id does not exist`, and a sidecar `fetch
failed`. The duration chart also shows what no count could: `image-description`
averages ~33.5 s a job against `search-index` at ~0.5 s, which is why a
12,710-job backlog on that one queue is a day of work rather than an afternoon.

## 4. Tests

| Suite | Before | After |
|---|---|---|
| `domains/events` (backend) | 46 | 64 |
| `common/schedule` | 2 | 5 |
| `JobMonitorService` | **0** | 8 |
| Job taxonomy | **0** | 7 |
| `JobsPage` (frontend) | **0** | 13 |

Every new test was run against the **unfixed** code first to confirm it fails
there: 4 of 4 backend worker/completion tests failed pre-fix, and 7 of 9 original
frontend tests failed pre-fix.

```bash
cd backend/apps/api && yarn test src/domains/events src/common/schedule src/domains/etl
```

```bash
cd frontend/apps/web && yarn vitest run src/pages/JobsPage
```

Both suites, plus `yarn typecheck` and `yarn lint` in each workspace, are clean.

**Verified in a browser** against real data, via a scratch Vite entry that
mounted the real `JobsPage` with the three data hooks aliased to fixtures
captured from the live database. That avoided the two things a normal dev server
would have needed: an authenticated session, and a second API process whose
worker loop would have started draining the live 12,710-job backlog. The harness
was removed after the screenshots; it is trivial to recreate (alias
`./useJobsList`, `./useJobHistory` and `./useJobsDashboard` to stubs in a
`vite.config` and mount the page under `DeviceLayoutProvider args={[]}`).

Two bugs came out of looking at it that the DOM tests did not catch: the
throughput axis clipped six-figure values (`100000` rendered as `00000`), and the
"All" tab counted the *filtered* total, so it collapsed to the current selection
the moment a state was picked.

---

## 5. On the pg-boss dashboard and proxy

**Do not upgrade pg-boss to adopt the official dashboard.**

| Package | Installed | Latest |
|---|---|---|
| `pg-boss` | 10.3.2 | 12.27.0 (v10 line ends at 10.4.2) |
| `@pg-boss/dashboard` | — | 1.6.5, **requires pg-boss ≥ 12.21** |
| `@pg-boss/proxy` | — | 1.5.3 |

Two blockers, both confirmed against the source: there is no migration path from
schema 24 to v12, and **`pgboss.archive` does not exist in v11 or v12** while two
production code paths read it directly. On an appliance that ships to end users,
an in-place schema migration at boot is not a risk worth taking for a monitoring
UI.

**None of it is necessary.** pg-boss 10.3.2 already declares everything the
dashboard is missing:

```
cancel(name, id|ids)      resume(name, id|ids)       retry(name, id|ids)
deleteJob(name, id|ids)   getJobById(name, id, { includeArchive })
purgeQueue(name)          deleteQueue(name)
getQueues()               getQueue(name)             getQueueSize(name, { before })
schedule(name, cron, data, options)   unschedule(name)   getSchedules()
```

Job detail, retry, cancel, delete and purge can ship today against the installed
version. `@pg-boss/proxy` solves a problem this codebase does not have — HTTP
access to pg-boss from non-Node runtimes — and would add an unauthenticated
surface over the job tables.

---

## 6. Still open

Ranked, not yet done. Severities and file references come from the multi-agent
review (61 findings confirmed, 17 refuted); the full plan is in the workflow
transcript.

1. **No ack timeout.** `executeJob`'s promise settles only via `done`/`fail`/`defer`. `ImageDescriptionListener` awaits `ollamaService.chat()` with no AbortSignal, so a black-holed Ollama host parks a concurrency slot forever; after six, the queue spins on its backoff and `flush()` makes SIGTERM hang until SIGKILL. **The highest-value item left** — it is the one remaining way the appliance can wedge itself.
2. **Leases are taken before global capacity is reserved**, so far more jobs are held `active` than the global cap allows (~108 against a cap of 32 on the shipped config). Land it with the ack timeout, or the reduced lease count just moves the stall.
3. **No job actions.** `retry` / `cancel` / `deleteJob` / `purgeQueue` exist in the installed pg-boss and are unwired; the dashboard is still read-only for no technical reason. Now that there is a table to select rows in, this is the natural next feature.
4. **`monitorStateIntervalSeconds` is off** (`version.monitored_on` is NULL). Enabling it makes pg-boss emit per-queue state counts from one `GROUP BY rollup`, which could replace the summary's two grouped scans entirely.
5. **Handlers that swallow transient failures** report success and never retry — `FileDocumentParseListener`, `FileChunkSearchIndexListener`, and all 12 `GraphEventListener` handlers. Safe to land now that failures are visible in the UI; expect dead-letter volume to rise on a broken appliance, which is the point.
6. **19 declared events remain orphaned** — `send()` on them enqueues nothing. `position.created` is emitted once per GPS fix. (Message update/delete are fixed; the rest are mostly `device.*`, `question.*`, `savedSearch.*`.)
7. **"Completed (lifetime)" is really a ~36-hour window** — `deleteAfterHours: 24` on top of a 12-hour archive delay. The label is now just "Completed", but the number still means less than it looks like. `ci.job_metrics` is the honest long-run source.
8. **The `default` queue mixes multi-minute LLM inference with graph writes and new-user seeding** on one 6-slot semaphore at equal priority. (Its ceiling is now settable per queue from the Jobs page — see `docs/operations/job-controls.md` — but that lowers the whole queue, it does not separate the workloads.)
9. **`ci.pipeline_dead_letters` only grows.** The reaper inserts; nothing purges.
10. **`PythonFunctionCrons` and `McpController` import `Cron` from `@nestjs/schedule` directly**, bypassing the role gate and the traceId scope.
11. **20 of 22 work queues declare no per-queue `expireInSeconds`**, inheriting one 12-hour expiry for very different workloads. (Retry policy is now written onto every queue row; expiry still is not.)

### Since closed by the operator controls

Items 4 and 11 above are still open, but the shape of the problem changed: the
per-queue and appliance-wide ceilings are now persisted settings an operator can
change from the Jobs page rather than environment variables read once at boot,
and a queue or schedule can be paused or switched off entirely. See
`docs/operations/job-controls.md` for the model, where it is enforced, and why
the Hub's per-app CPU limit does not substitute for it.

### Closed since the first pass

The ETL self-DoS (duplicate transform execution), the phantom pg-boss scheduler,
the error listener attached after `start()`, NULL retry columns rendering as
`"null"`, `CI_QUEUE_SUPPRESS` being bypassed by explicit-queue sends, the missing
message update/delete search listeners, and the absence of pagination, filtering
and queue metrics over time.

---

## 7. Corrections to earlier claims

Two findings from the review did **not** survive verification and are recorded
here so they are not repeated:

- **"Nothing consumes the dead-letter queue; it grows unbounded."** False.
  `DeadLetterReaperListener` polls it every two minutes and copies each entry
  into `ci.pipeline_dead_letters` — all 1,191 are harvested there. It
  deliberately does not complete or delete, so pg-boss's copy stays inspectable
  for its retention. The rows *do* stay in `pgboss.job` state `created`, which is
  why the Pending fix above is still needed.
- **"~28 `@Cron` methods have no try/catch, so any DB blip exits the process."**
  False for `@nestjs/schedule` v6: `SchedulerRegistry.addCronJob` wraps
  `fireOnTick` in a try/catch that awaits and logs. The real gap was that the log
  line does not say which schedule failed.

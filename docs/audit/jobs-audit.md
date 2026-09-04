# Jobs system audit

**Read baseline:** worktree `clau/jobs-system-refactor-audit` @ `f26f5b68a` ("Search index: stop embedding
planned blocks through the pipeline (#2556)").
**Fix baseline:** `origin/main` @ `7367b26e8` — **12 commits ahead of what was read.** One of those commits
changes a finding's blast radius (see J4). Rebase before touching anything; see `docs/audit/jobs-plan.md`
Phase 0.

**Scope:** pg-boss queues, NestJS `@Cron` schedules, the event bus, job controls and concurrency caps, the
web-vs-worker role split, and the jobs dashboard.

**Method.** Every claim in §3 was read at the cited line and then adversarially re-checked against the code,
the pinned dependency source (pg-boss 10.3.2 and cron 4.3.0 extracted from the Yarn cache), the migrations,
the config files and the existing specs — looking for the guard that would refute it. Eight survived; one
was refuted and is not here. Four had their severity **lowered** during verification, and those corrections
are recorded per finding because they change what is worth doing first. A second tier of 22 lower-severity
findings was **not** verified and is quarantined in §4 — treat those as leads, not facts.

**Nothing here is gated by CI.** Nine of twelve CI-Server workflows are `workflow_dispatch`-only, `main` has
no `required_status_checks` and `required_approving_review_count: 0`. Every acceptance check in the plan has
to be run locally to mean anything.

---

## 1. Subsystem map

### 1.1 Two corrections to the usual mental model

**`backend/apps/api/src/domains/schedule/` is not part of this subsystem.** It is the *personal planning*
schedule domain — `entities/EventCandidateEntity.ts`, `entities/RhythmEntity.ts`,
`services/{CandidateService,SuggestionSyncService,TaskBreakdownService}.ts` — with zero `@Cron`s and zero
queue code. It exports a `ScheduleModule` that `application.ts:71` imports under the same identifier
`application.ts:14` aliases Nest's as (`import { ScheduleModule as NestCronModule } from '@nestjs/schedule'`).
The jobs scheduler lives in `backend/apps/api/src/common/schedule/`.

**"`CI_ROLE` defaults to `all`, so the web/worker split is off in practice" is true only of unit tests and a
bare `yarn dev`.** Every shipped topology splits: `Procfile:1-2` (`api: CI_ROLE=web`, `worker: CI_ROLE=worker`
— what `make dev` runs under overmind), `docker-compose.production.yml:28,96`,
`docker-compose.staging.yml:12,63`. `config.role` is absent from `config/default.json`; the zod default
`'all'` (`configuration.ts:88`) only applies with `CI_ROLE` unset. Split-role behaviour is the production
path, not an exotic one.

### 1.2 Recurrence and queueing are two separate systems

pg-boss's own scheduler is **off** — `schedule: false` at
`backend/apps/api/src/domains/events/services/PGBossEventService.ts:210`. Nothing calls `boss.schedule()`, so
`pgboss.schedule` is permanently empty; the dashboard still surfaces it as `JobDashboardDto.schedules`
(always `[]`) with a `summary.scheduled` counter that is always 0. Every recurring job is a NestJS `@Cron`
wrapped by `backend/apps/api/src/common/schedule/decorators/Cron.ts`.

### 1.3 Declaring a consumer

`@OnEvent(EventName, { queue, autoAcknowledge, queueOptions })` —
`backend/apps/api/src/domains/events/decorators/OnEvent.ts`. `queue` defaults to `DEFAULT_QUEUE` (`'default'`)
at `OnEvent.ts:36`. At class-definition time the decorator calls
`EventListenerRegistry.register(...)` (`domains/events/event-registration.ts:20`), which is the **entire**
source of truth for which queues exist. Two invariants throw at import: one listener per `(event, queue)`
pair, and no conflicting explicit `queueOptions` value on a shared queue (merged into a copy, committed only
if the whole merge passes). It keeps three maps — `listeners` keyed `${eventName}:${queue}`, `queueOptions`
keyed by queue, and the derived `queuesByEvent` routing index. `OnEvent` also applies Nest's
`BaseOnEvent(${event}:${queue})`; dispatch is by the original event name and `EventEmitterModule.forRoot()`
runs without wildcards.

`autoAcknowledge: true` (default) wraps the handler — return → `ack.done()`, throw → `ack.fail(err)`, and
rethrows only when there is no `ack` at all. `autoAcknowledge: false` hands the handler a *tracked* ack and
fails the job as a fallback if the body throws without acknowledging (EventEmitter2's `suppressErrors: true`
would otherwise eat it and leak the slot forever). Only the two `python.function.run` listeners use
`ack.defer()`.

`QueueOptions` (`domains/events/types.ts:23-66`): `policy` (`standard|short|singleton|stately`),
`expireInSeconds`, `retryLimit`, `retryDelay`, `localConcurrency` (ours; can only lower), `role`
(`web|worker`, ours; decides *consumption* only). **There is no retention field** — see J2.

### 1.4 Boot

`PGBossEventService.onModuleInit` (`PGBossEventService.ts:222`), in order: log listeners → attach
`boss.on('error')` **before** `start()` → `boss.start()` → `getRegisteredQueues()` (every listener queue plus
`default`, unconditionally) → `warnOnOrphanEvents()` (every `defineEvent` name resolving to zero queues) →
populate `interactiveQueues` from `queueInventory()` → take session advisory lock **804_551_297** on a
dedicated TypeORM query runner and `createQueue` + `updateQueue` every queue inside it (the lock exists
because web and worker boot together and pg-boss's `create_queue` deadlocks `40P01` between the
`pgboss.queue` insert and the partition DDL) → `syncConcurrencyLimits()` → start one `work()` loop per queue
**this process serves** (`serves(queueRole)`), each `.catch()`-terminated and parked in `stopTasks`.

Queue options written (`PGBossEventService.ts:328-333`):
`{ name, deadLetter: 'dead-letter', retryLimit: 3, retryDelay: 10, retryBackoff: true, ...listenerOptions }`.
The DLQ itself is created first with `retentionMinutes: 43200` (30 days — `retentionDays` is silently dropped
by pg-boss v10, documented in the comment at `:290-295`).

### 1.5 The worker loop

`PGBossEventService.work()` (`:951`). There is **no `boss.work()` subscription anywhere**; each served queue
polls:

```
while (running):
  syncConcurrencyLimits()                       # integer revision compare
  mode = queueMode(queue); if mode != enabled: sleep 5000; continue
  free = perQueueSemaphore.concurrency - (activeCount + pendingCount)
  if free == 0: sleep 150; continue
  reserved = globalSlots.reserve(min(free, fetchBatchSize))
  if reserved == 0: await globalSlots.waitForSlot(150); continue
  jobs = boss.fetch(queue, { includeMetadata: true, batchSize: reserved })   # on throw: release, sleep 5000
  globalSlots.release(reserved - jobs.length)
  if jobs empty: sleep 5000; continue
  for job: void perQueueSemaphore(() => runJob(q, job)).finally(release global slot).catch(log)
```

Three concurrency devices, all in this one file: `globalSemaphore` (a `p-limit`, the appliance in-flight
ceiling, resized live), `perQueueSemaphores` (one `p-limit` per queue), and `globalSlots` — a `JobSlotPool`
(`domains/events/jobSlotPool.ts`) that *claims* the global budget synchronously before the fetch, because all
~32 loops start in one synchronous pass and a mere *read* let every one of them fetch against the same free
slots and take the pg-boss lease on rows the box would not run for minutes. The pool reads its ceiling from
`globalSemaphore.concurrency` so a runtime change moves both.

`runJob` (`:1105`) acquires the global semaphore *inside* the per-queue one; completion bookkeeping sits
deliberately outside the listener's `try` (a failing `boss.complete()` on succeeded work used to call
`boss.fail()`). `failJobQuietly` persists `{message, stack, failedAt}` into `pgboss.job.output`. `executeJob`
(`:1215`) restores request context via `ContextService.run({ traceId: job.id, userId: job.data?.userId })` —
the user id travels in the **payload**, `pgboss.job` has no such column — then emits `${name}:${queue}` if
`eventEmitter.hasListeners(...)`, else `skip()` → completed. **Nothing anywhere puts a clock on that promise**
— see J1.

### 1.6 Producing work

`EventService` (`domains/events/services/EventService.ts`) exposes exactly four methods — `send`, `sendMany`,
`completeJob`, `failJob` — plus protected `getRegisteredQueues()` and `getQueuesForEvent()`. There is no
`emit()`.

`send` has two routing modes. No `queue` option → `EventListenerRegistry.getQueuesFor(name)`, one job per
listening queue; an empty set logs a warning and enqueues nothing. An explicit `queue` → short-circuits
*before* the listener lookup and validates against all existing queues (this is how a backfill re-drives an
event onto one worker, and it means `send` can legitimately enqueue onto a queue with no listener for that
event). Both branches honour `CI_QUEUE_SUPPRESS` and the operator's `disabled` mode. The payload written is
`resolvedData = { ...event, name }` (`:478`) — **the target queue is not stamped**, which is what makes J3
unrecoverable. `sendToQueue` logs an ERROR for a keyless send to an enforcing-policy queue, and logs when
pg-boss resolves `null` (a de-duplicated insert). `sendMany` bulk-inserts via `boss.insert()` in chunks of
**2000** and throws outright if the target queue declares an enforcing policy; conflict loss is undetectable
on the bulk path because pg-boss's bulk plan has no `RETURNING`.

Priority tiers (`domains/events/constants.ts`): `INTERACTIVE_JOB_PRIORITY = 10`, `DEFAULT_JOB_PRIORITY = 0`,
`BACKFILL_JOB_PRIORITY = -10`; `SmartRotationService.workTypePriority()` also emits 5, 2 and −2. pg-boss
fetches `ORDER BY priority DESC, created_on, id`, within one queue only.

`LocalEventService` (`domains/events/services/LocalEventService.ts`) mirrors the routing rule and honours
`startAfter` inline, but **is bound nowhere** — `EventsModule` unconditionally provides
`{ provide: EventService, useClass: PGBossEventService }`. It is instantiated only by
`LocalEventService.startAfter.spec.ts` and `EventRouting.spec.ts`, while ~8 comments under `domains/pipeline/`
still describe it as what "tests, some dev setups" run on.

### 1.7 The `@Cron` wrapper and its two registries

`common/schedule/decorators/Cron.ts` (131 lines) is the single choke point. Per tick, in order:

1. `JobControlStore.cronMode(runName) === 'disabled'` → `recordSkip('cron', runName)` and **return without
   stamping `ci.cron_runs`** (`:81-85`; the rationale is in the comment at `:66-75` and pinned by
   `common/schedule/__tests__/cronDisabled.test.ts`).
2. Mint a `traceId`.
3. `CronRunStore.record(runName)` — the *attempt* stamp, before the body, so a hung or throwing tick still
   counts as fired.
4. Run the body inside `ContextService.run({ traceId })`.
5. `CronRunStore.recordSuccess(runName)` on a clean return.
6. On throw, log `Scheduled job ${runName} failed (traceId=…)` and swallow.

`runName` is the explicit `name:` option, else `Class.method`. Then, **before** the role gate,
`CronRegistry.declare({ name, cron, timeZone, role, servedHere: serves(role) })`; then
`if (!serves(role)) return descriptor;` — the method never reaches Nest's scheduler in the other process.
eslint (`eslint.config.mjs:88-112`) bans importing `Cron` from `@nestjs/schedule` outside
`**/src/common/schedule/**`.

`CronRegistry` is a process-wide singleton filled at class-definition time in **both** processes, so it is
the complete list of what this *build* schedules; it holds nothing live. `CronRunStore` is wired to the
DataSource by `domains/events/services/CronRunTracker.ts`; `record()`/`recordSuccess()` are fire-and-forget
upserts into `ci.cron_runs (name PK, last_run_at, last_success_at)`, and `runsByName()` degrades to a
`last_run_at`-only query on `42703` for DBs missing
`20260821053951_cron_runs_last_success.sql`.

Invariant tests: `common/schedule/__tests__/{cronDisabled,cronRegistry,cronRegistryNames,cronRole,cronRunOutcome,cronSecondOffsets}.test.ts`.

### 1.8 Job controls (`ci.job_settings`)

Migration `backend/apps/api/db/postgres/migrations/20260901194244_job_settings.sql` is the spec — read it.
Table `ci.job_settings(kind, key, mode, concurrency, skipped_count, last_skipped_at, updated_at, updated_by)`,
PK `(kind, key)`, CHECKs on `kind IN ('global','queue','cron')`, `mode IN ('enabled','paused','disabled')`,
`concurrency >= 1`. **NULL means "no opinion"; zero rows is exactly pre-feature behaviour and nothing is
seeded.**

`common/job-controls/JobControlStore.ts` — process-wide singleton, synchronous snapshot refreshed every 5 s,
skip counters flushed every 30 s. A failed refresh keeps the previous snapshot (a DB blip must not un-pause a
paused queue). `revision()` bumps only when `mode`/`concurrency` actually change. `queueMode(queue,
{interactive})` at `:260-268`: the queue's own mode wins; the global pause can only *add* `paused`, and only
for non-interactive queues — see J4.

`domains/events/jobConcurrency.ts` holds the arithmetic shared by the worker and the settings API:
`queueWorkerProcesses()` = 1 under `all` else 2; `perProcessGlobalConcurrency` is one-way (a setting can only
make the box quieter); `effectiveQueueConcurrency` is a **minimum**, so `localConcurrency: 1` in code always
wins. `domains/events/jobControlPolicy.ts` holds `PROTECTED_CRONS` (6 names, each with a prose reason) and
`PROTECTED_QUEUES` (`dead-letter` only, currently unreachable because that queue has no listener and so never
enters `queueInventory()`). `domains/events/queueInventory.ts` folds the listener registry together with the
taxonomy into `{queue, role, localConcurrency, interactive, events[], categories[]}`.

### 1.9 Taxonomy

`domains/events/taxonomy.ts` (906 lines). `JOB_CATEGORIES` = 10 (`search, ingest, enrich, graph, pipeline,
import, llm, personalization, planning, maintenance`) plus the sentinel `UNCLASSIFIED_CATEGORY`, deliberately
not a member so no descriptor can be authored against it. `JOB_TYPES` = 68 literal keys + 45 generated by
`searchIndexTypes(entity, label)` over 15 entities × created/updated/deleted. `JOB_TYPES_BY_QUEUE` = 5
`${event}::${queue}` overrides. `SMART_ROTATION_WORK` = 10 work types with their own label and description.

Four resolvers, and the rule that keeps them consistent: `describeJob(event, workType, queue)` for display
(unknown event → `fingerprintJob()`, which guesses a label in the **prose only** and leaves `category` as
`unclassified`); `categoryOfEvent(event)` for the degraded answer; `categoryOfJob(event, queue)` — **the fold
every aggregate must use**; and `jobCategorySelector(category)`, the SQL-expressible unfold of the same rule.

### 1.10 Read side

`domains/events/controllers/JobsController.ts` (`@Controller('jobs')`, global prefix `api`):

| Route | Guard | Backing |
|---|---|---|
| `GET /api/jobs/dashboard` | `JwtOrApiKeyAuthGuard` only | `JobMonitorService.getDashboard` |
| `POST /api/jobs/crons/run?name=` | + `@RequireCapability(FULL_CAPABILITY)` | `full` because the set includes `AccountPurgeCron` |
| `GET /api/jobs` | guard only | `JobQueryService.list` (`state,queue,category,type,search,limit,offset`) |
| `GET /api/jobs/history` | guard only | `JobQueryService.history(hours, queue)` |
| `GET /api/jobs/history/categories` | guard only | `JobQueryService.categoryHistory(hours)` |
| `GET /api/jobs/controls` | + `READ_CAPABILITY` | `JobControlsService.get` |
| `PUT /api/jobs/controls` | + `WRITE_CAPABILITY` | zod `jobControlsSchema`, PATCH-shaped |
| `GET /api/jobs/types` | guard only | the whole taxonomy |

Dead letters are a **different** controller: `GET/POST /api/pipeline/dead-letters[/replay]` in
`domains/pipeline/controllers/PipelineController.ts:299-359`, over `ci.pipeline_dead_letters`.

`JobMonitorService` (986 lines) answers "how is the appliance doing" from `PgBossJobEntity` /
`PgBossArchiveEntity` / `PgBossScheduleEntity` / `PgBossQueueEntity`. `getSummary()` is two grouped scans and
pulls `deadLettered` out of `pending` because pg-boss inserts a dead-lettered copy in state `created`.
`JobRecordDto` deliberately withholds `data`/`output` verbatim and projects
`{event, workType, payloadBytes, failure{message,stack,failedAt}}`. `getCronSchedules()` (`:452`) merges the
live `SchedulerRegistry` with `CronRegistry.all()` for schedules this process does not register — those get
`running: null` (not `false`, which the badge renders "stopped"), durable `lastRunAt`/`lastSuccessAt` from
`ci.cron_runs`, and a real `overdue` computed from the declared expression.

`JobQueryService` (798 lines) answers "find me these jobs". `list()` pages `created_on DESC, id DESC`, and
returns `queues[]`, `stateCounts` and `categoryCounts` from one grouped scan. `history()` reads
`ci.job_metrics` bucketed by `bucketMinutesFor(windowHours)` — see J8. `categoryHistory()` unions live
`pgboss.job` + `archive` for whatever `liveCoverageFrom()` still covers with sampled
`ci.job_category_metrics` for the rest, and reports `source: 'live'|'metrics'|'mixed'`.

`JobMetricsCollector` (529 lines) is the only durable history: `@Cron('18 */5 * * * *')` and
`@Cron('48 25 4 * * *')`, 30-day retention, four grouped scans per tick, both inserts
`ON CONFLICT DO NOTHING` via `jsonb_to_recordset`. Migrations `20260817030000_add_job_metrics.sql` and
`20260901192406_add_job_category_metrics.sql`.

### 1.11 Dead letters

`domains/pipeline/listeners/DeadLetterReaperListener.ts` — `@Cron('40 */2 * * * *')` **polls** `pgboss.job`
and never subscribes: registering any `@OnEvent` on `dead-letter` would make it a discovered queue, start a
worker, and that worker would `skip()` + `complete()` every dead letter whose event name it is not registered
for. It copies up to 500 rows into `ci.pipeline_dead_letters` keyed on the originating pg-boss job id
(anti-join + `ON CONFLICT (id) DO NOTHING`), never completing or deleting the pg-boss row. Same tick,
separately try/caught, `purgeReplayed()` reclaims replayed rows older than 30 days; **an unreplayed letter has
no TTL at any age.** `domains/pipeline/constants.ts:75` duplicates the string `'dead-letter'` with a comment
admitting the drift risk.

### 1.12 Dashboard

`frontend/apps/web/src/pages/JobsPage/` — 39 files, ~11.5k lines. Routes from `jobsSections.ts`: `/jobs`,
`/jobs/history`, `/jobs/schedules`, `/jobs/dead-letters`, plus `/jobs/category/:category` deep links
generated from `CATEGORIES_IN_SYSTEM_ORDER` (real routes, not query params, so the rail's pathname-only
active check works). `JobsPage.tsx` (748 lines) composes six hooks behind `PullToRefresh` and owns the
Schedules table; `useJobControls` is deliberately **not** polled — it is a form. `ScheduleStatus` precedence:
`disabled` → `overdue` → `servedHere === false` → `!running` → "scheduled". `JobHealthCard.tsx` renders
`jobVerdicts()` above six clickable state tiles and a proportional category bar. A fixture preview app lives
at `frontend/apps/web/src/preview/jobs/` (2.3k lines) and models `role` as a declaration rather than deriving
it from the process.

### 1.13 Counts, recomputed (not copied from a doc)

| Thing | Measured at `f26f5b68a` | `docs/jobs-system.md` claims |
|---|---|---|
| `@OnEvent` decorators | **112** across **57** non-test files | 109 across 56 |
| Distinct event names consumed | **92**, all 92 with a taxonomy entry | 89 |
| `defineEvent` registrations | ~101 (so ~12 orphans warned at every boot) | — |
| pg-boss queues at boot | 39 (38 listener + `dead-letter`) | 39 |
| Queues pinned `role: 'worker'` | 6 (5 import + `derivation-run`) | 6 |
| `@Cron` methods | **54** across **30** non-test files | 53 across 29 |
| Crons pinned `role: 'worker'` | **12** | 11 |

The 12 worker crons: `AgentMemoryRetentionCron.runOnSchedule`, `BlueBubblesSyncCron.runOnSchedule`,
`ConsumptionSweepCron.sweepOnSchedule`, `DerivationCron.deriveNightly`, `EntityTypeAuditCron.auditEntityTypes`,
`ImportRetentionCron.runOnSchedule`, `ImportStageListener.sweepOnSchedule`, `OrphanCleanupCron.sweepOnSchedule`,
`RecallProbeCron.probeRecall`, `RetrievalHealthCron.captureRetrievalHealth`,
`StagedUploadPurgeCron.runOnSchedule`, `ToolInvocationRetentionCron.pruneOnSchedule`.

Shipped ceilings: `config/default.json` → `queues.concurrency: 10`, `fetchBatchSize: 10`,
`perQueueConcurrency: 6`, `replayedDeadLetterRetentionDays: 30`. `configuration.ts:385-387` declares
*different* zod fallbacks (32 / 20 / 6) that apply only if the key is absent from the config files.

Only five queues declare `expireInSeconds`: `llm` 900 s, `agent-memory` 300 s, `ingest-coalesce` 3600 s,
`py-fn-summary` 1800 s, `py-fn-hbpe` 28800 s. The other 33 inherit the constructor's `expireInHours: 12`.

`localConcurrency: 1`: `llm`, `image-description`, `thing-vision`, `browser-activity-insight`, `planning`,
`agent-memory`, `derivation-run`, `import-unpack`, `import-parse`, `import-push` (and `import-media` = 2).

---

## 2. What is wrong, in one paragraph

The jobs system is well-built and unusually well-commented, and its failure modes cluster in one place: **it
trusts promises that nothing bounds, and it drops facts that nothing can reconstruct.** Three of the eight
confirmed findings are a missing bound — no retention on queued work (J2), no deadline on a listener (J1), no
deadline on the shutdown drain (J5). Two are a dropped fact — the originating queue of a dead letter (J3), the
`affected` count of a deferred completion (J6). Two more are an aggregate that folds a dimension it should
have kept (J8) or a value that survives a deliberate refusal to record it (J7). And one is a control whose
scope no longer matches what it says it does (J4). None of them is a bad decision; each is a decision that was
correct when it was made and is no longer enforced by anything.

---

## 3. Confirmed findings

Severity is the **post-verification** severity. Where verification lowered it, the correction is recorded —
it is load-bearing for the plan.

---

### J1 · P1 · No per-job execution timeout: one hung listener permanently leaks a global slot, and ten of them stop every queue until restart

**`backend/apps/api/src/domains/events/services/PGBossEventService.ts:1110`**

**Evidence.** `runJob` does `outcome = await this.executeJob(queueName, job);` (`:1110`) with no deadline, and
`executeJob` (`:1215-1275`) returns a `new Promise` that settles **only** when the listener calls
`done`/`fail`/`defer`/`skip` — there is no timer on it. Grepping the file for `timeout`, `deadline`,
`AbortSignal` or `Date.now()` yields only the 150 ms / 5000 ms backoff sleeps and the 50 ms flush poll.

A listener that never settles therefore holds three things forever:

- the per-queue `p-limit` slot (taken at `:1075`),
- the `globalSemaphore` slot (taken at `:1106`),
- the `globalSlots` reservation — released only in the `.finally()` at `:1076-1078`, which is chained on that
  same promise.

`domains/events/jobSlotPool.ts:38-40` states the consequence and bounds nothing: *"a listener that hangs
forever holds its reservation forever"*. `services/__tests__/PGBossEventService.worker.spec.ts:83-84` adds
that a leaked slot is *"invisible from the outside until enough of them have leaked that the queue quietly
stops fetching at all"*. With the shipped `queues.concurrency: 10` (`config/default.json:148-151`) and the
pool's ceiling being `() => this.globalSemaphore.concurrency` (`jobSlotPool.ts:118`), **ten** hung jobs
anywhere on the box make `available()` 0, `reserve()` return 0 for every one of the ~32 loops, and each parks
in `waitForSlot(150)` and continues forever. The whole jobs system stops with no self-recovery.

pg-boss's own `work()` subscription API does bound this — `manager.js` wraps the callback as
`resolveWithinSeconds(callback(jobs), maxExpiration)` — but this codebase deliberately hand-rolls the loop on
`boss.fetch()` and did not carry that guard across.

Every candidate guard was checked and none exists. `decorators/OnEvent.ts` acks only when the handler promise
settles (the `autoAcknowledge: false` branch acks on a *throw* without ack, not on a hang). The constructor's
`expireInHours: 12` recycles the **database row** and cannot settle an in-process promise —
`failJobsByTimeout` has no access to the semaphore. There is no global `statement_timeout` on the datasource
(only per-call `SET statement_timeout` in `OrphanCleanupService` and `EmbedCoverageTelemetryService`), so a
lock-blocked query inside a listener is genuinely unbounded. `docker-compose.production.yml:85` says the
worker has "No healthcheck on purpose", so nothing restarts it. And the dashboard cannot see it:
`frontend/apps/web/src/pages/JobsPage/jobVerdicts.ts:110` fires `stalled` only when
`pending > 0 && active === 0`, which is false while the leaked jobs still sit `active`.

The repo has been patching this class of bug one listener at a time —
`domains/smart-rotation/listeners/AnswerInferenceListener.ts:45` documents a real observed appliance hang, and
its comment "indefinitely, up to pg-boss's own 900s `expireInSeconds`" is precisely the misconception here,
since expiry never frees the semaphore.

**Fix.** Wrap the `executeJob` call in `runJob` in a deadline —
`Promise.race([this.executeJob(...), rejectAfter(ms)])` — using the queue's declared `expireInSeconds` where
present and a config-backed default (`queues.jobTimeoutSeconds`) otherwise, mirroring pg-boss's own
`resolveWithinSeconds(callback, maxExpiration)`. On timeout, route through `failJobQuietly` so the job gets
pg-boss's retry/dead-letter treatment and all three slots are released. The `deferred` outcome is not at risk
— a deferring listener settles the promise promptly, and the job's liveness is then pg-boss's
`expireInSeconds`, not ours.

**Effort:** half-day. **Blast radius if wrong:** high — see the plan's Risks section; the deadline must be
derived from `expireInSeconds`, or `import-unpack` (a documented 1-hour unpack) and `py-fn-hbpe` (8 h) start
being killed mid-flight.

---

### J2 · P1 · Queued-but-unrun jobs are silently archived after 14 days — a paused or disabled queue loses its backlog with no dead letter and no log

**`backend/apps/api/src/domains/events/services/PGBossEventService.ts:328`**

**Evidence.** No work queue is ever given a retention. `onModuleInit` builds
`const options = { name, deadLetter, ...QUEUE_RETRY_POLICY, ...queueOptions }` (`:328-333`), where
`QUEUE_RETRY_POLICY` (`:85-89`) is `retryLimit`/`retryDelay`/`retryBackoff` only, and `QueueOptions`
(`domains/events/types.ts:23-66`) **has no retention field at all** — so no listener can supply one.
`retentionMinutes` appears only on the dead-letter queue (`:298`, `:305`). The PgBoss constructor
(`:194-211`) sets `expireInHours: 12` / `deleteAfterHours: 24` but no `retention*`, and does not disable
supervision. A repo-wide grep finds no other retention or `keepUntil` setter; the pgboss migration
(`20251001000000_setup_pgboss_schema.sql`) only does `CREATE SCHEMA`; and neither `sendToQueue` (`boss.send`,
`:620`) nor `sendMany` (`boss.insert`, `:763`) attaches a `keepUntil`.

In the lockfile-pinned pg-boss **10.3.2** (extracted from the Yarn cache):

- `attorney.js:238-249` leaves `config.keepUntil = null` and `keepUntilDefault` undefined.
- `plans.js:787` (`insertJob`) and `:875` (`insertJobs`) resolve
  `keep_until = start_after + COALESCE(keep_until, q.retention_minutes, keep_until_default, '14 days')` —
  every term NULL here, so **14 days**.
- `plans.js:928` `archive()` runs `DELETE FROM pgboss.job WHERE … OR (state < 'active' AND keep_until < now())`,
  and `job_state` is an ENUM ordered `created, retry, active, …` (`plans.js:105-116`) — so `state < 'active'`
  is exactly `created` **and** `retry`.
- `attorney.js:160` defaults `supervise = true`; `attorney.js:302-306` sets the maintenance interval to 120 s;
  `boss.js:115-119` runs `expire`/`archive`/`drop`, and `drop` (`plans.js:913-917`) deletes archive rows older
  than `deleteAfterHours: 24`.

So any job that has been **waiting and never leased** for 14 days is moved to `pgboss.archive` unrun, and
deleted 24 h later. Nothing logs it — only `boss.on('error')` is subscribed (`:237`), so the `maintenance`
result is never read. No dead letter is minted, and `DeadLetterReaperListener` never sees it.

This directly contradicts the operator promise the same file makes for the pause control at `:968-979`: *"the
jobs stay `created`, pg-boss holds no lease on them, and they run in order the moment the queue is switched
back on … it costs a backlog, never work."* A queue an operator sets to `paused` or `disabled` from the Jobs
page for two weeks — and `disabled` explicitly stops working the *existing* backlog (`:976-979`) — loses
every job older than 14 days. The same applies to the tail of a multi-million-row `sendMany` backfill.

The repo corroborates the mechanism empirically: `docs/jobs-system-rebuild-plan.md:164-170` records a live
stack with every `pgboss.queue.retention_minutes` NULL and `min(keep_until - created_on)` = 14 days, and
`docs/architecture/adr-pipeline-ledger.md:170-175` already names it *"a TTL on unstarted work"* without
anything acting on it. `docs/jobs-system.md:285-296` §1.7 "Retention — what actually happens to a finished
job" documents only the finished-job path (~12 h to archive, +24 h to delete) and never mentions `keep_until`
on unfinished jobs, so the behaviour is invisible to the operator too.

No recovery exists: there is no sweeper that detects or re-enqueues a silently archived `created` job
(`IngestResetService` / `MaintenanceController` offer only manual backfills), and `PipelineDispatchService`'s
sweep is a self-requeuing chain — losing its queued hop stops the chain with no error.

**Fix.** Add `retentionMinutes` to `QueueOptions` (`domains/events/types.ts`) and pass an explicit, long
default (90 days) in the `options` object at `PGBossEventService.ts:328`, so every `createQueue`/`updateQueue`
writes `pgboss.queue.retention_minutes` instead of inheriting pg-boss's 14-day fallback. Because `createQueue`
is a no-op on an existing queue, the adjacent `updateQueue` call already back-fills live appliances — the
same pattern the DLQ fix at `:302-306` uses. Add a spec asserting the provisioned options carry a retention,
and document the unfinished-job path in `docs/jobs-system.md` §1.7 alongside the finished-job table.

**Effort:** half-day.

---

### J3 · P1 · Dead-letter replay re-emits onto every listening queue, because the reaper never records the originating queue

**`backend/apps/api/src/domains/pipeline/services/PipelineRunService.ts:1185`** (with
`backend/apps/api/src/domains/pipeline/listeners/DeadLetterReaperListener.ts:198`)

**Evidence.** `DeadLetterReaperListener.reap()` inserts `ci.pipeline_dead_letters.queue` from `j.name`
(`:198` column list, `:200` the value) while the same statement pins `WHERE j.name = $1` with
`$1 = DEAD_LETTER_QUEUE` (`:225`, params at `:231`). **Every reaper-harvested row therefore has
`queue = 'dead-letter'`, unconditionally.**

It is unrecoverable, not merely unread. pg-boss's own DLQ plan (`plans.js:678-690`) is
`dlq_jobs as (INSERT INTO job (name, data, output, retry_limit, keep_until) SELECT dead_letter, data, output, …)`
— the DLQ row's `name` *is* the dead-letter queue and no column carries the source. And `send()` writes
`resolvedData = { ...event, name }` (`PGBossEventService.ts:478-481`), so the payload has no `queue` either.

`emitClaimedLetter` then does `const queue = letter.queue === DEAD_LETTER_QUEUE ? null : letter.queue;`
(`PipelineRunService.ts:1185`) and passes `...(queue == null ? {} : { queue })` (`:1196`) into `send()`. With
`queue` omitted, `send()` falls past the explicit-queue branch (`:497-528`) to `:534`
(`const targetQueues = this.getQueuesForEvent(name)`) and the `:548-574` loop enqueues **one job on every
queue that listens for the event** — not the one it died on. `getQueuesForEvent` (`EventService.ts:94`) is a
bare `EventListenerRegistry.getQueuesFor(eventName)`: no role filter, no de-dup, nothing that collapses a
multi-queue set.

Nine events fan out to more than one queue: `file.uploaded` (6 — `file-preview-generation`,
`document-parsing`, `memory-file-entity`, `thing-vision`, `search-index`, `default`), `import.stage` (5),
`python.function.run` (2), and `content.created`, `communication.created`, `browseractivity.created`,
`user.created`, `answer.created`, `graph.node.upserted` (2 each).

The worst case is `python.function.run`. `PythonFunctionDispatchListener.ts:36-52` registers **both**
`py-fn-summary` (`:37`) and `py-fn-hbpe` (`:46`) in the same class, so they always register together — and
each derives its sidecar from the **queue**, not from `payload.target`: `dispatchSummary` (`:42`) always POSTs
to `config.services.summary.host`, `dispatchHbpe` (`:51`) always to the HBPE host. Replaying one
dead-lettered HBPE function therefore also POSTs that HBPE function name to the Summary sidecar, which
rejects it at accept time — `backend/apps/summary/src/ci/summary/runner.py:90-95` raises
`HTTPException(400, "Unknown function …")` — so `dispatch`'s `if (!response.ok) throw` (`:75-79`) reaches
`ack.fail(err)` (`:97`), exhausts `py-fn-summary`'s `retryLimit: 3`, and **manufactures a brand-new permanent
dead letter every single time an operator hits Replay.** It does not converge. The shared
`singletonKey` `dead-letter-replay:<id>` does not save it: pg-boss's `job_i1` is unique on
`(name, singleton_key)`, i.e. per queue, so both queues accept.

For `file.uploaded`, a replay re-runs an Ollama vision pass, a document parse, a preview generation and a
re-embed that all already succeeded.

It is operator-reachable and unguarded: `PipelineController.ts:337` (`POST dead-letters/replay`) and `:362`
(`POST dead-letters/:id/replay`) pass straight through behind only a WRITE capability check, and
`frontend/apps/web/src/pages/JobsPage/DeadLettersCard.tsx:136-145` renders a "Replay selected (n)" button
wired to it. The only spec touching replay routing (`PipelineRunService.spec.ts:1103-1180`) registers a
**single** queue for its event, so it structurally cannot observe the fan-out. The comment at
`PipelineRunService.ts:975-979` asserts this routing is correct — *"which is where the job would have gone had
it been sent fresh"* — which is true only for single-listener events and false for the nine that fan out.
`docs/jobs-system.md:733-737` records the lost queue only as a *counting* trap and never connects it to replay
routing.

The other writer, `PipelineStateService.recordDeadLetter` (`:895-910`), does store a real stage queue — so the
bug is confined to reaper-harvested rows, which is the bulk producer (the docs cite 1,191 DLQ jobs on a live
appliance).

**Fix.** Stamp the target queue into the job payload where `send()` already stamps `name`
(`PGBossEventService.sendToQueue`, ~`:600`), strip it alongside `name` in `executeJob`'s
`const { name, ...data } = job.data` (`:1232`), and have the reaper record
`COALESCE(NULLIF(j.data->>'queue', ''), j.name)` into `ci.pipeline_dead_letters.queue`. `emitClaimedLetter`
then routes to that single queue and the existing explicit-queue branch does the rest. Pre-change rows keep
`queue='dead-letter'` and cannot be recovered, so `emitClaimedLetter` must **refuse** to replay a letter whose
originating queue is unknown *and* whose event has more than one listener queue — throwing the same
`ConflictException` it already raises for an unroutable letter — rather than falling through to listener
fan-out.

**Effort:** half-day for the stamp + reaper + guard; add half a day for the spec that a `file.uploaded` letter
replays to exactly one queue.

---

### J4 · P2 · The global "pause background work" switch exempts the queue that carries the appliance's heaviest background work

**`backend/apps/api/src/domains/events/queueInventory.ts:112`** (with
`backend/apps/api/src/common/job-controls/JobControlStore.ts:260-268`)

**Evidence.** `queueInventory()` computes
`interactive: sorted.some((event) => Boolean(describeJob(event, null, queue).interactive))` (`:112`) — a
queue-level OR over the queue's events — and `JobControlStore.queueMode()` (`:260-268`) never applies the
global pause to a queue flagged interactive.

The `llm` queue is flagged interactive because of `chat.generate` (`taxonomy.ts:326-331`, the only
`interactive: true` entry at the read baseline). But that same queue also carries two **non-interactive**
events: `Events.CHAT_SUMMARIZATION` (`domains/llm/listeners/ChatGenerateListener.ts:24`, `queue: LLM_QUEUE`)
and `Events.INFER_QUESTION_ANSWER` (`domains/smart-rotation/listeners/AnswerInferenceListener.ts:212`,
`queue: LLM_QUEUE`), the latter enqueued by `AnswerInferenceCron` (`@Cron('55 * * * * *')`,
`domains/smart-rotation/cron/AnswerInferenceCron.ts:30-66`).

So flipping "Pause background work" pauses `image-description`, `thing-vision`, `search-index` and the rest,
and leaves the single-slot Ollama generation queue running answer inference and thread summarisation at full
rate — the loudest thing on the box. There is no per-job escape hatch: `PGBossEventService.ts:780-781` and
`:980` are the only pause gates and both are **queue-keyed**; `describeJob` is never imported into
`PGBossEventService` (its only callers are `queueInventory.ts`, `JobQueryService.ts`, `JobControlsService.ts`).
`Cron.ts` gates a tick only on `JobControlStore.cronMode(runName)`, never on the global pause, so the cron
keeps enqueueing while paused. Config makes it live in both profiles: `default.json` has
`scheduled.answer.inferencing: true` / `smart.rotation: false`; under `development.json`
(`smart.rotation: true`) the cron short-circuits but `SmartRotationListener` dispatches the same
`INFER_QUESTION_ANSWER` to `LLM_QUEUE` instead.

Three places assert the opposite: `queueInventory.ts:39-41` (*"Today that is exactly one queue (`llm`, via
`chat.generate`), and the approximation costs nothing"*), `docs/operations/job-controls.md:79-85` (*"Adding an
interactive event to a busy queue **would** quietly exempt…"* — framed as a future risk, already true), and
the UI copy at `frontend/apps/web/src/pages/JobsPage/JobControlsCard.tsx:213` (*"Stops the workers on every
queue except the ones a person is waiting on"*). `PGBossEventService.controls.spec.ts:359` pins the exemption
as correct behaviour using `llm` as the example.

**Verification corrections.**

1. *Volume was overstated.* `QuestionService.findUnansweredByUserId` ends `WHERE rn <= 1`
   (`QuestionService.ts:1076`), so the cron enqueues **one question per user per tick**, not one per
   unanswered question. With ~1,278 eligible seeded questions and `INFERENCE_ATTEMPT_COOLDOWN_HOURS = 6`,
   that is still ~1 GPU generation per minute per user (60 s timeout, `keep_alive '1h'`) for about a day,
   running straight through "Pause background work".
2. *Severity P1 → P2.* `llm` is **not** in `PROTECTED_QUEUES` (`jobControlPolicy.ts:56` lists only
   `dead-letter`) and `queueMode` gives the queue's own mode precedence (`if (own !== 'enabled') return own`),
   so an operator can pause or disable `llm` individually from the same card;
   `AnswerInferenceCron.cronInferAnswers` is likewise not protected and is individually disablable; and
   `localConcurrency: 1` bounds the residual to one generation at a time. A real control-fidelity defect with
   an in-UI workaround, not unstoppable load.

**It is materially worse on `origin/main` than at the read baseline.** `taxonomy.ts` on `7367b26e8` has
**six** `interactive: true` entries (`:330`, `:429`, `:435`, `:441`, `:448`, `:454`) — `chat.generate` plus
`agent.task.dispatch`, `agent.task.checkpoint`, `agent.task.completed`, `agent.task.blocked` and
`planning.task_result`. `domains/agent/listeners/AgentDispatchListener.ts:56-71` registers the last four with
**no queue option**, which `OnEvent.ts:36` defaults to `DEFAULT_QUEUE` (`'default'`). So on `main` the entire
`default` queue — described in `queueInventory.ts:47-52` as sixteen listeners spanning graph writes, new-user
seeding and LLM work — is *also* exempt from the global pause. The scenario `queueInventory.ts:39-41` and
`docs/operations/job-controls.md:79-85` frame as a future risk has now occurred twice.

**Fix.** Split `chat.generate` onto its own queue (`llm-chat`, `policy: 'short'`, `localConcurrency: 1`) so
`llm` carries only `chat.summarization` + `infer.question.answer` and becomes pausable; update
`ChatTurnService.execute`'s send target and the `SmartRotationListener` / `AnswerInferenceCron` cooldown query
that reads back `queue = LLM_QUEUE` (`SmartRotationListener.ts:403`). Worst case two generations overlap when
both queues are busy; if a single GPU slot must hold, instead make the pause **job-level** by checking
`describeJob(job.data.name, …).interactive` before dispatch on an interactive queue. Independently, give the
four `agent.task.*` / `planning.task_result` listeners their own queue so `default` stops being interactive.
Then correct `queueInventory.ts:39-41`, `docs/operations/job-controls.md:79-85`, and the UI string.

**Effort:** half-day for the `llm-chat` split; +1 h for the `default`-queue half on `main`.

---

### J5 · P2 · Shutdown never releases pg-boss leases: `flush()` waits without a deadline and `failWip` is a no-op here, so a killed process strands jobs `active` for up to 12 hours

**`backend/apps/api/src/domains/events/services/PGBossEventService.ts:1181`**

**Evidence.** `flush()` (`:1169-1184`) ends with
`while (this.totalInFlightJobs() > 0) { await new Promise((resolve) => setTimeout(resolve, 50)); }` — no
deadline, no abort, and no clock read anywhere in the file. `onModuleDestroy` (`:408-428`) awaits it **before**
`boss.stop()`, and `app.enableShutdownHooks()` is called (`main.ts:28`, `:67`), so this path really runs on
SIGTERM. Import stage jobs run inline (`ImportStageListener.handleUnpackStage` → `runStage` →
`await runner.run(...)`, `:141-265`) and are documented at `:122-124` as *"a 350GB unpack holding its slot for
an hour"*, so `flush()` waits that out; a hung job (J1) makes it block forever.

`failWip` is a no-op for this app. The loop polls
`this.boss.fetch(queueName, { includeMetadata: true, batchSize: reserved })` (`:1021`), and
`grep -rn "boss\.work(" backend/apps/api/src` returns nothing. In pg-boss 10.3.2, `manager.js:114-121`
`failWip()` iterates `this.workers`, and `addWorker` is called from exactly one place — `manager.js:231`,
inside `watch()`, reached only via `work()`. `index.js:147-210` `stop()` calls `manager.failWip()` over that
empty map, so **no fetched row is failed**.

The 12-hour lease is real and measured. `plans.js:780-784` resolves `expire_in` as job option →
`q.expire_seconds` → `expire_in_default` → 15 min, and only five queues pass `expireInSeconds` through
`createQueue`/`updateQueue` (`:335-336`). `docs/jobs-system-rebuild-plan.md:165` records a live
`select min(expire_in) … from pgboss.job` returning `12:00:00`. Recovery is only `plans.js:551-552`
`failJobsByTimeout` (`state = 'active' AND (started_on + expire_in) < now()`).

No compose file sets `stop_grace_period` (only `restart: unless-stopped`), so Docker's 10 s default applies
and SIGKILL follows. Nothing else releases the leases: the only app SQL against `pgboss.job` state `active` is
`IngestResetService.ts:154` (a manual maintenance DELETE for the search-index queue) and read-only counts in
`JobMetricsCollector.ts:249,428` — which is exactly why the dashboard shows phantom "Running". The existing
shutdown test (`__tests__/PGBossEventService.worker.spec.ts:877-908`) asserts the drain ordering and its own
comment concedes the consequence — *"closing the pg-boss connection first would strand jobs as `active` until
they expired and were retried"* — but no test bounds the drain, and no `queues.*` config key exists for one
(`config/default.json:148-153` has only `concurrency`, `fetchBatchSize`, `perQueueConcurrency`,
`replayedDeadLetterRetentionDays`).

Operator-visible effect: after a hard restart the Jobs console shows phantom "Running" jobs for half a day,
and that work does not resume for half a day.

**Fix.** Give `flush()` a deadline (`queues.shutdownDrainSeconds`, default 20-30 s) and, for whatever is still
in flight when it expires, call `boss.fail(queue, id, { message: 'process shut down while active' })` for the
fetched-but-unfinished job ids — the same thing pg-boss's `failWip` does for its own workers — so the rows go
straight to retry instead of waiting out a 12 h lease. Track fetched job ids per queue for that purpose (the
same bookkeeping J1's deadline wants), and set a `stop_grace_period` on the api and worker services that
exceeds the configured drain.

**Effort:** half-day.

---

### J6 · P2 · Deferred-job completion is never verified: `complete()` affecting zero rows is logged and reported to the sidecar as success

**`backend/apps/api/src/domains/events/services/PGBossEventService.ts:1203`**

**Evidence.** `completeJob` is `await this.boss.complete(queue, jobId, output);` followed unconditionally by
`this.logger.log('Completed deferred job', { queue, jobId })` (`:1202-1205`); `failJob` (`:1211-1214`) is the
same shape. Both discard pg-boss's return value.

In pg-boss 10.3.2, `manager.js:481` `complete()` returns `mapCommandResponse(ids, result)` =
`{ jobs, requested, affected }` and does **not** throw on zero rows, and `plans.js:528` `completeJobs` is
`UPDATE … WHERE name = $1 AND id IN (SELECT UNNEST($2::uuid[])) AND state = 'active' … SELECT COUNT(*)`. So a
completion for a job that is no longer `active` matches nothing and is a silent no-op returning `affected: 0`.

The path is live. `PythonFunctionDispatchListener.ts:88` calls `ack.defer()`; `runJob` returns early on
outcome `'deferred'` with the comment *"Deferred jobs stay `active` in pg-boss"*.
`PythonFunctionCallbackController.ts:29-45` is `@HttpCode(204)` with only two guards (`job_id` present, queue
in the allowlist), then calls straight into `completeJob`/`failJob` and returns — nothing inspects the
outcome. So a callback with a typo'd or unknown `job_id` logs "Completed deferred job" and returns 204.

The expiry mechanism that makes it bite is enabled: `attorney.js:160` defaults `supervise = true`,
`PGBossEventService.ts:194-211` sets only `schedule: false`, and `boss.start()` (`:244`) →
`boss.js:115 maintain()` → `expire()` → `failJobsByTimeout`. `plans.js:557` `failJobs` DELETEs then re-INSERTs
**preserving `id`**, so a re-dispatched attempt carries the same job id — meaning a stale callback can
silently complete a live second attempt and discard its real outcome.
`domains/python-functions/types.ts:50-54` names exactly this as the recovery contract, and
`PythonFunctionCallbackBody` (`types.ts:137-143`) is `{job_id, queue, status, result?, error?}` with **no
attempt or run token** to tell the two apart.

Nothing guards it elsewhere: `PGBossEventService.deferred.test.ts:59` only asserts delegation to pg-boss, and
`PythonFunctionCallbackController.test.ts:12-13` mocks both methods as resolving `undefined`. The sidecar
cannot detect rejection either — `backend/apps/summary/src/ci/summary/runner.py:190-200` logs
`function_run_callback_delivered` and stops retrying on any `status_code < 300`.

**Verification correction (was P1).** The unconditional success log and the 204 are real and always present —
a genuine observability hole — but the escalated failure mode is bounded. The Python function writes its
results to Postgres **before** posting the callback, so no real work is lost when a completion is dropped;
only the job row's terminal state and output. Mis-completing a re-dispatched attempt additionally requires
expiry to fire mid-run, and `types.ts:60-95` documents that the windows were deliberately re-sized for exactly
that reason (`py-fn-hbpe` `expireInSeconds` = 8 h against a measured 3.6 h worst case), and that the nightly
cron plus the 03:00 `ensure_bootstrap` sweep re-enqueue daily so *"recovery does not depend on it"*. Damage is
corrupted job history and metrics plus silent loss of outcome reporting — not user-visible data loss.

**Fix.** Have `completeJob`/`failJob` read `affected` from pg-boss's response and, when it is 0, log an error
naming the queue and job id and return that fact to the caller; make `PythonFunctionCallbackController` answer
409 (or 404) so the sidecar's own logs record that its result was not accepted. Additionally, carry a
per-attempt token (`retry_count`, or a dispatch nonce stamped into the job payload and echoed by the runner)
in `PythonFunctionCallbackBody` and reject a callback whose token does not match the current attempt.

**Effort:** 1 h for the `affected` check and the 409; half-day with the attempt token (it touches the Python
runner).

---

### J7 · P2 · A disabled schedule's "Last run" keeps advancing, and can raise a false critical "run and never succeeded" alarm

**`backend/apps/api/src/domains/events/services/JobMonitorService.ts:483`**

**Evidence.** `common/schedule/decorators/Cron.ts:81-85` returns **before** `CronRunStore.record(runName)`
when `JobControlStore.cronMode(runName) === 'disabled'`, and its comment (`:66-75`) states the reason:
*"recording a fire for it would leave the Jobs page showing a healthy 'last run' two minutes old for a job the
appliance is deliberately not doing."* `common/schedule/__tests__/cronDisabled.test.ts:12-17` pins the same
invariant.

But nothing stops the underlying `CronJob`. The only `getCronJob(s)` call sites are
`JobControlsService.ts:426` and `JobMonitorService.ts:368,459`, and none calls `.stop()`; the only
`.stop()`/`.start()` in the jobs code are `JobControlStore.stop()` and `boss.start`/`stop`. The wrapper's own
doc calls itself *"the ONE place a recurring job can be turned off"* — so a disabled cron keeps ticking. In
`cron` 4.3.0 (pinned at `backend/apps/api/package.json:65`), `dist/job.js:180-185` does
`this.lastExecution = new Date(); … void this.fireOnTick();` (and again at `:199-201`), with
`lastDate() { return this.lastExecution; }` at `:210-211`. **So `lastDate()` advances on every tick of a
disabled cron.**

`getCronSchedules()` then reads it: `memoryLastRunAt = job.lastDate()?.toISOString()` (`:473`), folded in at
`:478-483` with `Math.max(...times)`, and emitted as `lastRunAt` at `:493` — while
`const disabled = JobControlStore.cronMode(name) === 'disabled'` is computed at `:485`, **one line after the
merge**, and used only for `overdue` (`:495`). The class doc at `:415-419` says the memory value is a fallback
*"for the rare tick that has not flushed yet"* — not for a tick the wrapper deliberately refused to stamp.

The frontend prints that value unconditionally in the Last run cell
(`frontend/apps/web/src/pages/JobsPage/JobsPage.tsx:660`), and
`frontend/apps/web/src/pages/JobsPage/jobVerdicts.ts:178-192` raises a **critical** verdict for every cron
where `lastRunAt != null && lastSuccessAt == null`; grep for `disabled` in `jobVerdicts.ts` returns nothing,
and `JobHealthCard.tsx:83` passes the raw unfiltered dashboard crons.

No guard or test prevents it: `JobMonitorService.spec.ts:691`'s disabled case goes through the `cronRow()`
helper which hardcodes `lastDate: () => null` (`:630`) plus a durable row, so it cannot observe this.

**Verification correction (was P1).** The advancing "Last run" for a disabled schedule is unconditional and
contradicts the documented invariant, but the false **critical** additionally requires that no `ci.cron_runs`
row exists at all — a schedule disabled before it ever ticked. Where a durable row exists, the verdict already
fires from the durable value, which is a separate `jobVerdicts` gap. Impact is a misleading admin dashboard;
no data loss, no functional or security effect.

**Fix.** Move the `const disabled = …` computation above the `times` array (`:478-485`) and exclude
`memoryLastRunAt` from it when `disabled` is true, so a disabled schedule's `lastRunAt` comes only from the
durable `ci.cron_runs` row the wrapper deliberately did not stamp. Add a `JobMonitorService` spec asserting
that a disabled, registered cron with an in-memory `lastDate()` and no `ci.cron_runs` row reports
`lastRunAt: null`.

**Effort:** 1 h.

---

### J8 · P2 · The Backlog chart averages queue-depth gauges across queues, so it plots roughly 1/39th of the number the Health tiles show

**`backend/apps/api/src/domains/events/services/JobQueryService.ts:249`**

**Evidence.** `ci.job_metrics` is one row **per queue per sample** —
`PRIMARY KEY (sampled_at, queue)` (`backend/apps/api/db/postgres/migrations/20260817030000_add_job_metrics.sql:46`),
written from `JobMetricsCollector.readGauges()`, which is `SELECT name AS queue, … FROM pgboss.job GROUP BY name`.

`history()` selects `ROUND(AVG(metric.pending))::int`, `AVG(metric.active)`, `AVG(metric.retry)`,
`AVG(metric.dead_lettered)` (`:249-252`) but the **only** grouping in the method is `.groupBy('1')` (`:260`,
positional on the bucket expression; there is no `addGroupBy` anywhere in the body). So the AVG divides by
`N_queues × N_samples` where the intended semantics divide by `N_samples` — an exact `1/N_queues`
understatement. The code contradicts its own comment immediately above (`:245-248`): *"summing across queues
inside a bucket is right (total work outstanding), but summing across TIME is not"* — the comment only
justifies collapsing the **time** dimension.

The divisor is not even constant: `readGauges` emits a row only for queues that currently have rows in
`pgboss.job`, so an idle queue appearing or draining rescales the whole series.

The on-screen contradiction is real. `frontend/apps/web/src/pages/JobsPage/JobHistoryCharts.tsx:439` plots
`backlog = point.pending + point.active + point.retry` under the hint *"Jobs waiting, running or retrying"*
(`:86`), while `JobHealthCard.tsx:46-48` renders the same three tiles from the appliance-wide
`dashboard.summary`, whose `JobMonitorService` query groups by state only, across all queues. The unscoped
case is the default view: `DEFAULT_JOB_FILTERS.queue` is `''` (`useJobsList.ts:62`), `historyUrl` omits the
queue param when empty (`useJobHistory.ts:48-56`), and default `windowHours: 24` →
`bucketMinutesFor` returns 30-minute buckets against `SAMPLE_INTERVAL_MINUTES = 5`, so time contributes 6 and
queues contribute the rest.

No test catches it: the only history test (`JobQueryService.spec.ts:625`) is explicitly queue-scoped, passes
`{ windowHours: 1, queue }`, filters its other-queue row out, and its one arithmetic assertion is on
`completed` — which is correctly a `SUM` and so passes identically under AVG or SUM.

**Verification correction (was P1).** A genuine correctness defect that makes the Backlog chart understate
outstanding work by roughly 20-40× and contradicts the Health tiles beside it — but the blast radius is an
internal operator dashboard. No data corruption, no job loss, no security impact, and the fix is confined to
one query.

**Fix.** Aggregate per queue first, then sum: wrap the gauge columns in a subquery grouped by
`(bucket, queue)` taking AVG (or the last sample per queue via `DISTINCT ON`), and `SUM` those per-queue
values in the outer `GROUP BY bucket`. Leave `completed`/`failed` as `SUM` (they are deltas) and
`p95_duration_ms` as `MAX`. Add a test with two queues in one bucket asserting the returned `pending` is their
sum, not their mean.

**Effort:** half-day.

---

## 4. Unverified findings — leads, not facts

**These 22 were reported but NOT adversarially verified.** Do not act on any of them without first
re-reading the cited code **against `origin/main`**, not against this audit's read baseline. Precedent: a
prior QA sweep in this repo re-reported 62% already-fixed bugs because it triaged from a stale branch.
Severities are as-reported and are likely overstated by one level — every finding that *was* verified in §3
kept or lost severity; none gained it.

Four of these overlap each other or §3 and should be de-duplicated on triage: **U2 is the same defect as J3**
(different file anchor); U12 duplicates U7; U20 duplicates U5; U21 duplicates U18.

### Unverified P1

| # | Claim | Anchor | Proposed fix |
|---|---|---|---|
| U1 | `GET /api/jobs` and `GET /api/jobs/dashboard` return every user's job failure messages and stack traces, while the same file scopes *searching* that exact string to its owner | `domains/events/services/JobQueryService.ts` | Scope the failure projection to the owner in both services: return `failure: null` unless `job.data->>'userId'` equals the request context's `userId` (pass the context into `toListItem`/`toJobRecord`, or add the predicate in SQL). Keep `state`, `retryCount`, `payloadBytes` unscoped so the operator view still works. Alternatively gate the full failure text behind `FULL_CAPABILITY` and return a redacted marker otherwise. |
| U2 | Dead-letter replay re-emits to every listening queue because the reaper records `queue='dead-letter'` for every harvested letter | `domains/pipeline/listeners/DeadLetterReaperListener.ts` | **Same defect as J3** — fold into that work item, do not schedule separately. |
| U3 | The web/worker split moves only 6 of 38 queues and 12 of 54 schedules, because `role` defaults to `'web'` at every declaration site | `domains/events/types.ts` | Invert the default: make `role` required at the `@OnEvent`/`@Cron` declaration (or default it to `'worker'`), and have the queues that must answer a live request — `llm`, `ingest-coalesce`, `context-prompt-persist` — declare `role: 'web'` explicitly. Land it queue-by-queue starting with the GPU/parse queues (`image-description`, `thing-vision`, `document-parsing`, `pipeline-embed`, `etl`), and add a test asserting each queue's declared role against an explicit expected map so a new queue cannot silently land on the web process. |

### Unverified P2

| # | Claim | Anchor | Proposed fix |
|---|---|---|---|
| U4 | `docs/jobs-system.md` lists `task.created`/`updated`/`deleted` as consumed by nobody; all three have live search-index listeners | `docs/jobs-system.md` | Remove the three from the orphan list at `:688-692` (the surrounding count drops 16 → 13) and add them to the event→queue table alongside the other `search-index` entries. |
| U5 | The cron second-offset invariant guards 11 of 54 schedules and reserves a second for a deleted cron, so 15 live crons sit unguarded on second 0 | `common/schedule/__tests__/cronSecondOffsets.test.ts` | Replace the hand-written `SUBJECTS` array with an enumeration of `CronRegistry.all()` and assert six fields plus a unique second-of-minute for every schedule whose cadence is under an hour; delete the stale `'10': 'PipelineControlService.tickOnSchedule'` entry; rewrite the five `PlanningJobsCron` expressions and the ten `SMART_ROTATION_CRONS` as six-field with distinct seconds. |
| U6 | `file.uploaded` is handled twice by the same class on every new upload — the `default` drain sits on the live fan-out path, not behind it | `domains/memory/services/FileService.ts` | Delete the `@OnEvent(FileUploadedEvent, { queue: LEGACY_FILE_ENTITY_QUEUE })` handler at `:81-84` and drain residual rows once with a one-off `send(..., { queue: MEMORY_FILE_ENTITY_QUEUE })` re-drive (or let them skip+complete — `findOrCreateForFile` is idempotent). If the drain must stay, gate it behind a config flag with an expiry date rather than a comment. |
| U7 | The appliance concurrency cap is split 50/50 between two processes whose queue loads are structurally asymmetric, so roughly half an operator's budget is unusable | `domains/events/jobConcurrency.ts` | Either weight the division by what each process actually serves (sum of served queues' effective ceilings) instead of a flat `/2`, or make the control explicitly per-process: relabel to "Jobs at once, per worker process", set `value`/`default`/`max`/`effective` from `perProcessGlobalConcurrency` without the multiply-back-out at `JobControlsService.ts:537`, and keep `topology.queueWorkerProcesses` as the explainer. Update `jobConcurrency.test.ts`'s split-topology cases and `JobControlsCard.tsx:233-235`. |
| U8 | The global job-slot budget has no reservation or priority for interactive work, so a chat turn queues behind background jobs for a slot | `domains/events/jobSlotPool.ts` | Give the pool a priority axis: pass an `interactive` flag into `reserve()`, hold back `Math.min(1, limit)` slots only interactive queues may claim (`PGBossEventService.interactiveQueues` is already populated at `:266-270`), and wake interactive waiters first in `release()` via two waiter sets. Add a `jobSlotPool.test.ts` case pinning that a saturated pool still admits an interactive reservation. |
| U9 | Jobs console shows no failure reason for lease-expired jobs — exactly the failures a crashed or hung worker produces | `domains/events/services/JobMonitorService.ts` | In both `toFailure` implementations, fall back to `output.value.message` (and other nested `value` payloads) before giving up; when still empty but the row is failed/dead-lettered, project a message from the raw output the way the reaper does. Factor the two copies into one shared helper and add a spec fixture using pg-boss's `{ value: { message: 'job failed by timeout in active state' } }`. |
| U10 | The Health card mixes appliance-wide state counts with filter-scoped category counts, and its own comment now asserts the opposite | `frontend/apps/web/src/pages/JobsPage/JobsPage.tsx` | Give the card one population: either add appliance-wide `categoryCounts` to `GET /api/jobs/dashboard` (folded out of the grouped scan `getSummary` already runs) and feed the card from `dashboard.data` alone, or fetch unfiltered facet counts separately. Then rewrite the comment at `JobHealthCard.tsx:87-94`. |
| U11 | A `ci.cron_runs` schema predating `last_success_at` degrades into a false CRITICAL alarm for every schedule on the box | `common/schedule/CronRunStore.ts` | Thread the unknown-ness through instead of collapsing it to null: have `runsByName()` return `{ runs, successTracked: false }` on the 42703 fallback, carry it onto `CronScheduleDto`, and have `jobVerdicts` skip the `never-succeeded` verdict when success tracking is unavailable — surfacing a one-line "migration missing" notice instead. |
| U12 | The operator's appliance-wide cap is split evenly between processes serving 32 and 6 queues | `domains/events/jobConcurrency.ts` | **Duplicate of U7.** |
| U13 | Schedule categories are computed twice — a stale frontend prefix table and the backend taxonomy — and the table has drifted | `frontend/apps/web/src/pages/JobsPage/cronDescriptor.ts` | Make the registry the source: add an optional `category` to `CiCronOptions`, record it in `CronRegistry.declare` (`Cron.ts:116-123`), return it from `JobMonitorService.getCronSchedules` and `JobControlsService.cronDeclarations`, and have `describeCron` read it. Delete `CLASS_CATEGORY`. Add a backend test (in the style of `jobControlPolicy.test.ts`) asserting every declaration carries a category in `JOB_CATEGORIES`. |
| U14 | Boot warns about events with no queue but never about queues with no listener, so a renamed queue strands its jobs invisibly | `domains/events/services/PGBossEventService.ts` | After provisioning, query `pgboss.queue` (or `boss.getQueues()`) and log a warning listing any queue name not in `getRegisteredQueues()`, with its pending count. Surface those rows read-only in the controls DTO with a `noConsumer` flag so the dashboard can say why they are stalled. |
| U15 | `policy: 'short'` de-duplicates queue-wide on the key alone, and the `etl` queue's two events share one raw-UUID key namespace | `domains/etl/listeners/SyncOrchestrator.ts` | Prefix both keys with their event (`etl-execute:${jobId}` / `etl-transform:${id}`), then encode the convention: in `EventListenerRegistry.register`, or in a test over `queueInventory()`, require each sender on an enforcing-policy queue to prefix its `singletonKey` with the event name, checked in `sendToQueue`. |

### Unverified P3

| # | Claim | Anchor | Proposed fix |
|---|---|---|---|
| U16 | `GraphNodeSearchIndexListener` registers a consumer whose allowlist is empty, doubling `graph.node.upserted` fan-out for a handler that always returns early | `domains/search-ingress/listeners/GraphNodeSearchIndexListener.ts` | Comment out the `@OnEvent` at `:77` (keeping the class and its rationale) so the binding returns in the same change that adds the first `RESOLVABLE_FROM_ENTITIES_ALONE` entry; or move the allowlist check into `GraphEventService.emitSearchIndexEvent` so the send is skipped rather than the job discarded. |
| U17 | `JobControlsService.update()` applies a multi-row patch without a transaction, so a mid-loop failure leaves the appliance half-configured and reports it as settled | `domains/events/services/JobControlsService.ts` | Wrap the loop in `this.repository.manager.transaction(...)`, keeping the refresh and snapshot outside it, so the patch is all-or-nothing at the database as well as at validation. |
| U18 | `docs/jobs-system.md` and nine in-code comments state schedule/listener counts that no longer match the build | `docs/jobs-system.md` | Update the four doc files and nine comments, then stop the drift: `common/schedule/__tests__/cronRegistryNames.test.ts` already walks every source file and reads registered `@Cron` metadata — add total-schedule and worker-role assertions against committed numbers. §1.13 of this audit has the current figures. |
| U19 | The Schedules table's Category column has drifted: one rule points at a deleted class, and 12 of 39 cron classes fall through to "Maintenance" | `frontend/apps/web/src/pages/JobsPage/cronDescriptor.ts` | Delete the dead `/^EntityPromotion/` rule, add rules for the 12 fall-through classes, and add a `cronDescriptor.test.ts` case walking the cron names the controls payload declares and asserting none reaches the `?? 'maintenance'` fallback implicitly — i.e. make the fallback opt-in per class. Superseded by U13 if that lands. |
| U20 | The cron second-offset test reserves a second for a schedule that no longer exists and only checks a hand-picked subject list | `common/schedule/__tests__/cronSecondOffsets.test.ts` | **Duplicate of U5.** |
| U21 | Hardcoded schedule/listener counts in the `@Cron` wrapper, `queueInventory`, and the reference doc are all wrong, including two that contradict each other in one file | `common/schedule/decorators/Cron.ts` | **Duplicate of U18.** Delete the numbers from code comments entirely and replace the doc's "At a glance" table with a jest snapshot over `CronRegistry.all()` and `EventListenerRegistry.getListeners()`. |
| U22 | `LocalEventService` is maintained in lockstep with the pg-boss implementation but is bound by nothing, while production comments describe deployments that run on it | `domains/events/services/LocalEventService.ts` | Decide and record it: either bind it behind an explicit config flag and test that path, or delete the class and rewrite the three specs against `PGBossEventService` with a stub boss. Either way correct the four comments to say the guard exists for a process that starts before pg-boss provisions its tables, not for a deployment that runs `LocalEventService`. |

---

## 5. Stalled-branch salvage

**Verdict: all ten branches are already landed. Nothing to cherry-pick; delete all ten and close draft PR
#2551.** Each was checked with `git diff <branch> origin/main -- <every file the branch touches>`, which is
empty in every case. This repo squash-merges, so `git branch -r --merged` reports zero — the emptiness of the
file-scoped diff is the real signal.

| Branch | Behind main | What it was | Verdict |
|---|---|---|---|
| `fix/jobs-cron-role` | 6 | Declared-role + `timeZone` on `CronDeclaration`; `overdue` for schedules this process never registered. +276/−34, 10 files | **Landed** as `8f4d8fda2` (#2554). Delete. |
| `clau/jobs-controls` | 40 | The whole job-controls feature: `ci.job_settings`, `JobControlStore`, `jobConcurrency`, `jobControlPolicy`, `queueInventory`, `JobControlsService`, the controls routes, `JobControlsCard`, `docs/operations/job-controls.md`. +5050/−14, 32 files | **Landed** (#2519). Main has since evolved it (only-go-down clamp, complete cron list, switches moved into the Schedules table). Delete. |
| `clau/jobs-console-redesign` | 23 | Verdict band (`jobVerdicts.ts`, `JobHealthCard.tsx`), query-string-as-source-of-truth (`useJobFilters.ts`), `errorStatus` in `useJobControls`, preview app. +1304/−109, 13 files | **Landed.** Delete. |
| `review/jobs-console` | 17 | Verdict/category-bar corrections; `SMART_ROTATION_WORK` label+description moved into the backend taxonomy, deleting the frontend's `smartRotationLabels.ts`. +350/−191, 8 files | **Landed** — main carries `SMART_ROTATION_WORK_LABELS` and the frontend file is gone. Delete. |
| `clau/jobs-doc-recount` | — | Docs-only: four at-a-glance numbers in `docs/jobs-system.md`. +5/−4 | **Landed verbatim** at `docs/jobs-system.md:6-22`. Note the *content* is stale again — see §1.13 and U18. Delete. |
| `clau/jobs-schedules-worker-visibility` | 17 | One-way concurrency clamps, `max` as the shipped figure, `CronRegistry` in the controls payload, `getCronSchedules()` appending unregistered declarations, `fireCronJobs` erroring instead of returning empty. +1300/−43, 24 files | **Landed** (#2546/#2548). Delete. |
| `clau/jobs-worker-schedule-history` | 9 | The narrower cut of the same idea: durable history with `running: null` so the badge says "elsewhere". +561/−43, 9 files | **Landed / superseded** by #2548 + #2554. Delete. |
| `clau/agitated-herschel-4a432b` | 17 | Byte-identical duplicate of `clau/jobs-schedules-worker-visibility`. Backs **draft PR #2551** | **Landed.** Close PR #2551 rather than rebasing it; delete the branch. |
| `clau/goofy-albattani-fc24d8` | 17 | `JwtOrApiKeyAuthGuard` + `FULL_CAPABILITY` on `POST /jobs/crons/run`, replacing the `request.socket.remoteAddress` loopback check; adds `JobsController.spec.ts`. +224/−27, 5 files | **Landed** — main has the guard, the capability and the full comment. Delete. |
| `clau/adoring-varahamihira-ac496c` | 17 | `domains/events/jobSlotPool.ts` and the reserve-before-fetch rewiring of `work()`, +210-line unit suite. +578/−30, 5 files | **Landed.** Delete. |

Confirm before deleting (multiple agents work these repos in parallel):

```
for b in fix/jobs-cron-role clau/jobs-controls clau/jobs-console-redesign review/jobs-console \
         clau/jobs-doc-recount clau/jobs-schedules-worker-visibility clau/jobs-worker-schedule-history \
         clau/agitated-herschel-4a432b clau/goofy-albattani-fc24d8 clau/adoring-varahamihira-ac496c; do
  echo "== $b"; git diff --stat "origin/$b" origin/main -- \
    $(git diff --name-only origin/main..."origin/$b")
done
```

An empty diff for a branch means main already carries its content.

---

## 6. Where to start

`docs/audit/jobs-plan.md`. Phase 1 is J2 + J1 — the two missing bounds whose absence loses work — and both
live in `PGBossEventService.ts` and `types.ts`, so they can start immediately after the Phase 0 rebase.

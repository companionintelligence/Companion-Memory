# The jobs system — reference

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

What every background job on this appliance is, what it does, and how the machine
that runs it works. Read against the worktree at the time of writing; every claim
carries a `path:line`. **Counts re-verified against `main` after #2514, #2519,
#2522, #2523, #2524 and #2525 landed.** Companion documents: [`jobs-schedule-review.md`](jobs-schedule-review.md)
(a point-in-time critique of the schedule), [`jobs-system-rebuild-plan.md`](jobs-system-rebuild-plan.md)
(the pipeline design), [`runbooks/jobs-system-review-2026-08.md`](runbooks/jobs-system-review-2026-08.md).

## At a glance

| | |
|---|---|
| Queue engine | pg-boss 10, schema `pgboss`, **its own cron scheduler disabled** (`schedule: false`) |
| Listener bindings | **109** `@OnEvent` methods across 56 files |
| Distinct event names consumed | **89** |
| pg-boss queues created at boot | **39** (38 from listeners + `dead-letter`) |
| Scheduled methods | **53** `@Cron` methods across 29 files — all via the `@ci/common/schedule` wrapper |
| Crons pinned to the worker role | **11** |
| Queues pinned to the worker role | **6** (5 import + `derivation-run`) |
| Pipeline stages behind one `pipeline.slice` event | **43** |
| Global in-flight ceiling | 10 jobs **per process**; 6 per queue |

Recurrence and queueing are two separate systems here. **Nothing** calls
`boss.schedule()` — every recurring job is a NestJS `@Cron`, and `pgboss.schedule`
is permanently empty. A cron's job is usually to *enqueue* pg-boss work, not to do it.

---

## 1. The machine

### 1.1 Declaring a job

A job is a method decorated with `@OnEvent` from `@ci/domains/events`:

```ts
@OnEvent(FileUploadedEvent, {
  queue: 'document-parsing',
  autoAcknowledge: true,                      // default
  queueOptions: { policy: 'short', localConcurrency: 1, role: 'worker' },
})
async parseDocument(payload: FileUploadedPayload) { … }
```

The decorator has a **side effect at module-import time**: it calls
`EventListenerRegistry.register(event, class, method, queue, queueOptions)`
([`event-registration.ts:22`](../backend/apps/api/src/domains/events/event-registration.ts)).
That registry is the entire source of truth for which queues exist. Two
invariants are enforced at registration, i.e. before Nest even starts:

- **One listener per `(event, queue)` pair.** A second throws.
- **`queueOptions` must not conflict.** Two listeners on the same queue asking
  for different explicit values for the same option throws. The merge happens
  into a copy and is committed only if the whole merge passes, so a throwing
  registration never leaves a half-configured queue behind.

`queueOptions` fields ([`types.ts:19-70`](../backend/apps/api/src/domains/events/types.ts)):

| Field | Meaning | Default |
|---|---|---|
| `policy` | pg-boss de-duplication policy. **This is what makes a `singletonKey` real** | `standard` (stores keys, enforces nothing) |
| `expireInSeconds` | how long an `active` job may run before pg-boss expires and retries it | constructor `expireInHours: 12` |
| `retryLimit` / `retryDelay` | retries before dead-lettering; seconds between them | 3 / 10, with backoff |
| `localConcurrency` | in-process worker slots for this queue — **can only lower**, never raise | `queues.perQueueConcurrency` (6) |
| `role` | which process **consumes** this queue | `web` |

### 1.2 Boot

`PGBossEventService.onModuleInit` ([`PGBossEventService.ts:158`](../backend/apps/api/src/domains/events/services/PGBossEventService.ts)):

1. Log every registered listener.
2. Attach `boss.on('error')` **before** `start()` — an EventEmitter that emits
   `error` with no listener throws, and startup is exactly when one is likeliest.
3. `await boss.start()`.
4. Collect `discoveredQueues` (every registered queue + `default`, unconditionally).
5. `warnOnOrphanEvents()` — every `defineEvent` name resolving to zero queues is
   logged. Warn, not throw: a dormant domain is legitimate; refusing to boot over
   one would be a self-inflicted outage.
6. Take **session advisory lock `804_551_297`** on a dedicated TypeORM query
   runner, then `createQueue` + `updateQueue` every queue, then release. The lock
   exists because web and worker boot together and pg-boss's `create_queue`
   deadlocks (observed `40P01`) between the `pgboss.queue` insert and the
   partition DDL when two sessions race the same name.
7. Start one worker loop per queue **this process serves**.

Each queue is created with `{ name, deadLetter: 'dead-letter', retryLimit: 3,
retryDelay: 10, retryBackoff: true, ...listenerOptions }`. `createQueue` is a
no-op on an existing queue, so `updateQueue` (a COALESCE merge) follows every
call — that is what applies new options to a live database.

### 1.3 The worker loop

There is **no `boss.work()` subscription anywhere**. Each served queue runs its
own hand-rolled poller ([`PGBossEventService.ts:635`](../backend/apps/api/src/domains/events/services/PGBossEventService.ts)):

```
while (running):
  available = min(perQueueSemaphore.free, globalSemaphore.free)
  if available == 0:  sleep 150ms;  continue          # backoffWhenFull
  jobs = boss.fetch(queue, { batchSize: min(available, 10) })
  if jobs is empty: sleep 5000ms;  continue           # backoffWhenEmpty
  for job in jobs:
     void perQueueSemaphore(() => runJob(queue, job))  # NOT awaited
```

Two nested `p-limit` semaphores. The **per-queue** slot is held for the job's
whole lifetime; `runJob` acquires the **global** slot inside it. So a job holds
one of each while executing, and can sit `pending` on the per-queue limiter while
it waits for a global slot. One queue can therefore never starve another, and
total in-flight never exceeds the global cap.

| Knob | Config path | Env | Value |
|---|---|---|---|
| Global in-flight ceiling | `queues.concurrency` | `CI_QUEUE_CONCURRENCY` | **10** |
| Per-queue ceiling | `queues.perQueueConcurrency` | `CI_QUEUE_PER_QUEUE_CONCURRENCY` | **6** |
| Fetch batch cap | `queues.fetchBatchSize` | `CI_QUEUE_FETCH_BATCH_SIZE` | **10** |
| Replayed dead-letter retention | `queues.replayedDeadLetterRetentionDays` | `CI_REPLAYED_DEAD_LETTER_RETENTION_DAYS` | **30 days** |
| Queue suppression | *(none — raw env only)* | `CI_QUEUE_SUPPRESS` | unset |
| Process role | `role` | `CI_ROLE` | **`all`** |

> ⚠️ `configuration.ts:383-385` declares zod fallbacks of **32 / 20 / 6** that
> apply only if the key is absent from the config files. `default.json` supplies
> all three, so **10 / 10 / 6** is what actually runs.

> ⚠️ The ceiling is **per process**. `p-limit` is an in-memory counter, not a
> distributed lease — under the split topology the api and worker containers
> each get their own, so the appliance-wide ceiling is 2 × 10.

Two more things are hardcoded and not configurable: the backoffs (150 ms full,
5000 ms empty) and pg-boss's own connection pool (`max: 10`), shared by every
fetch, complete, fail and send across all ~29 polling loops.

### 1.4 Producing work

`EventService` exposes exactly four methods: `send`, `sendMany`, `completeJob`,
`failJob`. **There is no `emit()`** — the `eventEmitter.emit()` call inside
`executeJob` is internal dispatch from a fetched job to the decorated method, not
a producer API.

`send(name, payload, options)` has two routing modes:

- **No `queue` option** → routes to `EventListenerRegistry.getQueuesFor(name)`,
  i.e. only queues that actually have a listener for that event name, and
  enqueues **one job per queue**. An empty set logs a warning and enqueues nothing.
- **Explicit `queue`** → short-circuits *before* the listener lookup and validates
  against **all** existing queues. This is deliberate — naming a queue is how a
  backfill re-drives an event onto one worker — and it means `send` can
  legitimately enqueue onto a queue with no listener for that event, where the
  job is fetched, matched against nothing, and completed.

Routing by listener is a relatively recent fix. It used to fan out to *every*
registered queue and let each worker discard the mismatch — measured on a fresh
stack as an identical 90 jobs per queue, ~93 % pure waste.

`sendMany(queue, events)` bulk-inserts through pg-boss's own `insert()` in chunks
of **2000** and **throws outright** if the target queue declares an enforcing
policy (one `singletonKey` for a whole batch would keep exactly one job). That
throw is the *whole* defence, not the first line of one — the second line cannot
exist.

> ⚠️ **Silent conflict loss is undetectable on the bulk path**, so nothing there
> tries to detect it. pg-boss 10.3.2's bulk `insertJobs` plan ends
> `ON CONFLICT DO NOTHING` with **no `RETURNING` clause**, so `manager.insert()`
> evaluates `rows.length ? rows.map(i => i.id) : null` over an always-empty
> `rows` and resolves `null` — identically whether it wrote every row or one.
> The *single*-job plan `insertJob` does carry `RETURNING id`, which is why the
> null-check in `sendToQueue` is real work; that intuition does not transfer to
> `insert()`. An earlier revision of the loop read `insert()`'s return as an id
> array and logged a drop — code that could never run — and has been removed.

Not checking costs nothing, because the throw makes a conflict unreachable. The
`ON CONFLICT` has no target, so it absorbs any of the five unique constraints on
`pgboss.job` — and every one of them is out of reach here:

- **PK `(name, id)`** — `id` is `COALESCE(id, gen_random_uuid())` and `sendMany`
  never sets one.
- **`job_i1` / `job_i2` / `job_i3`** — partial on policy `short` / `singleton` /
  `stately`, which is precisely what the throw refuses. `enforcingPolicyFor`
  reads the same registry `onModuleInit` provisions from, and boot calls
  `updateQueue` (`policy = COALESCE($2, policy)`, `$2` defaulted to `standard`),
  so the declared policy and the queue row cannot drift.
- **`job_i4`** — partial on `singleton_on IS NOT NULL`, which requires a per-job
  `singletonSeconds`. `EventSendOptions` has no such field, so this path cannot
  produce one.

The other way rows vanish is not a conflict at all: `insertJobs` INNER JOINs
`pgboss.queue`, so an unprovisioned queue silently swallows the whole batch. That
is what the `getRegisteredQueues()` check at the top of `sendMany` is for.

**Priorities.** pg-boss fetches `ORDER BY priority DESC, created_on, id`, so
higher runs sooner — but only among jobs already waiting on the *same* queue, and
only among jobs whose `startAfter` has passed. Three tiers are named
([`constants.ts:17-50`](../backend/apps/api/src/domains/events/constants.ts)):
`INTERACTIVE = 10`, `DEFAULT = 0`, `BACKFILL = -10`. Two more values are enqueued
in practice by `SmartRotationService.workTypePriority()`: **5** (graph_link,
graph_enrich, context_prompt, hydrate_answers, hydrate_things) and **2**
(schedule_sync, summaries, insights), plus **-2** (answer_infer, question_feed).
Live values are therefore `-10, -2, 0, 2, 5, 10`.

### 1.5 The singleton-key trap

**A `singletonKey` on a `standard` queue is stored and never enforced.** pg-boss's
three de-duplication indexes are all partial on policy:

| Policy | Unique index | Active while |
|---|---|---|
| `short` | `(name, COALESCE(singleton_key,''))` | `state = 'created'` |
| `singleton` | `(name, COALESCE(singleton_key,''))` | `state = 'active'` |
| `stately` | `(name, state, COALESCE(singleton_key,''))` | `state <= 'active'` |

Two consequences the codebase guards explicitly:

1. A queue that wants its `singletonKey` honoured **must declare a policy**.
   `sendToQueue()` logs an ERROR when an enforcing queue receives a keyless send.
2. Every index `COALESCE`s a *missing* key to `''`, so **keyless sends to an
   enforcing queue de-duplicate against each other**, and the insert is
   `ON CONFLICT DO NOTHING` — the loser is discarded with no error and `send()`
   resolves `null`. This is why `thing-vision` deliberately has
   `localConcurrency: 1` but **no** policy: its only event is `file.uploaded`,
   whose producer sends without a key (and cannot grow one, because the event
   fans out to six queues under one shared options object). Under `short`,
   concurrent uploads would collapse into one row.

### 1.6 Acknowledgement, retries, dead letters

`autoAcknowledge: true` (default) wraps the handler: return → `ack.done()`,
throw → `ack.fail()`. `autoAcknowledge: false` hands the handler an `ack` and it
must call `done` / `fail` / `defer` itself; the wrapper tracks whether it did and
fails the job as a fallback if it threw without acknowledging, because
EventEmitter2's `suppressErrors: true` would otherwise eat the exception and leak
the worker slot forever.

`ack.defer()` releases the worker slot while the job stays **`active`**.
Completion arrives out-of-band via `EventService.completeJob` / `failJob`, or the
queue's `expireInSeconds` elapses and pg-boss retries. Only the two
`python.function.run` listeners use this — they POST to a FastAPI sidecar and are
completed by its callback webhook.

Completion bookkeeping sits deliberately *outside* the listener's `try`. It used
to be inside, which meant a transient failure of `boss.complete()` on work that
had **succeeded** called `boss.fail()` — burning a retry on completed work and
eventually dead-lettering a job that had done its job. Split, a completion
failure is only logged; the job stays `active` and pg-boss's expiry re-queues it.
At-least-once, which is what a queue promises anyway.

**Retry timing.** `retryBackoff: true` means `retryDelay: 10` is not the gap.
pg-boss computes `start_after = now() + (retry_delay * 2^LEAST(16, retry_count+1) / 2) * (1 + random())`,
so the three retries land roughly 10–20 s, 20–40 s, 40–80 s after each failure.

**Dead letters.** Every work queue is created with `deadLetter: 'dead-letter'`.
A job that exhausts its retries is re-inserted there with payload and failure
output preserved. **Nothing consumes that queue** — deliberately, and never
subscribe one: dispatch is by the *original* event name, so a listener registered
on `dead-letter` would make it a discovered queue, start a worker on it, and that
worker would fetch every dead letter, find no handler for the other ~88 event
names, `skip()` and `complete()` — silently destroying the dead letters of every
other event.

Instead `DeadLetterReaperListener` **polls** `pgboss.job` every 2 minutes
(`'40 */2 * * * *'`), copying up to 500 rows into `ci.pipeline_dead_letters`
keyed on the originating pg-boss job id (natural idempotency key; anti-join plus
`ON CONFLICT (id) DO NOTHING`). It never completes or deletes the pg-boss row.
The same tick purges up to 500 **replayed** rows older than 30 days.
**An unreplayed letter has no TTL at any age** — its payload is frequently the
only surviving copy of a record the source will not re-send.

### 1.7 Retention — what actually happens to a finished job

| Stage | Mechanism | Window |
|---|---|---|
| `pgboss.job` → `pgboss.archive` | pg-boss archive default (`archiveCompletedAfterSeconds` unset) | ~12 h |
| `pgboss.archive` → deleted | `deleteAfterHours: 24` | +24 h |
| **End to end** | | **~36 h, in two stages** |

`deleteAfterHours` never touches `pgboss.job` or `pgboss.queue` — pg-boss folds
it into one statement, `DELETE FROM pgboss.archive WHERE archived_on < now() - interval '24 hours'`.
Likewise only the three **retry** values are written onto queue rows; `expireInHours: 12`
stays a constructor default resolved as `COALESCE(job, queue, constructor)`.

Charts on the Jobs dashboard therefore read from `ci.job_metrics` (sampled every
5 minutes, 30-day retention), not from pg-boss.

### 1.8 The web / worker split

Every process **creates** every queue and may **send** to every queue. Only
**consumption** is role-gated:

```ts
const queueRole = EventListenerRegistry.getQueueOptions(queue)?.role ?? 'web';
if (!serves(queueRole)) continue;   // no work() loop started here
```

```ts
export function serves(target: ServedRole): boolean {
  const role = processRole();
  return role === 'all' || role === target;   // config.role defaults to 'all'
}
```

> ⚠️ **`config.role` defaults to `'all'` and is absent from `default.json`.** With
> `CI_ROLE` unset, one process consumes both halves and `role` has no effect at
> all. The split exists only where `CI_ROLE` is set explicitly: the overmind
> `Procfile` (`api: CI_ROLE=web`, `worker: CI_ROLE=worker`) and
> `docker-compose.production.yml` / `.staging.yml`.

The `@Cron` wrapper applies the same gate, but at *decoration* time — when the
process does not serve the role, the method never registers with the scheduler.

### 1.9 The `@Cron` wrapper

`@ci/common/schedule` wraps `@nestjs/schedule` ([`Cron.ts`](../backend/apps/api/src/common/schedule/decorators/Cron.ts)).
**All 53 decorator sites use it** — no non-test file imports the `Cron` symbol
from `@nestjs/schedule`. It adds three things Nest's own wrapper does not:

- a `ci.cron_runs` stamp keyed on the registry name — **twice**: an attempt stamp
  before the body (so a hung or throwing tick still counts as fired) and a
  success stamp after it returns. A schedule that fails every tick is otherwise
  indistinguishable from a healthy one on the dashboard.
- a `traceId` in `ContextService` for the whole tick.
- an error log that names the failing schedule. Nest catches one frame further
  out and logs `SchedulerRegistry` with no schedule name; with 53 scheduled
  methods, "something in the scheduler threw" is not a diagnosis.

The tick is swallowed after logging, matching the framework's behaviour: the tick
is lost, the schedule keeps running.

> The wrapper's own docstring still says "~34 scheduled methods". It is 53.

### 1.10 Observability

`GET /api/jobs/dashboard`, `/api/jobs`, `/api/jobs/history`, `/api/jobs/types`
and `POST /api/jobs/crons/run` ([`JobsController.ts`](../backend/apps/api/src/domains/events/controllers/JobsController.ts))
are the whole jobs API — there is no GraphQL surface. The frontend is
`frontend/apps/web/src/pages/JobsPage/`.

Every one of them requires `JwtOrApiKeyAuthGuard`. `POST /api/jobs/crons/run`
additionally requires `@RequireCapability('full')`, because it fans out over
**every** registered schedule and that set includes
`AccountPurgeCron.purgeDueAccounts`, which permanently deletes accounts past
their grace period — an authority `write` ("mutating, but nothing that deletes")
does not describe. It previously carried no auth guard at all, gated instead on
`request.socket.remoteAddress` being loopback; that is the immediate peer rather
than the client, and both proxies this repo ships (the `make dev` Caddy route,
and the Vite dev server's `/api` proxy, which binds `0.0.0.0`) dial the API on
localhost, so any caller on the network satisfied it. An operator inside the
container now needs a session or a full-capability API key like anyone else.

[`taxonomy.ts`](../backend/apps/api/src/domains/events/taxonomy.ts) is the layer
that turns queue names into meaning: every event gets a `label`, one of eleven
`category` values, a plain-language `description`, and an `interactive` flag.
`describeJob(event, workType, queue)` never throws and never returns undefined —
an unknown event renders as **"Unclassified job"**, which is a gap in that file,
not a reason for the dashboard to fail. `JOB_TYPES_BY_QUEUE` disambiguates the
handful of event names two unrelated listeners share (see §5).

---

## 2. Queues

38 pg-boss queues. `default` is created unconditionally even with zero listeners;
`dead-letter` is created separately, before the loop, and is deliberately absent
from the discovered set — which is why no worker starts on it and why
`send(…, { queue: 'dead-letter' })` is refused with a warning.

Everything not stated inherits: `policy standard`, `retryLimit 3`, `retryDelay 10`
(with backoff), `expireInHours 12`, `localConcurrency 6`, `role web`.

| Queue | Slots | Role | Policy | Expire | Carries |
|---|---|---|---|---|---|
| `search-index` | 6 | web | — | — | **53 bindings.** Every entity create/update/delete → `ci_search` |
| `default` | 6 | web | — | — | `user.created` (saved searches), `answer.created` (home confirm), `graph.node.upserted`, `graph.relationship.upserted`, `file.uploaded` (legacy drain) |
| `pipeline-index` | 6 | web | — | — | Postgres-bound slices + sweeps; the pipeline control queue (arrivals, dead-letter reap) |
| `pipeline-enrich` | 6 | web | — | — | Slices + sweeps for CPU / object-store / metered-provider stages |
| `pipeline-embed` | 6 | web | — | — | Slices + sweeps for the Ollama-bound embed family |
| `planning` | 6 | web | `short` | — | The five `planning.*` jobs |
| `llm` | **1** | web | `short` | **900 s** | `chat.generate`, `chat.summarization`, `infer.question.answer` |
| `image-description` | **1** | web | `short` | — | `preview.generated`, `file.image-description-backfill-request` |
| `thing-vision` | **1** | web | — *(deliberate)* | — | `file.uploaded` → Ollama vision "thing" pass |
| `agent-memory` | **1** | web | `short` | **300 s** | `agent-memory.turn-fragments` |
| `derivation-run` | **1** | **worker** | `short` | — | `maintenance.derivation-run-request` |
| `import-unpack` | **1** | **worker** | `short` | — | `import.stage` (unpack) |
| `import-parse` | **1** | **worker** | `short` | — | `import.stage` (parse) |
| `import-media` | **2** | **worker** | `short` | — | `import.stage` (media) |
| `import-push` | **1** | **worker** | `short` | — | `import.stage` (push) |
| `import-stages` | **1** | **worker** | — *(deliberate)* | — | Legacy drain + deleted-stage fallback |
| `py-fn-summary` | 6 | web | `short` | **1800 s** | `python.function.run` → Summary sidecar. **Deferred completion** |
| `py-fn-hbpe` | 6 | web | `short` | **14400 s** | `python.function.run` → HBPE sidecar. **Deferred completion**, `retryLimit 2`, `retryDelay 300` |
| `ingest-coalesce` | 6 | web | `short` | **3600 s** | `ingest.coalesce`, `retryDelay 60` |
| `etl` | 6 | web | `short` | — | `connectionSyncJob.execute`, `connectionSyncJob.transform` |
| `smart-rotation` | 6 | web | `short` | — | `smart.rotation.work` (ten work types) |
| `context-prompt-persist` | 6 | web | `short` | — | `context.prompt.persist` |
| `unfurl-sweep` | 6 | web | `short` | — | `embed.unfurl-sweep-request` |
| `file-preview-sweep` | 6 | web | `short` | — | `file.preview-sweep-request` |
| `feed-queue` | 6 | web | — | — | `action.created`, `summary.created` |
| `telemetry` | 6 | web | — | — | `tool.invoked`, `retrieval.query` |
| `people-linking` | 6 | web | — | — | `communication.created` → participant resolution |
| `geocode` | 6 | web | — | — | `event.geocode-batch-request` |
| `estimate-location` | 6 | web | — | — | `event.estimate-location-batch-request` |
| `media-dimensions` | 6 | web | — | — | `file.media-dimensions-backfill-request` *(deprecated shim)* |
| `document-parsing` | 6 | web | — | — | `file.uploaded` → text extraction |
| `file-preview-generation` | 6 | web | — | — | `file.uploaded` → thumbnails |
| `memory-file-entity` | 6 | web | — | — | `file.uploaded` → graph File node |
| `import-inbox-provision` | 6 | web | — | — | `user.created` → inbox drop folders |
| `graph-edge-backfill` | 6 | web | — | — | `maintenance.graph-edge-backfill-request` |
| `search-index-backfill` | 6 | web | — | — | `maintenance.search-index-backfill-request` |
| `cv-detections` | 6 | web | — | — | `cv.detections.captured` — **no producer; the queue is dead** |
| `dead-letter` | *none* | — | — | 30 d retention | Exhausted-retry jobs. **No consumer by design** |

### Events that fan out to several queues

One `send()` with no `queue` option enqueues **one job per listening queue**:

| Event | Jobs per send | Queues |
|---|---|---|
| `file.uploaded` | **6** | `file-preview-generation`, `document-parsing`, `memory-file-entity`, `thing-vision`, `search-index`, `default` (drain) |
| `import.stage` | 5 registered | routed explicitly by kind, so 1 in practice |
| `pipeline.slice` / `pipeline.sweep` | 3 registered each | routed explicitly by stage queue, so 1 each |
| `python.function.run` | 2 registered | routed explicitly by target, so 1 |
| `user.created` | **2** | `default` (saved searches), `import-inbox-provision` |
| `answer.created` | **2** | `search-index`, `default` (home confirm) |
| `communication.created` | **2** | `search-index`, `people-linking` |
| `content.created` | **2** | `search-index`, `pipeline-index` (arrival) |
| `graph.node.upserted` | **2** | `default`, `search-index` |

---

## 3. Jobs, by category

108 bindings over 89 event names. Search-index jobs are collapsed into one row —
all 53 are mechanically identical.

### Search index — 53 bindings, queue `search-index`

One listener per entity per verb, all writing `ci_search`. Entities:
`note`, `event`, `item`, `place`, `person`, `concept`, `content`, `answer`,
`thread`, `message`, `communication`, `browseractivity`, `position`, `product`,
`receipt`, `file`, plus `agent-memory` (created/deleted only),
`graph.node.upserted` and `document.parsed` (file chunks).

**Trigger:** every entity write in the app, plus `SearchIndexBackfillService`
which `sendMany`s them in bulk.
**Note:** three of these have listeners but **no live producer** —
`file.deleted`, `product.deleted`, `receipt.deleted`. `file.created`,
`product.created` and `receipt.created` are only ever produced by the backfill
sweep, never by the create path.

### Pipeline — the staged ledger

| Event | Queue | What it does | Triggered by |
|---|---|---|---|
| `pipeline.slice` | `pipeline-index` / `-enrich` / `-embed` | **The generic worker.** One class processes every stage. Parse payload → claim ids into `ci.pipeline_state` → `stage.run(ctx, ids)` → bulk-record every claimed id's outcome (silence is recorded as failure, never success). On throw: fail the claimed ids with `stage_threw: …`, write `ci.pipeline_dead_letters`, rethrow so pg-boss's own retry/DLQ still applies | Chained only — `PipelineDispatchService` sweep hops (`sendMany`, priority −10) and `StageArrivalListener` flushes (priority 0) |
| `pipeline.sweep` | same three | One hop of a durable keyset sweep. Up to 5 slices per hop, then **re-enqueues itself onto the same queue at the same priority** — pg-boss's FIFO-within-priority means the next hop cannot run until those slices drain. Backpressure for free, as pure ordering. Bails at `MAX_SWEEP_HOPS = 10_000` | `PipelineTickCron` (5 min), the four sweep-request listeners, operator routes |
| `content.created` | `pipeline-index` | **Arrival signal.** Adds the id to an in-memory Set and arms a single 2 s fixed-window timer; the flush enqueues slices. Rides the *control* queue on purpose — an arrival note on a stage queue would count toward that queue's ready depth and make backpressure shed the actual slices | `ContentService.create` / `createMany` (user-driven) |
| `pipeline.dead_letter.reap` | `pipeline-index` | On-demand harvest. **No producer in the repo** — an operator/test hook | — |
| `maintenance.search-index-backfill-request` | `search-index-backfill` | Maps 7 wire type names to (embed, vector) stage pairs and starts a sweep for each | `PushStage` post-push kick (import) |
| `maintenance.graph-edge-backfill-request` | `graph-edge-backfill` | Maps source names to `promote.edge_*` stages and starts a sweep for each | `PushStage` post-push kick |
| `embed.unfurl-sweep-request` | `unfurl-sweep` | Starts an `enrich.unfurl` sweep, cap 20 000 ids | `PushStage` (when content was handled), `POST /api/maintenance/unfurl-sweep` |
| `file.preview-sweep-request` | `file-preview-sweep` | Starts an `enrich.file_preview` sweep | `POST /api/maintenance/file-preview-sweep` |

**43 stage ids** hide behind `pipeline.slice`, grouped `get.* / index.* / enrich.* / clean.* / promote.*`.
Stage ids are **permanent** — the id is the third component of `ci.pipeline_state`'s
primary key, so renaming one abandons every ledger row written under the old name.

Stages by queue: `pipeline-enrich` gets `enrich.media_dimensions`,
`enrich.file_preview`, `enrich.geocode`, `enrich.estimate_location`,
`enrich.unfurl`, `enrich.event_reverse`, `enrich.position_reverse`;
`pipeline-embed` gets the seven `index.embed*` dense-embedding stages;
`pipeline-index` gets everything else (the seven `index.vector*`, four `clean.*`,
`enrich.person_link` / `_self_claim` / `event_person_link`, and all fourteen
`promote.*`).

**Only about half the pipeline is nocturnal.** 19 of the 43 stages declare
`window: 'enrichment'` and are confined to the window — 16 nightly
(`minInterval: 1 * DAYS`) and 3 weekly. The other **24** declare `window: 'any'`
and run on an hourly, unwindowed tier at any hour: all seven `index.embed*`, all
seven `index.vector*`, and all ten `promote.edge_*`. Search freshness and
bulk-import edge projection deliberately do not wait for the night. `isDue()`
gates on nothing but `schedule.window === 'enrichment'`, so a stage that does not
declare it is never held back (`domains/pipeline/schedule.ts:1070,1077`).

> ⚠️ **The budget and the rotation are configured but not enforced.** `config.enrichment`
> declares a 90-minute activity budget and 20-minute per-user turns, and both are
> inert: `EnrichmentWindowService.takeTurn()` — the only caller of `recordServed`,
> which is the only writer of `ci.pipeline_turns.spent_ms` and the rotation
> pointer — has **no production caller** (repo-wide, only its own spec).
> `PipelineControlService` says so itself at line 711: it calls only the
> read-only `status()`. So `nightTally()` always sums 0, `applyBudget` can never
> return `budget_spent`, and no per-user rotation ever happens.
> `EnrichmentWindowService.isOpen()` likewise has zero production callers, so the
> sweep-hop gate its docstring describes is not applied either. In practice the
> window is a plain 01:00–06:00 wall-clock gate on those 19 stages, nothing more.

### Ingest and files

| Event | Queue | What it does | Triggered by |
|---|---|---|---|
| `file.uploaded` | `file-preview-generation` | Generate the 300 px JPEG PREVIEW variant; returns early if one exists | Upload (REST, bulk, import media stage) |
| `file.uploaded` | `document-parsing` | Text extraction. Marks `parse_status` PROCESSING → COMPLETED/SKIPPED; **rethrows** on failure so retries apply | same |
| `file.uploaded` | `memory-file-entity` | Idempotent graph File-node upsert in `ci.entities`; doubled idempotency (pre-check + `23505` catch that re-reads the race winner) | same |
| `file.uploaded` | `default` | Identical body — a **drain** for jobs enqueued before the handler moved off `default` | same |
| `file.uploaded` | `thing-vision` | Ollama vision pass behind the camera's "thing" mode. Gated on `payload.thingCapture` **and** the image-description preference | Upload with `thingCapture` |
| `preview.generated` | `image-description` | Title + description for an image via a local vision model. Four early returns that **complete** rather than throw | `FilePreviewService.generate`, and the backfill below |
| `file.image-description-backfill-request` | `image-description` | Re-drives description for originals that still have none. Its `singletonKey` deliberately matches `FilePreviewService`'s so a preview already queued is refused, not described twice | Flipping the setting on (`POST /personalization/image-descriptions`) |
| `file.media-dimensions-backfill-request` | `media-dimensions` | **Deprecated shim** — emits one `pipeline.sweep` for `enrich.media_dimensions` and writes nothing | `POST /api/maintenance/backfill-media-dimensions` |
| `document.parsed` | `search-index` | Index the extracted chunks | `FileDocumentParseListener` |
| `cv.detections.captured` | `cv-detections` | Materialize CV detections into memory rows, keyed `<fileId>:<detectionId>` | **Nothing. Built, never wired** |
| `ingest.coalesce` | `ingest-coalesce` | Server-side "finish" for a bulk `/v1` push whose client never called finish. Re-enqueues itself 60 s out if the orchestrator is busy | `BulkIngestController` after a successful materialize |

### Import / ETL

| Event | Queue | What it does | Triggered by |
|---|---|---|---|
| `import.stage` | `import-unpack` | `unzip` a multi-GB archive after a disk preflight. 1 slot so two archives' preflights cannot both pass and jointly fill the volume | `ImportRunService.enqueueStage` — chained (`advance`), user-driven (`startRun`, `retryStage`), or the resume sweep |
| `import.stage` | `import-parse` | Walk the tree, recognize data sources, run parsers into `ci_import.staged_*`. **1 slot appliance-wide** — two abreast starved the event loop | same |
| `import.stage` | `import-media` | Push media to object storage, re-entering the `file.uploaded` fan-out. 2 slots (I/O-bound) | same |
| `import.stage` | `import-push` | Read staged rows by `push_status`, fan through `destinationsFor`, call ingest services **in-process**. 1 slot: concurrent pushes into shared `ci.*` is an untested dedup path | same |
| `import.stage` | `import-stages` | Same body — legacy drain, plus the deleted-stage fallback. **The only import queue on `standard`**, because that fallback sends without a key | legacy / fallback |
| `user.created` | `import-inbox-provision` | `mkdir` the account's inbox drop folders. Whole body try/caught — an unavailable mount must never fail signup, so the job **always completes** | `UserService.create` |
| `connectionSyncJob.execute` | `etl` | Claim a job atomically, fetch one page from a provider, write the raw payload | `SyncOrchestrator.executeSyncJobs` cron only |
| `connectionSyncJob.transform` | `etl` | Claim atomically (1 h stale-claim window), map the provider payload into the memory model | `SyncOrchestrator.executeTransformJobs` cron only |

Every stage runs under a shared `runStage` spine: claim → scratch dir → 30 s
heartbeat → runner → `completeStage` → `advance` (which enqueues the successor),
or `failStage` + rethrow.

### LLM

| Event | Queue | What it does | Triggered by |
|---|---|---|---|
| `chat.generate` | `llm` | One chat turn. Flips `generation_status` to running, builds the turn, streams from Ollama, persists. **Survives leaving the page; Stop cancels it.** `INTERACTIVE_JOB_PRIORITY`, `singletonKey chat-generate:<threadId>` | `POST /llm/generate` |
| `chat.summarization` | `llm` | Sidebar title for an unnamed thread. Try/caught and only logged — never retried | Chained from a successful `chat.generate`, only when the thread has no name |
| `infer.question.answer` | `llm` | Infer a first-person answer to an unanswered profile question from what the appliance knows, rather than asking. Embedding call + `ci_search` query + generation, 60 s timeout | `AnswerInferenceCron` (flag off) or `SmartRotationListener` (flag on) |
| `python.function.run` | `py-fn-summary` | POST to the Summary sidecar (`/functions/run`, 30 s *accept* timeout only), then `ack.defer()`. Completed by the callback webhook | The `PythonFunctionCrons` fan-outs, `SmartRotationListener` |
| `python.function.run` | `py-fn-hbpe` | Same, aimed at HBPE. 4 h expiry because bootstrap trains models for hours | `hbpeNightly`, `hbpeBootstrapSweep`, `ForecastResolver.triggerHbpe` |

### Personalization, planning, graph, maintenance

| Event | Queue | What it does | Triggered by |
|---|---|---|---|
| `smart.rotation.work` | `smart-rotation` | **Ten-way switch**, one background-intelligence chore per work type: `question_feed`, `answer_infer`, `schedule_sync`, `insights`, `summaries`, `graph_link`, `graph_enrich`, `context_prompt`, `hydrate_answers`, `hydrate_things` | Ten `@Cron` classes — **all inert while `smart.rotation` is false** (the default). The flag is checked on the producer side only |
| `agent-memory.turn-fragments` | `agent-memory` | Distil a user's finished chat turns into raw memory fragments. **The window travels with the job** — a retry an hour later distils the window it was enqueued for | `TurnFragmentCron` — flag `agent.memory.turnFragments`, **default false** |
| `planning.todo_scan` | `planning` | Recall the last stretch of memory (Ollama embedding), surface possible to-dos, dedupe against the backlog, auto-add or propose per the trust dial | `PlanningJobsCron.todoScan`, daily 06:00, per onboarded user |
| `planning.todo_process` | `planning` | For up to 40 open tasks: one recall + one Ollama call each, asking for an action | `PlanningJobsCron.todoProcess`, every 6 h |
| `planning.inbox_scan` | `planning` | Up to 30 inbound messages from the last **30 days** into one Ollama call | `PlanningJobsCron.inboxScan`, every 30 min |
| `planning.event_now` | `planning` | Planned blocks within ±2 h of now — revise or ask. **Never auto-cancels** | `PlanningJobsCron.eventNow`, hourly :15 |
| `planning.verify_done` | `planning` | Blocks that ended in the last 36 h — look for completion evidence. Only `auto` + `doneSignal` closes without asking | `PlanningJobsCron.verifyDone`, hourly :45 |
| `maintenance.derivation-run-request` | `derivation-run` | Nightly graph aggregate per user. Skips if the orchestrator is live. 1 slot: set-based SQL over `ci.relationships`, nothing waiting on the answer | `DerivationCron`, nightly 04:40, one job per onboarded user |
| `communication.created` | `people-linking` | Resolve raw participant strings into Person ids, minting stubs for anyone not yet known. Own queue so it never waits behind search indexing | `CommunicationService.create` |
| `graph.node.upserted` | `default` | Find-then-save upsert on `ci.entities` | `GraphEventService.upsertNode` — agent `write_knowledge` tool |
| `graph.relationship.upserted` | `default` | Find-then-save upsert on `ci.relationships`. **No search indexing at all** — an edge written through `write_knowledge` never touches `ci_search` | `GraphEventService.upsertRelationship` |
| `event.geocode-batch-request` | `geocode` | Forward and reverse geocoding via `ci.geocode_cache`. **Egresses to a metered provider** — two-layer rate limit (a listener `p-limit` of 10, plus a QPS throttle inside the singleton service) | `POST /api/maintenance/geocode-locations` only — **no cron** |
| `event.estimate-location-batch-request` | `estimate-location` | Infer where undated-location events happened from neighbouring physical-presence sources. Idempotent — never chains an estimate off an estimate | `POST /api/maintenance/estimate-locations`, the orchestrator |
| `context.prompt.persist` | `context-prompt-persist` | Persist the answered dossier prompt | `ContextPromptService.respond` |
| `action.created` | `feed-queue` | Trust-dial decision, then `INSERT … ON CONFLICT DO NOTHING` into `ci.feed_queue`. **This is the trust boundary for feed placement** — several producers rely on it rather than gating themselves | `ActionService.create` |
| `summary.created` | `feed-queue` | Same insert, but runs **no** trust-dial decision — only the row's `dismissed` flag gates it. Currently unreachable: `SummaryService.create` has no in-app caller | *(seed script only)* |
| `answer.created` | `default` | If the answer resolves the seeded home question, write the `LIVES_IN` edge and refresh daily metrics | `AnswerService.create` |
| `user.created` | `default` | Seed the starter saved-search catalogue. Idempotent by an existing-row count | `UserService.create` |
| `tool.invoked` | `telemetry` | Append to `ci.tool_invocations`, including refused calls. Emit is try/caught — telemetry must never fail a completed tool call | `ToolRegistry.recordInvocation` |
| `retrieval.query` | `telemetry` | One insert into `ci.retrieval_query_log` | `SearchService.emit`, `RecallService` |

---

## 4. Schedules

53 `@Cron` methods. All use the wrapper. Expressions are 6-field (second-first)
unless marked **5f**, in which case they fire on second 0 — the crowded second
the 6-field schedules were deliberately staggered off.

### Queue and pipeline control

| Schedule | Registry name | Role | What it does |
|---|---|---|---|
| `20 */5 * * * *` | `PipelineTickCron.runOnSchedule` | web | The pipeline tick. Advisory lock `(0x6369, 1)`, one `BackpressureService.snapshot()`, then dispatches sweeps. Caps: 25 users, 4 sweeps and a bounded slice budget per tick |
| `40 */2 * * * *` | `DeadLetterReaperListener.reapOnSchedule` | web | Harvest ≤500 dead letters, then purge ≤500 replayed rows >30 d. Two separate `try` blocks so a harvest failure cannot silently skip reclamation forever |
| `18 */5 * * * *` | `JobMetricsCollector.sampleOnSchedule` | web | Sample per-queue gauges + throughput into `ci.job_metrics` |
| `48 25 4 * * *` | `JobMetricsCollector.purgeOnSchedule` | web | `DELETE FROM ci.job_metrics` older than 30 days |

### Import and ETL

| Schedule | Registry name | Role | What it does |
|---|---|---|---|
| `5 * * * * *` | `SyncOrchestrator.orchestrateSyncJobs` | web | Every minute — walk active connections × endpoints × iteration types and create pending sync jobs. In-process `orchestrating` flag is the only overlap guard |
| `8,38 * * * * *` | `SyncOrchestrator.executeSyncJobs` | web | Twice a minute — dispatch up to `5 − inFlight` pending jobs. **The only executor of pending sync jobs, including user-initiated Sync Now** |
| `15 * * * * *` | `SyncOrchestrator.executeTransformJobs` | web | Every minute — dispatch at most **2** transforms appliance-wide, oldest-first |
| `30 */5 * * * *` | `ImportStageListener.sweepOnSchedule` | **worker** | Reclaim stages stuck `running` >10 min back to `queued`, then re-enqueue **at most one** stage per unfinished run — the lowest-`seq` queued one, picked by a `LEFT JOIN LATERAL … ORDER BY s.seq LIMIT 1`, and only when no stage of that run is currently `running` (a queued stage behind a running one is waiting *by design*) |
| `0 17 * * * *` | `StagedUploadPurgeCron.runOnSchedule` | **worker** | Restage orphaned claims, purge expired staged uploads, walk the uploads root for orphans |
| `50 40 6 * * *` | `ImportRetentionCron.runOnSchedule` | **worker** | Reclaim staged payload for drained runs >7 d, prune run history >90 d |
| `0 */10 * * * *` | `BlueBubblesSyncCron.runOnSchedule` | web | iMessage pull for the first onboarded account. In-process `running` flag only |

### Python sidecars — every one is an unbounded per-user fan-out

| Schedule | Registry name | Ceded to smart rotation? | Function |
|---|---|---|---|
| `0 5 * * * *` | `PythonFunctionCrons.hourlySummaries` | yes | `hourly_summary` |
| `0 10 0 * * *` | `…dailySummaries` | no | `daily_summary` |
| `0 15 0 * * 1` | `…weeklySummaries` | no | `weekly_summary` |
| `0 20 0 1 * *` | `…monthlySummaries` | no | `monthly_summary` |
| `0 12 * * * *` | `…dossierRefresh` | yes | `dossier_refresh`, narrower audience (users with summary input) |
| `0 30 */3 * * *` | `…insights` | yes | `insights_generation`, 72 h lookback |
| `0 45 * * * *` | `…actions` | no | `actions_generation`, 7 d lookback |
| `0 30 2 * * *` | `…hbpeNightly` | no | HBPE `nightly` |
| `0 0 3 * * *` | `…hbpeBootstrapSweep` | no | HBPE `ensure_bootstrap` — shares the nightly singleton key |

### Smart rotation — all ten inert while `smart.rotation` is false (the default)

Each takes **10 users per tick** from an **in-process** round-robin cursor.
`answer_infer` and `question_feed` are additionally skipped when the pg-boss
backlog exceeds 500.

| Schedule | Work type | Priority |
|---|---|---|
| `0 0,20,40 * * * *` | `question_feed` | −2 |
| `0 7,27,47 * * * *` | `answer_infer` | −2 |
| `0 14 * * * *` | `schedule_sync` | 2 |
| `0 22 * * * *` | `summaries` | 2 |
| `0 45 */3 * * *` | `insights` | 2 |
| `0 5 */2 * * *` | `graph_link` | 5 |
| `0 10 */6 * * *` | `graph_enrich` | 5 |
| `0 30 */4 * * *` | `context_prompt` | 5 |
| `0 5 3 * * *` | `hydrate_answers` | 5 |
| `0 15 3 * * *` | `hydrate_things` | 5 |

### Planning — all five gated on `planning.enabled` (default true), all **5f**

| Schedule | Registry name | Cadence |
|---|---|---|
| `0 6 * * *` | `PlanningJobsCron.todoScan` | daily 06:00 |
| `0 */6 * * *` | `…todoProcess` | every 6 h |
| `*/30 * * * *` | `…inboxScan` | every 30 min |
| `15 * * * *` | `…eventNow` | hourly :15 |
| `45 * * * *` | `…verifyDone` | hourly :45 |

### Maintenance sweeps — all worker-role

| Schedule | Registry name | What it does |
|---|---|---|
| `35 50 2 * * *` | `OrphanCleanupCron.sweepOnSchedule` | **The heaviest recurring sweep.** One anti-join per (index table × indexable type), batches of 5000 under a 120 s statement timeout. Deliberately does **not** catch — a failure must be visible |
| `50 40 3 * * *` | `RetrievalHealthCron.captureRetrievalHealth` | Whole-table counts per indexable type into `ci.retrieval_health_snapshots`; alerting gated on `actions`. Depends on orphan cleanup having already run at 02:50 |
| `25 40 4 * * *` | `DerivationCron.deriveNightly` | Fan out one `derivation-run` job per onboarded user, `singletonKey derive:<user>:<day>` |
| `43 45 4 * * *` | `ToolInvocationRetentionCron.pruneOnSchedule` | Delete `ci.tool_invocations` older than 365 days. **Unbounded DELETE** |
| `33 20 2 * * *` | `AgentMemoryRetentionCron.runOnSchedule` | Expire processed fragments >365 d, delete in batches of 500 |
| `13 20 5 * * 0` | `RecallProbeCron.probeRecall` | Weekly recall probe — one user, ≤3 entity types, 50 sample vectors, 4 `ef_search` legs, 10 min deadline |
| `23 35 5 * * 0` | `EntityTypeAuditCron.auditEntityTypes` | Weekly per-user audit of import-minted Person entities, window 1000 |

### Everything else — web role

| Schedule | Registry name | Gate | What it does |
|---|---|---|---|
| `25 */15 * * * *` | `ActivityRollupCron.refreshRollup` | none | **Eight unbounded full-table aggregates**, every 15 min, no time or user predicate |
| `0 10 * * * *` | `DailyMetricsCron.refreshRecent` | none | Four phases; `findAllOnboarded()` called **four times** per tick. Only `refreshPlaces` is capped (25 users) |
| `28 */20 * * * *` | `FeedQueueCron.topUpFeedQueue` | **inverted** — runs only while `smart.rotation` is OFF | Top up `ci.feed_queue` for every onboarded user |
| `55 * * * * *` | `AnswerInferenceCron.cronInferAnswers` | off when `smart.rotation` on | **Every minute.** A `ci.questions × ci.users` CROSS JOIN with a window function and a correlated anti-join, 1440×/day |
| `45 */5 * * * *` | `MemoryCompactionCron.cronCompactMemories` | `agent.memory.compaction` — **default false** | Up to 25 sequential LLM generations **in-process on the web role**, not over pg-boss |
| `3 */10 * * * *` | `TurnFragmentCron.cronWriteTurnFragments` | `agent.memory.turnFragments` — **default false** | Fan out one turn-fragment job per user with completed turns. Interval config-driven, bounded 5–15 min |
| `0 20 * * * *` | `AccountPurgeCron.purgeDueAccounts` | `accountDeletion.purge.enabled` (true) | Hard-delete accounts past the 30-day grace, ≤5 per run. **The only cron with a real distributed mutex** (`pg_try_advisory_lock` per account) |
| `35 0 * * * *` | `InitialActionsCron.initializeEligibleUsers` | `actions` (true) | Seed cards for users onboarded >24 h ago. **The best-behaved per-user cron**: bounded indexed query, `LIMIT 25` in SQL, self-draining predicate |
| `0 */5 * * * *` | `AskExpiryCron.expireOverdueAsks` | none | Expire ≤200 overdue asks; one transaction + row lock each |
| `0 */5 * * * *` | `PendingActionExpiryCron.sweepPendingActions` | none — **the `tools.pendingActions` flag is never consulted** | Expire ≤200 proposed actions; the retention DELETE is **unbounded** |
| `0 */5 * * * *` **5f** | `McpController.reapStaleSessions` | none | Close MCP transports idle >30 min. The only `@Cron` on a controller, and the only `private` one |

---

## 5. Gaps and traps

### Events declared and produced, but consumed by nobody

`send()` resolves these to an empty queue set and **enqueues nothing**. Each is
logged once at boot by `warnOnOrphanEvents`, then silently dropped at every send:

`device.created` · `device.updated` · `device.deleted` · `savedSearch.created` ·
`savedSearch.updated` · `savedSearch.deleted` · `question.created` ·
`question.updated` · `question.deleted` · `task.created` · `task.updated`
(seven send sites) · `task.deleted` · `summary.updated` · `summary.deleted` ·
`user.updated` · `user.removed`

`user.removed` is the notable one: **nothing cleans up a deleted user's search
index, graph nodes or queued jobs in response.**

### Listeners with no producer

- **`cv.detections.captured`** — the only event on `cv-detections`, so the whole
  queue is dead. Built, never wired.
- **`pipeline.dead_letter.reap`** — an operator hook with no route behind it.
- **`file.deleted`, `product.deleted`, `receipt.deleted`** — search-index removal
  listeners that nothing ever fires. Deleting these entities leaves them in the index.

### Dashboard blind spots — ✅ closed

**Was:** four live events rendered as **"Unclassified job"** for want of a
`taxonomy.ts` entry — `retrieval.query` (586 of them on a live appliance),
`embed.unfurl-sweep-request`, `file.preview-sweep-request` and
`maintenance.derivation-run-request`. Measured: 587 of 9,557 jobs carried no
category, and **54% of everything on the Completed tab**.

All four now have descriptors, and the fallback descriptor no longer borrows a
real category: an unknown event resolves to the `unclassified` sentinel rather
than to `maintenance`. That mattered because the dashboard used to contradict
itself — those rows displayed "Maintenance" in the Category column while
selecting *Maintenance* resolved category → event names out of `JOB_TYPES` and
returned none of them.

(`communication.created` was never in this set; it is generated by
`searchIndexTypes()` and additionally disambiguated by `JOB_TYPES_BY_QUEUE`.)
Conversely, ~14 `JOB_TYPES` entries describe legacy `graph.*` events with zero
references anywhere in the codebase, and four describe orphaned events that can
never produce a job.

### Counting traps

- **Dead letters count as pending.** A dead-lettered job is inserted in state
  `created`, identical to work that is waiting to run. Every "pending work"
  aggregate must exclude the queue **by name** — on a live appliance that was
  1,191 of a reported 13,907 "pending" jobs, each of which *also* counted under
  "failed" on its original queue.
- **The reaper loses the originating queue.** `ci.pipeline_dead_letters.queue` is
  fed `j.name`, but the `WHERE` pins `j.name = 'dead-letter'` — so every row
  reads `queue = 'dead-letter'`. pg-boss's dead-letter insert never carries the
  source queue name onto the DLQ row, so it is not recoverable at reap time.
- **Fetch failures are structurally invisible.** pg-boss's `manager.fetch` wraps
  its query in an **empty catch** and returns `rows || []`. The defensive
  `try/catch` around `boss.fetch()` can essentially never fire, so a database
  outage presents to the worker loop as an empty queue: 5 s backoff, no log, no
  metric.
- **`last run` is not `last success`.** The wrapper stamps `ci.cron_runs` twice
  for exactly this reason; read the success column.
- **`pgboss.schedule` is permanently empty** while ~53 real crons run beside it.

### Structural notes

- **In-process state that a split topology breaks.** `SmartRotationService`'s
  round-robin user cursor, `SyncOrchestrator`'s `orchestrating` flag,
  `BlueBubblesSyncCron`'s `running` flag, `MaintenanceOrchestratorService.isRunning`
  and `StageArrivalListener`'s coalescing Set are all per-process. Under
  `CI_ROLE` split or multiple replicas each process keeps its own; the pg-boss
  `singletonKey` is the only real mutex.
- **The dead-letter queue name is duplicated** as a literal in
  `events/constants.ts:15` and `pipeline/constants.ts:75`, with a comment
  claiming the canonical one is not importable. It *is* exported — it is just not
  re-exported from the domain barrel. A drift makes the reaper harvest nothing,
  forever, silently.
- **Unbounded scans on short cadences**: `ActivityRollupCron` (8 full-table
  aggregates / 15 min), `AnswerInferenceCron` (a CROSS JOIN every minute),
  `JobMetricsCollector.sample` (a full ungrouped scan of `pgboss.job` / 5 min),
  `ImportStageListener.sweepOnSchedule` (`WHERE finished_at IS NULL` with a
  LATERAL and three EXISTS subqueries, no LIMIT, / 5 min),
  `SyncOrchestrator.orchestrateSyncJobs` (unfiltered `find()` with eager
  relations, every minute).
- **Unbounded per-user fan-outs**: all five planning crons, all nine
  `PythonFunctionCrons`, `FeedQueueCron`, `DerivationCron`, `TurnFragmentCron`
  and `EntityTypeAuditCron` call an unfiltered user list and send one job per
  user with no per-tick cap. `InitialActionsCron` is the counter-example worth
  copying: `LIMIT 25` in SQL.
- **`CI_QUEUE_SUPPRESS`** is read straight off `process.env`, appears in no
  config file and no `.env.example`. It drops sends in both the fan-out and the
  explicit-queue path, and makes `sendMany` refuse loudly rather than silently.

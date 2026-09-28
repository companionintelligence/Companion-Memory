# The jobs system — reference

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

What every background job on this appliance is, what it does, and how the machine
that runs it works. Read against the worktree at the time of writing; every claim
carries a `path:line`. **Counts re-verified against `main` @ `cee410cf1`
(2026-09-16)**, by re-running the same greps as the prior pass (`@OnEvent`/`@Cron`
decorator bodies, resolving each `queue:` value back to its string constant) —
see the prior commit for the method. That prior recount (checked 2026-09-01,
against #2514/#2519/#2522/#2523/#2524/#2525) is 218 commits behind as of this
pass, far too many to name individually, so this note cites the SHA instead of a
PR list. Companion documents: [`jobs-schedule-review.md`](jobs-schedule-review.md)
(a point-in-time critique of the schedule), [`jobs-system-rebuild-plan.md`](jobs-system-rebuild-plan.md)
(the pipeline design), [`runbooks/jobs-system-review-2026-08.md`](runbooks/jobs-system-review-2026-08.md).

## At a glance

| | |
|---|---|
| Queue engine | pg-boss 10, schema `pgboss`, **its own cron scheduler disabled** (`schedule: false`) |
| Listener bindings | **119** `@OnEvent` methods across 59 files |
| Distinct event names consumed | **99** |
| pg-boss queues created at boot | **42** (41 from listeners + `dead-letter`) |
| Scheduled methods | **59** `@Cron` methods across 34 files — all via the `@ci/common/schedule` wrapper |
| Crons pinned to the worker role | **14** |
| Queues pinned to the worker role | **6** (5 import + `derivation-run`) |
| Pipeline stages behind one `pipeline.slice` event | **43** |
| Global in-flight ceiling | 10 jobs **per process**; 6 per queue |
| Per-job execution deadline | queue's own `expireInSeconds`, else **7200 s** — see §1.11 |

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
| `expireInSeconds` | how long an `active` job may run before pg-boss expires and retries it — **and, since the in-process deadline landed, how long the listener itself gets (§1.11)** | constructor `expireInHours: 12` in pg-boss; `queues.jobTimeoutSeconds` (2 h) in-process |
| `retentionMinutes` | how long an **unfinished** (`created`/`retry`) job survives before the archive sweep discards it — see §1.7 | `WORK_QUEUE_RETENTION_MINUTES`, 90 d |
| `retryLimit` / `retryDelay` | retries before dead-lettering; seconds between them | 3 / 10, with backoff |
| `localConcurrency` | in-process worker slots for this queue — **can only lower**, never raise | `queues.perQueueConcurrency` (6) |
| `role` | which process **consumes** this queue | `web` |
| `lane` | name of a slot pool shared with other queues: members draw from ONE in-process semaphore sized to the smallest member's `localConcurrency`. The four Ollama-bound background queues share `ollama-background`, so at most one background generation is at the runner at a time | none (own semaphore) |
| `yieldsTo` | name of a yield gate (`yieldGates.ts`); while it says "yield", the loop takes no new lease — jobs stay `created` like `paused`, the running job finishes. `image-description` names `interactive-chat`, which closes while any thread has a chat turn queued/running | none (never yields) |

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
own hand-rolled poller ([`PGBossEventService.work()`](../backend/apps/api/src/domains/events/services/PGBossEventService.ts)):

```
while (running):
  if perQueueSemaphore.free == 0:  sleep 150ms;  continue      # backoffWhenFull
  reserved = globalSlots.reserve(min(perQueueSemaphore.free, 10))
  if reserved == 0:  wait for a release (≤150ms);  continue    # backoffWhenFull
  jobs = boss.fetch(queue, { batchSize: reserved })
  globalSlots.release(reserved - jobs.length)                  # short fetch
  if jobs is empty: sleep 5000ms;  continue                    # backoffWhenEmpty
  for job in jobs:
     void perQueueSemaphore(() => runJob(queue, job))          # NOT awaited
        .finally(() => globalSlots.release())
```

Two nested `p-limit` semaphores, plus a reservation in front of the fetch. The
**per-queue** slot is held for the job's whole lifetime; `runJob` acquires the
**global** slot inside it. So a job holds one of each while executing, and one
queue can never starve another.

The global half of the *fetch* decision is a claim
([`jobSlotPool.ts`](../backend/apps/api/src/domains/events/jobSlotPool.ts)), not
a reading of the limiter's counters, and that distinction is load-bearing. All
~41 loops are started un-awaited in one synchronous pass and each runs as far as
its first `await boss.fetch(...)` before any of them has dispatched anything — so
a *read* showed every loop the same ten free slots, and every loop fetched
against them. `fetch` takes the pg-boss lease, so the surplus rows went to state
`active` (on their `expireInSeconds` clock, and counted by the console's
"Running" tile) while sitting in a semaphore waiting for a slot. The pool grants
its ten slots synchronously and holds each one until the row reaches a terminal
outcome, so **rows leased never exceed the global cap**, not merely rows
executing. It reads its ceiling from `globalSemaphore.concurrency`, so a runtime
change from the Controls card moves both together.

| Knob | Config path | Env | Value |
|---|---|---|---|
| Global in-flight ceiling | `queues.concurrency` | `CI_QUEUE_CONCURRENCY` | **10** |
| Per-queue ceiling | `queues.perQueueConcurrency` | `CI_QUEUE_PER_QUEUE_CONCURRENCY` | **6** |
| Fetch batch cap | `queues.fetchBatchSize` | `CI_QUEUE_FETCH_BATCH_SIZE` | **10** |
| Fallback job deadline | `queues.jobTimeoutSeconds` | `CI_QUEUE_JOB_TIMEOUT_SECONDS` | **7200 s** |
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
fetch, complete, fail and send across all ~41 polling loops.

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

**The delivered payload is the domain's, verbatim.** The dispatcher strips
`name` — the routing key — and adds nothing else. The queue's own job id is
`ack.jobId`, and that is the id `completeJob` / `failJob` expect. A listener
that reports completion out-of-band (`autoAcknowledge: false`) must read it
from the acknowledgement, never from the payload.

It used to be merged in as `jobId`, which meant the bus wrote into a namespace
it does not own: any domain that named a field `jobId` silently lost it.
`domains/agent` declares one on five payload types meaning the `ci.agent_jobs`
row, so the dispatch listener rang OpenClaw's doorbell with pg-boss's id
instead — the harness 404'd fetching its packet and the stale reaper closed the
job reporting that it had never checked in.

`autoAcknowledge: true` (default) wraps the handler: return → `ack.done()`,
throw → `ack.fail()`. `autoAcknowledge: false` hands the handler an `ack` and it
must call `done` / `fail` / `defer` itself; the wrapper tracks whether it did and
fails the job as a fallback if it threw without acknowledging, because
EventEmitter2's `suppressErrors: true` would otherwise eat the exception and leak
the worker slot.

**Every execution is bounded.** `runJob` races the listener against a deadline —
the queue's own `expireInSeconds` where it declares one, otherwise
`queues.jobTimeoutSeconds` (2 h), floored at 60 s — and on expiry rejects with a
`JobTimeoutError` into the existing `catch`, so the timeout inherits the ordinary
retry and dead-letter policy and releases all three slots (per-queue semaphore,
global semaphore, `JobSlotPool`) through the same `.finally()` chain a normal
failure does. It is logged at `error` level naming the queue, job id and event.
Nothing bounded this before, and pg-boss's `expireInSeconds` is not a substitute:
that re-queues the row in Postgres, it cannot release a semaphore inside this
process. A listener that neither resolved nor rejected therefore held its three
slots until the process restarted — which presented as a queue that had quietly
stopped, with nothing in the log to say why.

Deferred jobs are not affected: `ack.defer()` settles the promise promptly with
outcome `deferred`, so the deadline is already cleared by the time the external
executor starts working. Liveness from there is pg-boss's `expireInSeconds`,
which is why `py-fn-hbpe` declares ~8 h.

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

**…and to a job that never ran.** The same archive statement carries a third
predicate, and it is the one that costs work rather than history:

```sql
OR (state < 'active' AND keep_until < now())
```

`state < 'active'` is the state enum's ordering, so it covers **`created` and
`retry`** — jobs that have never completed. `keep_until` resolves as
`start_after + COALESCE(job.keep_until, queue.retention_minutes * 60, constructor keep_until default, '14 days')`.

| Stage | Mechanism | Window |
|---|---|---|
| `created`/`retry` → `pgboss.archive` | `retentionMinutes` on the queue row | `start_after` + **90 d** |
| `pgboss.archive` → deleted | `deleteAfterHours: 24` | +24 h |

That path **logs nothing, raises nothing, and never routes to `dead-letter`** —
the job is simply gone, with no record that it existed. Until
`retentionMinutes` was stamped onto every work queue all three COALESCE terms
were NULL and the window was pg-boss's **14-day** fallback, so a queue an
operator paused for a fortnight — or a bulk-import fan-out that outlived one
behind a stalled Ollama — silently lost its oldest jobs.
`WORK_QUEUE_RETENTION_MINUTES` (90 days) is now written onto every queue by
`createQueue` **and** `updateQueue`; the second call is the one that back-fills
appliances whose queue rows already exist, because `createQueue` is a no-op on
an existing queue.

Units matter here and only one survives the trip: pg-boss v10 destructures
`retentionMinutes` alone, and its `create_queue` reads
`options->>'retentionMinutes'` — a `retentionDays` is dropped on the floor and
reads as a fix that did nothing. A queue wanting a different window declares
`queueOptions.retentionMinutes` (§1.1); the appliance-wide 90 days is a code
constant rather than a config key, because there is no appliance workload for
which losing queued work *sooner* is the better outcome.

This is also the horizon on the pause control described at §1.3: `paused` costs
a backlog rather than work, but only for 90 days.

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
**All 59 decorator sites use it** — no non-test file imports the `Cron` symbol
from `@nestjs/schedule`. It adds three things Nest's own wrapper does not:

- a `ci.cron_runs` stamp keyed on the registry name — **twice**: an attempt stamp
  before the body (so a hung or throwing tick still counts as fired) and a
  success stamp after it returns. A schedule that fails every tick is otherwise
  indistinguishable from a healthy one on the dashboard.
- a `traceId` in `ContextService` for the whole tick.
- an error log that names the failing schedule. Nest catches one frame further
  out and logs `SchedulerRegistry` with no schedule name; with 59 scheduled
  methods, "something in the scheduler threw" is not a diagnosis.

The tick is swallowed after logging, matching the framework's behaviour: the tick
is lost, the schedule keeps running.

> The wrapper's own docstring still says "~34 scheduled methods". It is 59.

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

### 1.11 The execution deadline — and why 34 queues had one imposed on them

Two different clocks bound a job, and they are not interchangeable.

| | `expireInSeconds` (pg-boss) | the execution deadline (`runJob`) |
|---|---|---|
| Where it runs | Postgres, on the `pgboss.job` row | in this process, `Promise.race` in [`withDeadline`](../backend/apps/api/src/domains/events/services/PGBossEventService.ts) |
| What it does | flips an `active` job back to `retry` once `started_on + expire_in < now()` | rejects the listener's promise with `JobTimeoutError` |
| What it frees | the queue row | the global slot, the per-queue slot and the `JobSlotPool` slot |
| What it cannot do | reach into the worker | **stop the work** |

The second one is the newer of the two and exists because the first was not
enough: `executeJob` resolves only when the listener acknowledges, so a listener
that neither resolved nor rejected — a `fetch` with no timeout, an Ollama
generation that hung — held all three slots for the life of the process, with no
log. Enough of those on one queue and it silently stops fetching. Expiring the
row in Postgres does nothing about that; the semaphore is in Node.

**A timed-out listener is abandoned, not killed.** `Promise.race` has no cancel.
The losing side keeps running — same sockets, same file handles, same open
transaction, still writing — while its three slots have been handed back and
pg-boss has re-queued the row for retry. So the deadline firing on *healthy*
work does not stop that work; it adds a second copy of it alongside. On a queue
whose `localConcurrency` is a safety property rather than a throughput knob
(`import-unpack` is 1 so two archives' disk preflights cannot both pass and then
jointly fill the volume; `import-push` is 1 because two runs resolving the same
person at once is an untested dedup path), that is precisely the state the
number exists to prevent. **A too-short deadline is not a milder version of a
too-long one. It is a different, worse failure.**

#### The default, and what it silently changed

`jobDeadlineMs` takes the queue's own `expireInSeconds` where there is one, and
otherwise `queues.jobTimeoutSeconds` — **7200 s (2 h)**, `CI_QUEUE_JOB_TIMEOUT_SECONDS`,
floored at `MIN_JOB_DEADLINE_MS` (60 s) so a misconfigured tiny value cannot
dead-letter the whole appliance.

The trap is that the fallback did not fill a gap. A queue declaring no
`expireInSeconds` was never unbounded: pg-boss resolves expiry as
COALESCE(job, queue row, constructor default) and the constructor says
`expireInHours: 12`. So for all 34 queues that declared nothing, the effective
bound went **12 h → 2 h**, with nothing saying so. For most of them the change
is invisible — their unit of work is two orders of magnitude inside two hours.
For the import lane it was not: an unpack alone is documented at an hour for a
350 GB Takeout, before parse, media and push have started. Those five now
declare 12 h of their own ([`IMPORT_STAGE_EXPIRE_SECONDS`](../backend/apps/api/src/domains/import/constants.ts)),
which restores exactly the bound they already had and puts the number where a
diff can see it. [`importStageQueueExpiry.test.ts`](../backend/apps/api/src/domains/import/__tests__/importStageQueueExpiry.test.ts)
pins it, parsing both `expireInHours` and the fallback out of the files that set
them so the assertion cannot be reverted along with the fix.

Deadlines are **not** how liveness is detected on the import lane, and never
were: `ImportStageListener` heartbeats the stage claim every 30 s and
`ImportRunService.resumeInterrupted` re-enqueues anything silent for
`STALE_STAGE_MINUTES` (10), on boot and every fifth minute. That reads a signal
the work itself emits and catches a wedged stage in minutes; the deadline is the
catastrophe backstop underneath it, sized to be unreachable by healthy work.
`runStage` also claims through `beginStage`, so a redelivery of a stage a live
owner still holds logs and returns instead of doing the work twice — which
bounds the damage of an expiry without making one harmless.

#### The 34 queues that declared nothing, and the verdict on each

| Queue | Unit of one job | 2 h? |
|---|---|---|
| `import-unpack` | `unzip` a whole archive after a disk preflight — **an hour for 350 GB** | ❌ **12 h declared** |
| `import-parse` | walk and parse the extracted tree; long synchronous stretches, 1 slot appliance-wide | ❌ **12 h declared** |
| `import-media` | every photo/voicemail in the export into the object store — the longest leg of a photo export | ❌ **12 h declared** |
| `import-push` | every staged row into `ci.*`; bounded by row count, not archive size | ❌ **12 h declared** |
| `import-stages` | pre-split drain — carries a whole unpack or parse enqueued by an older release | ❌ **12 h declared** |
| `pipeline-index` / `-enrich` / `-embed` | one slice (`DEFAULT_SLICE_SIZE` 200, **sized at ~60 s**) or one sweep hop (≤5 slices, then re-enqueues itself) | ✅ 120× headroom |
| `search-index` | one `ci_search` upsert for one entity | ✅ |
| `default` | one saved-search seed / home confirm / graph upsert / `file.uploaded` drain | ✅ |
| `feed-queue` | one `action.created` or `summary.created` row | ✅ |
| `telemetry` | one `tool.invoked` / `retrieval.query` row | ✅ |
| `people-linking` | participant resolution for one communication | ✅ |
| `memory-file-entity` | one idempotent graph File-node upsert | ✅ |
| `context-prompt-persist` | one prompt row | ✅ |
| `import-inbox-provision` | create one user's inbox drop folders | ✅ |
| `cv-detections` | — **no producer; the queue is dead** | ✅ vacuously |
| `geocode` | `geocoding.batchSize` (200) at `rateLimitPerSecond` (10) ≈ 20 s | ✅ |
| `estimate-location` | `DEFAULT_ESTIMATE_BATCH_LIMIT` (500) in one set-based `UPDATE` | ✅ |
| `media-dimensions` | deprecated shim — emits one sweep, writes nothing | ✅ |
| `unfurl-sweep` | starts a sweep (cap 20 000 ids) and returns — enqueues, does not process | ✅ |
| `file-preview-sweep` | starts a sweep and returns | ✅ |
| `search-index-backfill` | maps 7 wire types to stage pairs and starts a sweep each | ✅ |
| `graph-edge-backfill` | maps source names to `promote.edge_*` stages and starts a sweep each | ✅ |
| `person-stub-backfill` | post-push people pass: walks the **whole corpus** back to the account's first communication in a `while` loop over unbounded 7-day windows, each internally paginated (`for (;;)`) — synchronous in the listener, no sweep/re-enqueue to spread the work | ❌ **no budget declared** — same shape the import lane needed 12 h for, but never given one |
| `image-description` | one vision generation for one preview, 1 slot | ✅ *and the case the deadline is for* |
| `thing-vision` | one Ollama vision pass for one upload, 1 slot | ✅ *ditto* |
| `browser-activity-insight` | one insight pass for one page visit, 1 slot | ✅ *ditto* |
| `document-parsing` | text extraction for one file, via the parser sidecar | ✅ *ditto* |
| `file-preview-generation` | one file → one 300 px JPEG preview, returns early if one exists | ✅ |
| `planning` | one of six per-user passes, LLM-bound, 1 slot | ✅ |
| `smart-rotation` | one work type for one user — **all ten inert while `smart.rotation` is false** (the default) | ✅ |
| `etl` | ONE provider cursor page (`nextCursor` in, `results.nextCursor` out), or one job's transform | ✅ |
| `derivation-run` | one user's graph aggregate — set-based SQL over `ci.relationships`, 1 slot, worker role | ✅ |

Seven queues already declared a budget and were never touched by the fallback:
`agent-memory` 300 s, `llm` 900 s, `llm-background` 600 s, `py-fn-summary` 1800 s, `ingest-coalesce`
3600 s, `agent` 7200 s, `py-fn-hbpe` `HBPE_LABEL_BUDGET_SECONDS +
HBPE_POST_LABEL_SECONDS` (~8 h, pinned by [`hbpeQueueExpiry.test.ts`](../backend/apps/api/src/domains/python-functions/__tests__/hbpeQueueExpiry.test.ts)).
With the import five, **12 of the 41 now state their own; 29 take the 2 h
fallback.**

The lever for a queue that outgrows two hours is its own `expireInSeconds`, not
`CI_QUEUE_JOB_TIMEOUT_SECONDS` — raising the appliance-wide fallback widens the
wedge window for all 29 to buy headroom for one. Lowering it is only honest
after reading that queue's p95 out of `ci.job_metrics`, and is likewise a
per-queue edit. pg-boss asserts `expireIn / 3600 < 24`, so no queue may state a
day or more.

---

## 2. Queues

42 pg-boss queues. `default` is created unconditionally even with zero listeners;
`dead-letter` is created separately, before the loop, and is deliberately absent
from the discovered set — which is why no worker starts on it and why
`send(…, { queue: 'dead-letter' })` is refused with a warning.

Everything not stated inherits: `policy standard`, `retryLimit 3`, `retryDelay 10`
(with backoff), `expireInHours 12`, `retentionMinutes 129600` (90 d),
`localConcurrency 6`, `role web`.

The **Expire** column below is now load-bearing twice over: it is both pg-boss's
row-level expiry and the in-process execution deadline, and a blank one means
2 h rather than 12 — see §1.11 for the per-queue reasoning behind every blank.

| Queue | Slots | Role | Policy | Expire | Carries |
|---|---|---|---|---|---|
| `search-index` | 6 | web | — | — | **56 bindings.** Every entity create/update/delete → `ci_search` |
| `default` | 6 | web | — | — | `user.created` (saved searches), `answer.created` (home confirm), `graph.node.upserted`, `graph.relationship.upserted`, `file.uploaded` (legacy drain) |
| `pipeline-index` | 6 | web | — | — | Postgres-bound slices + sweeps; the pipeline control queue (arrivals, dead-letter reap) |
| `pipeline-enrich` | 6 | web | — | — | Slices + sweeps for CPU / object-store / metered-provider stages |
| `pipeline-embed` | 6 | web | — | — | Slices + sweeps for the Ollama-bound embed family |
| `planning` | 6 | web | `short` | — | The six `planning.*` jobs |
| `llm` | **1** | web | `short` | **900 s** | `chat.generate` only — the interactive slot; priority cannot preempt, so nothing else may run here |
| `llm-background` | **1** | web | `short` | **600 s** | `chat.summarization`, `infer.question.answer`; `yieldsTo: interactive-chat` |
| `image-description` | **1** | web | `short` | — | `preview.generated`, `file.image-description-backfill-request`; `yieldsTo: interactive-chat` |
| `thing-vision` | **1** | web | — *(deliberate)* | — | `file.uploaded` → Ollama vision "thing" pass; `yieldsTo: interactive-chat` |
| `browser-activity-insight` | **1** | web | — *(deliberate)* | — | `browseractivity.created` → Ollama insight pass; `yieldsTo: interactive-chat` |
| `agent-memory` | **1** | web | `short` | **300 s** | `agent-memory.turn-fragments` |
| `agent` | 6 | web | `short` | **7200 s** | `agent.task.dispatch` → OpenClaw. **Deferred completion** — stays `active` until checkpoint/complete |
| `derivation-run` | **1** | **worker** | `short` | — | `maintenance.derivation-run-request` |
| `import-unpack` | **1** | **worker** | `short` | **43 200 s** | `import.stage` (unpack) |
| `import-parse` | **1** | **worker** | `short` | **43 200 s** | `import.stage` (parse) |
| `import-media` | **2** | **worker** | `short` | **43 200 s** | `import.stage` (media) |
| `import-push` | **1** | **worker** | `short` | **43 200 s** | `import.stage` (push) |
| `import-stages` | **1** | **worker** | — *(deliberate)* | **43 200 s** | Legacy drain + deleted-stage fallback |
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
| `person-stub-backfill` | 6 | web | — | — | `maintenance.person-stub-backfill-request` → stub `Person` + identifier for unresolved communication participants (`PushStage` post-push kick, import) |
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

119 bindings over 99 event names. Search-index jobs are collapsed into one row —
all 56 are mechanically identical.

### Search index — 56 bindings, queue `search-index`

One listener per entity per verb, all writing `ci_search`. Entities:
`note`, `event`, `item`, `place`, `person`, `concept`, `content`, `answer`,
`thread`, `message`, `communication`, `browseractivity`, `position`, `product`,
`receipt`, `file`, `task`, plus `agent-memory` (created/deleted only),
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
| `chat.summarization` | `llm-background` | Sidebar title for an unnamed thread. Try/caught and only logged — never retried | Chained from a successful `chat.generate`, only when the thread has no name |
| `infer.question.answer` | `llm-background` | Infer a first-person answer to an unanswered profile question from what the appliance knows, rather than asking. Embedding call + `ci_search` query + generation, 60 s timeout | `AnswerInferenceCron` (flag off) or `SmartRotationListener` (flag on) |
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
| `planning.fire_reminders` | `planning` | Claim-and-deliver tick for due reminders | `PlanningJobsCron.fireReminders`, every minute |
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

59 `@Cron` methods. All use the wrapper. Expressions are 6-field (second-first)
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
| `0 */10 * * * *` | `BlueBubblesSyncCron.runOnSchedule` | **worker** | iMessage pull for the first onboarded account. Guard is a claim on the config row (`BlueBubblesConfigService.claimSync`), not an in-process flag — the old per-process flag couldn't span the web/worker split and double-ran |

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

### Planning — all six gated on `planning.enabled` (default true), all **5f**

| Schedule | Registry name | Cadence |
|---|---|---|
| `0 6 * * *` | `PlanningJobsCron.todoScan` | daily 06:00 |
| `0 */6 * * *` | `…todoProcess` | every 6 h |
| `*/30 * * * *` | `…inboxScan` | every 30 min |
| `15 * * * *` | `…eventNow` | hourly :15 |
| `45 * * * *` | `…verifyDone` | hourly :45 |
| `* * * * *` | `…fireReminders` | every minute |

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
| `53 17 * * * *` | `DeterministicPersonMergeCron.drain` | Hourly per-user drain of deterministic person merge candidates (shared email, adjudicated exact phone, exact LinkedIn profile URL). Keyset-paged, re-adjudicates the live rows before every merge (phone pairs against the owner's live phone corpus) and demotes a pair that no longer qualifies; a phone pair is never folded into the self Person. 10 min per user, 45 min per tick, `exclusive`. **Disabling it is the kill switch for the phone and profile-URL tiers** — the People page's on-read fold reads the same setting and keeps folding email pairs only |
| `20 15 * * * *` | `ConsumptionSweepCron.sweepOnSchedule` | Hourly reaper for `ci.consumption_windows` / `ci.consumed_nonces` — deletes rows idle past the rate-limit/nonce windows they serve (60× the 60 s rate-limit window, 12× the 5 min signature lifetime). In-process re-entrancy guard |
| `20 40 3 * * *` | `SyncWindowSweepCron.sweepOnSchedule` | Daily PowerSync retention: clears `sync_period` on `ci.events` / `ci.entities` rows older than the 30-day device window. Ages rows out of sync, does not delete them. In-process re-entrancy guard |

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
| `0 20 3 * * *` | `ImageDescriptionSweepCron.sweep` | none | Daily safety net for "Describe images" defaulting on (plus one run 30 s after boot): re-checks the live vision-capability flag per candidate user and re-fires the backfill request, idempotent on the same singleton key the setting's own toggle uses |
| `43 * * * * *` | `AgentDispatchStaleCron.failStale` | none | Every minute — closes OpenClaw dispatch jobs stuck `queued` >2 min or `running` >15 min |

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
- **`pgboss.schedule` is permanently empty** while ~59 real crons run beside it.

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
- **Unbounded per-user fan-outs**: all six planning crons, all nine
  `PythonFunctionCrons`, `FeedQueueCron`, `DerivationCron`, `TurnFragmentCron`
  and `EntityTypeAuditCron` call an unfiltered user list and send one job per
  user with no per-tick cap. `InitialActionsCron` is the counter-example worth
  copying: `LIMIT 25` in SQL.
- **`CI_QUEUE_SUPPRESS`** is read straight off `process.env`, appears in no
  config file and no `.env.example`. It drops sends in both the fan-out and the
  explicit-queue path, and makes `sendMany` refuse loudly rather than silently.

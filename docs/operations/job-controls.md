# Job controls — turning Memory's work down without turning it off

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

CI-Server left to itself will use a machine. Import fan-out, embeddings, image
description and the nightly HBPE run are all real work, and none of them ask
first. Until now the only way to make it stop was an environment variable and a
restart: `CI_QUEUE_CONCURRENCY`, `CI_QUEUE_PER_QUEUE_CONCURRENCY`,
`CI_QUEUE_SUPPRESS`. All three are read once at boot, none are reachable from the
UI, and the last is a bulk-import escape hatch an operator is expected to set,
restart into, and then remember to unset.

The Jobs page now has a **Controls** card that does the same job durably. The
settings live in `ci.job_settings`, survive restarts, and are read by every
process a few seconds after they change.

---

## The three off-states, and why there are three

| State | Enqueue | Execute | What it costs |
|---|---|---|---|
| **On** | yes | yes | — |
| **Pause** | yes | **no** | A growing backlog. Nothing is lost. |
| **Off** | **no** | **no** | New work is **dropped** and does not come back. |

**Pause is the one to reach for when a box is hot.** The workers stop fetching,
the jobs stay `created` in pg-boss with no lease held, and they run in order the
moment it goes back on.

**Off also stops the enqueue**, which is the whole point of it — a disabled queue
does not accumulate a backlog to be paid off later. The price is that the work
never happens: a note created while `search-index` is off is never indexed, and
switching the queue back on does not go and find it. The card says so, and the
row reports a running count of what has been dropped.

A cron has only two states. A tick that is not taken is simply not taken, so
`paused` would mean nothing for a schedule.

**The Schedules list covers the whole build, not just this process.** Under the
`Procfile`'s split the API runs `CI_ROLE=web` and never registers the eleven
`role: 'worker'` schedules with its own scheduler, so a list read from
`SchedulerRegistry` stopped at the ones the API happens to run — presented under
a plain count, as though it were the total. The list is sourced from
`CronRegistry` (`common/schedule/CronRegistry.ts`) instead, which every `@Cron`
fills in at class-definition time *before* the role gate, so it is complete and
identical in both processes. Rows the answering process does not run carry a
`worker` badge and the card says how many there are.

Those rows are still switchable from the web process: the mode is a
`ci.job_settings` row, every process polls it, and the `@Cron` wrapper in the
worker consults it on each tick. The web process was never unable to *control* a
worker schedule — only unable to name one.

`JobMonitorService.getCronSchedules()` lists them too, carrying exactly what
durable state supports: `lastRunAt`, `lastSuccessAt` and `disabled`, read from
`ci.cron_runs` and `ci.job_settings`, which whichever process ticks has already
written. It carries `overdue` for them too, computed from the declared
expression and timezone against that durable last attempt — the one signal that
says a worker process has died, and the reason listing these rows was worth
doing. What it does not carry is `running` or `nextRunAt`: live scheduler state
this process does not have. `running` is `null` rather than `false` there,
because `false` renders as *stopped*, and a schedule ticking normally in the
worker is the last thing that should read as stopped on the page an operator
opens to find out what stopped. The Schedules table badges them by role instead,
except when they are overdue, which outranks the badge wherever a schedule runs.

`POST /jobs/crons/run` cannot fire across processes — `fireOnTick` is a handle on
a live job — so asking the web process for a worker schedule returns an error
naming the process that can, rather than the empty `{fired: [], skipped: [],
errors: []}` it used to.

### Pause background work

One switch, at the top of the card. It pauses every queue that carries no
interactive work, so chat keeps answering while everything else stops. Nothing is
dropped.

"Interactive" comes from the job taxonomy (`domains/events/taxonomy.ts`) — today
exactly one event, `chat.generate`, and therefore exactly one queue, `llm`. It is
a **queue-level** approximation of a **job-level** property, because the worker
fetches by queue: a queue carrying even one interactive event is spared whole.
Adding an interactive event to a busy queue would quietly exempt that whole queue
from the pause.

---

## Concurrency

Two numbers, and they are ceilings, never floors.

- **Jobs at once, whole appliance.** Default is the shipped
  `queues.concurrency` (10) multiplied by the number of processes that run queue
  workers. See [Why the appliance number is divided](#why-the-appliance-number-is-divided).
- **Jobs at once, per queue.** Default is `queues.perQueueConcurrency` (6). Not
  divided — every queue declares one `role` and is consumed by exactly one
  process, so a queue's semaphore exists in one place however the appliance is
  split.

A per-queue row can lower its own ceiling further. It can never raise it: the
effective cap is the minimum of the global per-queue default, the row's value,
and any `localConcurrency` the queue declared in code. `llm` declares 1 because
two chat generations at once thrash the model — the card shows that as a fixed
number rather than an editable box, since an editable one would be a control that
silently does nothing.

**Nothing an operator can save from this page makes the box hotter than the
build already allowed.** That is deliberate, and it is why every number here is a
minimum rather than an override — including the two global ones, whose maximum is
the shipped figure itself. Both boxes therefore show the same number as their
default and their ceiling: 10 appliance-wide, 6 per queue, on a build that has
not changed `queues.concurrency`.

There is no way to ask for more throughput than the build ships with from this
page, and that is the point: it exists because an unattended appliance drives a
machine to 100% CPU. More capacity is a `CI_QUEUE_CONCURRENCY` change and a
restart — a deliberate act, not a text box on the page you opened because the
fans were loud. A stored value above the ceiling (written by an older build, or
by hand) is clamped on read rather than rejected, and the card says
*Running at N — a lower ceiling applies* rather than echoing the request back.

Changes take effect on a running worker. `p-limit`'s concurrency is live in both
directions: lowering it admits nothing new and lets the jobs already running
finish, which is the behaviour you want from a control you reached for because
the machine was already struggling.

### Why the appliance number is divided

The global semaphore is a **per-process in-memory counter**, not a distributed
lease. Under `CI_ROLE=all` — the single-process topology every test and every
default deployment runs — there is one of them. Under the web/worker split (see
the `Procfile`) there are two, and the appliance-wide ceiling is twice whatever
either process was given.

So a control labelled "at most N jobs at once on this box" has to be divided
before it reaches a semaphore, or it means N on one topology and 2N on the other.
The default is expressed as `shipped × processes` precisely so that it divides
back to the shipped value and **an appliance nobody has configured behaves
exactly as it did before this feature existed.**

The division rounds **down**, so the appliance never exceeds the number typed —
with one exception, stated on the card: a process is never given zero slots, so
an appliance-wide cap of 1 on a split deployment yields 1 per process. A process
with no worker slots is a stopped process, and "cap at 1" must not silently mean
"switch the appliance off".

---

## This caps the queue. Hub caps the container. You usually need both.

They are different ceilings and neither substitutes for the other.

| | CI-Hub `defaultAppCpuLimit` | Memory job controls |
|---|---|---|
| **What it bounds** | The container's share of host CPU (`deploy.resources.limits.cpus` in the generated compose file) | How many jobs Memory **starts** |
| **Where it is set** | Hub → Settings → app defaults, or per-app on the install form | Memory → Jobs → Controls |
| **Default** | Auto-allocated at 75% of the Docker daemon's reported cores (`APP_CPU_FRACTION` in Hub's `resource-allocator.service.ts`), unless a user setting overrides it | `queues.concurrency` × worker processes |
| **What it does NOT do** | Stop Memory queuing thousands of jobs, or stop any individual job from being started | Stop a single runaway job — a `ffmpeg` transcode or a model call — from using every core it is allowed |

Concretely:

- **A generous CPU limit with no queue cap still pegs.** Memory will happily run
  ten concurrent embedding jobs inside a container permitted 75% of the host, and
  75% of the host is what you get.
- **A tight CPU limit with no queue cap still hurts.** The queue keeps stacking
  work the container cannot get through; latency goes up, the backlog grows, and
  nothing on the CPU graph explains why the appliance feels slow.
- **A queue cap with no CPU limit leaves one job unbounded.** Concurrency of 1
  still means one `ffmpeg` or one llama.cpp run with the whole machine available
  to it.

Set the Hub limit to decide how much of the machine Memory may ever use, and the
queue controls to decide how much work it tries to do inside that.

---

## Which jobs refuse to be switched off

Six schedules and one queue, out of 53 and 38. The bar is deliberately high,
because the point of the feature is that the operator is in charge. Something is
on the list only if switching it off would **break the appliance's ability to
tell you it is broken**, or **fail an obligation to the user rather than to the
appliance**.

| Job | Why |
|---|---|
| `JobMetricsCollector.sampleOnSchedule` | Samples the queue depths the Jobs charts draw. pg-boss keeps ~36 hours of working set and no history, so these samples are the only record that yesterday happened. |
| `JobMetricsCollector.purgeOnSchedule` | Retention for `ci.job_metrics`; without it that table grows unbounded. |
| `DeadLetterReaperListener.reapOnSchedule` | Copies exhausted jobs into `ci.pipeline_dead_letters` before pg-boss expires them. |
| `AccountPurgeCron.purgeDueAccounts` | Carries out deletions the user already requested. An obligation to the person, not a workload knob. |
| `StagedUploadPurgeCron.runOnSchedule` | Frees the disk that abandoned uploads sit on. |
| `McpController.reapStaleSessions` | Closes abandoned MCP sessions; each holds a transport open. |
| the `dead-letter` queue | Where failures go to stay diagnosable. Its worker is the reaper. |

The list lives in `domains/events/jobControlPolicy.ts`, with the reason attached
to each entry — the reason is what the API returns and what the UI shows on the
lock. Everything else is switchable, including `llm`: "stop the model" is one of
the most legitimate reasons to open this page.

---

## Where it is enforced

Three choke points, and nothing bypasses them.

| Control | Enforced in |
|---|---|
| Queue mode, enqueue side | `PGBossEventService.send()` / `sendMany()` |
| Queue mode, execute side | the per-queue worker loop in `PGBossEventService.work()` |
| Cron mode | the `@Cron` wrapper at `common/schedule/decorators/Cron.ts` |
| Concurrency | `syncConcurrencyLimits()`, from the worker loop, over the arithmetic in `domains/events/jobConcurrency.ts` |

All 53 scheduled methods go through that one `@Cron` wrapper — importing Nest's
raw `Cron` anywhere outside `src/common/schedule/` is an eslint error — so gating
there is the whole of "the user disabled this schedule".

Reads go through `JobControlStore` (`common/job-controls/`), a process-wide
singleton holding a snapshot refreshed every 5 seconds. It is a singleton rather
than a Nest provider because its two most important readers cannot be injected
into: a decorator, evaluated before any DI container exists, and an enqueue path
that runs once per imported row and cannot afford a database round trip.

**It fails open.** Until the store is configured, and on any read failure, every
getter answers "no opinion" and the appliance behaves as it did before this table
existed. A settings table that cannot be read must not be able to switch the
memory system off. The one refinement: a failure *after* a successful read keeps
the last good snapshot, so a dropped connection cannot un-pause a queue somebody
paused because the box was overheating.

---

## What a disabled job looks like

Deliberately not "nothing".

- The Controls card shows the mode, and for an off queue, a running count of the
  jobs it has dropped and when it last dropped one (`ci.job_settings.skipped_count`,
  batched from an in-memory counter so a bulk import costs one `UPDATE` per queue
  per flush, not one per row).
- The **Schedules** card badges a switched-off schedule `off`, and that badge
  outranks `scheduled` and `overdue`. The scheduler still holds a disabled cron
  and its `nextRunAt` still advances, so without the badge the row would promise
  a 03:00 run that will not happen.
- A disabled cron does **not** stamp `ci.cron_runs`. The gate sits ahead of that
  write, so the dashboard cannot report a fresh "last run" for a tick that was
  never taken.
- `overdue` is forced false for a disabled schedule. A job someone switched off
  is not late, and lighting it up as an alarm teaches operators to ignore the
  column that catches real failures.

---

## Scope

**Appliance-wide.** There is no `user_id` on the settings beyond `updated_by`,
which is provenance rather than ownership: any signed-in user of this Memory
changes the settings for the box.

That is the right model for a single-household appliance and the wrong one for a
shared server. It is also the only model the enforcement points can honour — the
worker loop and the `@Cron` wrapper have no user in scope, and a per-user
concurrency cap could not shrink a semaphore that is shared by everyone's work.

---

## Related

- `docs/runbooks/jobs-system-review-2026-08.md` — how the job system works, and
  what the August review changed.
- `docs/jobs-schedule-review.md` — the schedules themselves.
- companionintelligence/CI-Server#1782 — job priority and interactive LLM
  admission. The priority tiers (`domains/events/constants.ts`) are live and
  independent of this: priority reorders jobs already waiting on the same queue,
  while these controls decide whether the queue runs at all.

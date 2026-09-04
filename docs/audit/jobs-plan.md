# Jobs system — execution plan

Companion to `docs/audit/jobs-audit.md`. Finding ids (J1-J8, U1-U22) refer to that document.

**Target branch base:** `origin/main` @ `7367b26e8` or later. The audit was read at `f26f5b68a`, which is 12
commits behind; Phase 0 exists to close that gap because one of those commits widens J4.

**How to run anything here.** All of it is local — nine of twelve workflows are `workflow_dispatch`-only and
`main` has no required checks, so a green PR page proves nothing.

```bash
# from the worktree root
cd backend/apps/api && yarn test <pattern>     # one suite
make lint                                       # yarn + ruff/mypy, both stacks
make test                                       # everything
```

Do **not** hand-write a migration timestamp — `yarn workspace @ci/be-api migrate:make <name>` stamps real UTC
to the second, and `bin/check-migration-versions.js` rejects collisions. No phase below requires a migration
except the optional one noted in Phase 4.

---

## Dependency graph

```
Phase 0  rebase + re-baseline
   │
   ├──► Phase 1  bounds that stop work loss      (J2, J1)          ← start here
   │        │
   │        └──► Phase 2  bounded shutdown        (J5)   [needs P1's in-flight job-id tracking]
   │
   ├──► Phase 3  dead-letter replay routing       (J3)   [independent of 1 and 2]
   │
   ├──► Phase 4  make the pause switch honest     (J4)   [independent]
   │
   ├──► Phase 5  deferred-completion truth        (J6)   [independent]
   │
   ├──► Phase 6  dashboard tells the truth        (J7, J8) [independent, cheap]
   │
   └──► Phase 7  triage the unverified tier + branch cleanup  [do last: needs 1-6 landed to avoid re-reporting]
```

Phases 3-6 are mutually independent and can run in parallel by different people. Phase 2 is the only hard
dependency edge.

---

## Phase 0 — Rebase and re-baseline

**Why first.** The audit's read baseline is 12 commits stale, and `taxonomy.ts` on `main` now carries six
`interactive: true` entries instead of one — four of which (`agent.task.checkpoint`, `agent.task.completed`,
`agent.task.blocked`, `planning.task_result`) are registered by
`domains/agent/listeners/AgentDispatchListener.ts:56-71` with **no queue option**, so they land on `default`
and make the whole `default` queue exempt from the global pause. Any Phase 4 work planned against the audit's
baseline would fix half the bug.

**Do.**

1. `git fetch origin && git rebase origin/main` in the working worktree.
2. Re-read the four anchors the audit's confirmed findings depend on and confirm the line numbers still
   resolve: `PGBossEventService.ts` (`:328`, `:1110`, `:1181`, `:1203`), `PipelineRunService.ts:1185`,
   `JobMonitorService.ts:483`, `JobQueryService.ts:249`.
3. Re-count `grep -c "interactive: true" backend/apps/api/src/domains/events/taxonomy.ts` and note every
   queue those events bind to — that is Phase 4's real scope.

**Acceptance.** `git log --oneline -1` matches `origin/main`; the four anchors resolve; the interactive-event
list is written into the Phase 4 ticket.

**Effort.** 30 min.

---

## Phase 1 — Stop losing queued work (J2 + J1)

The two missing bounds. Both live in the same two files, so they land as one PR with two commits.

### 1a · Queue retention (J2)

**Files.**

- `backend/apps/api/src/domains/events/types.ts` — add `retentionMinutes?: number` to `QueueOptions`, with a
  doc comment naming pg-boss's 14-day `keep_until` fallback and the fact that `state < 'active'` in
  `archive()` covers `created` and `retry`.
- `backend/apps/api/src/domains/events/services/PGBossEventService.ts:328` — add
  `retentionMinutes: WORK_QUEUE_RETENTION_MINUTES` to the `options` object, **before** the `...queueOptions`
  spread so a listener can still override it. Define the constant next to `QUEUE_RETRY_POLICY` (`:85`) as
  90 days = `129_600`, with the same style of comment the DLQ constant carries at `:290-295`.
- `backend/apps/api/config/default.json` — optional: expose it as `queues.retentionDays` if operators should
  tune it; if not, leave it as a code constant and say why.
- `docs/jobs-system.md` §1.7 — add the unfinished-job path beside the finished-job table: a `created` or
  `retry` job is archived at `start_after + retention`, then dropped `deleteAfterHours` later, with no log
  and no dead letter. Correct the pause-control prose at `PGBossEventService.ts:968-979` if it stays as-is.

**Note.** `createQueue` is a no-op on an existing queue; the adjacent `updateQueue` at `:336` is what
back-fills live appliances. Do not skip it. `retentionDays` is silently dropped by pg-boss v10 — use
`retentionMinutes` only (the DLQ comment at `:290-295` is the precedent).

**Acceptance.**

- New case in `services/__tests__/PGBossEventService.worker.spec.ts` (or a new
  `PGBossEventService.provisioning.spec.ts`): assert every `createQueue` **and** `updateQueue` call recorded on
  the boss mock carries a `retentionMinutes` >= 129600, for a fixture registry with a listener that declares
  no `queueOptions` and one that declares its own.
- Against a real PG18 (a scratch stack, not a shared one): after boot,
  `select name, retention_minutes from pgboss.queue order by 1` returns non-NULL for all 39 rows.
- `grep -n "retention" docs/jobs-system.md` shows the unfinished-job paragraph.

### 1b · Per-job execution deadline (J1)

**Files.**

- `backend/apps/api/src/domains/events/services/PGBossEventService.ts` —
  - Add a `jobDeadlineMs(queue)` helper: the queue's declared `expireInSeconds`
    (`EventListenerRegistry.getQueueOptions(queue)?.expireInSeconds`) where present, else
    `config.queues.jobTimeoutSeconds`. Keep a hard floor so a misconfigured 0 cannot kill every job.
  - `runJob` (`:1110`): `outcome = await withDeadline(this.executeJob(queueName, job), ms, queueName, job.id)`
    where `withDeadline` rejects with a typed `JobTimeoutError` naming the queue, job id and event.
  - The existing `catch` at `:1111` already routes to `failJobQuietly`, so the timeout inherits pg-boss's
    retry and dead-letter policy and releases all three slots via the existing `.finally()` chain — verify
    that path rather than adding a second one.
  - Log the timeout at `error` level: this is the signal that does not exist today.
- `backend/apps/api/config/default.json` — add `queues.jobTimeoutSeconds`. Pick a value larger than the
  slowest queue with no declared `expireInSeconds`. **Today that includes `import-unpack`**, documented at
  `ImportStageListener.ts:122-124` as an hour for a 350GB archive, so either set the default generously
  (e.g. 7200) *or*, better, give the import stage queues an explicit `expireInSeconds` in the same PR and set
  the global default low (e.g. 900).
- `backend/apps/api/src/config/configuration.ts` — matching zod entry. Note the existing trap: the zod
  fallbacks at `:385-387` differ from `default.json`, so set both.

**Deferred jobs are not at risk.** A deferring listener settles the promise promptly with outcome
`'deferred'`; liveness after that is pg-boss's `expireInSeconds`, which is why `py-fn-hbpe` declares 8 h.

**Acceptance.**

- New case in `services/__tests__/PGBossEventService.worker.spec.ts`: register a listener that never
  acknowledges, dispatch one job, advance fake timers past the deadline, then assert (a) `boss.fail` was
  called for that job, (b) `globalSlots` reserved count returns to 0, and (c) a subsequent `boss.fetch` still
  happens on that queue — i.e. the loop kept running.
- A second case: a listener that takes longer than the *global* default but less than its queue's declared
  `expireInSeconds` is **not** killed.
- `cd backend/apps/api && yarn test PGBossEventService` green.

**Effort.** 1 day for both halves including tests.

---

## Phase 2 — Bounded shutdown (J5)

**Depends on Phase 1b**, which introduces the in-flight job bookkeeping this needs.

**Files.**

- `backend/apps/api/src/domains/events/services/PGBossEventService.ts` —
  - Track fetched-but-unfinished `{queue, id}` in a set: add on fetch (`:1021` region), remove in the same
    `.finally()` that releases the global slot (`:1076-1078`).
  - `flush()` (`:1169-1184`): replace the unbounded poll with a deadline of
    `config.queues.shutdownDrainSeconds`. When it expires, `await Promise.allSettled` over
    `boss.fail(queue, id, { message: 'process shut down while active', shutdownAt })` for everything still in
    the set, then proceed to `boss.stop()`. Log a warn naming the count — this is pg-boss's own `failWip`
    behaviour, which is a no-op here because the codebase never calls `boss.work()`.
- `backend/apps/api/config/default.json` + `src/config/configuration.ts` — `queues.shutdownDrainSeconds`,
  default 25.
- `docker-compose.production.yml`, `docker-compose.staging.yml` — add `stop_grace_period` on the `api` and
  `worker` services, comfortably above the configured drain (e.g. `40s`). Today no compose file sets one, so
  Docker's 10 s default SIGKILLs mid-drain.
- `Procfile` — no change; overmind's own stop signal path is unaffected.

**Acceptance.**

- Extend `services/__tests__/PGBossEventService.worker.spec.ts:877-908` (the existing shutdown-ordering test):
  with one job still in flight past the drain deadline, assert `boss.fail` is called for it **before**
  `boss.stop()`, and that `flush()` resolves within the deadline plus a small margin under fake timers.
- `grep -n stop_grace_period docker-compose.production.yml docker-compose.staging.yml` returns both.

**Effort.** Half a day.

---

## Phase 3 — Dead-letter replay routes to one queue (J3)

Independent of Phases 1, 2, 4, 5, 6. This is the change with the widest surface but the clearest shape.

**Files.**

1. `backend/apps/api/src/domains/events/services/PGBossEventService.ts`
   - `sendToQueue` (~`:600`): stamp the target queue into the payload the same way `send()` already stamps
     `name` at `:478` — the payload becomes `{ ...event, name, queue }`.
   - `executeJob` (`:1232`): extend the destructure to `const { name, queue: _queue, ...data } = job.data;`
     so listeners never see the routing field.
   - Anywhere `payloadBytes` or payload projection is computed, confirm the extra key does not break a
     size or schema assertion.
2. `backend/apps/api/src/domains/pipeline/listeners/DeadLetterReaperListener.ts:200`
   - Change the `queue` value from `j.name` to `COALESCE(NULLIF(j.data->>'queue', ''), j.name)`. Leave the
     `WHERE j.name = $1` predicate alone — it is correct, it is what selects DLQ rows.
3. `backend/apps/api/src/domains/pipeline/services/PipelineRunService.ts:1185`
   - Keep the `letter.queue === DEAD_LETTER_QUEUE ? null : letter.queue` mapping for backward compatibility,
     but when it yields `null`, look up `getQueuesForEvent(eventName)`: if the set has more than one member,
     throw the `ConflictException` this method already raises for an unroutable letter, naming the candidate
     queues so the operator can pick one. Only fall through to listener routing for a single-listener event.
   - Correct the comment at `:975-979`, which currently asserts the fan-out is right.
4. `backend/apps/api/src/domains/pipeline/controllers/PipelineController.ts` — optional: accept an explicit
   `queue` on the replay body so an operator can resolve a pre-change letter by hand.
5. `docs/jobs-system.md:733-737` — the lost-queue note currently appears only under "Counting traps"; add the
   replay-routing consequence.

**Pre-change rows are not recoverable.** Every letter already in `ci.pipeline_dead_letters` from the reaper
carries `queue='dead-letter'` and no payload hint; the guard in step 3 is what stops those from fanning out.
Do not attempt a backfill.

**Acceptance.**

- New case in `domains/pipeline/services/__tests__/PipelineRunService.spec.ts` alongside the existing replay
  test at `:1103-1180`: register **two** queues for one event, replay a letter whose payload carries
  `queue: 'q-a'`, assert exactly one `send` to `q-a` and none to `q-b`.
- Second case: replay a letter with no payload `queue` for a two-listener event → `ConflictException`, zero
  sends.
- Third case: single-listener event with no payload `queue` still replays (no regression).
- `cd backend/apps/api && yarn test PipelineRunService DeadLetterReaper` green.
- Manual: on a scratch stack, dead-letter one `python.function.run` HBPE job, replay it from
  `/jobs/dead-letters`, and confirm `py-fn-summary` receives nothing.

**Effort.** 1 day.

---

## Phase 4 — Make "pause background work" mean it (J4)

**Scope is set by Phase 0's re-count**, not by the audit's baseline. On `main` there are two exempt queues to
fix, not one.

**Option A (recommended) — split the interactive events onto their own queues.**

- `backend/apps/api/src/domains/llm/constants.ts` — add `LLM_CHAT_QUEUE = 'llm-chat'` with
  `policy: 'short'`, `localConcurrency: 1`, `expireInSeconds: 900`.
- `backend/apps/api/src/domains/llm/listeners/ChatGenerateListener.ts` — move the `chat.generate` binding to
  `LLM_CHAT_QUEUE`; leave `chat.summarization` (`:24`) on `LLM_QUEUE`.
- `backend/apps/api/src/domains/llm/services/ChatTurnService.ts` — retarget `execute`'s `send`.
- `backend/apps/api/src/domains/smart-rotation/listeners/SmartRotationListener.ts:403` — the cooldown query
  reads back `queue = LLM_QUEUE`; decide whether it should now also count `llm-chat` and update it explicitly
  either way (a silent miss here re-opens the duplicate-generation problem the cooldown exists to prevent).
- `backend/apps/api/src/domains/agent/listeners/AgentDispatchListener.ts:56-71` — give the four
  `agent.task.*` / `planning.task_result` listeners an explicit queue (e.g. the existing agent dispatch queue)
  so `default` stops carrying an interactive event.
- `backend/apps/api/src/domains/events/taxonomy.ts` — no change needed if the events keep their descriptors;
  confirm `JOB_TYPES_BY_QUEUE` does not need a new `::llm-chat` override.

**Option B (if the single GPU slot must be preserved literally) — make the pause job-level.** Import
`describeJob` into `PGBossEventService` and, on a queue flagged interactive while
`JobControlStore.nonInteractivePaused()` is true, complete-without-running (or requeue with `startAfter`) any
fetched job whose own descriptor is not interactive. This is more code and adds a per-job taxonomy lookup on
the hot path; prefer A.

**Then correct the three places that assert the old behaviour** (all of them, or the next reviewer re-derives
the bug): `queueInventory.ts:39-41`, `docs/operations/job-controls.md:79-85`, and
`frontend/apps/web/src/pages/JobsPage/JobControlsCard.tsx:213`.

**Acceptance.**

- `domains/events/__tests__/queueInventory.test.ts`: assert **exactly one** queue reports `interactive: true`,
  by name. This is the regression guard — it is what would have caught the `default`-queue drift.
- `services/__tests__/PGBossEventService.controls.spec.ts:359` — update the fixture: with the global pause on,
  `llm` is paused and `llm-chat` is not.
- Manual on a scratch stack: turn on "Pause background work", watch `ollama ps` / the API log, and confirm no
  `infer.question.answer` generation starts within three minutes (the cron fires at second 55 of every
  minute).

**Effort.** Half a day for the split, +1 h for the `default`-queue half, +1 h for the docs and UI copy.

---

## Phase 5 — A deferred completion that did nothing must say so (J6)

**Files.**

- `backend/apps/api/src/domains/events/services/PGBossEventService.ts:1202-1215` — capture pg-boss's
  `{ jobs, requested, affected }` from `complete()` / `fail()`; when `affected === 0`, log at `error` naming
  queue, job id and requested count, and return a boolean (or throw a typed
  `DeferredJobNotActiveError`) rather than resolving silently. Update the abstract signature on
  `domains/events/services/EventService.ts` to match.
- `backend/apps/api/src/domains/python-functions/controllers/PythonFunctionCallbackController.ts:29-45` —
  answer `409 Conflict` when the completion affected nothing, instead of the unconditional `204`. The sidecar
  stops retrying on any `status_code < 300` (`backend/apps/summary/src/ci/summary/runner.py:190-200`), so a
  409 is what puts the rejection in its log.
- **Attempt token (second commit, optional but recommended).**
  `backend/apps/api/src/domains/python-functions/types.ts:137-143` — add `attempt` to
  `PythonFunctionCallbackBody`; stamp the dispatching job's `retry_count` (available on
  `JobWithMetadata`) into the sidecar request in `PythonFunctionDispatchListener`, echo it back from
  `backend/apps/{summary,hbpe}/src/ci/*/runner.py`, and reject a mismatched callback with 409. This is what
  distinguishes a stale callback from a live re-dispatch, since `plans.js:557` `failJobs` preserves the job
  id across attempts.

**Acceptance.**

- `services/__tests__/PGBossEventService.deferred.test.ts`: boss mock returns `{ affected: 0 }` → error logged,
  method reports failure.
- `domains/python-functions/controllers/__tests__/PythonFunctionCallbackController.test.ts`: unknown `job_id`
  → 409, not 204.
- If the token lands: a callback carrying `attempt: 0` against a job now on attempt 1 → 409, and the Postgres
  results written by attempt 1 are untouched.

**Effort.** 1 h for the `affected` check and 409; half a day more for the attempt token (touches Python).

---

## Phase 6 — The dashboard tells the truth (J7 + J8)

Two small, unrelated fixes; one PR is fine.

### 6a · Disabled schedules stop advancing "Last run" (J7)

- `backend/apps/api/src/domains/events/services/JobMonitorService.ts:478-485` — move
  `const disabled = JobControlStore.cronMode(name) === 'disabled'` **above** the `times` array and exclude
  `memoryLastRunAt` from it when `disabled`. The durable `ci.cron_runs` row is then the only source, which is
  exactly what `Cron.ts:81-85` deliberately refuses to write for a disabled schedule.
- Consider the matching `jobVerdicts.ts` guard: `frontend/apps/web/src/pages/JobsPage/jobVerdicts.ts:178-192`
  raises a critical `never-succeeded` verdict with no `disabled` check at all. Skipping disabled crons there
  closes the residual case where a durable row already exists.

**Acceptance.** New case in `services/__tests__/JobMonitorService.spec.ts` — note the existing `cronRow()`
helper hardcodes `lastDate: () => null` at `:630`, so the test must build a row with a real `lastDate()` and
**no** `ci.cron_runs` entry, and assert `lastRunAt: null`.

### 6b · Backlog chart sums queues instead of averaging them (J8)

- `backend/apps/api/src/domains/events/services/JobQueryService.ts:243-262` — wrap the gauge columns in an
  inner aggregate grouped by `(bucket, queue)` (AVG within the bucket, or `DISTINCT ON` for the last sample
  per queue), then `SUM` those in the outer `GROUP BY bucket`. Leave `completed`/`failed` as `SUM` (deltas)
  and `p95_duration_ms` as `MAX`. Fix the comment at `:245-248`, which describes the intended semantics
  correctly and is contradicted by the code below it.

**Acceptance.** New case in `services/__tests__/JobQueryService.spec.ts` beside the existing history test at
`:625`, with **two queues in one bucket** and no `queue` filter: assert the returned `pending` equals their
sum, not their mean. The existing test is queue-scoped and passes under either implementation, so it is not
a guard.

**Effort.** Half a day for both.

---

## Phase 7 — Triage the unverified tier, then clean up the branches

**Do this last**, once Phases 1-6 have landed, so triage is against code that already carries the fixes.

1. **Triage U1-U22 against `origin/main`, one at a time, before writing any code.** Precedent in this repo: a
   QA sweep run from a stale worktree re-reported 62% already-fixed bugs. Fold U2 into Phase 3, U12 into U7,
   U20 into U5, U21 into U18 — those four are duplicates.
2. **Order the survivors.** Likely first: **U1** (cross-user failure-message exposure — the only unverified
   item with a security shape; verify whether `main` already scopes it), **U3** (role default, which decides
   whether the worker process is doing anything at all), **U5/U18/U21** (test and doc drift, cheap, and each
   one ends a recurring class of staleness by making the registry the source instead of a hand-written list).
3. **Branch cleanup.** All ten stalled branches are already landed — see §5 of the audit. Confirm each with
   the file-scoped diff command there, then delete the remote branches and close draft PR **#2551** (its
   content is a byte-identical duplicate of `clau/jobs-schedules-worker-visibility`, which merged as
   #2546/#2548). Confirm with the branch owners first: multiple agents work these repos in parallel.

**Acceptance.** A triage note recording, per unverified finding, one of: *already fixed on main* / *confirmed,
ticketed* / *refuted*. Zero of the ten branches remain on the remote; PR #2551 is closed.

**Effort.** Half a day for triage, plus whatever the survivors cost.

---

## Salvage

**Cherry-pick: nothing.** All ten stalled branches for this track are already on `main`; each one's diff
against `main`, restricted to the files that branch touches, is empty.

| Abandon and delete | Landed as |
|---|---|
| `fix/jobs-cron-role` | `8f4d8fda2` (#2554) |
| `clau/jobs-controls` | #2519 (main has since evolved it further) |
| `clau/jobs-console-redesign` | verdict band + query-string filters, on main |
| `review/jobs-console` | `SMART_ROTATION_WORK_LABELS` in the backend taxonomy, on main |
| `clau/jobs-doc-recount` | verbatim at `docs/jobs-system.md:6-22` |
| `clau/jobs-schedules-worker-visibility` | #2546 / #2548 |
| `clau/jobs-worker-schedule-history` | superseded by #2548 + #2554 |
| `clau/agitated-herschel-4a432b` | duplicate of the above — **close draft PR #2551** |
| `clau/goofy-albattani-fc24d8` | cron-fire endpoint auth, on main |
| `clau/adoring-varahamihira-ac496c` | `jobSlotPool.ts` + reserve-before-fetch, on main |

Two things worth taking from those branches even though the code is landed:

- `clau/jobs-doc-recount`'s *content* is stale again. `docs/jobs-system.md` now says 109 listeners / 53 crons /
  11 worker crons; the build has **112 / 54 / 12** (audit §1.13). Do the recount as part of U18, and make it a
  test rather than a doc edit so it stops recurring.
- `clau/adoring-varahamihira-ac496c`'s worker-spec comment about invisible slot leaks is the clearest
  statement of J1 in the repo — quote it in the Phase 1b test.

---

## Risks

**R1 — A per-job deadline can kill healthy long work (Phase 1b).** 33 of 39 queues declare no
`expireInSeconds` and inherit the constructor's 12 h. `import-unpack` legitimately runs for an hour
(`ImportStageListener.ts:122-124`) and `py-fn-hbpe` for hours. *Mitigation:* derive the deadline from the
queue's declared `expireInSeconds` first, give the import queues an explicit one in the same PR, and set the
global default only after checking the p95 in `ci.job_metrics` (`JobQueryService.history` reports
`p95DurationMs`). Ship the timeout logging one release before the enforcement if you want observation first.

**R2 — Retention is a live-database write (Phase 1a).** `updateQueue` runs at every boot inside the advisory
lock and mutates `pgboss.queue` on real appliances. `retentionDays` is silently dropped by pg-boss v10 while
`retentionMinutes` is honoured — get the unit right or the change is a no-op that reads as a fix. *Mitigation:*
assert on the recorded `updateQueue` options in a unit test, and verify `select retention_minutes from
pgboss.queue` on a scratch PG18 stack before merging.

**R3 — Splitting the `llm` queue costs GPU serialization (Phase 4).** `llm` is `localConcurrency: 1`
specifically because one Ollama slot exists; two queues at 1 each means two concurrent generations in the
worst case. *Mitigation:* accept it (a chat turn overlapping one background generation is the intended
trade), or take Option B and keep the pause job-level.

**R4 — Stamping `queue` into every job payload changes the payload shape (Phase 3).** `payloadBytes` in
`JobRecordDto`, any snapshot test over `job.data`, and the reaper's
`COALESCE(NULLIF(j.data->>'name',''),'unknown')` all read that object. *Mitigation:* strip the key in
`executeJob`'s destructure so no listener sees it, and grep for `job.data` and `data->>` before merging.

**R5 — Nothing gates a merge in this repo.** No required status checks, `required_approving_review_count: 0`,
and nine of twelve workflows are `workflow_dispatch`-only. Every acceptance check above must actually be run
locally; a quiet PR page is not evidence.

**R6 — Multi-agent worktrees.** Several agents work these repos in parallel and there are ~2,800 lines of
untracked source across sibling worktrees. Never `git reset --hard`, `git clean -f`, or force-push. Before
deleting the ten stalled branches (Phase 7), confirm with their owners. Note also that a sibling worktree
writing through host port 5432 can contaminate a local schema — if a scratch stack shows a schema this branch
never produced, that is the cause, not your change.

**R7 — The unverified tier is not a backlog.** Twenty-two findings were never adversarially checked. Treating
them as a work queue is how a sweep ends up re-fixing landed code. Phase 7 exists so triage precedes coding,
and its acceptance criterion is a per-finding verdict, not a set of commits.

**R8 — Phase 2 changes shutdown behaviour under an orchestrator.** Failing in-flight jobs at drain expiry
makes them retry immediately on the next boot rather than 12 h later — correct, but it turns a silent stall
into a visible burst of retries right after every deploy. Size `shutdownDrainSeconds` and
`stop_grace_period` together, and expect the first deploy after this lands to show a retry spike on the Jobs
page.

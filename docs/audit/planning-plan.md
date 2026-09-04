# Planning subsystem — execution plan

Companion to `docs/audit/planning-audit.md`. Findings are cited as **C1–C5** (confirmed) and
**U1–U34** (unverified — see the audit's Section 4 caveat before you act on any of them).

**Baseline.** Plan against `origin/main`, not the audit worktree. `origin/main` moved three times
during the audit and now carries the `domains/agent/` dispatch stack and the `'delegated'` status;
the audit worktree at `f26f5b68a` has neither. Every phase below assumes a fresh branch off current
`origin/main`.

**House rules that constrain this work.**
- Migrations are hand-written SQL under `backend/apps/api/db/postgres/migrations/`, applied by
  dbmate, and are the source of truth; TypeORM entities follow them. **Never hand-write the timestamp
  prefix** — use `yarn workspace @ci/be-api migrate:make <name>`. `bin/check-migration-versions.js`
  enforces uniqueness in lint-staged and before `yarn migrate`.
- CI is `workflow_dispatch`-only for everything relevant here, and `main` has no required checks.
  Absence of a red check proves nothing — run the suites locally and dispatch the workflow
  deliberately (`gh workflow run <file> --ref <branch>`; see `docs/CI.md`).
- Husky runs whole-workspace lint on commit; pre-existing failures in untouched directories are not
  yours. `--no-verify` is legitimate for that case only.
- Multiple agents work these repos in parallel. No `git reset --hard`, no `git clean -f`, no
  force-push to a shared branch.

---

## Phase 1 — Make the status vocabulary honest, and unbreak task dispatch

**Start here. No dependencies. One PR.** This closes C1 and the `sectionFor` half of U32.

`#2558` widened the task status vocabulary in four TypeScript layers and in zero migrations, so the
value `'delegated'` that `AgentDispatchService` writes is rejected by `tasks_status_check`. A second,
independent bug sits on the same path: the UI sends a `GlobalUID`-encoded task id into a controller
that demands a raw uuid, so the request 400s before the constraint is ever reached. Fix both, or the
Dispatch button stays broken either way.

**Files to touch**

| File | Change |
|---|---|
| `backend/apps/api/db/postgres/migrations/<new>_widen_tasks_status_delegated.sql` | new — drop and re-add `tasks_status_check` including `'delegated'`, in `TASK_STATUSES` order. The **down** leg must `UPDATE ci.tasks SET status = 'open' WHERE status = 'delegated'` *before* restoring the narrow check, mirroring `20260818185920:93-98`; without it the down leg fails on live data. |
| `backend/apps/api/src/domains/agent/controllers/AgentJobsController.ts:31` | decode the incoming `taskId` (accept the global id and resolve to a uuid) **or** relax the Zod shape and decode in the service — pick one, and reject the other form explicitly rather than silently. |
| `frontend/apps/web/src/components/ChatWithAgent/useChatAboutActions.ts:91` | the other side of the same decision: send whichever form the controller now accepts. |
| `frontend/apps/web/src/pages/PlanPage/taskSections.ts:130-159` | add a `delegated` branch to `sectionFor` so a delegated task does not fall through to the dated branch and land in Overdue. |
| `frontend/apps/web/src/pages/PlanPage/Task.tsx` | suppress the Schedule button for `delegated`. |
| `backend/apps/api/src/domains/planning/services/__tests__/TaskService.tenancy.integration.test.ts` (or a sibling integration spec) | assert **every** member of `TASK_STATUSES` round-trips through `update()` against real Postgres. |
| `backend/apps/api/src/domains/agent/services/__tests__/AgentDispatchService.test.ts` | give the mocked `taskService` a `findById` so the `taskId` branch of `dispatch()` is actually exercised; assert the `{ status: 'delegated' }` call. |
| `frontend/apps/web/src/pages/PlanPage/__tests__/taskSections.node.test.ts` | a `delegated` bucketing case. |

**Acceptance check**
1. `cd backend/apps/api && yarn test` — the new integration assertion fails on `main` and passes on
   the branch. Verify it fails first; a test that never went red proves nothing.
2. Against a real PG 18 instance with the migration applied:
   `UPDATE ci.tasks SET status='delegated' WHERE id = …` succeeds, and `migrate:down` on that same
   database succeeds with a delegated row present.
3. `POST /v1/agent/jobs` with the id form the web app actually sends returns 2xx and creates the
   thread + `ci.agent_jobs` row (previously 400).
4. A task in `delegated` renders outside the Overdue lane with no Schedule button.

**Effort:** 3h. **Risk:** low — additive constraint widening, no data rewrite on the up leg.

---

## Phase 2 — Make the Plan board show the user's actual work

**Depends on Phase 1** only for the `'delegated'` status literal in the new status filter (do Phase 1
first, or the filter omits a live status). Closes C2.

The board issues one `tasks(first: 200)` with no `status` argument, the resolver forwards no `limit`
so the whole table is materialized and sliced in memory, and `findAll` orders
`due_at ASC NULLS LAST` — which puts archived past-due proposals at the *front* of the budget and
every undated manually-created task at the *back*, where the cut lands. Nothing purges terminal rows
and nothing surfaces the truncation.

**Files to touch**

| File | Change |
|---|---|
| `frontend/apps/web/src/pages/PlanPage/usePlanTasks.ts:9-37, 137` | add `$status: [TaskStatus!]` to `GET_TASKS` and pass `['proposed','open','in_progress','delegated']`; fetch the Done column with its own separate, capped query (or lazily on tab open). |
| `frontend/apps/web/src/layouts/Main/SecondaryNavigation/usePlanBadgeCount.ts` | same status filter; delete the stale G5 comment once it is no longer true. |
| `backend/apps/api/src/domains/graphql/resolvers/TaskResolver.ts:437` | pass `limit` into `taskService.findAll` so the cut happens in SQL, not in `Paginator`. Consider a resolver-level default excluding `archived` so a future status-less caller cannot re-open this. |
| `frontend/apps/web/src/pages/PlanPage/PlanPage.tsx` | render `totalCount` against the loaded count so residual truncation is visible; or wire `after`/`fetchMore`. |
| `frontend/apps/web/src/pages/PlanPage/__tests__/usePlanTasks.test.ts`, `PlanPage.test.tsx` | fixture with >200 rows, majority `archived` and past-due, asserting every open task still renders. |

Optional follow-on in the same phase if capacity allows: the status/search/sort controls
CI-Planning's `client/src/views/AllTasks.tsx:21-45` ships, which are what actually make a grown
backlog navigable.

**Acceptance check**
1. A fixture of 400 tasks — 250 `archived` with `dueAt` in the past, 150 `open` with `dueAt` null —
   renders all 150 open tasks on the board and in the rail badge. This test fails on `main`.
2. Query log (or a spy on `findAll`) shows `LIMIT` in the emitted SQL, and the resolver no longer
   materializes the full table.
3. The Done column still populates, from its own query.

**Effort:** half-day for the query/limit/visibility work; +1 day with the filter/search/sort controls.
**Risk:** medium — `usePlanTasks` feeds both `PlanPage` and `SchedulePage`'s Possibilities rail
through the same Apollo cache entry; splitting the Done query risks two cache entries disagreeing.
Keep one hook as the single source and let it own both queries.

---

## Phase 3 — Close the task ↔ planned-block lifecycle

**Independent of Phases 1–2; sequence it third because it is the largest backend change.** Closes C3
and, if you take the whole phase, the verified-adjacent U6/U16/U28 (re-verify those three first —
they are Section 4 material).

Today `TaskService.remove` hard-deletes the row, `ci.events.task_id` goes NULL under
`ON DELETE SET NULL`, and the `planned_block` survives as `status='planned'` — invisible to search
and the explorer, unreachable by every `task_id`-keyed repair path, rendered as a ghost chip by
`PlannedBlockService.list`, and still counted as busy by `findInRange`, which is the gap solver's
only occupancy source.

**Files to touch**

| File | Change |
|---|---|
| `backend/apps/api/src/domains/planning/listeners/` (new listener, e.g. `TaskLifecycleListener.ts`) | `@OnEvent(TaskRemovedEvent, { queue: PLANNING_QUEUE, queueOptions: PLANNING_QUEUE_OPTIONS })` → cancel the active block for that `taskId`. **Prefer the listener over calling `PlannedBlockService` from `TaskService`** — `remove` has no such dependency today and adding one risks a cycle with `PlannedBlockService`'s existing `TaskService` injection. Note `PLANNING_QUEUE_OPTIONS` is queue-wide: registering a sixth handler on the same queue must reuse the identical object or `EventListenerRegistry.register` throws at import. |
| `backend/apps/api/src/domains/planning/index.ts` | register the listener. |
| `backend/apps/api/db/postgres/migrations/<new>_cancel_orphan_planned_blocks.sql` | backfill: `UPDATE ci.events SET status='cancelled' WHERE event_type='planned_block' AND task_id IS NULL AND created_by='planning.placer' AND is_deleted = false AND status NOT IN ('cancelled','no_show','skipped')`. The extra predicates keep it consistent with the block queries. Down is a documented no-op. |
| `backend/apps/api/src/domains/planning/services/PlannedBlockService.ts:346` | (U6) after a successful `reschedule` in `scheduleTaskAt`'s existing-block branch, mirror `placeAt` and re-sync `task.scheduledFor` via `planningTime.localDate`. |
| `backend/apps/api/src/domains/planning/services/TaskService.ts` | (U16) close the linked block on `complete`, restore it on `reopen` — or handle both from the same lifecycle listener via `TaskUpdatedEvent`. |
| `backend/apps/api/src/domains/graphql/resolvers/TaskResolver.ts` | (U28) add a `complete` arm to `acceptTaskPendingChange` calling a new `PlannedBlockService.markBlockCompleted`, and route `VerifyDoneService`'s auto branch through the same method so the two paths cannot drift. |
| `backend/apps/api/src/domains/planning/services/__tests__/PlannedBlockService.test.ts` | the three assertions below. |

**Acceptance check**
1. Delete a task that has an active block → `findInRange` over that day no longer reports it
   occupied, and `propose` offers the freed slot. Fails on `main`.
2. `PlannedBlockService.list` returns no chip for the deleted task.
3. Move a placed block to another day → `ci.tasks.scheduled_for` matches the new local date.
4. Complete a task → no active `planned_block` remains; reopen → it returns to `planned`.
5. The backfill migration, run against a database seeded with an orphan, leaves zero rows matching
   the orphan predicate.

**Effort:** half-day for C3 alone; ~2 days for the whole lifecycle set including U6/U16/U28.
**Risk:** medium. The backfill `UPDATE` touches `ci.events` — dry-run the `SELECT` form on a copy of
a real appliance database first and record the row count in the PR. Guardrail 2 means these rows are
not in `ci_search`, so no index repair is needed; guardrail 1 means never touch `duration_minutes`.

---

## Phase 4 — Make automation output visible

**Independent; small; good filler between the larger phases.** Closes C4, and U21 if bundled.

Three automations append to `ci.tasks.notes` and no surface reads it; the modal field labelled
"Notes" writes `description`.

**Files to touch**

| File | Change |
|---|---|
| `frontend/apps/web/src/pages/PlanPage/EditTaskModal.tsx:328` | relabel `edit-task-description` → "Description". |
| `frontend/apps/web/src/pages/PlanPage/Task.tsx:51-66` | add `notes` to `TaskRowFragment`. |
| `frontend/apps/web/src/pages/PlanPage/EditTaskModal.tsx`, `Task.tsx` | render `notes` read-only, attributed as automation-appended (a collapsed hint on the card, a labelled block in the modal). If it should be editable, add a second `edit-task-notes` Textarea bound to a `notes` draft key through `UpdateTaskInput.notes`, which the resolver already accepts. |
| `frontend/apps/web/src/pages/PlanPage/__tests__/EditTaskModal.test.tsx` | assert the two fields target the two different columns. |
| (U21, optional) `TaskRowFragment` + `EditTaskModal` | add `tags { … }`, render chips, mount `EntityTagsDescriptionCard` — it already takes a global id and the tag service, and `task` is already in `TAGGABLE_ENTITIES`. |

**Acceptance check** — run a `TodoScanService` append against a seeded task, then confirm the
appended text is visible in the UI without a database query. A snapshot test asserting the label
text is "Description" and that a `notes` value renders.

**Effort:** 2h for C4; +2h with tags. **Risk:** low.

---

## Phase 5 — Resolve the write-only columns and dead tables

**Depends on nothing; do it after Phases 1–4 because each item needs a product decision, not just
code.** Covers C5 and U1/U22/U24 (re-verify the U-items first).

Four structures are settable-but-unread or registered-but-unused. Leaving them half-wired is what
generated four separate findings in one audit. For each, land *a decision*, recorded in
`docs/architecture/planning-roadmap.md`'s "deliberately not doing" table if the answer is no.

| Item | Decide | If yes | If no |
|---|---|---|---|
| `ci.tasks.task_time` (C5) | should a task carry a preferred time of day? | thread it into `propose()` as a `preferredStart` on `computePlacement`; pin when free, return `no_gap`/`preferred_busy` when not; **and** surface it in `NewTaskForm`/`EditTaskModal`, or it stays invisible | remove from `CreateTaskInput`/`UpdateTaskInput`/`TaskType`, drop the column |
| `ci.planning_prefs` (U1) | should users set their workday? | add `planningPrefs` query + `updatePlanningPrefs` mutation behind `assertPlanningEnabled()`, validate the CHECK bounds in the DTO (`work_start < work_end`, minutes 1..1440, `flexDays` 1..28) so a bad value 400s instead of raising 23514, add a Settings panel, then retire the legacy self-Person fallback at `PlannedBlockService.ts:571-586` | say so in the roadmap and delete `update()` |
| `ci.tasks.actual_minutes` (U22) | do we want estimate calibration? | populate from `VerifyDoneService` (it holds the block) or from the complete flow — `completeTask` already accepts the argument | drop the column and the `ci.time_entries` roadmap row |
| `ci.task_dependencies` (U24) | do we want dependencies? | `TaskDependencyService` with owner-scoped add/remove/list asserting both ids belong to the caller (**neither FK carries a `user_id` component** — copy `TaskService.assertOwnsParent:50-58`), cycle rejection ported from CI-Planning's `engine/deps.ts`, `dependsOn`/`blocks` on `TaskType`, a `blocked` guard in `PlannedBlockService.propose` | drop the entity, the `forFeature` entry, the `index.ts` re-export, and the table |

**Acceptance check** — for each item, either a test proving the value now changes behaviour, or a
migration proving the column/table is gone, plus a roadmap line recording the decision. No item may
be left in its current state.

**Effort:** half-day each, 2 days total. **Risk:** low technically, but each is a product call —
get sign-off before writing the migration, because a drop is hard to walk back.

---

## Phase 6 — Re-verify the Section 4 backlog, then schedule it

**Do not merge Section 4 fixes before this phase.** Three of the five confirmed findings were
downgraded once checked and one verified claim was refuted outright; a prior sweep in this repo found
roughly half of unverified agent findings did not survive checking
(`qa-findings-vs-stale-branch`, `import-etl-recurring-defects`).

Triage order, highest expected value first:

1. **Gap-solver correctness (U3, U4, U29).** If any of the three holds, the placer's output is wrong
   for ordinary calendars, which undermines every other planning feature. Check `findInRange`'s
   allowlist against what the `.ics`/Takeout importer actually writes, and against `is_all_day` and
   `'skipped'`. One shared `INACTIVE_EVENT_STATUSES` constant and one shared event-type constant
   would close all three if they hold.
2. **Scan safety (U7/U13, U8/U14).** These decide whether the automations can destroy a user's review
   inbox or auto-create tasks the user never approved. **Before touching any threshold, read the
   `personalization-shared-threshold-regression` note** — `reflection.autoPromoteThresholdBalanced` is
   shared with planning and lowering it has silently broken `VerifyDoneService` before. Give planning
   its own key rather than editing reflection's.
3. **Recall holes (U9, U10).** Cheap and self-contained; `SerializerService` already has the `task`
   case, so U9 is a few lines plus a diagnostic improvement.
4. **Capture and affordances (U19, U20, U23/U31, U32, U21).** Product work, sized by appetite. U20
   pairs naturally with Phase 3 — the confirm dialog is the right place to say a calendar block will
   be freed.
5. **Recurrence (U2).** The largest single parity gap: CI-Planning has five recurrence files and five
   `tasks` columns for it; CI-Server has none. Treat as its own roadmap milestone, not a bug fix.
6. **Dead code (U33) and branch pruning (U34).** Housekeeping; do them whenever.

**Effort:** 1 day to re-verify the whole list; scheduling follows from what survives.

---

## Salvage

**Cherry-pick: nothing. Abandon: all six.** Every stalled branch on this track has already landed,
and two would actively regress `main` if merged.

| Branch | Action |
|---|---|
| `feat/planning-parity` (#2552) | **Delete.** Main is a strict superset; the branch would revert `'delegated'`, the `placedOnCalendar` optional-field fix, the KNOWN-GAP comments, and #2555/#2556. |
| `clau/calendar-only-planning-view` (#2550) | **Delete.** Merging would drop main's `attempt.current += 1` fix in `EditTaskModal`'s revert-to-saved branch (plus 28 lines of test). |
| `fix/planning-queue-concurrency` (#2555) | **Delete.** Byte-identical to main. |
| `fix/planned-block-index-guard` (#2556) | **Delete.** Byte-identical to main; this commit *was* main's tip when the audit began. |
| `docs/planning-roadmap-status` (#2557) | **Delete**, and prune its worktree (`…/worktrees/planning-parity` at `6190864fb`). |
| `clau/companion-memory-audit-ef57a2` WIP (`8011e30d0`) | **Planning half: abandon** — it re-introduces the drag-to-place subsystem #2529 deliberately removed and depends on four files main no longer has. **Agent half: re-do by hand** as a small fresh PR on current main (`agentChat`'s `withScheme()` + throw-normalisation, plus `AgentHarnessesSection.tsx` and its test) — out of this track's scope. **Push or otherwise durably preserve `8011e30d0` before deleting anything**: it is the only copy. |

Prune by comparing PR `mergedAt` against branch tips, not `git branch -r --merged` — this repo
squash-merges, so that command reports zero (see `squash-merge-branch-pruning`).

---

## Risks

**Testing infrastructure is the root cause, not a side note.** Every planning service test injects a
mocked repository or a mocked sibling service; `TaskService.tenancy.integration.test.ts` is the only
one that reaches real Postgres, and it asserts tenancy rather than constraints. C1 shipped through a
full test suite because `AgentDispatchService.test.ts` mocks `taskService` wholesale and never
exercises the `taskId` branch. **Every phase above must add at least one test that fails on `main`
before it passes on the branch** — a green suite here has repeatedly meant "nothing was actually
executed."

**Nothing gates a merge.** No required status checks on `main`, and CI is `workflow_dispatch`-only
for all planning-relevant workflows. Run `cd backend/apps/api && yarn test` and the frontend vitest
suites locally, and dispatch the workflow explicitly. Silence is not a pass.

**`main` moves under you.** It advanced three times during a single audit, and #2558 changed
`TaskEntity`, `TaskType`, `Task.tsx` and `taskSections.ts` — the exact files Phases 1, 2 and 4 touch.
Rebase before every push and re-read those four files; `graphql/__generated__/gql.ts` and
`graphql.ts` conflict routinely and must be **regenerated** (`yarn graphql:generate`), never
hand-merged (see `graphql-generated-merge-conflicts`).

**Shared thresholds are a live trap.** `PersonalizationService` reads planning thresholds out of
`config.reflection`. Anything in Phase 6 item 2 that edits `reflection.autoPromoteThresholdBalanced`
changes reflection *and* planning at once — this has already caused one production regression in this
repo. Add `planning.*` keys instead.

**Queue-wide options.** `PLANNING_QUEUE_OPTIONS` applies to the whole `planning` queue. The Phase 3
listener must reuse the exact exported object; a divergent literal makes
`EventListenerRegistry.register` throw at import, taking the API down at boot rather than failing a
test.

**Migration collisions.** Parallel branches have collided on hand-picked timestamps before, and
dbmate keys `schema_migrations` on the prefix, so a duplicate breaks `migrate` for everyone. Always
use `migrate:make`. Phases 1, 3 and 5 each add a migration — do not batch them into one file, and do
not reorder them after they have been applied anywhere.

**Two disconnected proposal inboxes.** `domains/schedule/` (`ci.event_candidates`) and
`domains/planning/` (proposed tasks) both surface suggestions to the user, and there is no code path
between them — `ci.actions.task_id` is a declared bridge with nothing behind it. None of the phases
above changes that. If planning grows further without a decision here, the divergence will get
harder to reconcile, and it is worth a roadmap entry before Phase 5's product calls are made.

**The parity gap is structural, not a backlog.** CI-Planning has 57 entities, 16 engine files, 44
services, 17 agents and 13 client views; CI-Server has 4 ported entities, 1 engine file, 12 services
and 2 views. The phases above fix defects and wire dead structures — they do not close that gap.
Recurrence (U2), objectives, patterns, day types, calibration and reminders are each a milestone, and
none should be started before the confirmed defects above are closed, or they will be built on a
board that silently truncates and a placer whose occupancy view may be wrong.

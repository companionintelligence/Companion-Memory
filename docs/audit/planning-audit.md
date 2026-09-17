# Planning subsystem audit — CI-Server, and its gap against CI-Planning

Audit date **2026-09-03**. Scope: the planning system in CI-Server
(`backend/apps/api/src/domains/planning/`, `domains/personalization/`, `domains/schedule/`,
`frontend/apps/web/src/pages/PlanPage/`, `components/TaskSlate/`, `components/HorizonGrid/`)
measured against the CI-Planning product at `/Users/liam/devel/ci/CI-Planning` (read-only
reference, never modified).

## How to read this document

**Baselines, and why they matter.** `origin/main` advanced three times during the audit. Findings
were established against `f26f5b68a` ("Search index: stop embedding planned blocks through the
pipeline", #2556) and re-verified against `7367b26e8`. The audit worktree
(`.claude/worktrees/planning-ci-parity`) sits at `f26f5b68a`. The planning-relevant deltas that
landed after the worktree baseline all come from **#2558** ("OpenClaw dispatch from Memory into a
Chat thread", merge `6dfdd457d`) and **#2557** (`a9f5ce116`, roadmap refresh):

| Delta | Where | Effect on this audit |
|---|---|---|
| `TASK_STATUSES` / `TaskStatusEnum` gained `'delegated'` | `planning/entities/TaskEntity.ts:3-11`, `graphql/types/TaskType.ts:14`, `__generated__/schema.graphql:3438` | **Creates C1.** Does not exist at `f26f5b68a`. |
| whole `domains/agent/` dispatch stack | `backend/apps/api/src/domains/agent/` | C1's write site. Read with `git show origin/main:…`. |
| `Task.tsx` gained `ChatWithAgentMenu` / `AgentActionItems` | `pages/PlanPage/Task.tsx:162` | C1's UI entry point. |
| `taskSections.openCount` gained a `delegated` clause | `pages/PlanPage/taskSections.ts:325` | Half of C1's frontend gap — `sectionFor` did **not** get one. |
| roadmap re-dated, M2/M3/M4/M5 marked partial | `docs/architecture/planning-roadmap.md` | The worktree copy is stale; read main's. |

Before filing any defect against `TaskEntity.ts`, `TaskService.ts`, `TaskType.ts`, `Task.tsx`,
`taskSections.ts`, `docs/architecture/planning-roadmap.md`, or anything under `domains/agent/`,
run `git diff HEAD..origin/main -- <path>` first.

**Verification status.** Section 3 findings each survived an adversarial pass that actively tried
to refute them — hunting for guards, default-off config, unreachable call sites, an existing fix on
main, and covering tests. Nine claims went in; **one was refuted and is excluded**, eight survived,
and those eight collapse to **five distinct defects** (three reporters independently found the same
`delegated` constraint drift; two found the same 200-row board truncation). Severities in Section 3
are the *post-verification* ratings — three were downgraded from the reporters' originals, and the
reasoning is recorded inside each finding.

**Section 4 findings were NOT verified.** They are raw reporter output: unconfirmed, uncalibrated
severities, with known duplicates among themselves and against Section 3. Do not schedule work off
Section 4 without re-verifying — a prior sweep in this repo found roughly half of unverified
agent-reported findings did not survive checking (see the `qa-findings-vs-stale-branch` and
`import-etl-recurring-defects` notes in the workspace memory).

**CI.** CI in CI-Server is `workflow_dispatch`-only except `mobile-release.yml`,
`desktop-release.yml` and `benchmark-unit.yml`, and `main` has no required status checks. A green
or absent check proves nothing about any of this.

---

## 1. Subsystem map

### 1.1 Backend domain — `backend/apps/api/src/domains/planning/`

20 source files, ~8,800 lines including tests. `index.ts` declares `PlanningModule`:
`TypeOrmModule.forFeature([PlanningPrefsEntity, TaskEntity, TaskDependencyEntity,
TaskPendingChangeEntity, UserEntity, EventEntity, CommunicationEntity])`, imports `EventsModule,
UserModule, MemoryModule, SearchNextModule, LlmCoreModule, PersonalizationModule`, provides twelve
services, exports four (`TaskService`, `PlanningTimeService`, `PlannedBlockService`,
`PlanningPrefsService`). **There are no planning REST controllers — GraphQL is the only external
surface.**

**Tables and entities**

| Entity | Table | DDL |
|---|---|---|
| `TaskEntity` | `ci.tasks` | `20260808150000_schedule_planning_and_hbpe.sql:43-80`; `l0_class`/`l1_cluster_id` added by `20260828120000_hbpe_life_forecast.sql:63` |
| `TaskPendingChangeEntity` | `ci.task_pending_changes` | `20260818185920_task_proposed_and_pending_changes.sql`, kinds widened by `20260819010000_task_pending_schedule.sql` |
| `TaskDependencyEntity` | `ci.task_dependencies` | `20260808150000` — **zero readers, zero writers** |
| `PlanningPrefsEntity` | `ci.planning_prefs` | `20260903135230_planning_prefs.sql` (#2552) |

`ci.tasks` carries `ux_tasks_source UNIQUE (user_id, source_kind, source_ref) WHERE source_ref IS
NOT NULL` — the natural key every scan dedups on. `parent_id` self-references with `ON DELETE
CASCADE` and **no `user_id` component**, which is why `TaskService.assertOwnsParent` exists
(`TaskService.ts:50-58`) and why a subtree delete cascades in SQL. `l0_class` and `l1_cluster_id`
have no writer anywhere; HBPE's `get_completed_tasks_for_day`
(`backend/apps/hbpe/src/ci/hbpe/data_client.py`) filters on `l0_class` non-null and non-`'UNKNOWN'`,
so that query is structurally empty.

**A planned block is not a planning table.** It is a `ci.events` row with
`event_type = 'planned_block'`, `task_id` and `planned_minutes` (all added by
`20260818185920:37-45`, plus `idx_events_user_task`). `event_type` has no CHECK, so the value is
additive. `ci.events.duration_minutes` is `GENERATED ALWAYS … STORED` and `EventEntity` marks it
`insert:false, update:false` — writing it from TS silently no-ops, from SQL it hard-errors.

**Services**

- **`TaskService.ts`** (496 lines). Owner-scoped CRUD. *Invariant: every method takes
  `UserServiceContext`, never `ServiceContext`; there is no `SYSTEM_USER` escape* — pinned by
  `__tests__/TaskService.tenancy.integration.test.ts` (10 tests). `findAll` orders
  `due_at ASC NULLS LAST, priority ASC, created_at DESC` (`:175-178`) and applies `.limit()` only
  when `options.limit` is set (`:180-182`). `appendNotes` (`:221-243`) is idempotent on the exact
  fragment. `acceptPendingChange` (`:449-459`) strips `appendNotes`/`eventStatus`/`eventId` out of
  the patch before `update` — the comment records that a bare `eventId` used to reach
  `taskRepository.save` and be silently dropped, which is why an accepted cancellation used to leave
  the block on the calendar. Static `memoryScanSourceRef(title, entityHint?)` =
  `sha256(normalizedTitle[|hint]).slice(0,32)`. Every write emits
  `TaskCreatedEvent`/`TaskUpdatedEvent`/`TaskRemovedEvent`.
- **`PlanningTimeService.ts`** (103 lines). The two-clocks boundary: `date`/`time` columns are
  INPUTS, `timestamptz` are OUTPUTS. Caches the per-user timezone for the process lifetime;
  `invalidate(userId)` exists and nothing calls it.
- **`PlanningPrefsService.ts`** (118 lines). `find()`, `resolve()` (never-null; collapses NULLs onto
  `PLANNING_PREFS_DEFAULTS` = `{workStart:'09:00', workEnd:'17:00', defaultEstimatedMinutes:30,
  flexDays:7}`), `update(dto)`. **`update()` has no caller and there is no GraphQL surface for
  prefs** — see U1.
- **`PlannedBlockService.ts`** (621 lines). Sole owner of `planned_block` reads/writes. `list`,
  `findActiveForTask` (`:102`), `listActiveTaskIds` (batches `TaskType.placedOnCalendar`),
  `scheduleTask` → `propose()` → gap solver, `scheduleTaskAt` (exact instant, bypasses the solver,
  deliberately accepts the past), `tryPlaceAfterOpen` (routes through
  `PersonalizationService.decideAction({kind:'schedule_accept'})`), `applyPendingSchedule`,
  `applyPendingEventRevision` (only `REVISABLE_BLOCK_STATUSES = {cancelled, no_show, skipped}`;
  writes only `status`), `unschedule` (`:346`), `planAsUnscheduled` (`:362`), `placeAt` (`:447`).
  `propose()` (`:502-560`) resolves timezone/today/`workdayHours()`/prefs, takes **one**
  `CalendarEventService.findInRange` occupancy snapshot over
  `[startDate@workStart, startDate+flexDays@workStart)`, then loops days calling `computePlacement`.
  `workdayHours()` reads `ci.planning_prefs` first, then the legacy self-Person
  `properties.schedule.work_start`/`work_end`, then the shipped default.
- **`engine/computePlacement.ts`** (122 lines). Pure, clock-free first-fit.
  `DEFAULT_ESTIMATED_MINUTES = 30`, `SNAP_MINUTES = 15`. Five input fields; no preferred-start
  concept (see C5).
- **`engine/taskTitleSimilarity.ts`** (196 lines). `SCAN_DEDUP_STATUSES` (all live and terminal
  statuses), `SCAN_DEDUP_LIMIT = 300`, `titlesAreSimilar` (exact → substring at ≥12 chars → token
  overlap ≥0.7), `findSimilarTitle`, `newerDuplicateIds`, `claimedSourceIds`.
- **`ProposedTaskReconcileService.ts`** (177 lines). `windowForToday()` stamps
  `{scheduledFor: today, dueAt: today@12:00}`. `reconcileStaleProposed` redates a still-relevant past
  proposal onto today, or archives it via `declineProposed`.
- **`TodoScanService.ts`** (499 lines, daily `0 6 * * *`). Memory search → hydrate against
  `ci.entities` → one `OllamaService.chat` on `UTILITY_MODEL` with `format: RESPONSE_JSON_SCHEMA`
  (`maxItems: MAX_SURFACED = 12`), `SCAN_TIMEOUT_MS = 60_000`, treats `done_reason === 'length'` as
  failure. `null` = model failed (skip reconcile); `[]` = nothing surfaced (do sweep). Per item:
  dedupe, then `decideAction({kind:'task_create'})` → skip / open + `tryPlaceAfterOpen` / proposed.
  `clampConfidence` defaults a missing confidence to **0.75**.
- **`InboxScanService.ts`** (653 lines, `*/30 * * * *`). `LOOKBACK_MS = 30d` is a *width*;
  `scanAnchor()` positions the window on `MAX(comm.time)` so a static import does not age out.
  Carries an in-process, per-user, non-persisted `lastSurfacedCandidates` fingerprint gate, armed
  only after the answer is applied. Calls `decideAction` with `hasUserInput: false`.
- **`TodoProcessService.ts`** (708 lines) holds three providers: `TodoProcessService` (6-hourly;
  `none|append|revise|reparent|complete`), `EventNowService` (`15 * * * *`; only ever files an
  `event_revise` pending change — never cancels in any trust mode), `VerifyDoneService`
  (`45 * * * *`; `ATTRIBUTED_DONE_CONFIDENCE = 0.8` / `UNVERIFIED_DONE_CONFIDENCE = 0.55`; on
  `auto && doneSignal` completes the task **and** writes `block.status = 'completed'` through the raw
  `eventRepository.save`).

**Jobs.** `constants.ts` exports `PLANNING_QUEUE = 'planning'` and
`PLANNING_QUEUE_OPTIONS = { policy: 'short', localConcurrency: 1 }` — `policy:'short'` is what makes
the cron's per-user `singletonKey` actually refuse a duplicate (pg-boss's default `standard` stores
the key and never checks it), and `localConcurrency: 1` bounds the three in-process Ollama callers,
none of which route through the `llm` queue. Queue options are queue-wide, so all five `@OnEvent`
registrations must share the one object or `EventListenerRegistry.register` throws at import.
`events.ts` defines eight events; the three `task.*` payloads carry `{taskId, userId}` because
`TaskService` is unconditionally tenant-scoped and a listener holding only a taskId can index
nothing. `PlanningJobsCron` fans out five crons per onboarded user; `PlanningJobsListener` has five
bare `await service.runForUser(...)` handlers with **no try/catch** (a throw rejects the pg-boss job,
which retries).

### 1.2 GraphQL surface

`domains/graphql/resolvers/TaskResolver.ts` (519 lines), `@UseGuards(JwtOrApiKeyAuthGuard)`. Every
entry point calls `isPlanningEnabled()`; the mutations that matter use `assertPlanningEnabled()`.

- Queries: `tasks(status?, scheduledFor?, parentId?, first/after)` — calls `findAll` **without a
  limit** (`:437`) then slices in memory with `Paginator.paginate` (`:443`); `task(id)`;
  `taskPendingChanges(taskId?)`; `plannedBlocks(from!, to!)`.
- Mutations: `createTask`, `updateTask`, `deleteTask`, `completeTask(id, actualMinutes?)`,
  `reopenTask`, `acceptProposedTask`, `declineProposedTask`, `acceptTaskPendingChange`,
  `declineTaskPendingChange`, `deferTask`, `scheduleTask(id, estimatedMinutes?, date?, startTime?,
  endTime?)` (`startTime` bypasses the solver and ignores `date`), `planTask`, `unscheduleTask`.
- `TaskType` implements `Node, Taggable`; `toType` encodes `id: GlobalUID.encode('task', source.id)`
  (`TaskType.ts:116`) — **a base64 global id, not the raw uuid**. This matters for C1.
- **MCP asymmetry.** `domains/mcp/services/GraphQLToolAdapter.ts` auto-derives MCP tools from the
  live schema, so every task mutation above is *already* an MCP tool. CI-Planning consumes Google
  Calendar over MCP as a client and ships no MCP server for its own tasks — CI-Server is ahead here,
  and it is the one axis where parity runs the other way.
- **Built but unwired:** `plannedBlocks`, `deferTask` and `unscheduleTask` have zero frontend
  consumers. `taskTime` is settable and readable and read by nothing (C5).

### 1.3 Personalization / trust dial

`domains/personalization/services/PersonalizationService.ts` (231 lines) gates every planning
automation. Trust mode lives at `properties.planner.trust_mode` on the self-Person (60s cache,
default `'balanced'`). `PLANNING_ACTION_KINDS = {task_create, task_mutate, task_complete,
event_revise, schedule_accept}`. Thresholds come from `config.reflection`
(`config/default.json:194-200`): cautious `1`, balanced `0.55`, hands_off `0.7`,
`alwaysReviewBelowConfidence 0.55`. `task_complete` is the one kind with its own bar
(`TASK_COMPLETE_AUTO_PROMOTE_THRESHOLD_BALANCED = 0.85`, `:53`). Balanced sets
`autoSchedule: false`, so `schedule_accept` is always `review` there. Note the shared-threshold
hazard already on record (`personalization-shared-threshold-regression`): `reflection`'s balanced
threshold is load-bearing for planning too, and lowering it has broken `VerifyDoneService` before.

### 1.4 The adjacent `schedule` domain — a second, disconnected proposal inbox

`domains/schedule/` ships `EventCandidateEntity` → `ci.event_candidates`, `RhythmEntity` →
`ci.rhythms`, `CandidateService` (441), `SuggestionSyncService` (473), `TaskBreakdownService` (408,
brain-dump → candidates). Its GraphQL is `ScheduleCandidateResolver`.
**`grep -rn "TaskService|ci.tasks|taskId" backend/apps/api/src/domains/schedule/` returns nothing** —
accepting a candidate mints a `ci.events` row with no `task_id`, and there is no promotion path in
either direction. `ci.actions.task_id` (`20260808150000:92`) is the only declared bridge and has no
code behind it. Two review inboxes, no connection.

### 1.5 The six `ci.events` guardrails, and where they actually live

Declared in `docs/architecture/planning-roadmap.md:47-60`. Enforcement sites today:

1. Never write `duration_minutes` — `applyPendingEventRevision` names only `status`.
2. Search index — `search-ingress/listeners/EventSearchIndexListener.ts:93` early-returns, **and**
   (since #2556) `pipeline/stages/index/entityEmbedStages.ts:102`,
   `pipeline/stages/index/entityRows.ts:91`, `search-ingress/entitySourceMap.ts:97`;
   `20260903151335_repair_planned_block_search_index.sql` deletes the rows already written.
3. Explorer — `CalendarEventService.ts:753` and `:1433`. `getDistinctEventSources` does **not**
   exclude planned blocks.
4. HBPE — `data_client.py:152` and `:280` carry `AND e.event_type IS DISTINCT FROM 'planned_block'`.
5. Cross-tenant `events_source_triple_uniq` — `placeAt` stamps a user-scoped
   `platformIdentity('planning','task',task.id)`.
6. Maintenance backfills — only partially; `ContentService`, `EventParticipantBackfillService`,
   `LocationEstimateService` and `GeocodeBatchListener` were not re-checked in this pass.

The gap solver's occupancy source is `CalendarEventService.findInRange`, which uses an **allowlist**
`SCHEDULE_EVENT_TYPES = ['calendar_event','meeting','appointment','planned_block']`
(`CalendarEventService.ts:163`) plus `status NOT IN ('cancelled','no_show')`,
`start_time >= from - 92d`, `take(2000)`. Note what that excludes and what it does not: it *does* see
planned blocks, and it does **not** exclude `'skipped'`, unlike every `PlannedBlockService` query.
Both asymmetries generate unverified findings (U3, U29).

### 1.6 Search / recall integration (M4 slice, #2552)

`search-next/types.ts` lists `'task'` in `INDEXABLE_ENTITIES` and `TAGGABLE_ENTITIES`;
`entitySourceMap.ts:191-196` maps `task → {schema:'ci', table:'tasks', backfillPredicate: "s.status
<> 'archived'"}` with a compile-time completeness guard. `TaskSearchIndexListener` (209 lines)
handles all three `task.*` events on the `search-index` queue, scoped by `payload.userId`, and
*removes* an archived task rather than skipping it. `SerializerService` and `EntityResolutionService`
both have `task` cases. **Two holes** (both unverified, U9/U10): `SearchIndexBackfillService` has
`task` in neither `BACKFILLABLE_ENTITIES` nor `EVENT_BY_TYPE`, and its enqueue payload omits the
`userId` the listener requires; `tools/tools/DatabaseSearchTool.ts` has 14 per-type hydrators and no
`task` one.

### 1.7 Frontend

Routes: `App.tsx:63` lazy-loads `PlanPage`; `:113` sends `/plan` → `/plan/tasks` when `planning.page`
is on, `/plan/calendar` otherwise. Calendar (`SchedulePage`) is deliberately ungated.

`pages/PlanPage/` (14 source files): `PlanPage.tsx` (399) composes `NewTaskForm` + a selection bar +
`TaskBoard` and owns eight mutations. `usePlanTasks.ts` (234) is the single `GET_TASKS` query plus the
`placeOnDay`/`dismissProposed` writes. `taskSections.ts` (328) is the pure bucketing core ported from
CI-Planning's `client/src/lib/task-sections.ts` — `ColumnKey = proposed|unscheduled|scheduled|done`,
`LaneKey = inbox|proposed_upcoming|upcoming|overdue`, `sectionFor` (`:130-159`), `subtreeOf`
(cycle-guarded), `groupIntoSections` (roots in `tasks`, whole subtree in `count`). `Task.tsx` (580) is
one card with a long-press multi-select gesture (`SELECT_HOLD_MS = 450`). `EditTaskModal.tsx` (404)
autosaves after `SAVE_MS = 450` with a supersession counter and a three-way
`PersistResult = saved|invalid|failed`. `NewTaskForm.tsx` (94) is title-only. `useDeleteTasks.ts` (93)
has no confirm. **`DaySchedule.tsx` (81) and `EditEventModal.tsx` (220) are dead** — no importer
anywhere; `EditEventModal` still ships a 189-line, 5-test suite.

`components/TaskSlate/TaskSlate.tsx` (496) is the non-modal Sheet the calendar opens on an empty-slot
click: an HBPE prediction line, a `New event` composer, and a `Possibilities` tablist of the backlog.
`BacklogCard` is **click**-to-place; the whole drag subsystem was deliberately removed by #2529 and
the file comment records it.

`components/HorizonGrid/VerticalCalendar.tsx` (1,067) is the week/day grid — `HOUR_HEIGHT_PX = 52`,
HTML5 drag chip moves via `EVENT_DRAG_TYPE`, a keyboard `MoveEventForm` fallback, empty-slot click →
`onSelectSlot({instant, allDay})`, an all-day row, the HBPE rhythm strip. `scheduleGeometry.ts` (460)
holds `DROP_SNAP_MINUTES = 15`, `dropInstant`, `movedStart`, `slotForecastLine`, `rhythmClaims`.

`pages/SchedulePage/SchedulePage.tsx` (560) hosts the calendar. **Critically,
`api/useScheduleService.ts`'s `GET_SCHEDULE` reads `eventsInRange`, not `plannedBlocks`, and its
`ScheduleEvent` interface has no `taskId`** — so the calendar cannot distinguish a planned block from
a Google event except by whatever `classifyEvent` infers. That single fact sits upstream of several
findings: the calendar has no delete, no unschedule, and no way to route a task-linked chip back
through the planning mutations.

### 1.8 Tests

Backend planning: 13 files, ~167 `it()` blocks (`TaskService` 39, `InboxScanService` 25,
`PlannedBlockService` 21, `TodoProcessService` 14, `ProposedTaskReconcileService` 13,
`computePlacement` 12, `PlanningTimeService` 12, `PlanningPrefsService` 10, tenancy integration 10,
`taskTitleSimilarity` 9, `TodoScanService` 6, `PlanningJobsCron` 3, queue policy 3). Frontend:
`taskSections.node.test.ts` 35, `PlanPage` 30, `Task` 24, `TaskSlate` 22, `EditTaskModal` 15,
`NewTaskForm` 12, `usePlanTasks` 5, `WhenSelector` 5, `EditEventModal` 5 (dead component),
`useDeleteTasks` 3; HorizonGrid `scheduleGeometry` 51, `VerticalCalendar` 35, `scheduleToTimeline` 8,
`nowNext` 7, `scheduleClusters` 7.

Coverage is wide and shallow in one specific way that recurs across findings: **every planning
service test injects a mocked repository or a mocked sibling service.**
`TaskService.tenancy.integration.test.ts` is the only test in the domain that reaches a real
Postgres, and it asserts tenancy, not CHECK constraints. That is exactly how C1 shipped.

### 1.9 Flags and docs

`config/default.json:232-234`: `planning.enabled: true`, `planning.page: true`,
`planning.emptyState: false`; env overrides `ENABLE_PLANNING`, `ENABLE_PLANNING_PAGE`,
`ENABLE_PLANNING_EMPTY_STATE`. `docs/architecture/planning-roadmap.md` (171 lines on main) is the
authoritative object model: the nine-noun vocabulary, the six guardrails, the milestone ledger
(M0/M1 landed; M2/M3/M4/M5 partial), eight invariants, a "deliberately not doing" table, four open
questions. **`docs/prd/` holds no planning PRD** — only `asynchronous-document-parsing.md` and
`unified-content-identity-lifecycle-embeds.md`.

### 1.10 CI-Planning parity surface (read-only reference)

`/Users/liam/devel/ci/CI-Planning/server/src/db/entities/` holds **57 entities**; CI-Server has
ported four (`tasks`, `task_dependencies`, scheduling prefs → `planning_prefs`, blocks →
`ci.events`). Unported with no CI-Server home at all: objectives, patterns (5 tables), day types and
assignments, `daily_plan`, `daily_recap`, `flight_plan`, `plan_hints`, `reflections`, `reminders`,
`replan_suggestions`, `time_entries`, estimate calibration (3 tables), `life_priorities`, possible
tasks, the seven-table tag/category taxonomy, `block_templates`, `planning_sessions`,
`push_subscriptions`, triality (2 tables), `copy_history`.

| Axis | CI-Planning | CI-Server |
|---|---|---|
| `tasks` columns | 34, incl. `recurrence_rule`, `recurrence_parent_id`, `recurrence_dtstart`, `recurrence_exdates`, `occurrence_date`, `subtype`, `version`, `motivation`, `completion_mood` | 21 + `metadata`, `l0_class`, `l1_cluster_id`; **no recurrence at all** |
| Prefs columns | ~40 (`deep_work_windows`, `max_focus_block_minutes`, `planning_mode`, `fill_order`, `auto_defense_enabled`, `recurrence_horizon_days`, …) | 4 (`work_start`, `work_end`, `default_estimated_minutes`, `flex_days`) — and unwritable, see U1 |
| Engine | 16 files: `autoplan`, `scheduler`, `blocks-place`, `blocks-recur`, `recurrence*` ×3, `clear-range`, `extend-block`, `patterns-place`, `deps`, `auto-defense`, `quickadd`, `reminders`, `review`, `series-scope`, `stars` | **one**: `computePlacement.ts`, 122 lines, first-fit |
| Services | 44 | 12 |
| Agents | 17 | 3 scan services + 1 process service |
| Client views | 13 (`Today`, `Calendar`, `AllTasks`, `Focus`, `Balance`, `Patterns`, `Tags`, `PrioritiesWizard`, `Settings`, `Jobs`, …) | 2 (`PlanPage` kanban, `SchedulePage` calendar) |
| Capture | `quickadd` NL parse + voice + `ElementWizard` | title-only `NewTaskForm` |
| MCP | consumes Google Calendar as a client; no server for its own tasks | **auto-derives an MCP tool per GraphQL mutation** |

The honest summary: CI-Server has the better *integration* story (memory recall, trust dial, MCP
exposure, a real event bus) and roughly a tenth of the *planning* story.

---

## 2. Confirmed findings — index

Severity-ordered. The last column names the reporter findings each row consolidates.

| # | Sev | Title | Anchor | Merges |
|---|---|---|---|---|
| **C1** | P1 | `delegated` task status is unwritable — the DB CHECK forbids the value four TypeScript layers now emit | `db/postgres/migrations/20260818185920_task_proposed_and_pending_changes.sql:9` | 1, 2, 3 |
| **C2** | P1 | The Plan board's one unfiltered `tasks(first: 200)` page is ordered so terminal rows crowd out live work, and undated tasks fall off first | `frontend/apps/web/src/pages/PlanPage/usePlanTasks.ts:137` | 5, 6 |
| **C3** | P2 | Deleting a task strands its planned block on the calendar forever, and the block keeps consuming gap-solver capacity | `backend/apps/api/src/domains/planning/services/TaskService.ts:353` | 4 |
| **C4** | P2 | `ci.tasks.notes` is written by three automations and rendered by nothing; the field labelled "Notes" writes `description` | `frontend/apps/web/src/pages/PlanPage/EditTaskModal.tsx:328` | 7 |
| **C5** | P3 | `ci.tasks.task_time` is a fully dead column — the placer, and everything else, ignores the time of day the caller asked for | `backend/apps/api/src/domains/planning/services/PlannedBlockService.ts:502` | 8 |

One further claim was verified and **refuted**; it is excluded rather than downgraded.

---

## 3. Confirmed findings — detail

### C1 [P1] `delegated` task status is unwritable — the DB CHECK forbids what four TypeScript layers now emit

**Anchor:** `backend/apps/api/db/postgres/migrations/20260818185920_task_proposed_and_pending_changes.sql:9`
**Write site:** `backend/apps/api/src/domains/agent/services/AgentDispatchService.ts:90` (origin/main only)
**Exists on:** `origin/main` (`6dfdd457d`, #2558) — **not** on the audit worktree at `f26f5b68a`.

**Evidence.** #2558 widened the status vocabulary in four TypeScript layers and in **no migration**.

- Code list: `planning/entities/TaskEntity.ts:3-11` is
  `['proposed','open','in_progress','delegated','done','skipped','archived']`. `status` is a plain
  `@Column({ type: 'text', default: 'open' })` — no transformer, no validator, and `synchronize` is
  false in every config, so nothing sanitizes the value in transit.
- Effective constraint: `20260818185920:5-10` drops and re-adds
  `tasks_status_check CHECK (status IN ('proposed','open','in_progress','done','skipped','archived'))`.
  `git grep -n tasks_status_check origin/main -- backend/apps/api/db` returns exactly three
  locations — `20260808150000:65` (the original five-status CREATE TABLE), and lines 6/9 (up) and
  91/97 (down) of `20260818185920`. Nothing later touches it. The only later migrations that touch
  `ci.tasks` at all are `20260828120000_hbpe_life_forecast.sql:63` (adds two columns) and
  `20260902040000_openclaw_dispatch.sql:28` (an FK from `ci.agent_jobs.task_id`).
- `grep -rni delegated backend/apps/api/db/` returns **one** hit, and it is prose:
  `20260902040000_openclaw_dispatch.sql:57`, inside `COMMENT ON TABLE ci.agent_jobs`.
- There is no `schema.sql` in `backend/apps/api/db/postgres/` (`.gitignore` lists it), so the
  migration set is the whole truth for a fresh database. There is no trigger on `ci.tasks` and no
  TypeORM `EntitySubscriberInterface` in the repo.
- The write: `AgentDispatchService.ts:83-90` is
  `if (taskId) { const task = await this.taskService.findById(...); if (!task) throw …; await
  this.taskService.update(context, taskId, { status: 'delegated' }); }` — no try/catch.
  `TaskService.update` (`:189-211`) does `Object.assign(record, data)` then
  `this.taskRepository.save(record)`, i.e. a real `UPDATE ci.tasks SET status='delegated'` on an
  existing PK. Postgres raises **23514 check_violation**.
- Ordering: the write is line 90; `threadService.create` is 93, `jobRepository.save` 113,
  `messageService.create` 128, `eventService.send` 136. The exception aborts the dispatch before any
  thread, job, message or event exists — so it fails cleanly with no orphan rows, which is half the
  reason this is P1 and not P0.
- Nothing tests it. `domains/agent/services/__tests__/AgentDispatchService.test.ts:34` injects
  `const taskService = { update: jest.fn() }` — no `findById`, so the `taskId` branch of `dispatch()`
  is never exercised at all; the one `update` assertion is `{ status: 'done' }` from the completion
  path. No planning test reaches real Postgres except the tenancy integration suite, which asserts
  ownership, not constraints.

**Two corrections to the original reports, both load-bearing for how you fix this.**

1. **The shipped UI cannot currently reach the failing write, and not because of a guard.**
   `PlanPage/Task.tsx:162` builds the chat context with `sourceId: task.id`, and `TaskType.toType`
   (`graphql/types/TaskType.ts:116`) sets `id: GlobalUID.encode('task', source.id)` — a base64 global
   id. `ChatWithAgent/useChatAboutActions.ts:91` forwards it verbatim as
   `taskId: sourceKind === 'Task' ? sourceId : null`, and `AgentJobsController.ts:31` declares
   `taskId: z.string().uuid().optional().nullable()`. The Zod pipe rejects a global id, so
   `POST /v1/agent/jobs` **400s before `dispatch()` is entered**. There are therefore *two* stacked
   defects: the CHECK violation is latent, reachable today only by a JWT/API-key or MCP client that
   posts a raw task uuid, while the Dispatch button on a task card is broken by an unrelated
   global-id-vs-uuid mismatch. A PR that fixes only the constraint leaves the button still 400ing.
2. **The frontend half of #2558 is also incomplete.** `taskSections.ts:325` `openCount` got a
   `delegated` clause; `sectionFor` (`:130-159`) did **not**. A delegated task therefore falls through
   to the dated branch and renders in the Overdue lane once its date passes — and, per `Task.tsx`,
   with a live Schedule button.

**Severity.** P1, downgraded from the reporters' P0. It is a deterministic 100% failure of one
just-shipped path, but: it fails loudly (`useChatAboutActions` catches and toasts), it corrupts and
orphans nothing, dispatch from a non-Task source still works, and the UI entry point is additionally
gated on `openclaw.dispatchReady` (`AgentHarnessService.ts:256` sets it only when OpenClaw is
installed, connected and running), so a default appliance cannot reach it from the web app at all.

**Fix.**
1. `yarn workspace @ci/be-api migrate:make widen_tasks_status_delegated` — drop and re-add
   `tasks_status_check` with `'delegated'` in the same order as `TASK_STATUSES`. The `migrate:down`
   **must** remap existing rows before restoring the narrow check, mirroring `20260818185920:94`'s
   `UPDATE ci.tasks SET status = 'open' WHERE status = 'proposed'` — otherwise the down leg fails on
   any delegated row. Never hand-write the timestamp prefix; `bin/check-migration-versions.js`
   enforces uniqueness in lint-staged and before `yarn migrate`.
2. Fix the id mismatch in the same PR: either decode the global id server-side in
   `AgentJobsController`, or send the raw uuid from `useChatAboutActions`. Pick one and assert it in
   a test — the two sides currently disagree silently.
3. Add a `delegated` branch to `sectionFor` so it buckets as live-but-not-yours rather than falling
   into Overdue, and suppress the Schedule button for it.
4. Add a `TaskService` integration assertion that **every** member of `TASK_STATUSES` round-trips
   through `update()` against real Postgres. That single test is what would have caught this, and
   what stops the enum and the CHECK drifting again.

**Effort:** 1h for the migration + test; ~3h with the id mismatch and the `sectionFor` branch.

---

### C2 [P1] The Plan board loads one unfiltered 200-row prefix ordered so terminal rows crowd out live work

**Anchor:** `frontend/apps/web/src/pages/PlanPage/usePlanTasks.ts:137`
**Also:** `frontend/apps/web/src/layouts/Main/SecondaryNavigation/usePlanBadgeCount.ts:5-8`,
`backend/apps/api/src/domains/graphql/resolvers/TaskResolver.ts:437`,
`backend/apps/api/src/domains/planning/services/TaskService.ts:175-178`

**Evidence.**

- `GET_TASKS` (`usePlanTasks.ts:9-37`) is `tasks(first: $first, after: $after)` with **no `status`
  argument**, and the hook calls it with `variables: { first: 200 }` (`:137`). `$after` is declared
  and never supplied; there is no `fetchMore` anywhere for tasks (`grep fetchMore` across
  `frontend/apps/web/src` hits only `NotesPage.tsx` and `MemoryPage/useEntityService.tsx`).
- `TaskResolver.tasks` (`:411-459`) forwards `status: undefined` and **no `limit`** to
  `TaskService.findAll`, then slices the fully materialized array with `Paginator.paginate` (`:443`;
  `Paginator.ts:55` is `items.slice(startIndex, endIndex)`). The user's whole task table is loaded
  into memory on every board render to produce 200 rows.
- `TaskService.findAll` (`:168-186`) applies the status predicate only when `options.status?.length`,
  orders `due_at ASC NULLS LAST, priority ASC, created_at DESC`, and applies `.limit()` only when
  `options.limit` is set — which this caller never sets.
- Both halves of the ordering are wrong for this consumer:
  - **Terminal rows sort to the front.** `taskSections.sectionFor:135` routes
    `done | skipped | archived` into the Done column, so every completed and every scan-archived
    proposal consumes the 200-row budget. `TaskService.declineProposed` (`:312-328`) sets
    `status = 'archived'` and leaves `dueAt` untouched, and proposals are minted with
    `windowForToday`'s `dueAt = today@12:00` (`ProposedTaskReconcileService.ts:44-51`) — so an
    archived proposal is permanently a past-due row, and past due dates sort **first** under
    `due_at ASC`.
  - **Undated rows sort to the back.** `NewTaskForm.tsx:49` creates tasks as `{ title: trimmed }`
    only, so every manually created task has `due_at NULL` and lands at the very end under
    `NULLS LAST` — exactly the rows the 200-cut drops first. This half bites on day one, long before
    any archive pile exists.
- The archive pile is monotone and self-inflicted. `ProposedTaskReconcileService.reconcileStaleProposed`
  archives stale proposals; `TodoScanService:196`/`:357-374` and `InboxScanService:301`/`:478-495`
  both sweep and collapse duplicates. `grep -rn archived` over `domains/planning` shows **no purge,
  TTL or delete path anywhere**, and `TaskEntity` has no `@DeleteDateColumn`. The crons run by
  default (`planning.enabled: true`, TodoScan daily, InboxScan every 30 min).
  `SCAN_DEDUP_LIMIT = 300` (`taskTitleSimilarity.ts:39`) shows the backend already assumes hundreds
  of rows per user.
- Nothing tells the user. `totalCount` is selected (`usePlanTasks.ts:26`) and rendered nowhere —
  `grep -rn totalCount` across `PlanPage/`, `TaskSlate/` and `SchedulePage/` finds only that
  selection and test fixtures. `PlanPage.tsx` has no search, status filter, sort, or Archive split
  (its one `filter` at `:111` is an array toggle), so no user action can reach row 201.
- Every consumer shares the defect: `PlanPage.tsx:77` and `SchedulePage.tsx:268` both call
  `usePlanTasks`, `TaskSlateDrawer` takes those sections as props, and `usePlanBadgeCount` issues its
  **own** status-less `tasks(first: 200)` — with a comment that already concedes the bug: *"see G5 in
  the audit: Possibilities silently truncates past 200"*.
- CI-Planning's equivalent surface (`client/src/views/AllTasks.tsx:21-45`) ships an always-visible
  search, a status filter, a separate Archive split and a `SortControl` precisely so a grown backlog
  stays reachable.

**Severity.** P1, downgraded from P0. The total-blackout end state (board renders nothing but
archive) needs ~200 accumulated past-due terminal rows, which on the shipped cadence
(`MAX_SURFACED = 12` per scan, daily TodoScan, dedup suppressing re-creation on a static corpus)
takes weeks to months rather than being true on a fresh appliance. The immediate, day-one half is the
undated backlog silently falling off the end. Nothing is lost — only hidden.

**Fix.**
1. Pass an explicit `status` list from `usePlanTasks` —
   `['proposed','open','in_progress','delegated']` — and fetch the Done column separately with its
   own cap (or lazily on tab open). Do the same in `usePlanBadgeCount`.
2. Push the page size into SQL: pass `options.limit` from `TaskResolver.tasks` so the database does
   the cut instead of `Paginator` slicing a fully materialized array. Consider a resolver-level
   default that excludes `archived` so a future status-less caller cannot re-open this.
3. Render `totalCount` against the loaded count so any remaining truncation is visible, or wire
   `after`/`fetchMore` on `hasNextPage`.
4. Add the status/search/sort controls the backlog needs, matching `AllTasks.tsx`'s affordances.

**Effort:** half-day for 1–3; +1 day for 4.

---

### C3 [P2] Deleting a task strands its planned block on the calendar forever, and it keeps blocking the gap solver

**Anchor:** `backend/apps/api/src/domains/planning/services/TaskService.ts:353`

**Evidence.**

- `TaskService.remove` (`:353-363`) hard-deletes the row and emits only `TaskRemovedEvent`. The
  **only** listener on that event anywhere is
  `search-ingress/listeners/TaskSearchIndexListener.ts:64`, which calls `unindexTask` →
  `embeddingService.remove`/`vectorService.remove` for `entityType: 'task'`. Nothing touches
  `ci.events`. (`grep -rn TaskRemovedEvent backend frontend` returns the definition, the send, one
  unit test, and that listener.)
- The FK is `task_id UUID NULL REFERENCES ci.tasks (id) ON DELETE SET NULL` — declared identically in
  `20260808150000:93` and `20260818185920:38`. There is no trigger on `ci.tasks` or `ci.events`, no
  TypeORM subscriber, and `EventEntity.ts:205` declares `task_id` as a plain nullable `@Column` with
  no relation or cascade. So the block **survives** with `task_id = NULL`, `status = 'planned'`,
  `created_by = 'planning.placer'`, `is_deleted = false`.
- Every repair path keys on `task_id` and can therefore never match it again:
  `PlannedBlockService.findActiveForTask` (`:102`) and `listActiveTaskIds` both
  `andWhere('event.task_id = :taskId')`; `unschedule` (`:346`) and `planAsUnscheduled` (`:362`) both
  go through `findActiveForTask` first. There is no orphan sweep — `PlanningJobsCron` has only the
  five scan/process crons, and `grep 'task_id IS NULL|orphan'` across `domains/planning` and
  `domains/schedule` finds nothing.
- Every *display* path also hides it, so the user cannot even see what to fix: guardrail 2 keeps it
  out of `ci_search` (`EventSearchIndexListener.ts:93`), guardrail 3 keeps it out of the explorer
  (`CalendarEventService.ts:753`), and the calendar surface has exactly one write on a placed chip —
  `useRescheduleEvent` — with no delete and no unschedule (`grep -rn 'delete|unschedule'
  frontend/apps/web/src/pages/SchedulePage frontend/apps/web/src/components/HorizonGrid` is empty).
  Meanwhile `PlannedBlockService.list` does **not** filter on `task_id`, so the ghost chip keeps
  rendering on that day carrying the deleted task's title.
- It stays live occupancy. `CalendarEventService.ts:163` allowlists `planned_block` in
  `SCHEDULE_EVENT_TYPES`, and `findInRange` (`:669-686`) excludes only `('cancelled','no_show')` — a
  `status='planned'` orphan is counted as busy. That query is `PlannedBlockService.propose`'s sole
  occupancy source, so the placer will never offer that slot again while it is inside the flex
  window.
- The trigger is an ordinary UI action, not a corner case. `PlanPage/Task.tsx:453` and `:477` render
  the destructive menu item and Trash button unconditionally (no `placedOnCalendar` guard — that
  field is used only at `:350` for a label); `PlanPage.tsx:233` wires `onDelete` to `useDeleteTasks`,
  which fires `DELETE_TASK` straight at the resolver with no prior unschedule; the bulk Delete at
  `PlanPage.tsx:372` does the same. `TaskResolver.deleteTask` (`:146-161`) calls `taskService.remove`
  directly, and `planning.enabled` is true by default.

**Severity.** P2, downgraded from P0. It is real and permanent-by-UI, but there is no data loss, no
cross-tenant or security impact, and the occupancy harm is bounded — `propose` only scans
`[today, today + flexDays)`, so the stranded block blocks placement for that window and then ages
out. The lasting damage is an undeletable ghost chip plus lost gap capacity while the slot is still
inside the flex window.

**Fix.**
1. Have `TaskService.remove` call `PlannedBlockService.unschedule` before deleting — or, cleaner
   given the module boundary, add a `TaskRemovedEvent` listener in the planning domain that cancels
   blocks whose `task_id` matched. Prefer the listener: `remove` currently has no
   `PlannedBlockService` dependency, and adding one risks a cycle with `PlannedBlockService`'s
   existing `TaskService` injection.
2. Backfill the existing orphans in a migration:
   `UPDATE ci.events SET status='cancelled' WHERE event_type='planned_block' AND task_id IS NULL AND
   created_by='planning.placer' AND is_deleted = false AND status NOT IN
   ('cancelled','no_show','skipped')` — the extra predicates keep it consistent with the block
   queries.
3. Add a test asserting that after `remove`, `findInRange` over the block's day no longer reports it
   occupied and `propose` offers the freed slot.

**Effort:** half-day.

---

### C4 [P2] `ci.tasks.notes` is written by three automations and rendered by nothing; the field labelled "Notes" writes `description`

**Anchor:** `frontend/apps/web/src/pages/PlanPage/EditTaskModal.tsx:328`

**Evidence — write side.**

- `TaskService.appendNotes` (`:221-243`) mutates `record.notes` and saves. It is the sink for every
  LLM-derived detail: `TodoScanService.ts:219` (the dedup/`existing` branch, `tallies.appended += 1`),
  `InboxScanService.ts:324` (same shape), `TodoProcessService.ts:381-382` (the `decision === 'auto'`
  arm of the `append` suggestion), and `TaskService.ts:449-450` (the accepted `mutate` pending
  change).
- The column is real: `ci.tasks.notes TEXT NULL` at `20260808150000:48`, declared at
  `TaskEntity.ts:36`, exposed on `TaskType` by `toEgressType` (`:112`).
- This fires on the **ordinary second-run path** — whenever `findBySourceRef`/`findByTitleMatch` hits
  an existing task — not on an exotic branch. It is the entire "append knowledge instead of spawning
  a duplicate" strategy.

**Evidence — read side. There is no reader, in the UI or the backend.**

- `EditTaskModal.tsx:328` is verbatim `<Label htmlFor="edit-task-description">Notes</Label>` over a
  `Textarea` bound to `draft.description` (`:329-335`). `inputFromDraft` (`:117-130`) sends
  `{id, title, description, dueAt, estimatedMinutes}` — no `notes` key anywhere in the file, and
  neither `Draft` nor `EditableTask` has a `notes` member.
- `TaskRowFragment` (`Task.tsx:51-66`) — the single fragment every Plan surface reads through —
  selects id/title/description/status/priority/parentId/dueAt/scheduledFor/placedOnCalendar/
  deferUntil/estimatedMinutes/completedAt. **No `notes`.**
- Grepping every `.ts`/`.tsx` under `frontend/apps/web/src` (tests excluded), the only task-`notes`
  occurrence is `PlanPage.tsx:56`, inside the `AcceptTaskPendingChange` mutation payload — fetched
  purely to refresh the Apollo cache, never rendered, and never selected back since the fragment
  omits it. `TaskSlate.tsx:27` and HorizonGrid select `description`. iOS and Android are Capacitor
  shells over `web/dist`, so there is no second UI.
- Backend: grepping `.notes` across `domains/planning`, `/personalization`, `/schedule` returns only
  the two write lines, the `suggestion.notes` source in `TodoProcessService:360-361`, and the egress
  mapping. No digest, agent-chat or prompt-builder reads it back.
- The pending-change surface does not compensate: `Task.tsx:341-342` renders only `pendingRationale`,
  and `PlanPage.tsx:266-267` passes `pending?.rationale`/`pending?.kind`. The `appendNotes` patch
  content is shown neither before nor after acceptance.
- CI-Planning keeps the two distinct and renders both — `client/src/components/ElementWizard.tsx`
  (~`:950-963`) has a dedicated collapsible note field separate from its description.

**Severity.** P2, downgraded from P1. Nothing is lost or corrupted: the appended text is durably
stored and reachable over GraphQL/MCP, and the user's own typed text in the mislabeled field is not
dropped — `description` *is* rendered on the card (`Task.tsx:316-337`). The harm is that
automation-derived detail never becomes visible, plus a mislabeled field. A parity/feature gap and a
UI-copy bug.

**Fix.** Relabel `edit-task-description` "Description". Add `notes` to `TaskRowFragment` and render
it — read-only and clearly attributed as automation-appended — in `EditTaskModal` and as a collapsed
hint on the card. If it should be user-editable, add a second `edit-task-notes` Textarea bound to a
`notes` draft key through `UpdateTaskInput.notes` (already accepted by the resolver) and extend
`EditTaskModal.test.tsx` to assert the two fields target the two different columns.

**Effort:** 2h.

---

### C5 [P3] `ci.tasks.task_time` is a fully dead column — the placer ignores the time of day the caller asked for

**Anchor:** `backend/apps/api/src/domains/planning/services/PlannedBlockService.ts:502`

**Evidence.**

- `propose()` (`:502-560`) derives its window purely from `workdayHours()`, `prefs.flexDays` and one
  `eventService.findInRange` snapshot, then calls
  `computePlacement({workdayStart, workdayEnd, occupied, estimatedMinutes, now})`. The task's own
  preferred wall-clock is never an input.
- `engine/computePlacement.ts` (122 lines, read in full): `PlacementInput` has exactly five fields.
  No `preferredStart`, no pin logic.
- `grep -rn task_time backend/` returns exactly **two** hits repo-wide: the column definition
  (`20260808150000:53`) and the `@Column` mapping (`TaskEntity.ts:51`). No TypeScript, SQL or Python
  reader exists anywhere — the column is inert end-to-end, not merely ignored by the placer.
- Yet it is a documented public field: `CreateTaskInput.ts:28-29` ("Wall-clock `HH:MM`, user
  timezone. Zoneless."), `UpdateTaskInput` accepts it, `TaskType` exposes it, and the MCP adapter
  therefore advertises it on every derived task tool.
- CI-Planning treats the equivalent as load-bearing: its quick-parse writes `taskTime` and the
  wizard's START chip drives placement (`client/src/components/ElementWizard.tsx:471-476`).

**Severity and framing.** P3, downgraded hard from P1, and the "silently relocated" narrative is
wrong. Nothing is relocated — `taskTime` never produced a block. No contract is violated either:
`scheduleTask`'s own GraphQL description (`TaskResolver.ts:303-305`) reads "Place an open task into
the next free workday gap," and it exposes `startTime`, documented at `:314-320` as bypassing the gap
solver entirely — so an agent that wants an exact time already has the correct argument.
`docs/architecture/planning-roadmap.md:92` (M3) specifies the placer as answering one question
("given the workday window, existing events and an estimate, where does this task go?"), and
`docs/scratch1-bdc/tasks-and-scheduling.md:65` already records verbatim that `task_time` is "Written
by create/update; **nothing reads it**." Reachability is agent-only and narrow: `taskTime` appears
nowhere in `frontend/apps/web/src` outside generated types, and both automation callers of
`tryPlaceAfterOpen` (`TodoScanService.ts:272`, `InboxScanService.ts:384`) construct their own tasks
and never set it. This is a catalogued built-but-never-wired item and a genuine CI-Planning parity
gap — not a correctness bug.

**Fix.** Pick a direction rather than leaving it half-wired, and note that wiring *only* the placer
would leave the column invisible everywhere else.
- **Honour it:** thread `task.taskTime` into `propose()` as a preferred start (convert with
  `PlanningTimeService.toInstant`), give `computePlacement` an optional `preferredStart`, pin the
  block there when the slot is free, and return `no_gap` (or a distinct `preferred_busy`) rather than
  silently first-fitting elsewhere. Then also surface it in `EditTaskModal`/`NewTaskForm` so a human
  can set it.
- **Or retire it:** remove `taskTime` from `CreateTaskInput`/`UpdateTaskInput`/`TaskType` and drop
  the column, so callers cannot set a field with no effect.

**Effort:** half-day either way.

---

## 4. UNVERIFIED findings

**Everything in this section is unverified.** These are raw reporter outputs that did **not** go
through the adversarial pass. Severities are the reporters' own and are uncalibrated — note that
three of the five confirmed findings above were downgraded once checked, and one further verified
claim was refuted outright. Several entries below duplicate each other or restate Section 3;
duplicates are grouped and cross-referenced rather than dropped, so the count reconciles.
**Re-verify before scheduling any of this.**

### 4.1 Preferences (3 reports of one claim)

- **U1 / U5 / U12 — [P1, unverified] `ci.planning_prefs` can never be written.**
  `PlanningPrefsService.update()` is claimed to have zero callers and no GraphQL surface, so
  `work_start` / `work_end` / `default_estimated_minutes` / `flex_days` have no write path at all and
  every user runs on shipped defaults. Proposed fix: a `planningPrefs` query + `updatePlanningPrefs`
  mutation (a `PlanningPrefsResolver` guarded like `TaskResolver`, behind `assertPlanningEnabled()`),
  DTO validation against the migration's CHECK bounds (`work_start < work_end`, minutes 1..1440,
  `flexDays` 1..28) so a bad value 400s rather than raising a raw 23514, plus a Plan settings panel.
  Once written prefs are reachable, the legacy self-Person workday fallback
  (`PlannedBlockService.ts:571-586`) can be scheduled for removal, as its own docstring anticipates.
  *(Corroborated by §1.1, which records `update()` with no caller — but not independently verified
  end-to-end.)*

### 4.2 Gap solver / occupancy correctness

- **U3 — [P1, unverified] The `.ics`/Takeout importer writes `event_type='event'`, which the schedule
  allowlist excludes**, so the placer books over imported commitments. Fix: add `'event'` to
  `SCHEDULE_EVENT_TYPES` and keep it in sync with `lifeStats.ts`'s `CALENDAR_EVENT_TYPES` — better,
  export one shared constant from `domains/memory` and have both import it; regression tests that an
  `event_type='event'` row in range comes back from `findInRange`, and that
  `SCHEDULE_EVENT_TYPES ⊇ CALENDAR_EVENT_TYPES ∪ {planned_block}`.
- **U4 — [P1, unverified] All-day events are counted as occupied time**, so one birthday or PTO entry
  makes the placer return `no_gap` for the whole flex window. Fix: filter the snapshot in `propose()`
  (`occupiedEvents.filter((e) => !e.isAllDay)`), plus a test with a 24h all-day span over the workday
  asserting a placement is still found.
- **U29 — [P2, unverified] A `skipped` planned block is counted as occupied** while every planning
  read treats it as gone, so a skipped block permanently blocks its own slot. Fix: export one
  `INACTIVE_EVENT_STATUSES = ['cancelled','no_show','skipped']` from `CalendarEventService` and use it
  in both `findInRange` and the three `PlannedBlockService` queries. *(Consistent with the asymmetry
  observed in §1.5.)*
- **U17 — [P1, unverified] Placing a Possibility on the all-day row creates a 30-minute block at
  midnight, off-screen.** Fix: either disable `onPlace` for all-day slots in `TaskSlateDrawer` with
  copy saying a task needs a time, or add an `allDay` argument to `scheduleTask`/`scheduleTaskAt` and
  have `placeAt` set `is_all_day: true` with a day-spanning `end_time`.

### 4.3 Task ↔ block lifecycle parity (adjacent to C3)

- **U6 — [P1, unverified] Moving an already-placed block leaves `ci.tasks.scheduled_for` on the old
  date**, violating the roadmap's status-parity invariant. Fix: in `scheduleTaskAt`'s existing-block
  branch, after a successful `reschedule`, mirror `placeAt` —
  `const scheduledFor = await this.planningTime.localDate(context, start)` then
  `taskService.update(context, task.id, { scheduledFor })` — and extend the `:243` test. For the
  calendar-drag path, either route task-linked chips through `SCHEDULE_TASK_AT` (select `taskId` on
  `eventsInRange`; `EventType` already exposes it at `graphql/types/EventType.ts:120`), or have
  `CalendarEventService.reschedule` re-sync a linked task's `scheduledFor` when `event.taskId` is set.
- **U16 — [P1, unverified] Completing a task leaves its planned block on the calendar as a live
  future commitment.** Fix: in `TaskService.complete` (or a `TaskUpdatedEvent` listener in the
  planning domain) close the linked block the way `VerifyDoneService` does (`status='completed'`), and
  mirror it in `reopen` by returning it to `'planned'`.
- **U28 — [P2, unverified] Accepting a `complete` pending change never touches the linked planned
  block**, while the auto path in the same service does mark it completed. Fix: add a `complete` arm
  to `TaskResolver.acceptTaskPendingChange` calling a new `PlannedBlockService.markBlockCompleted`
  that applies `status: 'completed'` through `CalendarEventService.update` after the same ownership
  checks `applyPendingEventRevision` performs (`block.taskId === taskId && block.eventType ===
  'planned_block'`); route `VerifyDoneService`'s auto branch through the same method so the two cannot
  drift again.

### 4.4 Scan / automation behaviour

- **U2 — [P1, unverified] A recurring obligation surfaced once can never be surfaced again**: scan
  dedup matches `done` and `archived` tasks and there is no recurrence model. Fix (short term): drop
  `done`/`archived` rows older than the scan's own lookback before passing them to `findSimilarTitle`,
  and salt `memoryScanSourceRef` with the occurrence date so `ux_tasks_source` does not pin one task
  per title for all time. Long term: land the roadmap's Recurrence item.
- **U7 / U13 — [P1, unverified] The sweep archives the user's proposed backlog on a false relevance
  test.** Two variants of one mechanism: (a) an empty memory/inbox search passes `[]` as
  `relevantTitles` (`TodoScanService.ts:159`, `InboxScanService.ts:214`) so a zero-candidate run
  mass-archives the review inbox — fix by hoisting the `tracked` read above the zero-candidate early
  return and passing `proposedTitles(tracked, …)`; (b) because the prompt forbids re-emitting tracked
  titles, "was it re-emitted?" is the wrong relevance test at all — fix by passing the **union** of
  newly surfaced titles and live proposal titles (`InboxScanService.ts:296-299`,
  `TodoScanService.ts:191-194`), archiving only when a row drops out of `tracked` or an explicit
  staleness horizon expires. Both want the same regression test: one tracked past-dated proposal plus
  one newly surfaced item must leave the proposal **redated**, not archived.
- **U8 / U14 — [P1, unverified] A model that omits `confidence` gets 0.75 by default, which
  auto-creates real tasks in the default trust mode**, contradicting `InboxScanService`'s own
  docstring (`:137-138`); and balanced mode has no review band for
  `task_create`/`task_mutate`/`event_revise` because
  `alwaysReviewBelowConfidence == autoPromoteThresholdBalanced == 0.55`. Fix: (1) make the
  absent-confidence default fail toward review — lower the `0.75` in `clampConfidence`
  (`TodoScanService.ts:495`, `InboxScanService.ts:649`) below `ALWAYS_REVIEW_BELOW_CONFIDENCE`, or add
  `confidence` to the schemas' `required` arrays so an omission is a parse failure; (2) give planning
  its own thresholds instead of borrowing `reflection`'s — add
  `planning.autoPromoteThresholdBalanced` (e.g. 0.85, matching the `task_complete` bar) to
  `config/default.json` + `custom-environment-variables.json` and branch on it in
  `decide`/`thresholdForKind`, leaving `reflection`'s to `inferred_fact`. Then make the docstring
  true. **Heed the shared-threshold regression already on record**
  (`personalization-shared-threshold-regression`): changing `reflection.autoPromoteThresholdBalanced`
  has silently broken `VerifyDoneService` in this repo before.
- **U30 — [P2, unverified] `TodoScanService` has no idempotency gate**, so on a static corpus it
  re-asks the model the identical question every day forever — the loop `InboxScanService`'s
  fingerprint gate was built to close. Fix: extract that gate into `domains/planning/engine/` and
  apply it against `fresh.map((hit) => hit.id)`, armed at the same point (after the surfaced items are
  applied, so a throw re-arms next run).
- **U15 — [P1, unverified] On an OpenAI-compatible LLM endpoint the planning scans lose both their
  grammar constraint and their truncation detection**: the JSON Schema is collapsed to `json_object`
  (`OllamaService.ts:941`) and `done_reason` is hardcoded to `'stop'`. Fix: propagate
  `choice.finish_reason` through `toChatResponse` (and the stream's final chunk) so `'length'`
  surfaces; widen the driver's `format` to `string | Record<string, unknown>` and emit
  `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }` when given an
  object, falling back to `json_object` only for `format === 'json'`; remove the lossy collapse; add a
  driver unit test. *(Cross-domain — `domains/llm`, not `domains/planning`.)*

### 4.5 Search / recall holes

- **U9 — [P1, unverified] Task search hits are silently dropped before the agent sees them** —
  `DatabaseSearchTool` has no `task` hydrator. Fix: inject `TaskService`, add the `task` group to the
  `Promise.all` using the existing `findByIds`, and set the composite key; `SerializerService` already
  handles `task` (`:106`, `:160-163`) so nothing downstream changes. Then replace the all-or-nothing
  diagnostic at `:279` with a per-type check against `INDEXABLE_ENTITIES` so the next missing hydrator
  trips on the first dropped hit rather than only on a fully empty page.
- **U10 — [P1, unverified] No sweep can ever index a pre-existing task**: `task` is absent from
  `BACKFILLABLE_ENTITIES` and the sweep payload omits the `userId` the listener requires. Fix: add
  `'task'` to `BACKFILLABLE_ENTITIES` and a `task: { event: TaskCreatedEvent, idField: 'taskId' }`
  entry to `EVENT_BY_TYPE`; teach the enqueue at `:397` to carry the owner for tenant-scoped types
  (select `ci.tasks.user_id` alongside the id and emit `{ [idField]: row.id, userId: row.user_id }`) —
  a per-type `ownerColumn` on `ENTITY_SOURCE_MAP` is the tidiest place to declare it, and
  `person`/`concept` will want the same. Test: a task row present before any event fires becomes
  searchable after one sweep. *(Note the interaction: `OrphanCleanupService` and
  `EmbedCoverageTelemetryService` iterate `INDEXABLE_ENTITIES` generically and therefore already
  include `task`, so coverage telemetry reports a task gap no sweep can close.)*

### 4.6 Frontend capture, editing and affordances

- **U11 / U18 — [P1, unverified] duplicates of C4** (`ci.tasks.notes` invisible; the "Notes" label
  writes `description`). Treated as confirmed at **P2** in Section 3; the P1 rating here is not
  supported.
- **U19 — [P1, unverified] No keyboard path to any calendar write**: the day lane is not focusable and
  the chip's dialog only opens on click. Fix: give the day lane `role="button"`/`tabIndex={0}` with an
  Enter/Space handler selecting a default slot (or a per-day "Add here" button), and make `EventPeek`
  clone `onKeyDown` alongside `onClick` while switching the chip's role to `button`.
- **U20 — [P1, unverified] Task delete is one unconfirmed click and silently cascades to every
  descendant.** Fix: confirm before delete whenever the target has children (or on any multi-select
  delete), stating the subtree size from `subtreeOf`; alternatively make `deleteTask` archive rather
  than hard-delete and reserve the cascade for an explicit "delete permanently". *(Interacts with C3 —
  a confirm dialog is the natural place to also say "this frees a calendar block".)*
- **U23 / U31 — [P2, unverified] Capture and editing expose 4 of the 11 writable input fields**;
  priority is displayed but never editable, a subtask cannot be created, and there is no NL parse or
  voice. Fix: extend `NewTaskForm` to a quick-add line parsing `#tag`, `~Nm` and a date phrase
  client-side and sending the full `CreateTaskInput`; add priority, `scheduledFor` and a defer control
  to `EditTaskModal` (wiring the already-shipped `deferTask`); add an "Add subtask" action passing
  `parentId`. All backend fields exist and are tested — the change is frontend-only.
- **U21 — [P2, unverified] Task is the only `TaggableEntityType` member with no tag surface**, so M2's
  landed tag slice is unreachable by a user. Fix: add `tags { … }` to `TaskRowFragment`, render chips
  on the card, and mount `EntityTagsDescriptionCard` in `EditTaskModal` (it already takes a global id
  and the tag/untag service), or add a task detail route reusing the shared entity scaffold.
- **U32 — [P2, unverified] `delegated` has no bucket, and skipped/archived rows render an unchecked
  "Complete" checkbox in the Done column.** Fix: add a `delegated` branch to `sectionFor` (own column
  or labelled lane) and suppress Schedule for it; base the checkbox state on
  `status !== 'open' && status !== 'in_progress'` rather than `=== 'done'`. *(The `sectionFor` half is
  confirmed as part of C1.)*
- **U33 — [P3, unverified] Three dead planning UI modules stay green under their own tests.** Fix:
  delete `EditEventModal.tsx` + its 5-test suite, `DaySchedule.tsx`, and the five unused exports in
  `scheduleToTimeline.ts` with their tests; fix the stale TimelineJS comment in `SchedulePage.tsx`. If
  an agenda view is still wanted, wire `buildTodayTimelineData` to a route instead of leaving a
  passing-test decoy.

### 4.7 Dead columns and dead tables

- **U22 / U25 — [P2, unverified] `ci.tasks.actual_minutes` has no writer anywhere**, so HBPE's
  duration model always falls back to the estimate and CI-Planning's estimate/calibration loop can
  never be ported. Fix: either capture actuals (pass `actualMinutes` from the Plan complete flow —
  `completeTask` already accepts the argument — or derive it from the linked block's start/end in
  `VerifyDoneService`, which has the block in hand), or drop the column from the entity and `TaskType`
  and remove the `ci.time_entries` row from the roadmap object model.
- **U24 / U26 — [P2, unverified] `ci.task_dependencies` is a fully dead table** — registered with
  TypeORM, zero readers, zero writers, and M1 claims it landed. Fix: decide and land one.
  *Retire:* drop the import, the `forFeature` entry and the `planning/index.ts` re-export, delete the
  entity, add a migration dropping the table (it holds no rows). *Implement:* a
  `TaskDependencyService` with owner-scoped add/remove/list asserting both ids belong to the caller
  (the way `TaskService.assertOwnsParent` does at `:50-58` — **neither FK carries a `user_id`
  component**), `dependsOn`/`blocks` on `TaskType`, cycle rejection ported from CI-Planning's
  `engine/deps.ts`, and a `blocked` guard in `PlannedBlockService`. Either way record the decision in
  the roadmap's "deliberately not doing" table so the next audit does not re-open it.
- **U27 — [P2, unverified] `taskTime` is a write-only column** — the same defect as C5, filed at a
  higher severity. Treated as **P3** in Section 3; see C5 for why the "silently ignores the time the
  user asked for" framing overstates it.

### 4.8 Branch hygiene

- **U34 — [P3, unverified] All five stalled planning branches are fully superseded.** Corroborated
  independently by the salvage pass in Section 5, which *is* verified — see there for the per-branch
  evidence and the regression warnings.

**Reconciliation:** 34 reporter findings → U1–U34 above, of which U1/U5/U12, U7/U13, U8/U14, U11/U18,
U22/U25, U23/U31 and U24/U26 are duplicate pairs or triples, and U11/U18 and U27 restate confirmed
findings C4 and C5.

---

## 5. Stalled-branch salvage

All six were diffed against `origin/main` over their own paths. **Nothing on any of them is worth
merging.**

| Branch | PR / commit | Verdict | Evidence |
|---|---|---|---|
| `feat/planning-parity` | #2552 (`10cef4e69`) | **ABANDON — already landed** | `git diff origin/main..feat/planning-parity` over every path it touches is **deletions only** (283 removed / 20 added): main is a strict superset. The 20 "additions" are staleness, not work — it predates #2558 (would revert `'delegated'` from `TASK_STATUSES`/`TaskStatusEnum`/`findByTitleMatch`), predates the `TaskType.placedOnCalendar` optional-field fix (would re-introduce `placedOnCalendar!: boolean` hardcoded `false` in `toType`, killing `TaskResolver`'s fallback ResolveField), predates the `l0Class`/`l1ClusterId` KNOWN-GAP comments, and predates #2555 and #2556. Its real content — the `planning_prefs` migration + service, `task` in the taggable/indexable sets, `TaskSearchIndexListener`, the `SerializerService`/`EntityResolutionService` task cases — is all on main. |
| `clau/calendar-only-planning-view` | #2550 (`69995b8c7`) | **ABANDON — merging would regress** | The three-dot diffstat looks like 543 insertions only because the earlier #2529-era calendar work also landed. Diffed over its own four files it is deletions only, and **main carries one fix the branch lacks**: `attempt.current += 1` in `EditTaskModal`'s revert-to-saved effect branch (plus 28 lines of test), which retires an in-flight save so a late failure cannot raise `saveFailed` over a draft that already matches the server. |
| `fix/planning-queue-concurrency` | #2555 (`1b5915a53`) | **ABANDON — already landed** | `git diff origin/main..fix/planning-queue-concurrency -- domains/planning/constants.ts domains/planning/listeners/` is **empty** — byte-identical to main. |
| `fix/planned-block-index-guard` | #2556 (`f26f5b68a`) | **ABANDON — already landed** | `git diff origin/main..origin/fix/planned-block-index-guard` over all six files is empty. This commit *was* `origin/main`'s tip when the audit started. |
| `docs/planning-roadmap-status` | #2557 (`a9f5ce116`) | **ABANDON — landed mid-audit** | `origin/main` advanced from `f26f5b68a` to `a9f5ce116` during the audit and now carries the text verbatim. Its worktree (`…/worktrees/planning-parity` at `6190864fb`) can be pruned. **The doc was already stale an hour later** — it does not mention the `'delegated'` status #2558 added. |
| `clau/companion-memory-audit-ef57a2` (uncommitted WIP, preserved as `8011e30d0`) | — | **planning half: ABANDON. agent half: RE-DO by hand (out of track scope)** | Based on a far older tree — `git diff origin/main..8011e30d0` spans 1,313 files and −104,627 lines. Its `TaskSlate`/`VerticalCalendar` work depends on files main no longer has: `TaskSlate/ScheduleDragGhost.tsx` and `TaskSlate/useCandidatePointerDrag.ts` were deleted by #2529; `lib/scheduleDrag.ts` on main exports only `EVENT_DRAG_TYPE`/`EventDragPayload`/`parseEventDrag` (no `CANDIDATE_DRAG_TYPE`, no `EVENT_EXTERNAL_DRAG_TYPE`), and `lib/schedulePointerDrag.ts` / `HorizonGrid/useScheduleDropTarget.ts` do not exist at all. Porting it would revert the deliberate #2529 decision (click an empty slot instead of dragging), which main's own `TaskSlate` comment documents, and would delete the slot composer `SchedulePage` depends on. The `agentHarness`/`agentChat` half **is** unlanded (`AgentHarnessesSection.tsx` is absent from main while `ChatWithAgent/` and `lib/agentChat.ts` exist, and #2558 has since changed `Task.tsx`'s use of `namedChatContext`) — re-do `agentChat`'s `withScheme()` + throw-normalisation and the 174-line settings section (+125-line test) as a small fresh PR on current main. |

**Pruning note.** `git branch -r --merged` reports **zero** on this squash-merging repo, which is why
these still look live; prune by comparing PR `mergedAt` against the branch tip (see the
`squash-merge-branch-pruning` workspace note). Before deleting `clau/companion-memory-audit-ef57a2`,
confirm `8011e30d0` is reachable somewhere durable — it is the only copy of the agent-harness work.

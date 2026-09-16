# Planning — roadmap and object model

> Status (re-verified against `main` 2026-09-03): **M0, M1 and M4 landed.** M2, M3 and M5 have each landed in slices — see [Milestones](#milestones). The remaining M3 gap is the `ci.events` column extension; the remaining M5 gap is reminders.
> Feature flags: `planning.enabled` (backend GraphQL gate, `ENABLE_PLANNING`, default **on**), `planning.page` (Plan route + rail, `ENABLE_PLANNING_PAGE`, default **on**), `planning.emptyState` (Plan page empty state, `ENABLE_PLANNING_EMPTY_STATE`, default **off**).

## Why planning lives here

CI-Planning is a standalone planning app — Koa + SolidJS over SQLite — that already reaches *into* CI-Server over HTTP for the things it cannot do itself: the knowledge graph, embeddings, hybrid recall. Its `connectors/memory.ts` is a 29KB HTTP client for `/graph/*` and `POST /v1/events`.

Everything that client asks for is already here, on the other side of a boundary it maintains. Moving planning into CI-Server deletes that boundary and gets four things for free:

- **One calendar object.** Google and Outlook calendar events already land in `ci.events` via `domains/etl`. A planned block and a calendar event are the same object at different points in time, so planning does not need a parallel calendar — it needs the existing one extended. CI-Planning's entire two-way mirror (`external_events`, `outbound_queue`, `sync_state`, a second OAuth client, an MCP child process) has nothing left to do.
- **One identity.** `ci.users` + `domains/auth` replaces a whole parallel auth stack.
- **Recall.** Tasks become first-class citizens of `ci_search` and of `/memory/recall`, so "what am I supposed to be doing about the Fenwick contract?" answers from the planner with no tool call.
- **One jobs engine.** pg-boss + `@Cron` + `JobsController` replaces a bespoke `scheduled_jobs`/`job_runs` registry.

## Object model

| Concept | Home | Notes |
|---|---|---|
| Task | **`ci.tasks`** | `ci.actions` is a feed card — missing 24 of 32 fields, and its `order:{priority:'asc'}` would return the backlog into the feed. `ci.actions.task_id` bridges the two. Status includes **`proposed`** (trust-dial review inbox). Nesting via **`parent_id` only** (children = `WHERE parent_id = ?`). |
| Pending change | **`ci.task_pending_changes`** | Trust-dial confirmation for mutate / complete / event_revise on an existing task. New work uses `proposed`, not this table. |
| Scheduled block | **`ci.events`, `event_type='planned_block'`** | Extended, not duplicated. See the guardrails below. Columns: `task_id`, `planned_minutes`; GraphQL exposes `parentEventId`. |
| Task dependencies, timer sessions | **`ci.task_dependencies`, `ci.time_entries`** (new) | `ci.relationships` can't hold them — tasks aren't `ci.entities` rows, and its FKs to entities were removed by `20260127185821`. `time_entries` needs `UNIQUE (user_id) WHERE ended_at IS NULL`, which on `ci.events` would fail against every point-in-time capture row. |
| Taxonomy (direction / intention / category) | **`ci_search.tags` + `ci_search.entity_tag`, extended** | `tags` gains `kind`, `muted`, `is_base`; `entity_tag` gains `level`. Positional categories live in a separate `ci_search.entity_categories` so `getTagsForEntity`'s contract is unchanged for existing readers. |
| Objectives | **`ci.objectives`** (new) + a `ci.entities` projection | `entity_type='Objective'` passes `valid_entity_type`, but `progress_cache` updates on every task completion and `entities_search_vector_trigger` fires `BEFORE UPDATE OF … properties` → a GIN rebuild per recompute. Project via `linked_table`/`linked_id` instead — the pattern `ci.files`/`ci.objects` already use. Graph-visible without being graph-resident. |
| Reflections | **`ci.reflections`** (new) | `ci.notes` has no `kind`/`period_key`/`position` and no composite key, so "the 2nd item of today's goals" is not upsertable. Folding in would also embed empty bodies via `NoteSearchIndexListener`. |
| Daily recap | **`ci.daily_recap`** (new), prose projected into `ci.summaries` | `ci.summaries` has no unique constraint on `(user_id, period_type, period_start)`, so regeneration would duplicate, and it feeds `ci.feed_queue` — every regeneration would surface a new feed card. Keep the freeze semantics in a real table; publish one-way for the feed. |
| Preferences | **`ci.planning_prefs`** (landed, #2552) | Nullable columns, NULL = shipped default, nothing seeded. `trust_mode` deliberately stays at `properties.planner.trust_mode` on the self-Person: it gates whether the five LLM jobs may act unattended, so moving it is a data migration, not a side effect. There was no user-preferences store before it. `ci.users.settings`/`display_preferences`/`permissions` jsonb exist in Postgres but `UserEntity` maps none of them and nothing reads them. **No `timezone` column** — `ci.users.timezone` is the source of truth (already used by `ForecastContextService`). |
| Reminders | **`ci.reminders`** (new) + pg-boss executor | pg-boss jobs are opaque and archived; you cannot render "your upcoming reminders" from a queue. Same shape as `ci.feed_queue` + `FeedQueueCron`. |
| Routines, day types, flight plan, calibration, possibles | **New `ci.*` tables** | No existing home. `ci.habits`/`ci.goals`/`ci.activities` existed and were dropped by `20260212191500`. |

Everything is keyed on `user_id uuid REFERENCES ci.users(id) ON DELETE CASCADE`. There is no `owners` table and no `planning` schema — planning extends `ci` and `ci_search`.

### Column types

`timestamptz` for instants, `date` for owner-local calendar dates, `time` for zoneless wall-clock, `jsonb` for blobs, `boolean` for flags, `text` for RRULEs and opaque tokens.

**The rule that keeps DST correct:** `date` and `time` columns are *inputs to* `PlanningTimeService`; `timestamptz` columns are *outputs of* it. Never hand a `timestamptz` to `zonedWallTimeToUTC`.

IDs are `uuidv7()` minted in the service layer with `@PrimaryColumn('uuid')`, or `DEFAULT gen_uuid_v7()` for tables written only by SQL.

---

## `ci.events` guardrails — read before touching planned blocks

`ci.events` is **not** a TimescaleDB hypertable, so `ALTER TABLE … ADD COLUMN` is plain DDL, non-partition-key unique indexes are legal, and FKs can point into it. It already carries `start_time`, `end_time`, a generated `duration_minutes`, `is_all_day`, `is_recurring`, `recurrence_pattern`, `status`, `priority`, `parent_event_id` and `metadata`.

Planning adds `task_id`, `is_locked`, `is_auto`, `planned_minutes`, `occurrence_date`, `recurrence_parent_id`, `recurrence_rule`, `last_moved_at`, `auto_run_id`, `category_tag_id`, `color_token`, and widens the `status` CHECK with `planned`/`in_progress`/`skipped`. `event_type` is free text with no CHECK, so `planned_block` is additive.

**Six existing consumers must stay guarded. These are not optional, and each has a regression test.**

| # | Consumer | What breaks | Guard |
|---|---|---|---|
| 1 | `duration_minutes` is `GENERATED ALWAYS AS … STORED` | Any INSERT/UPDATE naming it is a hard Postgres error. `EventEntity` carries `insert:false, update:false`, which makes `EventService.update`'s `updateData.durationMinutes` a **silent no-op**. | Never write it. `planned_minutes` holds intent; `duration_minutes` stays generated actual. |
| 2 | `EventSearchIndexListener` fires on every create **and update** — and the pipeline's `EventEmbedStage` selects from `ci.events` independently | An auto-plan run moving 40 blocks = 40 embedding calls — plan-loop frequency against an import-frequency pipeline. | Skip `event_type='planned_block'`. Index the **task**, not the block. **Both paths**: the listener's early return, AND `INDEX_EMBED_EVENT_SOURCE.predicate`, `loadEventRows`, and `ENTITY_SOURCE_MAP.event.backfillPredicate` (#2556). Until #2556 only the listener refused them; the ledger path embedded every block and the backfill sweep re-found each one on every pass. |
| 3 | `EventResolver.events()` fetches everything into JS then paginates | Planned blocks inflate an already-unbounded fetch and leak into the memory explorer, the `eventTypes`/`eventSources` pickers, the map and `SearchResolver`. | Exclude `planned_block` from `findAll`/`eventTypes()`/`eventSources()`. Planned blocks get a **SQL-pushdown** query, not `findAll`. |
| 4 | HBPE clusters `ci.events` into activity labels that `ForecastContextService` feeds back into the agent prompt | Feeding *planned* blocks means the forecaster learns from its own output — a closed loop. | Exclude `planned_block` from the HBPE ingest query; coordinate with `backend/apps/hbpe/`. |
| 5 | `events_source_triple_uniq` is **global, not user-scoped** (`EventService.createManyBatched` says so in a comment) | Two users generating a block from the same builtin routine collide **across tenants**. | Planning rows use a user-scoped `source_id`, or leave it NULL and dedupe on `ux_events_occurrence`. |
| 6 | `ContentService` provenance auto-linking; `EventParticipantBackfillService`, `LocationEstimateService`, `GeocodeBatchListener` bulk-UPDATE events | Planning rows have no media, participants or coordinates — backfills scan them for nothing. | `AND event_type <> 'planned_block'` in the maintenance queries. |

---

## Vocabulary

Carried over from CI-Planning's glossary; these nine nouns are the whole budget. Adding a tenth needs a good reason.

| Term | Means |
|---|---|
| **Task** | A unit of work. Has a status, may have an estimate, a due date and a parent. |
| **Time Block** | A span on the calendar. A `ci.events` row with `event_type='planned_block'`. May be linked to a task. |
| **Routine** | A repeating template that generates tasks or blocks. Habit ◯ / Routine ▢ / Ritual △. |
| **Tag** | A label with a `kind`: *direction* (Home/Work/Community), *intention*, or *category* (the six Balance dimensions). |
| **Category** | One of health, career, relationships, growth, leisure, finance. 1–3 per item, positional. |
| **Flight plan** | The staged shortlist of tasks the scheduler may place. |
| **Day plan** | The frozen, ordered list of tasks for one day. |
| **Objective** | A node in the goal tree. Level is derived from tree *height*, never stored intent. |
| **Reflection** | A dated, slotted note — today's goal, a weekly goal, a day note, an evening review. |

---

## Milestones

### Shipped

- **M0** — feature flags, this document.
- **M1 — Tasks, end to end.** `ci.tasks` + `ci.task_dependencies` (`20260808150000_schedule_planning_and_hbpe.sql`); `TaskEntity`/`TaskService`; the GraphQL Task slice (`TaskType implements Node`, `tasks`, `createTask`, `updateTask`); `PlanningTimeService` (a verbatim port of CI-Planning's `lib/tz.ts` minus `sqliteUtcToISO`) with DST tests at both boundaries; `/plan` page (`frontend/apps/web/src/pages/PlanPage/`). Note the timezone helpers themselves — `isValidTimezone`, `localDateInTZ`, `todayInTZ`, `zonedWallTimeToUTC` — have since moved to `@ci/common/time/zoned`; `domains/planning/index.ts` re-exports them, so callers are unaffected.

### Next

- **M2 — Taxonomy (partial).** **Landed** (#2552): `'task'` in `TAGGABLE_ENTITIES`; `TaskType implements Taggable` with `tags` hydrated through `TagLoader`; `TaskType` in the `TaggableEntityType` union and `TagResolver`. No migration — `ci_search.entity_tag.entity_type` is plain text. **Not started:** the taxonomy itself — no `kind`/`muted`/`is_base` on `ci_search.tags`, no `level` on `entity_tag`, no `ci_search.entity_categories`. Extend `ci_search.tags`/`entity_tag`; new join/pref tables; `'task'` in `TAGGABLE_ENTITIES`; `TaskType.tags` through the existing `TagLoader`. Watch: `TagService.validateLabel` lowercases every label, and adding `kind` changes what the explorer's tag picker returns.
- **M3 — Scheduling (partial).** The `ci.events` extension plus all six guards; a SQL-pushdown `plannedBlocks(from, to)`; `ci.planning_prefs`; a **simple deterministic placer** — a pure `computePlacement(input): PlacementPlan` answering one question: given the workday window, existing events and an estimate, where does this task go? No two-pass autoplan, no reflow, no LLM. Scheduling is by form and button; drag comes later.
  **Landed:** `computePlacement` (`domains/planning/engine/computePlacement.ts`), `PlannedBlockService`, the `plannedBlocks(from: DateTime!, to: DateTime!)` GraphQL query, and the `ci.events` columns `task_id` + `planned_minutes` (`20260818185920_task_proposed_and_pending_changes.sql`).
  **Landed** (#2552): `ci.planning_prefs` (`20260903135230_planning_prefs.sql`) — `work_start`/`work_end`, `default_estimated_minutes`, `flex_days`, every column nullable with NULL meaning the shipped default, so an untouched appliance is unchanged. `PlannedBlockService` reads the workday, fallback estimate and flex-day sweep from it, falling back to the legacy self-Person `properties.schedule` leaf so users who set hours through the graph keep them; that fallback and its two graph reads go once nothing writes the leaf.
  **Not landed:** the rest of the `ci.events` extension named above (`is_locked`, `is_auto`, `occurrence_date`, `recurrence_*`, `last_moved_at`, `auto_run_id`, `category_tag_id`, `color_token`, the widened `status` CHECK).
- **M4 — Search, recall, MCP.** **Landed** (#2552): `'task'` in `INDEXABLE_ENTITIES` + `EMBEDDABLE_SEARCH_TYPES` + `ENTITY_SOURCE_MAP`; `TaskSearchIndexListener`; task cases in `SerializerService` and `EntityResolutionService`; `TaskType` in `SearchResultType`. Tasks are findable through `search` and cited by recall. One decision to know about: task events carry `userId`, because `TaskService.findById` has no `SYSTEM_USER` escape — a listener copied from the `Note` template compiles, passes review and indexes **nothing**, silently. Archiving removes a task from the index rather than skipping it, so the backfill sweep converges.
  **Landed** (this PR): the `planning` intent domain — `planning.findTasks` (read, filters on status/title-substring/due-date range, defaulting to `ACTIVE_TASK_STATUSES`) and `planning.createTask` (write, through `TaskService.create`, never a `status` argument so a direct create cannot land in the `proposed` review inbox). Both resolve their `ToolExecutionContext` to a `UserServiceContext` via `toServiceContext` — same as `DatabaseSearchTool` — so there is no `SYSTEM_USER` path into `TaskService`, and both are `localCapable: true` (the corpus is entirely the user's own, no third-party dependency). Registered in `domains/tools/index.ts` next to the import/messaging intents.
  This also closed the **known gap** below it used to be: `knowledge.search` (`DatabaseSearchTool`) now hydrates a `'task'` hit through `TaskService.findByIds`, the same shape as every other resolver there. The fix that made both of these possible without a `forwardRef` or a weakened rule: `domains/planning/task.module.ts`, a narrow `TaskModule` carrying only `TaskService` + its two entities, depending on nothing but `EventsModule`/`MemoryModule` — the same DAG-breaking shape as `domains/llm/chat-model-preference.module.ts`. `PlanningModule` now imports `TaskModule` instead of declaring `TaskService` itself, so `domains/tools` (and `DatabaseSearchTool` within it) can depend on `TaskModule` directly without pulling in `LlmCoreModule` and closing `tools → planning → llm → tools`. Each cross into `domains/planning`'s internals through `task.module.ts` (rather than the `@ci/domains/planning` barrel) is a grandfathered `no-cross-domain-internals` entry, same as the `PersonalizationService`/`ChatModelPreferenceModule` precedents already in `.dependency-cruiser-known-violations.json`. `'task'` also joined `CiEntityType` (tool-core) and `IntentDomainKey`/`INTENT_DOMAINS`/`CI_ENTITIES` (`domains/tools/catalog`) so `produces: ['task']` and the `planning` domain are real, typed catalog entries rather than a documentation-only claim.
  **Adjacent, not M4:** Plan overdue reschedule (web + Plan-shaped iOS App Intents) takes off toward shared Time types in [shared-time-selectors.plan.md](shared-time-selectors.plan.md). When `planning.rescheduleTask` exists, its `day` argument is that shared type — still out of scope here, as noted when M4 was written.
- **M5 — Jobs (partial).** Queue `planning` on pg-boss; Jobs page category `planning`. Five landed handlers, fanned out by `PlanningJobsCron`:
  - `planning.todo_scan` (`0 6 * * *`) — daily fan-out; search memory → LLM surface → dedupe → `decide(task_create)` → `open` or `proposed`
  - `planning.todo_process` (`0 */6 * * *`) — every 6h; append / revise / reparent / complete under `task_mutate` / `task_complete`
  - `planning.inbox_scan` (`*/30 * * * *`) — LLM triage of recent email/SMS/chat into surfaced tasks, matching CI-Planning's `ingest_gmail` cadence (`InboxScanService`)
  - `planning.event_now` (`15 * * * *`) — hourly; revise planned blocks entering the present (`event_revise`)
  - `planning.verify_done` (`45 * * * *`) — hourly; after block end, auto-complete or ask on Plan
  Plan page remains the only user backlog (Proposed / Needs confirmation / date buckets). `/jobs` shows process jobs only — not a second to-do list.
  Still TODO for full M5: `ci.reminders` + web push.

### Parent convention (nestable CI objects)

Store **one** `parent_id` (or type-specific synonym). Do **not** add a second `sub_*` / `child_ids` column — both directions are ordinary queries.

| Nestable | Storage | Graph |
|---|---|---|
| Task | `ci.tasks.parent_id` | none (non-node) |
| Event | `ci.events.parent_event_id` | L0 `PART_OF` |
| Place | `ci.entities.parent_place_id` | Place `PART_OF` Place |
| File | `ci.files.parent_id` | `DERIVED_FROM` |

Types that should not nest simply omit the column.

### Later

Sequenced, not scheduled. Each depends on the one before unless noted.

**Recurrence** — port `engine/recurrence.ts` verbatim with a pinned `rrule`; `generate_recurrences` job; the this-occurrence-vs-all-following dialog. Never expand RRULEs in SQL.
**Objectives** — the goal tree, archive cascade with a 48h purge window, task→objective promotion. *Depends only on M1 — parallelizable.*
**Routines / patterns / day types** — 8 tables, pattern placement, `reset_routines`.
**Flight plan + autoplan** — the two-pass placer and `fill_order`. The 69KB `engine/autoplan.ts` extracted as pure core + a writer shell.
**Reactive reflow + review** — the highest-risk item in the programme. Write the four invariants below as property tests *before* the implementation.
**Insight** — reflections, five-star scoring, daily recap, estimate calibration (p50 median, 3-sample floor, honest zero), weekly review.
**Life priorities / balance** — `ci.life_priorities` plus the onboarding `Concept`/`PREFERS` bridge (`OnboardingService.captureFocusAreas` stores focus areas as graph entities with `strength: 0.9`; write `strength = importance/10` so `UserContextService` sees the rating).
**LLM agents** — plan authoring, daily brief, enrichment, auto-tag, quick-add overlay, all through `OllamaService`. The memory connector collapses: `graphContext()` → `UserContextService`, `graphSearch()` → `RecallService`, `graphData()` → `GraphReadService`, `postEvents()` → in-process `EventService.create()`.
**Intake / possibles** — listeners on the existing `PROMOTE_GMAIL_MESSAGES` / `PROMOTE_CALENDAR_EVENTS` events reading already-normalised rows; embedding dedupe on `EmbeddingGenerationService` + `SearchService`. Outlook comes free.
**Plan-my-week + FTUE** — onboarding steps registered against the existing `OnboardingService`, whose `SocialConnections`/`DataImportStep` already cover connect-a-source and run-first-sync.
**The drag-and-drop planner grid** — the only item needing a **new frontend dependency**. There is no DnD library anywhere in `frontend/` today. Recommend hand-rolled pointer events over dnd-kit (which solves sortable lists, not constrained 1-D move/resize with a collision clamp); CI-Planning's `client/src/lib/drag.ts` is 100% pure with 14KB of tests and ports verbatim. Keep the live delta **out of React state** — write `transform: translate3d()` via a ref during the gesture, commit on `pointerup`; use a CSS custom property for the group ghost so one DOM write per frame covers any group size. Ship a Playwright latency assertion with it.
**Calendar writeback** — pushing planned blocks out to Google. `domains/etl` is extract-only today, so this is new feature work in `domains/connections` (needs `calendar.events` write scope + an outbound queue), not a port.

---

## Invariants that must survive

From CI-Planning's `ARCHITECTURE.md` §6 and its hard-won scars:

1. **Clear-set equals re-place-set.** A reflow clears exactly the blocks it is about to re-place. An unscoped DELETE was the reflow-wipe bug, twice.
2. **Status parity.** A block's placement status and its task's status move together, or neither moves.
3. **Not-before-now clamp.** A re-pack never moves work into a past gap; that creates a churn loop with the missed sweep.
4. **Locked blocks are immune.** Never move in-progress, locked, or recently-moved blocks. Protection is passed **in memory**, never written as `is_locked`, so a crashed reflow cannot leave locks behind.
5. **Two clocks.** A slow LLM orders the day *once* into a frozen day plan; a fast deterministic placer re-packs. They never race.
6. **Deterministic fallback.** Every AI path degrades to a deterministic one, and the UI labels honestly — "AI Briefing" vs "Day Overview". Emit the fallback rate as a metric; if it is ~100%, the AI features are decorative and someone should know.
7. **Owner scoping is not optional.** Planning services take `UserServiceContext`, never `ServiceContext` — `SYSTEM_USER` is not a legitimate planning identity, and the `...(context.userId !== SYSTEM_USER && { userId })` idiom used elsewhere is a loaded gun here. Only a cron fan-out enqueuer touches `SYSTEM_USER`.
8. **pg-boss is at-least-once.** Idempotency comes from DB-level natural keys, not conventions. Constraints beat comments.

---

## Deliberately not doing

| | Why |
|---|---|
| Offline op-log, SSE, `sync_events`, `field_ts`, conflict resolution | They serve an offline-first PWA writing to embedded SQLite. This client is online-only, and CI-Server has no realtime layer at all — no subscriptions, no WS, no PubSub. If realtime is ever needed, add it **once** as a general capability, not a planning-only one. |
| A second Google OAuth client | `domains/connections` + `domains/etl` already own it. Two clients means two consent screens, two quota pools, two token stores. |
| `scheduled_jobs` / `job_runs` / croner | pg-boss + `@Cron` + `JobsController` + `JobMonitorService` already do this, with a `jobs.page` flag for the UI. |
| `snapshot_db`, litestream, `GET /api/export` | `better-sqlite3.backup()` against one file. Postgres backup is infrastructure. The export route's hand-maintained table list was already caught silently dropping tables. |
| `audit_log` | `DeltaEntity` is graph-only (`node_type ∈ {'entity','relationship'}`); there is no generic mutation log here. Domain events + pg-boss history + `RequestLoggerMiddleware` cover the operational need. |
| `app_config` | Configuration comes from `configuration.ts` + `custom-environment-variables.json`; `ProviderKeyService` owns provider credentials. |
| Triality | Out of scope. |

---

## Open questions

1. **Drag-and-drop dependency.** Hand-rolled pointer events (port `lib/drag.ts`) vs. a library. Needs a decision before the planner-grid phase.
2. **Tag surface.** Planning tags share `ci_search.tags` with the explorer's facets, separated only by `kind`. Long-term, does the explorer picker filter, or do the two surfaces diverge?
3. **Calendar writeback.** Worth building, or is read-only calendar + local planning enough?
4. **Model tier.** CI-Planning's quality tier is `gemma3n:e4b`; `PROMPT_MODEL` here is now `gemma4:e4b` (was `gemma3:1b`, which is what made day plans silently fall back to deterministic ordering — the tiers now match in class). Also port `lib/models.ts`'s **measured** thinking-model exclusion — thinking models return an empty `response` under `format:'json'` in 3 of 5 measured cases, and `think:false` does not rescue it.

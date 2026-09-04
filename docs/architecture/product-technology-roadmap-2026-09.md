# Companion Memory — product and technology roadmap (September 2026)

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**
>
> **Status:** point-in-time review of `main` at `a9f5ce116` (2026-09-03), written to be re-verified rather than trusted. **A first remediation pass has landed as [#2584](https://github.com/companionintelligence/CI-Server/pull/2584) — see §9 for what changed and what did not.** Every finding cites the file, doc, issue or screenshot it came from. Sizes are **S** (under a day), **M** (about a week), **L** (multi-week). Horizons are **Now** (to mid-October), **Next** (to the December freeze) and **Later** (2027). Nothing here is a commitment; it is the sequence the evidence argues for.
>
> **§3 describes the codebase as it was at `a9f5ce116`. A first remediation pass has since landed in the working tree — see [§9 Remediation status](#9-remediation-status-2026-09-03) for what is now fixed, and for the verification caveat that applies to all of it.** The findings below are deliberately left as written, as the audit record.
>
> **Method.** Seven read-only audits over the checkout (backend structure, frontend platform, AI stack, data/ops/security, information architecture, native shells and sync, prediction pillar), the committed screenshots under `docs/images/` and `video/assets/shots/`, the open GitHub issues, and the QA baselines in `docs/qa/`. No stack was run: `docker` is not on the review host, so screens were read from the captures the repo already carries (the video shots date from 2026-08-07, the nav captures from 2026-08-23).
>
> Companion docs: [architecture.md](architecture.md) · [planning-roadmap.md](planning-roadmap.md) · [../qa/ci-gate-proposal.md](../qa/ci-gate-proposal.md) · [../design/sources-ia.md](../design/sources-ia.md) · epic [#1790](https://github.com/companionintelligence/CI-Server/issues/1790)

---

## 1. Summary

Five things are true at once, and the roadmap is the order in which to fix them.

1. **The backend knows more than the product shows.** Nine subsystems produce intelligence (summaries, insights, derived suggestions, HBPE forecasts, rhythms, candidates, planning proposals, answer inference, agent memory). Three reach a screen a stock appliance renders. The Brief — the one list surface for summaries and actions — was removed from the calendar on 2026-09-02 ([#2538](https://github.com/companionintelligence/CI-Server/pull/2538)) and nothing replaced it. Forecast ships flag-off. Chat, the headline feature, is the ninth tab inside Memory and performs no retrieval of its own.
2. **The first hour loses people.** Onboarding runs nine steps, offers no way to log out or finish without syncing, and lands on an empty kanban with its empty-state copy flagged off. The shared empty-state component disables pointer events on its whole container, so the "Create note" and saved-search calls to action inside it cannot be clicked.
3. **Velocity has outrun the safety net.** 1,689 commits and 162 migrations landed in the last 30 days. Nothing gates a merge, the Postgres-backed suites skip even when CI is dispatched, both Python sidecars run with `mypy` errors ignored, the iOS lane cannot build, there is no backup or rollback path for an appliance update, and a render error on 44 of 45 web pages blanks the app because nothing above the Memory views catches it.
4. **The AI stack is careful islands without a spine.** The trust fence, tool registry, byte budgets and retrieval telemetry are unusually good. But prompts are inlined at twenty-plus call sites (the production system prompt still asks the model to be "+2sd smarter" and "more straussian"), there is no per-task model table, no process-wide GPU arbitration, five overlapping context builders and three LLM graph writers with three vocabularies.
5. **Built things are carried as dead weight.** PowerSync mounts in every session and can never connect. On-device LLM and speech plugins ship in both mobile apps with zero callers. `ci.rhythms` has no writer, `ci.event_candidates` no page, the metric forecaster no web consumer, and Summary duplicates its own prompt stack.

The through-line: **surface what is already computed, gate the pipeline that produces it, and give the AI one spine** — before adding capability.

---

## 2. Where the product stands

| Measure | Value | Source |
|---|---|---|
| Backend domains / non-test lines / test files | 56 / ~314k / 865 | `backend/apps/api/src/domains` |
| Web app lines / `.tsx` files / test files | ~133k / 700 / 352 | `frontend/apps/web/src` |
| Pages / declared routes / of which redirects | 45 / 72 / ~35 | `App.tsx`, `docs/screenshots.md` |
| SQL migrations, total / last 30 days | 356 / 162 | `db/postgres/migrations` |
| `@Cron` schedules / of which `role: worker` | 55 / 12 | `common/schedule/decorators/Cron.ts` |
| Native tools (intents) in the registry | 30 | `domains/tools/tools` |
| Commits, last 30 / 90 days | 1,689 / 2,475 | `git log` |
| Release tags in August | 15 (one every 2–3 days) | `git tag` |
| Workflows that run on a pull request | 1 of 12 (`benchmark-unit.yml`, path-filtered) | `docs/qa/ci-gate-proposal.md` |
| Intelligence producers with a rendered list surface | 3 of 9 | §3.1 P7 |

### What to keep

The roadmap proposes no rewrite of any of these. They are the parts that work, and several are better than what comparable products ship.

- **The pipeline ledger** (`domains/pipeline`, ADR-0004): versioned stages, honest skip reasons, dead-letter reaping. The nullability-ratchet write-up in its README is the clearest design argument in the repo.
- **pg-boss integration and the `Cron` wrapper**: advisory-locked provisioning, per-queue semaphores, web/worker role split, a cron registry with last-run stamps and per-schedule kill switches, an eslint ban on raw `@nestjs/schedule`.
- **The tool registry** (`domains/tools`): one chokepoint, privacy labels, the pending-action gate, an invocation ledger, and no recursive MCP re-exposure.
- **The trust boundary**: `common/prompt/untrustedBlock.ts`, speaker gates and confidence clamps in `inferredAnswerConfidence.ts`, each justified by a recorded incident.
- **Retrieval operability**: a versioned, fail-open `ci.retrieval_policy`, query-shape-only logging, ANN recall probes and coverage alerts.
- **Asks and consent**: `docs/asks-system-guide.md` and its threat model; disclosure ceilings enforced server-side.
- **Sources** and the **one-decision selectors**: `docs/design/sources-ia.md` is the model for how the rest of the IA should be argued.
- **HBPE's honest serving**: the D3 gate refuses the transformer unless it beats the day-of-week baseline and says so in the strip.
- **Boot-time schema integrity**, the migration-collision check, the feature-flag endpoint as single source of truth, `keysetPaginate` and the DataLoader base class (28 loaders).
- **Seven real iOS App Intents** and a **Tauri desktop orchestrator** that genuinely stands the stack up.
- **Documentation discipline**: file:line-cited docs with dated Δ corrections. This document follows that convention.

---

## 3. Findings

Each finding is numbered so roadmap items can point back at it.

### 3.1 Product and UX

**P1 — There is no home.** `/`, `/today`, `/feed`, `/brief`, `/insights` and `/schedule` all resolve to `/plan/calendar` or `/plan/tasks` (`App.tsx:198-325`). `#2538` deleted the Brief cards; `pages/FeedPage` (560 lines) is no longer imported. The plumbing survived: `useFeedBadgeCount` still badges Planning ▸ Calendar for actions and summaries no page shows (`layouts/Main/SecondaryNavigation/PlanningSubmenu.tsx:45`); `InitialActionsCron` seeds starter actions 24 h after onboarding (`domains/onboarding/cron/InitialActionsCron.ts:19`) into a feed nobody can open; `/brief/summaries/:id` is an orphan; Chat's starter prompts name Brief and Forecast.

**P2 — The rail hierarchy is inverted.** `RAIL_DESTINATIONS` reads Planning, Memory, Saved Searches (+Asks), Sources, Jobs (14 sub-rows), Forecast (hidden), Self, Settings (`layouts/Main/railDestinations.ts`; captures in `docs/images/nav/`). Chat is the ninth Memory tab. Sources — the one thing a new user must do — sits fourth. Jobs, an operator console, outranks both. Open issues [#2510](https://github.com/companionintelligence/CI-Server/issues/2510), [#2511](https://github.com/companionintelligence/CI-Server/issues/2511), [#2316](https://github.com/companionintelligence/CI-Server/issues/2316), [#2317](https://github.com/companionintelligence/CI-Server/issues/2317) are all symptoms of this.

**P3 — The first hour has trapdoors.** Nine onboarding steps (`pages/OnboardingPage/constants.ts`); wake/sleep/work hours, focus areas and six people are written to Person `properties` the product barely reads (four `TODO(settings)` markers in `domains/onboarding`). The onboarding page has no log-out, `/login` bounces un-onboarded users back, the last step's only exit is "Run my first sync and finish", and there is no sample-data path (`make seed` is dev-only). Landing is `/plan/tasks`: four columns reading 0 with `planning.emptyState` **off**, no sign a sync is running, no link to Sources. `frontend/packages/common/src/components/EmptyState/EmptyState.tsx:12` sets `pointer-events-none` on the whole container, so the CTAs Notes and Saved Searches place inside it are inert. `MemoryEmptyState` links "Import data" to `/settings/data` instead of `/sources/import`. People, Places, Things and Receipts say "No X found" whether empty or filtered.

**P4 — Five names for one primitive, and four more collisions.** `/self/reflections` renders `PromptsPage` (i18n `PROMPTS_*`) over `QuestionType`/`AnswerType`, gated by a flag called `insights.page`; "Life details" on `/self` is the same catalogue; context prompts are another Q&A shape; `planning-roadmap.md` reserves "Reflection" for a dated note; "Insight" separately means summary rows and Stats correlations. Things ↔ `/items/:id` ↔ `ItemType` ↔ `ci.objects` ↔ old `/inventory`. Content ↔ Files (both in the What bar). Sources ↔ Services ↔ Connections (`/connections/:id`) ↔ Providers (`/providers/:id`) ↔ Connect. Planning ↔ Plan ↔ Schedule (`SchedulePage`, `schedule.page`) ↔ Calendar ↔ Today (`TodayPage`). The wordmark says Companion Memory; every page title says Companion Intelligence.

**P5 — Import quality is visible in the list.** `docs/images/memory/explorer-list.jpg` shows subreddit subscriptions (`r/XREngine`, `r/worldnews`) and the filename `liam.broza@gmail.com.ics` rendered as calendar Events. `etl/services/Google/transform/TransformGmail.ts:119` records every Gmail message as `INBOUND` (its own TODO says so); category is hard-coded `'personal'` (`:197`, Outlook `:421`); Outlook attachments are dropped (`:423`). This is [mem.2](https://github.com/companionintelligence/CI-Server/issues/1783) in the epic, and it is the single biggest reason the explorer reads as raw import rather than memory.

**P6 — Copy and demo data over-promise.** The seeded summaries (`backend/apps/api/scripts/seed-database/data/summaries.ts`, shown in `video/assets/shots/insights-list.png`) offer to "book with your usual shop" and "compare quotes" — actions the appliance cannot take. The onboarding focus tiles promise meal planning and workout tracking (`onboarding-focus.png`). The Add menu's Predict toast says "Watch Forecast" on an appliance where `/forecast` is not registered. Planning invariant 6 already says the UI must label honestly; the copy does not yet.

**P7 — Intelligence is computed and hidden.** At default cadences Summary alone makes up to ~113 chat and ~65 embedding calls per user per day (`python-functions/cron/PythonFunctionCrons.ts:111-175`), sequentially on the one GPU, and the results have no list surface (P1). `forecast.page` ships off (`668a08b20`); `CalibrationPanel` and `DivergenceHeatmapPanel` are exported from `ForecastPanels.tsx:384,477` and never mounted (`ForecastPage.tsx:12`). Suggestions persist `evidence {metric, baseline, current, gap, sources}` (`daily-metrics/engines/SuggestionEngine.ts:210`) and the card says "No rationale available yet." (`FeedPage/FeedModal.tsx:75`). GraphQL `metricForecast` has no web consumer; `/forecast/due` and `/forecast/seasonal` are computed nightly and read by nothing a stock user sees.

**P8 — Find and Ask never meet.** One `GlobalSearchBox` (keyword by default, a Semantic chip) filters the explorer or jumps to a record; it never offers "Ask Companion about…". Asking begins only at `/memory/chat` or a right-click. "Ask" also names the interpersonal Asks feature, filed under Saved Searches.

**P9 — Personal settings and appliance administration share one overlay.** Appearance, Preferences and Location sit beside Model, MCP Servers, API Keys, OAuth Credentials and GraphiQL (`pages/SettingsPage/sections/`). Jobs is a primary destination; `/server` is a third place. The Jobs API is instance-wide and guarded only by `JwtOrApiKeyAuthGuard` (`domains/events/controllers/JobsController.ts:76-246`).

**P10 — Mobile is the web app in a box, minus the safety rails.** The phone's only navigation is the drawer (a bottom tab bar was added and reverted on 2026-08-25, `docs/screenshots.md`). Self and Reflections are open bugs on mobile ([#2318](https://github.com/companionintelligence/CI-Server/issues/2318), [#2319](https://github.com/companionintelligence/CI-Server/issues/2319)). No crash reporting reaches store builds (`VITE_SENTRY_DSN` is set by no workflow). Push registration fires on login with no entitlements, no `google-services.json` and no sender. There is no biometric app lock in front of a long-lived API key. Photo, video and audio uploads run through an in-memory promise chain (`frontend/packages/capacitor-local-hub/src/memoryUploadQueue.ts:7-12`); a force-quit loses the capture, while location fixes go through the durable SQLCipher outbox.

### 3.2 Frontend platform

**F1 — One render error blanks the app.** The only error boundary is `pages/MemoryPage/Components/ViewCrashBoundary.tsx:21-31`, scoped to Memory views; `layouts/Main/Main.tsx:42-46` wraps the outlet in `Suspense` only and `main.tsx:56-59` passes no `onUncaughtError`. Sentry is initialised (`lib/telemetry.ts:353`) but `Sentry.ErrorBoundary` is never used. A thrown render error on 44 of 45 pages unmounts the React root: a white screen with no retry.

**F2 — A 2.1 MB main bundle that pays for offline sync and the camera before login.** `vite.config.ts:73-75` records the main bundle at ~2.11 MB and raises the Workbox precache cap to 3 MiB to fit it; there is no `manualChunks`. Eleven providers mount at the root (`App.tsx:140-156`): `PowerSyncProvider` opens a WASQLite/IndexedDB database on mount regardless of auth (`api/powersync/PowerSyncProvider.tsx:27`), `CaptureModalProvider` pulls the 884-line `CaptureModal` plus `@ci/capture`, and the theme and background providers add ~1.3k lines. Route-level splitting itself is thorough (37 lazy pages, a lazy desktop/mobile split, a lazy 3D canvas, lazy settings sections) — the cost is in what mounts before any route.

**F3 — The Memory chunk ships every view's heavy dependency regardless of `?view=`.** `DesktopMemoryPage.tsx:29-33` and `MobileMemoryPage.tsx:14-21` statically import `GraphView`, `MapView` (leaflet), `StoryTimelineView` (TimelineJS) and `GalleryView`; `GraphExplorerModal.tsx:14` statically imports the 1,751-line 2D force graph plus `d3-force`. Opening the default list view downloads all of them. MemoryPage is otherwise a sound feature module: the URL is the only state (`MemoryPage.tsx:37-49`), every view reads one filter set through one provider, and deep links are stable.

**F4 — i18n is nominal.** One locale with 153 keys (`frontend/packages/common/i18n/translations/en.json`); `lib/i18n.ts:31-40` registers `en`/`en-US` with `load: 'currentOnly'` and a comment saying this breaks with a second locale. `useTranslation` appears in 25 of 242 page files; a regex sweep counts ~994 capitalised JSX text nodes in `pages/` (Settings ~217, Import ~62, Asks ~57, Jobs ~54). Localisation would be a rewrite, while `crowdin.yml` at the repo root promises a translation.

**F5 — Accessibility is unenforced.** No `jest-axe` or `@axe-core`; oxlint enables `correctness` only (`.oxlintrc.json:36-38`), no `jsx-a11y`; Storybook's a11y addon covers 48 stories. Zero skip links; `<nav>` landmarks exist only in `SecondaryNavigation.tsx`, none in `PrimaryNavigation.tsx` or `MobileNavigation.tsx`. Sixteen sampled clickable `div`/`span` elements have no role or `tabIndex` (`MapView.tsx`, `MediaLightbox.tsx`, `JobsTable.tsx`); `aria-live` appears six times app-wide. The Playwright mobile project is commented out (`playwright.config.ts:48-51`).

**F6 — Eight detail pages turn server errors into "not found".** `CommunicationPage`, `ConceptPage`, `ContentPage`, `EventPage`, `ItemPage`, `PersonPage`, `PlacePage` and `ReceiptPage` destructure `useQuery` without `error`; `PersonPage.tsx:125-128` renders "Person not found" for a 500 or an expired session. All eight directories have zero tests.

**F7 — Destructive actions without confirmation or undo.** `pages/PlanPage/useDeleteTasks.ts:17-18` says "no confirm step"; `PlanPage.tsx:97-99,372` deletes single and selected tasks on menu select with only a failure toast; `components/entities/ObjectIdentifierList.tsx:199-203` removes identifiers immediately. The good pattern exists (`DeleteEntityDialog`, `DeleteNoteModal`, `DeleteTagModal`, `DeleteSavedSearchModal`) and is not used here.

**F8 — The data layer is split three ways.** `api/ApolloProvider.tsx:45-47` builds `InMemoryCache({ possibleTypes })` with no `typePolicies` or `defaultOptions`, so pagination is re-implemented per hook (`useEntityService.tsx:381-394` dedupes edges by cursor by hand). Codegen covers 139 files; 20 still use untyped `gql` (all of `api/use*Service.ts`, `pages/ForecastPage/*`, the badge hooks, `queries.ts`). Twenty-eight raw `fetch()` sites in 17 files sit beside `apiFetch`/`fetchJson`; `useImportApi.ts` is a 2 s REST poller.

**F9 — Lists are not virtualised and fixed fetches are large.** No virtualisation library; `ListView.tsx:188-194` and `GalleryView.tsx:134` render every accumulated row (30 per page, unbounded). Fixed limits: tasks `first: 200`, dead letters 200, evolution 200, graph dots 2,000, map traces 2,000. `useEntityService.tsx:427-443` returns a fresh tuple every render, so every consumer re-renders on any provider render.

**F10 — Design-system leakage the canon lint cannot see.** 92 raw `<button>` against 383 `<Button>`; 22 `size="icon"` bypass `IconButton`; five bespoke button-likes; `InlineModal` beside Dialog (29 files), Sheet (12), AlertDialog (4) and ~30 one-off `*Modal` wrappers. 121 hex literals in 19 files and 508 Tailwind arbitrary values (`VerticalCalendar.tsx` alone has 27). `scripts/lint-canon.mjs` prints only 30 of its 93 hex warnings (`:404-410`), so the app's offenders are invisible in the gate, and its nine "undefined token" warnings point at CSS that reads tokens from an ignored `node_modules`.

**F11 — Background and polling cost.** The opt-in Conway texture (`components/ThemePicker/useBackground.tsx:397-423`) redraws a canvas and re-rasterises the page background through `toDataURL` every 360 ms, ignoring `prefers-reduced-motion` and hidden tabs — unlike `AnimatedBackground`, which gates on both. Chat's 2 s and 4 s pollers have no visibility guard or backoff; the Jobs pollers do.

### 3.3 Backend architecture

**A1 — Load-everything-then-paginate is the default.** `Paginator.paginate` (`domains/graphql/utils/Paginator.ts:18`, in-memory) has 26 call sites against 3 adopters of `common/persistence/keysetPaginate.ts`. Seventeen list queries `findAll` then slice, including `EventResolver.ts:220` → `CalendarEventService.ts:750-766` (every non-deleted event, no LIMIT), Person, Place, Note, Question, Answer, Action, Relationship, Tag, Thread, Task, Concept, Summary, SavedSearch and Connection. Off the GraphQL path, `llm/services/ChatTurnService.ts:807` loads every action on every chat turn to `.slice(0, 8)`. Personal data grows monotonically; a phone asking for twenty events materialises the table in the process that also runs 43 crons.

**A2 — One 27-domain knot, held "acyclic" by exceptions.** Tarjan over `@ci/domains/*` imports finds a single strongly-connected component of 27 domains with eight mutual pairs (graph↔memory, llm↔planning, maintenance↔pipeline, import↔maintenance, files↔pipeline, daily-metrics↔memory, personalization↔smart-rotation, files↔user). File-level cycles are avoided only by bypassing barrels, which is exactly the 41 baselined `no-cross-domain-internals` violations (`.dependency-cruiser-known-violations.json`); six files import `OllamaService` directly. `planning-roadmap.md` §M4 already hit the wall (`tools → planning → personalization → llm → tools`). The `imports` check runs only in dispatch-only `ci.yml:284`.

**A3 — Orchestration lives in resolvers and controllers.** `SearchResolver.ts` is 1,339 lines with 20 injected services and ~1,000 lines of private search logic testable only through GraphQL; `AskResolver.ts` carries 21 operations plus grant-ceiling rules; `MaintenanceController.ts` is 1,631 lines, 30 endpoints, raw SQL inline (`:731`, `:1495`); `OllamaService.ts` (1,408) mixes transport, the tool-call loop, tier routing, capability probing and preflight; `CalendarEventService.ts` (1,485) is CRUD plus search, map pins, timeline stats and hourly aggregates. `PipelineControlService.ts` (1,727) is large but well-tested and is not on this list.

**A4 — The safety net is off.** Nine of twelve workflows are `workflow_dispatch`-only and `main` has no required checks (`docs/qa/ci-gate-proposal.md`). The 2026-08-29 baseline had Prettier red on 148 files, ruff red on 153 errors, and three real backend unit failures. Fifty-seven Postgres-gated suites `describe.skip` without a database, and `ci.yml`'s `test` job declares no `services:`, so they skip even when dispatched. `pyproject.toml:160-166` sets `ignore_errors = true` for `ci.hbpe.*` and `ci.summary.*` (≈230 latent mypy errors). The iOS lane fails at the Safari-extension sync phase on every build (`frontend/apps/ios/ios/App/App.xcodeproj/project.pbxproj:384-398`, `scripts/sync-safari-extension.sh:117-120`). The one workflow that does run on PRs runs `pytest` and no linter, which is how 141 ruff errors reached `scripts/benchmark`.

**A5 — Errors leak on one transport and vanish on the other.** `common/filters/GlobalExceptionsFilter.ts:47-49` rethrows for GraphQL and there is no `formatError`, so TypeORM `QueryFailedError` text and Ollama fetch errors reach clients verbatim. Of 1,129 `catch` blocks, 772 neither log nor rethrow within six lines and 144 return `null`/`[]`/`false` (`GraphEnrichmentService.ts:491`, `LlmEndpointService.ts:55`). Two TODOs admit it (`CommunicationResolver.ts:208`, `EventResolver.ts:365`).

**A6 — Validation is uneven.** zod `ValidationPipe` covers 74 `@Body(...)` sites; 22 are bare `@Body()` including `PersonalizationController.ts:28/49/70` (trust mode unchecked at runtime), three `BulkIngestController` lanes and the Python callback. There is no zod in `graphql/inputs`, no string-length bound on GraphQL args, and query complexity (max 150) is the only limit — no depth limit (`graphql/plugins/ComplexityPlugin.ts:43`).

**A7 — Crons pile up in the web process.** 55 `@Cron` sites; the wrapper defaults `role: 'web'` and only 12 opt into the worker. `MemoryCompactionCron.ts:44-85` runs an LLM-backed compaction inline in the API event loop every five minutes. Eighteen cron files have no overlap guard; the rest use an ad-hoc mix of `running` flags, `singletonKey` and one advisory lock. Five per-minute crons and a 02:20–05:00 nightly cluster (retention, HBPE nightly, orphan cleanup, HBPE bootstrap, answers, derivation, purges) share one box. HBPE's nightly measured 11,230 s and bootstrap 12,820 s against an 8 h expiry on a runner with concurrency 1 (`python-functions/types.ts:37-45`).

**A8 — No realtime layer; fifteen pollers stand in.** No WebSocket, subscription or PubSub anywhere; chat SSE is the only stream. The web app polls at 2 s (`ChatPage/useThreadListService.ts:84`, `ImportPage/useImportApi.ts:744`), 4 s (`ChatPage.tsx:158`, `api/useDispatchJob.ts:91`), 5 s, 15 s, 30 s, 45 s, 60 s and 120 s, several of them against A1 queries. `architecture.md` §8 already lists this as a known tension.

**A9 — Duplicated and dormant subsystems.** Five context assemblers (`UserContextService.formatContextForSystemPrompt`, `ChatTurnService.buildLiveAppBlocks`, `ForecastContextService`, `PersonaContextPackService`, `LifeContextService`, plus `GET /memory/context`). Three LLM graph writers with three vocabularies (`MemoryCompactionService`, `ConceptExtractionService`, `GraphEnrichmentService` — the first lists two contradictory relationship-type sets at `:60-63`). Two "ask the user" systems (`ci.questions` vs `ci.context_prompts`). Two embedding clients (Node and Python) with separate model resolution. Two schedulers (`smart.rotation`, default off, and `PythonFunctionCrons`). `summarizer.py` and `summary_functions.py` carry duplicate prompt builders. Dormant: `ci.rhythms` (no writer), `ci.event_candidates` (writer only under a flag that is off, no page), the metric forecaster (no consumer), forage/branchial (flag-off experiment), PowerSync (mounted at `App.tsx:149`, token endpoint 503s by default, `NotesPage.tsx:47-49` reverted to GraphQL), the LocalLLM and speech Capacitor plugins (zero call sites, an 81 MB xcframework per iOS build), and a retired secure-storage pod still linked (`Podfile:45`).

### 3.4 Data, operations and security

**A10 — No backup, no rollback.** There is no `pg_dump` or backup tooling in the repo; the production runbook calls a backup "optional" (`docs/runbooks/one-off-prod-data-testing.md`). An update runs `migrate-database` and api/worker start only on its success (`docker-compose.production.yml:74-75,175-188`); an older image refuses to boot on a newer schema (`common/persistence/schemaIntegrity.ts:212-219`). 49 migrations have empty `migrate:down` sections, including `departition_position` and `convert_communications_to_cti`. The secrets volume is the encryption root and is backed up by nothing (`infrastructure/setup-secrets/entrypoint.sh:68-69`). Account export covers tables with a user column and MinIO blobs but not users, roles, pg-boss, HBPE models or secrets.

**A11 — Blocking migrations at 162 a month.** `convert_communications_to_cti.sql:18-21` rewrites "up to a few million rows" in one `INSERT … SELECT`; 155 files create indexes, none `CONCURRENTLY` (impossible inside dbmate's transaction); no `lock_timeout` or `statement_timeout` anywhere. `migration-integrity-check.yml` checks version collisions and immutability but never applies a migration. The entity-drift comparator covers 13 of 108 `@Entity` classes and skips without a database. `ci.summaries` has no unique key on `(user_id, period_type, period_start)`, so a pg-boss retry after a lost callback duplicates rows (`summary/activities.py:229-236`).

**A12 — Disk fills with zero visibility.** One retention policy exists in the whole schema (`hbpe.prediction_log`, 90 d). `ci.position` compresses at 7 d but never expires; `ci.browser_activity`, `ci.graph_deltas`, `ci.job_metrics` have none. No compose file sets `logging:`; `wal_level=logical` has no `max_slot_wal_keep_size` while a crash-loop-prone PowerSync consumer holds a slot in production. Disk is measured only as an import preflight (`domains/import/storage/databaseSpace.ts`).

**A13 — Health that checks nothing.** `common/controllers/HealthController.ts:7-19` returns a static `ok`; hbpe, summary, gateway and worker have no compose healthchecks; there are no metrics, no alerting, and the sidecars' failures surface only as dead letters on the Jobs page. `ForecastContextService` swallows to an empty string. `resolveServedChatModel` silently substitutes `served[0]` when the configured model is not pulled (`OllamaService.ts:1162-1166`); `generationStatus: 'failed'` exists in types and no UI renders it.

**A14 — Exposure without throttling.** The publish manifest marks the app `exposable: true`; there is no rate limiter or login lockout in `domains/auth` (only the asks/peers sliding windows). Portal OIDC accepts six first-party client ids plus the issuer as audience and JIT-provisions any unknown `(iss, sub)` as a local user (`auth/services/PortalTokenService.ts:66-74,253-270`). `CI_LOCAL_ONLY` gates only Sentry (`common/telemetry/settings.ts:48-52`); geocoding, map tiles, Google Fonts, Hugging Face model pulls and JWKS are ungated, which `docs/architecture/third-party-egress.md:104-105` concedes. api/worker run as root with no memory limits (a torch OOM can take Postgres with it); MinIO is unpinned; uploads trust the client MIME type. [#1780](https://github.com/companionintelligence/CI-Server/issues/1780) (capability not enforced on GraphQL for empty-scope keys) and [#1620](https://github.com/companionintelligence/CI-Server/issues/1620) (leaked keys in history) remain open.

**A15 — Single-tenant assumptions are load-bearing.** Eight of ten sampled surfaces are cleanly user-scoped; the jobs domain is instance-wide (`events/services/JobQueryService.ts:521-665`), BlueBubbles gives the first user all iMessage (`BlueBubblesSyncService.ts:702-706`), and file reads are key-only (`FileService.ts:617,632`). The multi-tenant Hub item in `architecture.md` §7.3 cannot start until these are swept.

### 3.5 AI stack

**A16 — Chat has no grounding retrieval.** `ChatTurnService.prepareTurn` (`:412-699`) assembles dossier + four live snapshots and hands the model tools; it never calls `RecallService`. Whether a question is answered from memory depends on a 4B model choosing `memory.recall` within two tool rounds (`OllamaService.ts:665-682` records tool-only turns ending in silence). Meanwhile `AnswerInferenceListener.ts:348` runs a real evidence-numbered RAG pipeline in the background that chat never uses.

**A17 — No prompt registry, no model table, no GPU arbitration.** Twenty chat call sites and one embedding path in Node, three in Python, every prompt inlined. The base system prompt at `ChatTurnService.ts:641-642` has carried "+2sd smarter" and "make it more straussian" since 2025-10-14. `PROMPT_MODEL` equals `UTILITY_MODEL` by default and background jobs split between them with no rule; the tier router is opt-in with an estimated 8K window. Five 1-slot queues plus inline persona/enrichment calls plus `p-limit(12)` embeddings plus two sidecars contend for one GPU with no process-wide semaphore; native `chatStream` has no wall-clock timeout beyond the 15-minute pg-boss expiry.

**A18 — Retrieval is unranked by time and unmeasured.** Hybrid fusion is a 50/50 weighted average "instead of RRF" (`search-next/services/SearchService.ts:850-857`) and product paths use `boosted` so hybrid is effectively unused; no reranker, no recency decay (a 2019 note outranks last week's), HNSW `ef_search` at the default 40. `scripts/benchmark` compares CI-Server to naive/mem0/hindsight but was last touched 2026-06-28 and only naive baselines are committed. JSON-mode on thinking models has a Python guard (`llm_config.py:290-316`) and no Node guard. Tool results are byte-bounded but not fenced; summarizer prompts are unfenced.

### 3.6 Prediction pillar

**A19 — HBPE runs, is honest, and is invisible.** L0/L1 occupancy over 96 buckets, Bernoulli occurrence and due/overdue renewal, nightly LoRA, Brier/ECE scoring against Qwen self-consistency, and a serve gate that refuses to beat a baseline it cannot beat. It reaches users through the calendar's rhythm lane and the chat context block; the calibration panel is unmounted (P7). [#1986](https://github.com/companionintelligence/CI-Server/issues/1986) (actuals written, nothing scores them) and [#2499](https://github.com/companionintelligence/CI-Server/issues/2499) (hard-coded sleep/work windows; forecasts not completing) are open and correctly scoped.

**A20 — Summary is Python for no structural reason.** Its work is prompt-building, SQL and pydantic-ai against the same Ollama and the same tables Node already owns. The move would remove one JWT-callback hop, the deferred-job expiry class of bug, the duplicate prompt stacks and a `markitdown[all]` image. The parser (196 lines, one dependency) is the only thing worth keeping in a container, and it should not ride the LLM service's lifecycle.

---

## 4. Roadmap

### Principles

1. **Surface before compute.** Every producer of intelligence gets a reader on a screen, or gets switched off. Nothing new is scheduled until what exists is shown.
2. **Gate before growth.** A three-minute lint-and-typecheck gate is cheaper than the weekly 32-finding review that replaced it.
3. **One spine for AI.** A prompt registry, a per-task model table, one inference semaphore, and a chat that retrieves before it speaks.
4. **Retire the duplicates.** Each capability has one owner; dormant scaffolds are gated or deleted, not carried.
5. **Operable by a non-engineer.** Backup, health, storage, model status and a real local-only switch are product features, not runbooks.
6. **Honest copy.** The UI, the onboarding and the demo data claim only what the box does today.

### Now — to mid-October: "show the value, close the trapdoors"

| # | Item | Fixes | Size |
|---|---|---|---|
| N1 | **Today home.** Route `/today` as `appHomePath()`: a now/next day strip from the calendar, the Brief cards (actions with evidence, one reflection, the latest summary), and a first-run checklist (connect, import, extension, capture). Re-point the badge, `InitialActionsCron` and the `/feed`/`/brief`/`/insights` redirects. Reuse `pages/FeedPage`. | P1, P7 | M |
| N2 | **Re-rank the rail**: Today, Plan, Memory, Chat, Sources, You, Settings, Appliance. Chat becomes top-level with Asks as its tabs; Jobs moves under Appliance. Closes #2510, #2511, #2316, #2317. | P2, P9 | S |
| N3 | **Empty states and FTUE trapdoors.** Remove `pointer-events-none` from `EmptyState`; give every browse page a CTA that links; fix the `MemoryEmptyState` import link; turn `planning.emptyState` on; add Log out and "Finish without syncing" to onboarding; add Task to the Add menu. | P3 | S |
| N4 | **Honest copy.** Delete the two rogue lines from the base system prompt; rewrite the seeded summaries to claims the box can make; align the focus-area tiles with shipped capability; drop the "Watch Forecast" toast when the route is unregistered. | P6, A17 | S |
| N5 | **"Why am I seeing this."** Render `metadata.evidence` in `FeedModal`; the `insights.explain` tool already exists. | P7 | S |
| N6 | **Grounded chat, v1.** Pre-run `RecallService.recall(latestUserTurn)` into the fenced turn-context block; render `generationStatus: 'failed'`; add an inference status card (preflight result, served model, endpoint) to Settings. | A16, A13 | M |
| N7 | **PR gate, phase 1.** `pull_request` on `ci.yml` for lint + typecheck (§3.1 of the gate proposal); ruff in `benchmark-unit.yml`; clear the red baseline (Prettier 148 files, ruff 153); add the project Postgres image as a `services:` entry so the 57 gated suites run; put the `imports` (dependency-cruiser) job on the PR path. | A4, A2 | S |
| N8 | **Keyset pagination** for events, people, places, notes, tasks and the chat-turn action load; delete `findAll` from time-growing services. | A1 | M |
| N9 | **Error and validation hygiene.** GraphQL `formatError` mapping `HttpException` to `extensions.code` and masking the rest; wrap the 22 bare `@Body()` sites; add a depth limit. | A5, A6 | S |
| N10 | **Cron safety.** `exclusive: true` in the `Cron` wrapper (skip and stamp overlaps); move LLM-backed crons to `role: 'worker'`; `UNIQUE (user_id, period_type, period_start)` on `ci.summaries` with `ON CONFLICT DO UPDATE`. | A7, A11 | S |
| N11 | **Appliance safety, phase 1.** `pg_dump` + secrets copy before `migrate-database`; compose `logging:` rotation; `max_slot_wal_keep_size`; drop `powersync` from the production profile until a client exists; memory limits on hbpe/summary; pin MinIO; `AdminOnlyGuard` on Jobs; a login throttle. | A10, A12, A14, A15 | S |
| N12 | **Native quick fixes.** `CI_SKIP_SAFARI_EXTENSION` stub for the iOS lane; `VITE_SENTRY_DSN` in the mobile workflows; gate `PowerSyncProvider` behind a flag tied to token availability; unlink the retired secure-storage pod; stop registering push tokens until a sender exists. Fix #2318, #2319. | P10, A9 | S |
| N13 | **Web resilience.** `Sentry.ErrorBoundary` around both layouts' outlets rendering `ErrorState` with a reload; `error → ErrorState onRetry` on the eight detail pages, with one test each; lazy `GraphView`, `MapView` and `StoryTimelineView` behind the existing `ViewCrashBoundary`; undo or confirm on task and identifier deletes; oxlint `jsx-a11y`, `<nav aria-label>` on both navigations, a skip link, the Playwright mobile project back on. | F1, F3, F5–F7 | S |

### Next — to the December freeze: "one spine"

| # | Item | Fixes | Size |
|---|---|---|---|
| X1 | **The AI spine.** A prompt module with snapshot tests; a per-task table of model, output format, timeout and budget read by every call site; a process-wide inference semaphore honouring `OLLAMA_NUM_PARALLEL`; a wall-clock chat deadline; capability-aware `format` fallback for thinking models; fence tool results and sidecar inputs. | A17, A18 | L |
| X2 | **One context assembler and one graph vocabulary.** Collapse the five builders into `ContextAssembler`; give the three graph writers one relationship-type set from `domains/graph/types.ts`; pick `ci.questions` or `ci.context_prompts` and retire the other. | A9 | M |
| X3 | **Vocabulary and IA, phase 2.** Reflections everywhere (rename `insights.page`); Topics = Concepts + Tags; Things and Content named once; an Appliance section (Model, MCP, API keys, OAuth credentials, Jobs, GraphiQL, Server URL); `SchedulePage` → `CalendarPage` with `schedule.page` folded into `planning.page`; Forecast under Plan when its flag is on; one product name. Update `docs/screenshots.md`. | P4, P9 | M |
| X4 | **Categorisation and job priority** ([mem.1](https://github.com/companionintelligence/CI-Server/issues/1782), [mem.2](https://github.com/companionintelligence/CI-Server/issues/1783)). pg-boss priority and an Ollama admission gate so chat is never behind a nightly; `kind` first-class in ETL so subscriptions stop being Events; fix the Gmail direction and category TODOs. | P5, A7 | L |
| X5 | **Retrieval quality.** A recency-decay term via the policy table; a committed CI-Server benchmark baseline and a dispatchable gate before any `ci.retrieval_policy` v2; tune `ef_search`; keep a reranker as a later option. | A18 | M |
| X6 | **Realtime v1.** One SSE change feed fed by the existing domain events (`EventUpdatedEvent` and peers), replacing the 2–4 s pollers first; keep GraphQL subscriptions for Later. | A8 | M |
| X7 | **Retire duplicates.** Fold Summary into Node behind `OllamaService` (keep the parser as a slim `python:slim` container); delete `summarizer.py` bodies; delete or gate `ci.rhythms`, `ci.event_candidates`, the metric forecaster and forage; decide PowerSync (§7). | A9, A20 | M |
| X8 | **Domain boundaries.** Extract an `llm-client` package (transport only) and a `memory` read-model package so llm, planning, personalization and tools depend downward; move `SearchResolver`'s privates into a `search-next` orchestrator; split `MaintenanceController` by concern; split `OllamaService` into client / tool loop / router. Retires most of the 41 baseline exceptions. | A2, A3 | L |
| X9 | **Operator surfaces.** A real `/health` (DB, MinIO, Ollama, HBPE, Summary, Portal, migration count, version) with compose healthchecks on every service; a Storage page (size by table, objects, logs, WAL, free disk, per-class retention); Model status (installed, residency, pull progress); Backup & Restore v1 (scheduled `pg_dump` + objects + secrets, a restore drill per release); an Update preflight (disk, backup taken, migration size); a heavy-migration marker with `lock_timeout`; the entity-drift comparator over all 108 entities, in CI. | A10–A13 | L |
| X10 | **Privacy that is true.** `CI_LOCAL_ONLY` gates geocoding, tiles, fonts, model pulls and JWKS; an egress panel listing what leaves the box with per-item switches; a per-box OIDC audience or owner allow-list at install; close #1780. | A14 | M |
| X11 | **Intelligence surfaces.** "How well do I know you" (calibration + divergence) under You ▸ Stats; due/overdue rhythms on Today; a summary timeline under You; Forecast on by default once #2499 completes. | P7, A19 | M |
| X12 | **Mobile as a phone app.** Decide the nav paradigm (see §7); a durable media outbox through the sidecar; biometric lock; a deep-link router with universal links; `@capacitor/network` feeding connection mode. | P10 | M |
| X13 | **Web platform.** `manualChunks` and deferring the PowerSync and Capture providers until after auth; Apollo `typePolicies` for the connection fields so hooks stop hand-paginating; retire untyped `gql` and the 28 raw `fetch` sites onto codegen and `fetchJson`; virtualise the explorer list and gallery; fix `useEntityService`'s unstable tuple; print every canon-lint warning and clear the 121 hex literals; consolidate the modal and button variants; gate the Conway texture on reduced-motion and visibility. | F2, F8–F11 | M |
| X14 | **Decide localisation.** Either commit — a `t()` sweep of ~1,000 strings, a second locale through Crowdin, `load` fixed — or remove the scaffold and `crowdin.yml`. Half-way is the expensive option. | F4 | L or S |

### Later — 2027: "compound"

| # | Item | Fixes / builds on |
|---|---|---|
| L1 | **HBPE closes its loop.** Score forecasts against actuals (#1986); learn sleep/work windows from occupancy (#2499); per-step nightly budgets on a GPU-bearing worker; incremental updates. | A19 |
| L2 | **Digital memory epic, mem.3–mem.7.** Graph projection of imported memory, latent enrichment, entity promotion, note import, hub-to-hub snapshot without re-embedding. | #1790 |
| L3 | **Planning, the sequenced tail.** Recurrence, objectives, routines, the drag-and-drop grid, calendar writeback — in the order `planning-roadmap.md` already gives. | planning-roadmap.md |
| L4 | **Agents.** OpenClaw dispatch (#2532) on the readiness object; `tools.pendingActions` on by default once the queue has a UI; chat-teaches-memory (`agent.memory.turnFragments`, `compaction`) after an eval run. | A16 |
| L5 | **Federation.** A write path for `ci.peer_links`, LLM-synthesised answers under the ceiling, disclosure budgets (#2364), RFC 9728 discovery (#2361). | peer-federation.md |
| L6 | **Multi-tenant hardening.** Sweep jobs, BlueBubbles and key-only file reads; `AdminOnlyGuard` everywhere it belongs; tenancy tests per domain. | A15 |
| L7 | **Desktop as the one-click appliance.** Updater, signing secrets, Docker-install UX, watchdog, crash reporting. | native review |
| L8 | **Ambient capture.** Share-to-Memory extensions, Siri intents for Today and Capture, Android App Actions, HealthKit; offline Ask on the on-device model — or delete the plugins. | P10 |
| L9 | **Local-first, decided.** Commit to PowerSync as a capture-first mobile store (XL) or delete it. | A9 |
| L10 | **Observability, second half.** Metrics and traces once health exists; GraphQL subscriptions if SSE v1 proves insufficient. | A8, A13 |

---

## 5. Sequencing

- **N1–N5 are one release.** They are independent of each other and of every platform item; ship them first because they change what a new user sees on day one.
- **N7 before N8–N10.** Turning the gate on before the refactors means the refactors land with checks that actually ran.
- **N6 before X1.** Grounded chat is a one-call wiring change; the spine generalises it.
- **X4 (categorisation) before X11 (surfaces)** for anything that renders Events, or the surfaces show the same raw import.
- **X7 (retire) before X8 (boundaries).** Deleting the duplicates removes a third of the edges the boundary work would otherwise have to route.
- **X9 (operator surfaces) before L6 (multi-tenant).** A box that cannot back itself up should not host a second user.
- The **planning** milestones (M2–M5 in `planning-roadmap.md`), the **digital-memory epic** (#1790) and the **HBPE** issues keep their own sequence; this roadmap places them, it does not rewrite them.

---

## 6. Measures

| Measure | Today | Target |
|---|---|---|
| Time from signup to a populated Today with one connected source | no Today | under 10 minutes |
| Intelligence producers with a rendered reader | 3 of 9 | 9 of 9, or switched off |
| Chat answers carrying at least one citation | 0 | 80% |
| p95 for `events(first: 20)` at 1M rows | unmeasured (full scan) | under 300 ms |
| PR-gate green rate; red baseline | no gate; red | 95%; zero |
| DB-backed suites that actually run in CI | 0 of 57 | 57 |
| HBPE nightly completing inside its budget | 11,230 s vs 8 h expiry | inside budget |
| Restore drill per release | never | one, recorded |
| Crash-free mobile sessions | unknown (no reporting) | measured, then 99% |
| Web pages inside an error boundary | 1 of 45 | 45 of 45 |
| Main bundle before login | ~2.1 MB | under 800 KB |

---

## 7. Decisions the owner has to make

1. **Summary sidecar** — fold into Node (recommended, X7) or keep Python and accept two prompt stacks and two embedding clients.
2. **PowerSync** — gate now (N12) and decide by December: commit to a capture-first local store (XL) or delete the dependency, the WASM worker, the CSP `wasm-unsafe-eval` allowance and the production service.
3. **Mobile navigation** — the drawer-only decision of 2026-08-25 matches desktop but hides every primary destination on a phone. Recommendation: a four-item bottom bar (Today, Memory, Chat, Capture) with the drawer for the rest; the platform conventions and the open mobile issues both point that way.
4. **CI cost** — accept roughly 8–14 hosted minutes per PR for the full `ci.yml`, take the 2–3 minute lint + typecheck subset, or make `ci-local` mandatory with the run pasted into the PR.
5. **Product name** — Companion Memory (wordmark, splash, store) or Companion Intelligence (page titles). One of them.
6. **OIDC provisioning** — keep JIT provisioning of any first-party Portal token, or bind each appliance to an owner allow-list at install.
7. **Forecast by default** — on once #2499 lands, or hidden until the scoring loop (#1986) can show a number.

---

## 8. Relationship to existing plans

| Plan | What this roadmap does with it |
|---|---|
| `architecture.md` §7 | Supersedes its "Now/Next/Later" tables with the ones above; §7.2's "Summary monthly tier" is done, "yearly" is not; "PowerSync client phase" becomes decision 2. |
| `planning-roadmap.md` | Unchanged; N1–N3 give planning the home and empty states its invariants 6 and 7 assume. |
| Epic #1790 (digital memory) | mem.1 and mem.2 move to Next (X4); mem.3–mem.7 stay Later (L2). Its "much of this is routing and exposure" finding is this document's thesis. |
| `docs/qa/ci-gate-proposal.md` | Adopted as N7 in its recommended order (§5 of that doc). |
| `vsAppleIntelligence.md` "still missing" | The enforcing dispatcher becomes L4; the uniform `EntityQuery` resolver is folded into X8's read-model package. |
| #2532 (OpenClaw dispatch) | Later (L4), after chat is grounded and the pending-action queue has a UI. |
| #1986, #2499 (HBPE) | Later (L1), with X11 surfacing what they produce. |

---

## 9. Remediation status (2026-09-03)

A first pass against these findings landed in the working tree on 2026-09-03, in the same session that produced this document. It is **uncommitted**.

### The verification caveat — read this first

**The JavaScript toolchain could not be run, so none of the TypeScript was compiled or tested.** `yarn install` fails: `@companionintelligence/tokens` is a private GitHub Packages dependency and the available `gh` token carries `repo` and `read:org` but not `read:packages`, so the registry returns 403. One command unblocks it:

```bash
gh auth refresh -s read:packages && scripts/gh-packages-auth.sh --install
```

Until that runs, **treat every TypeScript change below as unverified**. What *was* verified, and passed:

| Check | How |
|---|---|
| oxlint, whole repo, repo config | cached binary run directly; a control file proved the four new accessibility rules fire |
| ruff check + ruff format + py_compile | on the one changed Python file |
| Migration version collision guard | `bin/check-migration-versions.js`, dependency-free by design |
| Design canon | `scripts/lint-canon.mjs`, unchanged at 102 non-blocking warnings |
| YAML syntax | all 13 workflows and all 4 compose files |
| JSON syntax | both backend config files |
| Shell syntax | `bash -n` on the new backup script |
| Prettier | every file authored in this pass; 4 files remain unformatted and were **already** unformatted at `a9f5ce116` |

**Not run:** `tsc --noEmit` (both workspaces), ESLint, Jest, Vitest, Playwright, mypy, and every Docker-dependent check.

In place of the compiler, all 20 change sets were put through an adversarial review: one reviewer per cluster reading the diff as compiler, linter and test runner, then an independent verifier trying to refute each claim. That produced **26 candidate defects, 22 confirmed and 4 refuted**; all 22 were then repaired and the repairs re-checked. The largest was a genuine regression: defaulting the new cron `exclusive` option to *true* changed behaviour for all 55 schedules and broke seven existing tests, so the default was flipped to *false* and opted into explicitly on the 15 schedules that have no overlap guard of their own.

### Status per finding

| Finding | Status | What landed |
|---|---|---|
| P1, P7, N5 | **Partial** | `/today` route restored behind a new `today.page` flag that ships **off**; the badge no longer counts items no page can open; `FeedModal` renders the persisted suggestion evidence instead of "No rationale available yet." |
| P3 | **Partial** | `EmptyState` no longer kills clicks on its own calls to action (inline styles, immune to Tailwind content globs); Memory's import link repointed to `/sources/import`. Onboarding still has no log-out and no finish-without-sync. |
| P6 | **Fixed** | Seeded demo summaries no longer promise booking, quote-comparing or sign-ups; the Predict action no longer points at an unregistered `/forecast`. |
| P9 | **Partial** | Jobs API gating tightened; the admin-semantics question is in §7. |
| F1 | **Fixed** | App-level Sentry error boundary around both layouts, reusing `ErrorState`; a page crash no longer blanks the shell. Skip link added. |
| F3 | **Fixed** | Graph, map, timeline and gallery views lazy-loaded; "Try again" now issues a fresh `import()` rather than replaying React's cached rejection. |
| F5 | **Partial** | `<nav>` landmarks on both navigations; four accessibility rules enforced and verified clean. The Playwright mobile project was left honestly disabled with a note, not silently enabled. |
| F6 | **Fixed** | All eight detail pages distinguish a server error from a real 404, with a retry; eight previously untested directories now have tests. |
| F7 | **Fixed** | Bulk task delete and identifier removal now confirm; the single-row delete stays deliberately unconfirmed and its docblock now says so. |
| F11 | **Fixed** | The Conway background respects `prefers-reduced-motion` and pauses on a hidden tab. |
| A5 | **Fixed** | GraphQL `formatError` masks internal errors while passing `HttpException` messages and deliberate codes through. |
| A6 | **Partial** | Five bare `@Body()` handlers validated with zod, including the trust-mode write. Ingest and import lanes deliberately untouched. A depth limit now complements the complexity ceiling. |
| A7 | **Fixed** | Opt-in `exclusive` cron guard, applied to the 15 schedules with no guard; "Run now" reports an in-flight schedule honestly. |
| A10, A12 | **Partial** | Backup script, log rotation, memory limits, pinned MinIO, runbook now says a pre-update backup is required. Deliberately **not** wired into the automated upgrade path — see §7. |
| A11 | **Partial** | Partial unique index on `ci.summaries` with duplicate cleanup and a real `migrate:down`; the Python writer upserts without destroying a good embedding. Entity-drift coverage and migration lock timeouts not addressed. |
| A13 | **Fixed** | `/health` unchanged for liveness; new `/health/detailed` probes dependencies concurrently, never throws, leaks nothing. |
| A14 | **Partial** | Failed-login throttle, fail-open, configurable. Local-only egress gating, OIDC audience narrowing and upload MIME sniffing not done. |
| A16 | **Fixed** | Chat pre-runs recall into the existing untrusted fence, inside the existing byte budget, failing open. On by default; one env var disables it. |
| A17 | **Partial** | The two rogue prompt lines are gone. No prompt registry, no per-task model table, no global inference semaphore. |
| A4 | **Configured, unverified** | New cheap `pr-gate.yml` (lint + typecheck only, kept in its own file so the cost decision is one deletion to revert); ruff added to the one auto-running workflow; Postgres service and the test database variables added to `ci.yml`. None of it has been executed. |
| P2, P4, P5, P8, P10, F2, F4, F8, F9, F10, A1, A2, A3, A8, A9, A15, A18, A19, A20 | **Not started** | Deliberately. These are the M/L items in §4, several are the owner decisions in §7, and adding more unverifiable code while the toolchain is down would have been the wrong trade. |

### If you take one action

Restore the toolchain and run the gates before trusting any of the above:

```bash
gh auth refresh -s read:packages && scripts/gh-packages-auth.sh --install
```

Then `yarn workspace @ci/be-api typecheck`, `yarn workspace @ci/fe-web typecheck`, both lint lanes, and both unit suites.

---

## 9. Implementation status — 2026-09-03

> **Δ 2026-09-03.** The first remediation pass landed the same day as the review, on this branch, as [#2584](https://github.com/companionintelligence/CI-Server/pull/2584). Nineteen file-disjoint changes were made in parallel, adversarially reviewed (46 reviewers; 22 confirmed defects, 4 refuted), repaired, then verified against the real toolchain: both typechecks, all four lint lanes, the design canon, the migration-version check, Prettier on every touched file, ruff on the touched Python, and both full unit suites are **green** — backend 11,061 passing / 0 failing, frontend 3,524 passing / 0 failing. 94 tracked files changed (+2,414 / −273) plus 24 new files. Findings whose status changed are marked below; unmarked findings stand as written.

### Landed

| Finding | What landed | Behaviour change on a stock appliance |
|---|---|---|
| A16 | `ChatTurnService.prepareTurn` pre-runs `RecallService.recall` for the newest user message and inserts the lines inside the existing untrusted fence, admitted through the existing byte budget, under a 3 s timeout, failing open. Flag `llm.chat.groundedRecall.enabled`. | **On by default.** Up to one extra retrieval round-trip per chat turn. |
| A17 (partial) | The two rogue system-prompt bullets are gone. Prompt registry and model table are not built. | Prompt shrinks; no other change. |
| A5 | `formatError` masks non-`HttpException` errors on the GraphQL plane; `HttpException` messages and deliberate `extensions.code` values pass through. | Clients stop receiving raw TypeORM/Ollama text. |
| A6 (partial) | A memoised, cycle-safe query depth rule (`graphql.maxDepth`, default 12); zod on the personalization, context-prompt and model-routing bodies. The ingest/import bare bodies are untouched by design. | Requests nested deeper than 12 are rejected. |
| A7 | `Cron` gains `exclusive`, **default false**, opted in explicitly on the 15 schedules with no guard of their own; `fireCronJobs` reports an in-flight schedule honestly. The 40 self-guarding schedules are untouched, so every pre-existing cron test passes unmodified. | Those 15 schedules no longer overlap themselves. |
| A11 (partial) | Landed on `main` the same afternoon, independently, as `summaries_user_window_uniq` (`20260903162709`, four-column key, `WHERE period_type <> 'insight'`, with a dedupe that also clears orphaned `hbpe.summary_l1_label` rows). This branch's own three-column migration was dropped in the merge as redundant. What this branch still adds: the Python writer upserts `summary_embedding` with `COALESCE`, so a retry whose embedding call failed cannot null a good vector — main's straight overwrite would. | Nothing beyond main's migration. |
| A13 | `GET /health` unchanged; new `GET /health/detailed` probes Postgres, MinIO, the LLM endpoint (read-only) and both sidecars concurrently with timeouts, always 200, names what failed. | Additive. |
| A14 (partial) | `LoginThrottleService`: failed-login throttle keyed on client ip + identity, `auth.loginThrottle.*` (10 / 15 min), success clears, fail-open, prune cannot evict the active key. Egress gating, OIDC audience and MIME sniffing are not done. | **On by default.** |
| A15 (partial) | `POST jobs/crons/run` is now the most strongly gated route on the controller. `AdminOnlyGuard` was **deliberately not applied**: the admin backfill is a one-shot migration, so a stock appliance can end up with no admin and no in-app way to make one — the guard would lock the owner out. Jobs tenancy scoping is not done. | None. |
| A4 (partial) | `pr-gate.yml`: lint + typecheck on every PR, in its own file so the cost decision reverts by deleting it; `ci.yml`'s `test` job gains the appliance's own Postgres image and every `*_TEST_DATABASE_URL` the suites read, so the 57 gated suites run when dispatched; `benchmark-unit.yml` gains ruff. `ci.yml` stays dispatch-only. Branch protection is unchanged, so nothing blocks yet. | GitHub Actions cost of ~2–3 min per PR. |
| A10 / A12 (partial) | `scripts/backup/appliance-backup.sh` (Postgres dump with a real end-to-end truncation check, secrets copy, TimescaleDB pre/post-restore in the written procedure, explicit list of what it does not cover); the runbook now says **required**; compose log rotation on every long-running service; memory limits on hbpe/summary; MinIO pinned. Not wired into `migrate-database`. | Log rotation and limits apply on next compose up. |
| F1 | `AppErrorBoundary` (Sentry, no-DSN safe) around both layouts' outlets, rendering `ErrorState` with reload, reset on navigation; a skip link. | A page crash no longer blanks the app. |
| F3 | Graph, Map, Timeline and Gallery views are lazy in both Memory pages, inside the existing crash boundary, with a retry that issues a fresh `import()`. | Smaller Memory chunk. |
| F5 (partial) | `<nav aria-label>` on primary and mobile navigation; oxlint `jsx-a11y` enabled with a beachhead of rules the tree is already clean for. The Playwright mobile project stays off, now with the reason written down (mobile coverage lives in `playwright.e2e.config.ts`). | None visible. |
| F6 | All eight detail pages render `ErrorState` with retry on a query error; each has a test. | A 500 no longer reads as "not found". |
| F7 | Confirmation on bulk task delete and on identifier removal; the single-row delete stays unconfirmed per its documented intent, and the docblock now says so. | Two new confirm dialogs. |
| F11 | The Conway texture honours `prefers-reduced-motion` and pauses while hidden. | None for a visible tab with motion on. |
| P3 (partial) | `EmptyState` uses inline `pointerEvents` (the package is outside Tailwind's source set, so a class would never compile); Memory's "Import data" links to `/sources/import`. Onboarding log-out and finish-without-sync are not done. | Empty-state CTAs are clickable. |
| P6 | Every seeded summary claims only what the appliance does; the Predict toast no longer points at an unregistered route. | Demo copy only. |
| P1 / P7 / N5 (partial) | Flag `today.page`, **default off**. When on, `/today` renders the Brief and the Planning badge points at it; when off, the badge is suppressed instead of counting items no page shows. `FeedModal` renders the persisted suggestion `evidence`. Re-ranking the rail is not done. | None until the flag is turned on. |

### Pre-existing breakage found and fixed on the way

All from [#2558](https://github.com/companionintelligence/CI-Server/pull/2558), merged the same day as HEAD, and all reproduced at pristine HEAD in a throwaway worktree before being touched. This is finding A4 in miniature: a type error, an allowlist miss, 28 red tests and 24 lint errors reached `main` because nothing ran.

- Two type errors in `AgentDispatchService.test.ts` (a literal `as const` and an undeclared mock property).
- `AgentJobsController` missing from the hand-maintained capability allowlist.
- 28 frontend test failures: `PlanPage.test.tsx` and `ChatPage.test.tsx` were never given the `ChatWithAgent` / `useAuth` stubs that `Task.test.tsx` already had.
- 24 auto-fixable eslint errors across 12 files.
- Two stale import tests asserting a classification vocabulary (`photo`, sleep-as-health) the parsers had deliberately moved on from.

### Still open from this document

Everything not in the table above, most importantly: the **Now** items N1 (a real Today home, not just the flag), N2 (rail re-rank), N8 (keyset pagination), the remaining N3 onboarding trapdoors and N12 native fixes; all of **Next** and **Later**; and the seven decisions in §7, which this pass deliberately did not make. Two shipped-on defaults need the owner's eye: grounded recall (A16) and the login throttle (A14).

## Appendix — evidence index

Key files, so the findings can be re-checked quickly:

- Routing and nav: `frontend/apps/web/src/App.tsx`, `layouts/Main/railDestinations.ts`, `layouts/Main/AddMenu.tsx`, `layouts/Main/SecondaryNavigation/useFeedBadgeCount.ts`, `components/MemoryHub/memoryHubSections.ts`, `lib/appHome.ts`
- FTUE: `pages/OnboardingPage/constants.ts`, `domains/onboarding/services/OnboardingService.ts`, `domains/onboarding/cron/InitialActionsCron.ts`, `frontend/packages/common/src/components/EmptyState/EmptyState.tsx`
- Pagination: `domains/graphql/utils/Paginator.ts`, `common/persistence/keysetPaginate.ts`, `domains/graphql/resolvers/EventResolver.ts`, `domains/memory/services/CalendarEventService.ts`
- Boundaries: `backend/apps/api/.dependency-cruiser.mjs`, `.dependency-cruiser-known-violations.json`
- Chat and prompts: `domains/llm/services/ChatTurnService.ts`, `domains/llm/services/OllamaService.ts`, `common/prompt/untrustedBlock.ts`, `domains/search-next/services/SearchService.ts`, `domains/retrieval-policy/`
- Ops: `common/controllers/HealthController.ts`, `docker-compose.production.yml`, `common/persistence/schemaIntegrity.ts`, `infrastructure/setup-secrets/entrypoint.sh`, `domains/auth/services/PortalTokenService.ts`, `domains/events/controllers/JobsController.ts`
- Prediction: `backend/apps/hbpe/src/ci/hbpe/functions.py`, `backend/apps/summary/src/ci/summary/summary_functions.py`, `domains/python-functions/cron/PythonFunctionCrons.ts`, `frontend/apps/web/src/pages/ForecastPage/ForecastPanels.tsx`, `domains/daily-metrics/engines/SuggestionEngine.ts`
- Native: `frontend/apps/ios/ios/App/App.xcodeproj/project.pbxproj`, `frontend/packages/capacitor-local-hub/src/memoryUploadQueue.ts`, `frontend/apps/web/src/api/powersync/`, `frontend/apps/desktop/src-tauri/src/stack_manager.rs`
- QA: `docs/qa/baseline-2026-08-29.md`, `docs/qa/ci-gate-proposal.md`, `docs/architecture/test-strategy.md`

# CI-Server documentation index

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Map of everything documented in this repo, plus where the cross-repo docs live.
Orientation and quickstart are in the [root README](../README.md); the backend
developer guide is [`backend/apps/api/README.md`](../backend/apps/api/README.md).

> Index re-checked against `git ls-files docs` on **2026-08-23**. Every file tracked
> under `docs/` is listed below (images and the style-audit screenshot aside);
> `jobs-schedule-review.md` had been missing from it. The per-doc **status**
> column is the document's own claim, not a re-verification of it — except where
> a row says otherwise.

## API reference — [`docs/api/`](api/README.md)

File:line-cited reference for every way to talk to CI-Server:

| Doc | Covers |
|---|---|
| [api/README.md](api/README.md) | The three surfaces (GraphQL / REST / MCP), orientation, quick start |
| [api/graphql.md](api/graphql.md) | Endpoint, query & mutation catalog, the **bulk-ingest contract** (idempotency, deferred indexing), types, errors |
| [api/rest.md](api/rest.md) | Every REST controller: capture ingest (`/v1/events`), files, `/api/maintenance/*` enrichment, agent memory, connectors, LLM, health |
| [api/auth-and-conventions.md](api/auth-and-conventions.md) | Auth (sessions / API keys / OIDC), guard model, CORS, body limits, validation, error shapes, provenance-triple idempotency, the MCP surface |

Developer workflow around GraphQL (the in-app **GraphiQL** IDE, API-key flow, schema
codegen): [graphql-api.md](graphql-api.md).

## Architecture — [`docs/architecture/`](architecture/)

| Doc | Covers | Status |
|---|---|---|
| [architecture/architecture.md](architecture/architecture.md) | Platform & ecosystem: services, compose topology, domains, data flows, roadmap | living doc |
| [architecture/correlation-anomaly-suggestions.md](architecture/correlation-anomaly-suggestions.md) | **Derivation layer (#55):** pairwise/lagged correlation, FDR, changepoints, evidence-linked suggestions — engines that turn `daily_metrics` into hypotheses and `ci.actions` | implemented |
| [architecture/post-ingest-enrichment.md](architecture/post-ingest-enrichment.md) | **Post-ingest enrichment (#51):** server-side finish after bulk `/v1`, GPS reverse on `ci.position`, position search, objects place FK, coverage % — the producer hole behind daily metrics | implemented |
| [architecture/thicker-daily-metrics.md](architecture/thicker-daily-metrics.md) | **Thicker daily metrics (#53 leftovers):** `time_at_home`, `meeting_minutes`, `sleep_minutes`; home asked via selector / Q&A / action → `LIVES_IN` | implemented |
| [architecture/agent-harness-and-cold-start.md](architecture/agent-harness-and-cold-start.md) | **Agent harness (#59) + cold-start (#63):** REST intent execute on `/api/intents` and `/api/agent/intents`, `places.next`, 14-day copy floors, Brief producer cap, flags default on | implemented |
| [architecture/hbpe-landing.md](architecture/hbpe-landing.md) | **HBPE landing:** paper as contract (L0/L1/L2, kernel, local-first); appliance as product (live scoring, HMM, daily_metrics lifts, B0/B1/B2 gate). L2 head skipped until tokens exist. Plan snapshot: [architecture/hbpe-landing.plan.md](architecture/hbpe-landing.plan.md) | landed on `feat/hbpe-landing` |
| [architecture/planning-roadmap.md](architecture/planning-roadmap.md) | **Planning:** why CI-Planning's object model moved in-repo; `ci.tasks` + `ci.task_pending_changes`, the trust dial and `proposed` triage inbox, the `/plan` page, the planning feature flags | M0–M1 landed; M3/M5 partial; M2/M4 not started |
| [architecture/product-technology-roadmap-2026-09.md](architecture/product-technology-roadmap-2026-09.md) | **Product and technology roadmap (Sept 2026):** a point-in-time review of `main` — seven read-only audits over UX/IA, frontend, backend, AI stack, data/ops/security, native shells and the prediction pillar — with numbered findings, a Now/Next/Later plan sized S/M/L, measures, and the decisions it needs. Supersedes the roadmap tables in `architecture.md` §7. **§9 records the first remediation pass and the verification caveat that applies to it** | review 2026-09-03; first remediation pass landed same day (§9): typecheck, lint and both unit suites green; PR #2584 |
| [architecture/shared-time-selectors.plan.md](architecture/shared-time-selectors.plan.md) | **Shared Time selectors:** takeoff from Plan overdue-reschedule toward one `RelativeDay` / `TimeScope` / `Cadence` vocabulary for web chips, Siri App Intents, and context prompts | plan |
| [architecture/Database.md](architecture/Database.md) | **The database**: engine/extensions, schemas (`ci`, `ci_search`, `ci_import`, `ci_derived`, `ci_etl`, `hbpe`, `pgboss`, plus vestigial `ci_core`), tables by domain, class-table inheritance, idempotency/dedup design, indexing (HNSW/GIN/GIST), hypertables, migration workflow | verified 2026-08-19 |
| [architecture/life-graph-matrix.md](architecture/life-graph-matrix.md) | **Life graph under CTI** (#1945–#1947): ontology, L0/L1/L2 layers, deterministic edge matrix, job path, code map, PR #1943 delivery notes | living doc |
| [architecture/entity-merge.md](architecture/entity-merge.md) | **Entity identity & merge:** what the merge primitive does today (tombstones, `ci.entity_merges`, blocks, scored `ci.merge_candidates`) and the design for the parts still unbuilt, per entity type | survey + design |
| [architecture/account-deletion.md](architecture/account-deletion.md) | **`DELETE /account` and the purge:** immediate `deleted_at` revocation vs the deadline-driven `AccountPurgeService` hard delete — the source for the App Store / Play data-safety answers | implemented |
| [architecture/third-party-egress.md](architecture/third-party-egress.md) | Where data still leaves the appliance, so the "your records stay on hardware you own" claim can be stated accurately. Targeted sweep, **not** an exhaustive audit | living doc |
| [architecture/hypertable-audit.md](architecture/hypertable-audit.md) | Every `create_hypertable` in the migration history audited in both directions, and the criteria for future ones. De-hypertabled `ci.communications`; departitioned `ci.position` / `ci.user_snapshots` | accepted; remediation landed |
| [architecture/schema-consolidation.md](architecture/schema-consolidation.md) | The LifeScope-audit consolidation waves A–E, and the hypertable exceptions that are settled and should not be reopened. Backing audit: [lifescope-vs-ci-server-schema.html](architecture/lifescope-vs-ci-server-schema.html) | waves A–E landed; D reverted (`ci.browser_activity` is again the sole home) |
| [architecture/schema-cleanup-plan.md](architecture/schema-cleanup-plan.md) | The sequenced `DROP`/rename plan from the 41-agent schema audit — each change replayed against a throwaway replica, with a "review corrections" preamble that overrides the body. Backing audit: [schema-comparison-lifescope.html](architecture/schema-comparison-lifescope.html) | plan |
| [architecture/adr-pipeline-ledger.md](architecture/adr-pipeline-ledger.md) | **ADR-0004:** `ci.pipeline_state` as a versioned ledger replacing "is the column I write still NULL?" as the completion test (filed alongside, not inside, `adr/`) | accepted 2026-08-09 |
| [architecture/event-ingest-spec.md](architecture/event-ingest-spec.md) | Unified capture-event ingest (`/v1/events`) spec | partially implemented — see status header |
| [architecture/hub-inference-integration.md](architecture/hub-inference-integration.md) | Getting LLM + embedding config from CI-Hub's inference proxy | design/proposal |
| [architecture/test-strategy.md](architecture/test-strategy.md) | Test layers, priorities, conventions, coverage ratchet — **plus which runner each workspace uses, the sixteen `*_TEST_DATABASE_URL` variables, and the two suites that are red on `main` before you touch anything** | active; §1 re-surveyed 2026-08-23 |

### Architecture decision records — [`docs/architecture/adr/`](architecture/adr/)

| ADR | Decision | Status |
|---|---|---|
| [adr/0001-rest-for-file-uploads.md](architecture/adr/0001-rest-for-file-uploads.md) | REST for binary file uploads, GraphQL for everything else | accepted 2026-04-08 |
| [adr/0002-timescaledb-hypertable-criteria.md](architecture/adr/0002-timescaledb-hypertable-criteria.md) | When a table may be a TimescaleDB hypertable (companion to the hypertable audit) | accepted 2026-08-07 |
| [adr/0003-tenancy-column.md](architecture/adr/0003-tenancy-column.md) | `user_id` as the one canonical tenancy column | accepted 2026-08-08 |

ADR-0004 lives one level up as [`architecture/adr-pipeline-ledger.md`](architecture/adr-pipeline-ledger.md).

## Product requirement docs — [`docs/prd/`](prd/)

- [prd/asynchronous-document-parsing.md](prd/asynchronous-document-parsing.md) — extracting,
  chunking and indexing the text inside uploaded documents. Written as a draft (2026-04-03);
  the parsing domain has since shipped at `backend/apps/api/src/domains/parsing/`.
- [prd/unified-content-identity-lifecycle-embeds.md](prd/unified-content-identity-lifecycle-embeds.md)
  — one object model for content identity, lifecycle and embeds, from a 14-agent
  survey-and-critique pass. Proposal; its cross-repo half predates the CI-Import-Tools
  retirement, and `domains/identity` is implemented but still unwired.

## Design explorations — [`docs/design/`](design/)

- [design/selectors.md](design/selectors.md) — catalog of one-decision feed / onboarding selectors. Time takeoff: [architecture/shared-time-selectors.plan.md](architecture/shared-time-selectors.plan.md)
- [design/selectors-catalog.html](design/selectors-catalog.html) — interactive HTML mocks
- [design/sources-ia.md](design/sources-ia.md) — why `/connections`, `/connect` and `/import`
  became one **Sources** surface (`/sources/:half?`), and what each old route redirects to

## Spikes & scratch designs

- [spikes/webbed-feet-graph-view.md](spikes/webbed-feet-graph-view.md) — spike: a full-bleed
  force-layout graph view for the Explorer, over the unchanged graph read APIs
- [`docs/scratch1-bdc/`](scratch1-bdc/) — the 2026-08-09 prediction/planning proposal set,
  for team review rather than as a record of what shipped:
  [system map](scratch1-bdc/ci-prediction-doc-map.md) (start here — how the four systems relate) ·
  [HBPE data-rich redesign](scratch1-bdc/hbpe-data-rich-redesign.md) ·
  [tasks & scheduling](scratch1-bdc/tasks-and-scheduling.md) ·
  [completion detection](scratch1-bdc/completion-detection.md)

## Features

- [saved-search-sharing.md](saved-search-sharing.md) — saved searches: full-filter capture,
  capability-link sharing, the read-only shared viewer.
- [asks-system-guide.md](asks-system-guide.md) — **the reference document for the Asks
  feature; read it before changing anything on the consent path.** Grants, modes, the
  disclosure ladder and the four ceilings that combine into one; the capture-at-consent-time
  rule and the revocation-widens-disclosure bug it exists to prevent; the ask lifecycle local
  and federated, with the tables written at each step; the privacy properties that are
  deliberately counter-intuitive, each with its reasoning; how to run the `/asks` page, the
  two-box federation harness and the consent-path CI gate; screenshots of every surface; and
  the nine known gaps — two of them blockers — stated unsoftened.
- [peer-federation.md](peer-federation.md) — asking questions across two Companion memories:
  Portal discovery, the three ask archetypes, the consent gate, free/busy without leaking a
  calendar.
- [asks-threat-model.md](asks-threat-model.md) — the adversaries the ask feature does and
  does not defend against: coercion in a shared household, stalking via repeated free/busy,
  social engineering at the consent moment, prompt injection (traced, none today),
  cumulative disclosure, and the default tier. Read before changing a ceiling. Companion to
  [asks-system-guide.md](asks-system-guide.md): that one is how the feature works, this one
  is what it does not defend.

## Import & ETL — [`docs/import/`](import/)

How a personal archive becomes rows in `ci.*`, and how to work on that safely.

| Doc | Covers |
|---|---|
| [import/etl-agent-guide.md](import/etl-agent-guide.md) | **Start here to fix an import bug.** The stage spine (`unpack → parse → media → push`) and what one-stage-at-a-time costs on a real corpus; the routing rules (`destinationsFor`) and the provenance triple; **`INGEST_REFRESH_COLUMNS` — why a re-import does NOT repair most columns**; the six recurring failure modes with the PR/migration for each; how to verify a fix (count before/after, and a test that fails with the fix reverted); local setup; the QA baseline queries |
| [cli/ci-import.md](cli/ci-import.md) | The `ci-import` command line: every command, what was kept/dropped from the retired standalone importer, and why it is an HTTP client rather than an embedded server |
| [runbooks/import-acceptance-2026-08.md](runbooks/import-acceptance-2026-08.md) | The August 2026 acceptance pass against a live stack: a 2.7GB Takeout end to end, four defects found and fixed, the per-row→batched push measurement (1,000 → 73,000 rows/min), and gotchas |

## Frontend conventions — [`docs/frontend/`](frontend/)

- [frontend/tooltips-and-i18n.md](frontend/tooltips-and-i18n.md) — the `IconButton` /
  `Tooltip` contract for icon-only controls, and the i18next setup shared with CI-Hub
  (flat `SCREAMING_SNAKE` keys, `en.json` as the Crowdin source).
- [screenshots.md](screenshots.md) — the UI screenshots the docs want, the routes to capture
  them from, and the naming/committing conventions (`docs/images/`). Carries the current
  **nav map** — the Power Rail, the Memory hub and the Self hub, with captures of the
  first two — and the full redirect table for the addresses that moved.

## Jobs & background work

- [jobs-system-rebuild-plan.md](jobs-system-rebuild-plan.md) — the working design document
  behind the jobs/data-processing rebuild. Written before the CI-Import-Tools retirement
  (flagged in its own header) and before Temporal was removed, so read it as the plan, not
  as the current system.
- [jobs-schedule-review.md](jobs-schedule-review.md) — the **`@Cron` half**: the Jobs
  dashboard "Schedules" card, the cron methods behind it, and what it costs to run against
  a full corpus. **Point-in-time review; its whole "Fix these first" list has since landed**
  and the doc now carries a status box saying so per item. Read it for the analysis, not as
  a work list. (This file was absent from this index until 2026-08-23.)
- [runbooks/jobs-system-review-2026-08.md](runbooks/jobs-system-review-2026-08.md) — how
  pg-boss actually behaves here, verified against the pg-boss source and a live appliance
  database on 2026-08-17, and the Jobs-dashboard changes that came out of it.
- [operations/job-controls.md](operations/job-controls.md) — the **persisted operator
  controls**: on / pause / off per queue and per schedule, concurrency ceilings, why the
  appliance-wide number is divided by the worker-process count, which seven jobs refuse to
  be switched off, and why the Hub's per-app CPU limit and these queue caps are different
  ceilings that do not substitute for each other.

## Operations — [`docs/operations/`](operations/)

- [operations/error-reporting.md](operations/error-reporting.md) — Sentry: opt-out by design,
  what a missing DSN means (nothing initialises), and the `CI_TELEMETRY` / `CI_LOCAL_ONLY`
  switches.
- [operations/job-controls.md](operations/job-controls.md) — turning Memory's work down
  without turning it off. See [Jobs & background work](#jobs--background-work) above.
- [CI.md](CI.md) — **running CI for this repo.** Every workflow is gated to
  `workflow_dispatch`; this is how to dispatch one and how to run the same checks locally.
  Generated from `CI-Local-CICD` — do not hand-edit.

## Runbooks (operator procedures)

- [`docs/runbooks/one-off-prod-data-testing.md`](runbooks/one-off-prod-data-testing.md)
  — one-off PR deploy against Hub production data; env handling, rollback, and production update path.
- [`backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md`](../backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md)
  — high-throughput imports: the GraphQL bulk path, index deferral, TimescaleDB-aware loading.
- [`backend/apps/api/db/postgres/INGEST_RESET_RUNBOOK.md`](../backend/apps/api/db/postgres/INGEST_RESET_RUNBOOK.md)
  — wiping all bulk-ingested data for a clean re-import (server + importer watermark).
- [`docs/runbooks/pipeline-operations.md`](runbooks/pipeline-operations.md)
  — reading, steering and stopping the enrichment pipeline (`ci.pipeline_*`, the three pg-boss queues).
- [`docs/runbooks/pipeline-enrichment-loop.md`](runbooks/pipeline-enrichment-loop.md)
  — the enrichment loop end to end.
- [`docs/runbooks/import-acceptance-2026-08.md`](runbooks/import-acceptance-2026-08.md)
  — the import acceptance pass; see also the [Import & ETL](#import--etl--docsimport) section above.
- [`docs/runbooks/jobs-system-review-2026-08.md`](runbooks/jobs-system-review-2026-08.md)
  — the pg-boss/Jobs-dashboard review; see [Jobs & background work](#jobs--background-work) above.

## Elsewhere

- **User-facing docs:** the [Companion Memory page on docs.ci.computer](https://docs.ci.computer/docs/apps-available/first-party-apps/companion-memory-server)
  (source in the CI-Docs repo). The older `/docs/first-party-apps/digital-memory-server`
  slug only still resolves via a 301.
- **Cross-repo platform architecture & roadmap:** `CI-Engineering/architecture/` (private repo).
- **HBPE sidecar design docs:** `CI-Engineering/architecture/HBPE/`.
- **Importer:** CI-Server's own native import domain, `backend/apps/api/src/domains/import/`.
  Its push stage calls the ingest services **in process** (`CommunicationService`,
  `ContentService`, `EventService`, `ItemService`, `PositionService`,
  `BrowserActivityService`, `GraphIngestService`) — not over GraphQL. The bulk GraphQL
  mutations still exist for *external* bulk clients:
  [api/graphql.md §4.7](api/graphql.md#47-bulk-ingest-mutations-the-importer-surface--detailed).
  Ported from the now-retired CI-Import-Tools (`ZARCHIVED-CI-Import-Tools`).

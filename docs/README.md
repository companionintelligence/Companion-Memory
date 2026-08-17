# CI-Server documentation index

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Map of everything documented in this repo, plus where the cross-repo docs live.
Orientation and quickstart are in the [root README](../README.md); the backend
developer guide is [`backend/apps/api/README.md`](../backend/apps/api/README.md).

## API reference — [`docs/api/`](api/README.md)

File:line-cited reference for every way to talk to CI-Server:

| Doc | Covers |
|---|---|
| [api/README.md](api/README.md) | The three surfaces (GraphQL / REST / MCP), orientation, quick start |
| [api/graphql.md](api/graphql.md) | Endpoint, query & mutation catalog, the **bulk-ingest contract** (idempotency, deferred indexing), types, errors |
| [api/rest.md](api/rest.md) | Every REST controller: capture ingest (`/v1/events`), files, `/api/maintenance/*` enrichment, agent memory, connectors, LLM proxy, health |
| [api/auth-and-conventions.md](api/auth-and-conventions.md) | Auth (sessions / API keys / OIDC), guard model, CORS, body limits, validation, error shapes, provenance-triple idempotency, the MCP surface |

Developer workflow around GraphQL (the in-app **GraphiQL** IDE, API-key flow, schema
codegen): [graphql-api.md](graphql-api.md).

## Architecture — [`docs/architecture/`](architecture/)

| Doc | Covers | Status |
|---|---|---|
| [architecture/architecture.md](architecture/architecture.md) | Platform & ecosystem: services, compose topology, domains, data flows, roadmap | living doc |
| [architecture/Database.md](architecture/Database.md) | **The database**: engine/extensions, schemas (`ci`/`ci_search`/`ci_etl`/`hbpe`), tables by domain, idempotency/dedup design, indexing (HNSW/GIN/GIST), hypertables, migration workflow | verified 2026-07-06 |
| [architecture/life-graph-matrix.md](architecture/life-graph-matrix.md) | **Life graph under CTI** (#1945–#1947): ontology, L0/L1/L2 layers, deterministic edge matrix, job path, code map, PR #1943 delivery notes | living doc |
| [architecture/event-ingest-spec.md](architecture/event-ingest-spec.md) | Unified capture-event ingest (`/v1/events`) spec | partially implemented — see status header |
| [architecture/hub-inference-integration.md](architecture/hub-inference-integration.md) | Getting LLM + embedding config from CI-Hub's inference proxy | design/proposal |
| [architecture/test-strategy.md](architecture/test-strategy.md) | Test layers, priorities, conventions, coverage ratchet | active |

## Design explorations — [`docs/design/`](design/)

- [design/selectors.md](design/selectors.md) — catalog of one-decision feed / onboarding selectors
- [design/selectors-catalog.html](design/selectors-catalog.html) — interactive HTML mocks

## Features

- [saved-search-sharing.md](saved-search-sharing.md) — saved searches: full-filter capture,
  capability-link sharing, the read-only shared viewer.

## Frontend conventions — [`docs/frontend/`](frontend/)

- [frontend/tooltips-and-i18n.md](frontend/tooltips-and-i18n.md) — the `IconButton` /
  `Tooltip` contract for icon-only controls, and the i18next setup shared with CI-Hub
  (flat `SCREAMING_SNAKE` keys, `en.json` as the Crowdin source).

## Runbooks (operator procedures)

- [`docs/runbooks/one-off-prod-data-testing.md`](runbooks/one-off-prod-data-testing.md)
  — one-off PR deploy against Hub production data; env handling, rollback, and production update path.
- [`backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md`](../backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md)
  — high-throughput imports: the GraphQL bulk path, index deferral, TimescaleDB-aware loading.
- [`backend/apps/api/db/postgres/INGEST_RESET_RUNBOOK.md`](../backend/apps/api/db/postgres/INGEST_RESET_RUNBOOK.md)
  — wiping all bulk-ingested data for a clean re-import (server + importer watermark).

## Elsewhere

- **User-facing docs:** the [Companion Memory page on docs.ci.computer](https://docs.ci.computer/docs/first-party-apps/digital-memory-server)
  (source in the CI-Docs repo).
- **Cross-repo platform architecture & roadmap:** `CI-Engineering/architecture/` (private repo).
- **HBPE sidecar design docs:** `CI-Engineering/architecture/HBPE/`.
- **Importer:** CI-Import-Tools (pushes via the GraphQL bulk mutations —
  [api/graphql.md §4.7](api/graphql.md#47-bulk-ingest-mutations-the-importer-surface--detailed)).

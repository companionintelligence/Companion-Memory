# CI-Server API Reference

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

CI-Server is the **memory brain** of the Companion Intelligence appliance — a personal database, RAG/search engine, knowledge graph, and behavioral-prediction engine. This directory documents every way to talk to it.

It is a single **NestJS 11** process (default `0.0.0.0:3030`) backed by PostgreSQL 18 + pgvector + TimescaleDB + PostGIS (see [Database.md](../architecture/Database.md)), Ollama (local LLM/embeddings), PGBoss (jobs), and MinIO (object store). All clients — the React/Vite web app, the native iOS/Android shells (`frontend/apps/ios`, `frontend/apps/android`) and the iOS App Intents, Companion Capture, and MCP agents (CI-Hermes, CI-OpenClaw) — reach it through the surfaces below. (The importer is CI-Server's own native import domain, `backend/apps/api/src/domains/import/`, running in-process — not a separate external client — ported from the now-retired CI-Import-Tools, since renamed `ZARCHIVED-CI-Import-Tools`.)

The same binary also boots headless as a **worker** (`processRole() === 'worker'` in `main.ts`) — the full DI graph with no HTTP server — so the long synchronous import stages run off the interactive event loop.

## The three surfaces

| Surface | Endpoint | Best for | Doc |
|---|---|---|---|
| **GraphQL** | `POST /graphql` | The web app and any rich client: reads (events, communications, content, graph, search, forecast, tasks/schedule, metrics, asks) and writes, incl. the high-throughput **bulk ingest** mutations | **[graphql.md](graphql.md)** — 93 queries, 117 mutations, 285 named types |
| **REST** | 50 NestJS controllers | Bulk capture ingest (`/v1/*`), file/media upload, the `/maintenance/*` and `/pipeline/*` enrichment surfaces, in-process import runs (`/import/*`), agent memory (`/memory/*`), the intent catalog, connectors, LLM/chat, account export & deletion, health | **[rest.md](rest.md)** |
| **MCP** | `POST /mcp` (JSON-RPC + SSE) | AI agents: every GraphQL query/mutation is auto-exposed as a privacy-labelled tool, plus curated intents — both filtered per caller by the key's scopes and capability | **[auth-and-conventions.md](auth-and-conventions.md) §5** |

Cross-cutting concerns — **authentication (session cookies / API keys / OIDC / Portal bearers), the guard model, API-key scopes and capability, CORS, body limits, validation, error shapes, and the provenance-triple idempotency convention** — are in **[auth-and-conventions.md](auth-and-conventions.md)**.

## Orientation — the five things to know first

1. **No server-side `/api` prefix.** Controllers mount at bare paths (`/graph`, `/v1/events`). Browsers call same-origin `/api/*`; the fronting proxy (Vite dev server / Caddy / Traefik) **strips `/api`** before the request reaches Nest. A raw API client calls the bare path. *(No controller bakes `api/` into its own mount any more: `MaintenanceController`, `PipelineController`, `IntentsController` and four more did, which doubled the browser-facing URL to `/api/api/…` behind the stripping proxy and left the single `/api/…` a client asked for a 404. They were unbaked in #2645, `243b15945` and #2653, and `controllerGatewayPrefix.test.ts` now fails on any `@Controller('api…')`. The paths quoted throughout these docs are the bare mounts; put one `/api` in front of them behind the proxy.)*

2. **Three credentials, one guard.** Most routes accept **either** an access-token `Authorization: Bearer` JWT (the web app), an API key as `x-api-key` or `Authorization: Bearer <key>` (programmatic clients), **or** a Portal OIDC bearer (**on by default** since `auth.portal.enabled` flipped true) — via `JwtOrApiKeyAuthGuard`. `userId` flows through an AsyncLocalStorage context and scopes every query. There is no global auth guard and no `@Public` decorator — a route is public simply by declaring no auth guard (`/health`, the login endpoints, `/config/telemetry`, `/_internal/features/global`).

   A **scope-limited** API key is additionally confined deny-by-default to the routes that declare a scope it holds (`memory`, `intents`, `mcp`, `capture`, `agent-jobs`), and its `capability` (`read` / `write` / `full`) decides what it may do there.

3. **Bulk ingest dedups on the provenance triple `(source_type, source_system, source_id)`.** The high-volume write paths that carry it — `/v1/events`, `/v1/communications`, `/v1/contents`, `/v1/things`, `/v1/browser-activity`, `/v1/positions`, `/v1/receipts`, `/v1/product-models`, `/v1/observations`, and the GraphQL `createEvents`, `createCommunications`, `createContents`, `createThings`, `createBrowserActivities` — are set-based and idempotent on it, so the importer can re-push the same records without creating duplicates. The triple is optional on every one of those lanes except `/v1/events`, which requires `source_system` + `source_id` (and defaults `source_type` to `capture`); a record that omits it has no capture identity and materializes directly, deduped only by its own service's key — positions on `(user_id, time)`. **`POST /v1/notes` is the one lane with no triple in its schema at all** (`bulkNoteRecordSchema` is `id`/`title`/`content`/`captured_at`): it is idempotent on the client-minted note uuid, last-write-wins on `captured_at`. See [graphql.md §4.7](graphql.md#47-bulk-ingest-mutations-the-importer-surface--detailed).

4. **Bulk load defers indexing.** The bulk paths pass `emitCreated:false` — they skip the per-row event fan-out, so search embedding is **deferred** to `POST /v1/ingest/finish` (or the older `POST /maintenance/search-index/backfill`). A load that pushes data but never runs the finish/maintenance chain will have rows that are stored but not yet searchable. (`/v1/notes` is again the exception — it emits per row and indexes live, because `note` is in `INDEXABLE_ENTITIES` but not `BACKFILLABLE_ENTITIES`, so the deferred sweep could never reach it.)

5. **The full load flow** is: stream records to the REST `/v1/*` lanes (NDJSON) → upload media via `POST /v1/files` (or `POST /files/upload`) → sync the graph via GraphQL `bulkIngestGraph` + `bulkIngestItemRelationships` → run the enrichment chain via `POST /v1/ingest/finish` (or `POST /maintenance/orchestrate`) → poll `GET /v1/ingest/status` / `GET /maintenance/search-index/embedded-count` for the embed-drain progress. See [rest.md — "What the importer drives"](rest.md#what-the-importer-drives-during-a-run).

## Quick start

```bash
# 1. Authenticate — either a browser session (see auth-and-conventions.md §1.1)
#    or, for a programmatic client, an API key (managed at /keys, which needs a
#    browser session or a CI-Portal bearer — never another API key):
KEY=a1b2c…   # 64 hex chars, shown once at creation

# 2. Query GraphQL
curl -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"query":"{ me { id email }  events(first:5){ totalCount edges{ node{ id title } } } }"}' \
  https://ci-memory.example.com/api/graphql

# 3. Bulk-ingest events (idempotent on the provenance triple)
curl -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"query":"mutation($i:[CreateEventInput!]!){ createEvents(input:$i){ id } }",
       "variables":{"i":[{"title":"Lunch","startTime":"2026-07-01T12:00:00Z",
                          "sourceType":"calendar","sourceSystem":"google","sourceId":"evt_123"}]}}' \
  https://ci-memory.example.com/api/graphql

# 4. Connect an MCP agent (companion-memory server)
curl -i -X POST https://ci-memory.example.com/api/mcp \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"agent","version":"1.0"}}}'
```

## Contents

- **[graphql.md](graphql.md)** — the GraphQL endpoint, auth/context, the full query & mutation catalog, the bulk-ingest contract (idempotency, deferred indexing, per-service arbiters), key types, and error semantics.
- **[rest.md](rest.md)** — every REST controller (ingest, files, maintenance/enrichment, pipeline, import runs, memory/graph, agent memory & intents, connectors, LLM/chat, account portability, pairing, peers, Solid, jobs, health) with per-route tables, plus what the importer drives.
- **[auth-and-conventions.md](auth-and-conventions.md)** — the auth mechanisms, guard model, API-key scopes & capability, CORS, body/validation/error conventions, the provenance-triple idempotency key, and the MCP surface.

## See also

- [docs index](../README.md) — everything documented in this repo
- [Database.md](../architecture/Database.md) — schemas, the idempotency/dedup design behind §3–4 above, indexing, hypertables
- [Bulk load runbook](../../backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md) / [ingest reset runbook](../../backend/apps/api/db/postgres/INGEST_RESET_RUNBOOK.md) — operator procedures around the bulk path
- [GraphiQL IDE & codegen workflow](../graphql-api.md) — exploring this API interactively; regenerating schema/types
- [Backend developer guide](../../backend/apps/api/README.md)

---

*These documents are generated from and cite the actual source (`backend/apps/api/src`, `file:line`). The generated GraphQL SDL at `domains/graphql/__generated__/schema.graphql` is the ultimate source of truth for the GraphQL surface.*

*Route catalogs, controller/query/mutation counts and guard assignments re-verified against the tree on **2026-08-19**.*

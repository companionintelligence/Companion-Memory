# CI-Server API Reference

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

CI-Server is the **memory brain** of the Companion Intelligence appliance — a personal database, RAG/search engine, knowledge graph, and behavioral-prediction engine. This directory documents every way to talk to it.

It is a single **NestJS 10** process (default `0.0.0.0:3030`) backed by PostgreSQL 18 + pgvector + TimescaleDB + PostGIS (see [Database.md](../architecture/Database.md)), Ollama (local LLM/embeddings), PGBoss (jobs), and MinIO (object store). All clients — the React/Vite web app, CI-Import-Tools, CI-Connect, mobile App Intents, and MCP agents (CI-Hermes, CI-OpenClaw) — reach it through the surfaces below.

## The three surfaces

| Surface | Endpoint | Best for | Doc |
|---|---|---|---|
| **GraphQL** | `POST /graphql` | The web app and any rich client: reads (events, communications, content, graph, search, forecast) and writes, incl. the high-throughput **bulk ingest** mutations | **[graphql.md](graphql.md)** — 54 queries, 68 mutations, ~160 types |
| **REST** | ~28 NestJS controllers | Capture ingest (`/v1/events`), file/media upload, the `/api/maintenance/*` enrichment chain, agent memory (`/memory/*`), connectors, LLM proxy, health | **[rest.md](rest.md)** |
| **MCP** | `POST /mcp` (JSON-RPC + SSE) | AI agents: every GraphQL query/mutation is auto-exposed as a privacy-labelled tool, plus curated intents | **[auth-and-conventions.md](auth-and-conventions.md) §5** |

Cross-cutting concerns — **authentication (session cookies / API keys / OIDC), the guard model, CORS, body limits, validation, error shapes, and the provenance-triple idempotency convention** — are in **[auth-and-conventions.md](auth-and-conventions.md)**.

## Orientation — the five things to know first

1. **No server-side `/api` prefix.** Controllers mount at bare paths (`/graph`, `/v1/events`). Browsers call same-origin `/api/*`; the fronting proxy (Vite dev server / Caddy / Traefik) **strips `/api`** before the request reaches Nest. A raw API client (or the importer) calls the bare path. *(A few controllers — `api/maintenance`, `api/intents` — hardcode `api/` into their own path so their public URL survives the rewrite.)*

2. **Three credentials, one guard.** Most routes accept **either** an access-token `Authorization: Bearer` JWT (the web app), an `x-api-key` header (programmatic clients), **or** a Portal OIDC bearer (migration path) — via `JwtOrApiKeyAuthGuard`. `userId` flows through an AsyncLocalStorage context and scopes every query. There is no global auth guard and no `@Public` decorator — a route is public simply by declaring no auth guard (`/health`, the login endpoints, `/_internal/features/global`).

3. **Bulk ingest dedups on the provenance triple `(source_type, source_system, source_id)`.** Every high-volume write path (`createEvents`, `createCommunications`, `createContents`, `createInventoryItems`, `createBrowserActivities`, `/v1/events`) is set-based and idempotent on this triple — the importer can re-push the same records without creating duplicates. See [graphql.md §4.7](graphql.md#47-bulk-ingest-mutations-the-importer-surface--detailed).

4. **Bulk load defers indexing.** The bulk paths pass `emitCreated:false` — they skip the per-row event fan-out, so search embedding is **deferred** to `POST /api/maintenance/search-index/backfill`. An import that pushes data but never runs the maintenance chain will have rows that are stored but not yet searchable.

5. **The importer's full flow** (CI-Import-Tools) is: push records via the GraphQL bulk mutations → upload media via `POST /files/upload` → sync the graph via `bulkIngestGraph` + `bulkIngestItemRelationships` → run the enrichment chain via `POST /api/maintenance/orchestrate` (or the per-leg fallback) → poll `GET /api/maintenance/search-index/embedded-count` for the embed-drain progress. See [rest.md — "What the importer drives"](rest.md#what-the-importer-ci-import-tools-drives-during-a-run).

## Quick start

```bash
# 1. Authenticate — either a browser session (see auth-and-conventions.md §1.1)
#    or, for a programmatic client, an API key (managed at /keys, session-required):
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
- **[rest.md](rest.md)** — every REST controller (ingest, files, maintenance/enrichment, memory/graph, agent memory, connectors, LLM proxy, jobs, health) with per-route tables, plus what the importer drives.
- **[auth-and-conventions.md](auth-and-conventions.md)** — the three auth mechanisms, guard model, CORS, body/validation/error conventions, the provenance-triple idempotency key, and the MCP surface.

## See also

- [docs index](../README.md) — everything documented in this repo
- [Database.md](../architecture/Database.md) — schemas, the idempotency/dedup design behind §3–4 above, indexing, hypertables
- [Bulk load runbook](../../backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md) / [ingest reset runbook](../../backend/apps/api/db/postgres/INGEST_RESET_RUNBOOK.md) — operator procedures around the bulk path
- [GraphiQL IDE & codegen workflow](../graphql-api.md) — exploring this API interactively; regenerating schema/types
- [Backend developer guide](../../backend/apps/api/README.md)

---

*These documents are generated from and cite the actual source (`backend/apps/api/src`, `file:line`). The generated GraphQL SDL at `domains/graphql/__generated__/schema.graphql` is the ultimate source of truth for the GraphQL surface.*

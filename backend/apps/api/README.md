# Companion Intelligence — Backend API (`@ci/be-api`)

The NestJS 10 service that is the memory brain of the appliance: personal database,
GraphQL/REST/MCP API, RAG/search indexing, and the enrichment/maintenance pipelines.
It listens on `0.0.0.0:3030` and is fronted same-origin by a proxy that strips the
browser's `/api` prefix (Caddy under `make dev`).

**Start here:**

- **API reference** (endpoints, auth, conventions): [`docs/api/`](../../../docs/api/README.md)
- **Database architecture** (schemas, idempotency, indexing, hypertables): [`docs/architecture/Database.md`](../../../docs/architecture/Database.md)
- **Platform architecture**: [`docs/architecture/architecture.md`](../../../docs/architecture/architecture.md)
- **Runbooks**: [bulk load](db/postgres/BULK_LOAD_RUNBOOK.md) · [ingest reset](db/postgres/INGEST_RESET_RUNBOOK.md)

## Getting started

See the [repo README](../../../README.md) for prerequisites and `make dev`, which brings up
the whole per-worktree stack (Postgres, MinIO, Temporal, hbpe/summary services, Caddy route,
api + web dev servers). To run just this service against an already-running stack:

```bash
yarn dev          # nodemon + ts-node; watches src/, config/, and the repo-root .env
```

Everyday commands (run from `backend/apps/api`):

```bash
yarn test               # jest (82 spec files; colocated __tests__/ + *.spec.ts)
yarn typecheck          # tsc --noEmit
yarn lint / lint:fix    # oxlint + eslint
yarn depcheck           # dependency-cruiser import rules (see below)
yarn graphql:generate   # resolvers → src/domains/graphql/__generated__/schema.graphql
```

## Source layout

```
src/
├── domains/     # one NestJS module per domain (controllers/, services/, entities/, listeners/)
├── common/      # cross-cutting infrastructure shared by all domains
├── main.ts      # bootstrap (bodyParser off — see body limits below)
└── configuration.ts
```

### Domains (`src/domains/`)

| Domain | Purpose |
|---|---|
| `memory` | Core timeline records + graph-facing services: `EventService`, `CommunicationService`, `ContentService`, `ItemService`, `PersonService`, `PlaceService`, `ConceptService`, `FileService`; the `v1/events` capture-ingest controller |
| `graph` | Graph primitives: nodes/relationships, `entity_identifiers`, `item_relationships`, bulk graph ingest |
| `graphql` | Apollo schema assembly: resolvers (29), DataLoaders (15), complexity plugin, GraphiQL page |
| `search-ingress` | The search **write** path: per-entity `*SearchIndexListener`s consuming the `search-index` queue → `ci_search.embeddings` / `ci_search.vectors`; skip markers |
| `search-next` | The search **read** path (the `search` GraphQL query): candidate-set + post-filter retrieval, tags |
| `maintenance` | Post-ingest enrichment + operations: geocoding, location estimation, people/graph linking backfills, search-index backfill/cleanup, index deferral, ingest reset, the `orchestrate` chain (`/api/maintenance/*`) |
| `intelligence` | Questions/answers/actions — the "ask my memory" surface |
| `conversations` | Chat threads/messages |
| `llm` | Ollama wrapper (chat/vision/embeddings), answer-inference cron, OpenAI-compatible proxy routes |
| `connections` / `etl` | OAuth connector catalog + instances; per-provider sync services and sync-job bookkeeping |
| `auth` / `user` / `onboarding` | Sessions (JWT), API keys, OIDC (CI-Portal), signup codes, profiles |
| `files` | Uploads, previews, MinIO-backed storage, saved searches |
| `events` | **The in-process event bus** (PGBoss) — not calendar events; see below |
| `agent` / `mcp` / `tools` | Agent memory (`/memory/*`), the MCP server (`POST /mcp`), the shared ToolRegistry + intent catalog |
| `notes`, `devices`, `position`, `browser-activity`, `geocode`, `entity-resolution`, `summaries`, `predictions`, `audit` | What they say on the tin |

### Common infrastructure (`src/common/`)

| Piece | What it does |
|---|---|
| `guards/` | `JwtOrApiKeyAuthGuard` (Bearer JWT ∥ `x-api-key` ∥ Portal OIDC) and friends. No global guard: a route with no guard is public. See [auth-and-conventions.md](../../../docs/api/auth-and-conventions.md). |
| `context/` | AsyncLocalStorage request context — auth strategies set `{ userId }`, services read it via `toServiceContext()`, which throws if unauthenticated |
| `pipes/` | zod-based `ValidationPipe` (the codebase validates with zod, not class-validator) |
| `middleware/` | `BodyParserMiddleware` — `main.ts` boots with `bodyParser: false` and this applies per-route limits (default 100 KB; `/graphql` gets 10 MB for bulk mutations) |
| `persistence/` | **`bulkInsertIdempotent`** (`bulkUpsert.ts`) — the set-based `INSERT … ON CONFLICT` engine behind every bulk-ingest path: one transaction, provenance-triple arbiter, optional self-heal columns (`ingestRefreshColumns.ts`), hypertable time-bounding, and **internal chunking** via `computeChunkSize` (bind-param-budget-sized sub-batches, so callers never hit the 65535-parameter cliff — chunking is not the caller's job) |
| `embeddings/` | `EmbeddingGenerationService` — batched `nomic-embed-text` (768-dim) via Ollama; config block `embedding` |
| `feature/` | Feature flags (`config features` block + `/_internal/features/global`) |
| `crypto/`, `logging/`, `filters/`, `schedule/`, `rpc/` | Token encryption, pino logging, exception filters, cron plumbing |

### The event bus (`src/domains/events/`)

A typed, persistent pub/sub layer over **PGBoss** (jobs live in the `pgboss` schema of the
main database):

- **`EventService.send()` / `sendMany()`** publish events; `sendMany` is the bulk form used
  by backfills (per-row awaited `send()` at ~1M scale was a throughput killer).
- **`@OnEvent`** subscribes a service method to an event on a specific queue; the registry
  (`event-registry.ts`) types every event payload.
- **Routing gotcha:** a send fans out to all registered queues and listeners self-scope by
  queue — an event *sent* on a queue with no consumer is a **silent drop**.
- The big consumer family is `search-ingress/listeners/*SearchIndexListener.ts` on the
  `search-index` queue; other listeners cover previews, geocoding, LLM enrichment, ETL
  orchestration, and maintenance backfills.
- Queue worker concurrency comes from the `queues` config block
  (`concurrency`/`fetchBatchSize`) — for large index drains this, not Ollama, is usually the
  bottleneck.

### Ingest: interactive vs. bulk (deferred indexing)

Two write modes, one invariant (provenance-triple idempotency —
[Database.md](../../../docs/architecture/Database.md#idempotency--dedup-design)):

- **Interactive** single-row creates emit a per-row `*CreatedEvent` → the search index
  updates live.
- **Bulk** (the GraphQL list mutations `createEvents`, `createCommunications`, … that
  CI-Import-Tools uses) pass `emitCreated:false` — no per-row fan-out. Rows are persisted
  and idempotent but **not searchable** until the post-load sweep
  `POST /api/maintenance/search-index/backfill` re-emits create events for unindexed rows
  (LEFT JOIN against `ci_search.embeddings`). The full post-import chain is
  `POST /api/maintenance/orchestrate`; see
  [rest.md — what the importer drives](../../../docs/api/rest.md#what-the-importer-ci-import-tools-drives-during-a-run)
  and the [bulk load runbook](db/postgres/BULK_LOAD_RUNBOOK.md).

## Configuration

[node-config](https://github.com/node-config/node-config) JSON layers in `config/`:

- `default.json` → `development.json` / `production.json` / `test.json` (by `NODE_ENV`) →
  **`custom-environment-variables.json`** (maps env vars onto config paths — an env var
  wins over every file).
- Secrets/env come from the **repo-root `.env`** (every script sets
  `DOTENV_CONFIG_PATH=../../../.env`); deployed containers load `/run/secrets/.env.secrets`
  via `entrypoint.sh`.
- Notable blocks: `db` (also consumed by the dbmate wrapper), `auth` (JWT, portal OIDC),
  `graphql.maxQueryComplexity` (150), `embedding` (model/batching), `queues`
  (worker concurrency), `features` (flags, e.g. `hbpe`, `shared.search`), `services`
  (Ollama/MinIO endpoints), `geocoding`.

## GraphQL

Code-first Apollo: the schema is assembled from resolver decorators and emitted to
`src/domains/graphql/__generated__/schema.graphql` (generated — do not edit). After
changing resolvers/types:

```bash
make graphql              # from the repo root: backend schema + frontend typed documents
yarn graphql:generate     # just the backend half (no DB needed)
```

- **Full API reference:** [`docs/api/graphql.md`](../../../docs/api/graphql.md) — query and
  mutation catalog, the bulk-ingest contract, types, errors.
- **GraphiQL IDE + codegen workflow:** [`docs/graphql-api.md`](../../../docs/graphql-api.md)
  — the in-app IDE at `/api/graphiql`, API-key auth flow, theming, troubleshooting.

## Database workflow

Hand-written SQL migrations (dbmate format) in `db/postgres/migrations/` are the schema's
source of truth; update the TypeORM entities to match. Details, schema map, and indexing
strategy: [`docs/architecture/Database.md`](../../../docs/architecture/Database.md).

```bash
yarn migrate:make <name>    # new migration (offline)
yarn migrate                # version check + dbmate up
yarn migrate:down           # rollback last
yarn dbshell                # psql shell
```

## Dependency violations

We use dependency-cruiser to validate imports (`yarn depcheck`). If the import check fails
you should generally fix the violations — accepting new ones is an explicit increase in
technical debt. To accept (and flag it in your PR for the reviewer):

```bash
yarn depcheck:accept
```

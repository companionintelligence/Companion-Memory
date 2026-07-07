# CI-Server — Non-GraphQL HTTP (REST) API Reference

Reference for every NestJS REST controller in CI-Server (`backend/apps/api/src`). The GraphQL surface (`POST /graphql`) is documented in [graphql.md](graphql.md); auth, the MCP JSON-RPC surface, and cross-cutting conventions are in [auth-and-conventions.md](auth-and-conventions.md).

Grounded in source; every route cites `file:line`.

---

## Global routing & prefix behavior

- **No `setGlobalPrefix`.** `main.ts:9-12` bootstraps with `bodyParser: false` and never calls `app.setGlobalPrefix(...)`. Every `@Controller('x')` string is the **literal mounted path** on the API server (e.g. `graph` → `/graph`, `v1/events` → `/v1/events`). There is no server-side `/api` mount.
- **The `/api` prefix is a proxy convention, not a server mount.** Browsers/clients call same-origin `/api/*`; the edge proxy strips `/api` before forwarding:
  - **Dev (`make dev`)** — Caddy strips `/api` and forwards to the API.
  - **Vite standalone** (`frontend/apps/web/vite.config.ts:139-148`) — `proxy['/api']` rewrites `^/api` → `''`, target `API_PROXY_TARGET`, `xfwd: true`.
  - So browser `/api/graph/stats` → server `/graph/stats`. A raw API client (or the importer, which targets the API host directly) calls `/graph/stats` with **no** `/api`.
- **Two controllers bake `api/` into the path**: `MaintenanceController` (`@Controller('api/maintenance')`, `MaintenanceController.ts:374`) and `IntentsController` (`@Controller('api/intents')`, `IntentsController.ts:18`). These mount at server paths `/api/maintenance/*` and `/api/intents/*`. Reached through the proxy the browser path is `/api/api/maintenance/*`; reached **directly** on the API host it is `/api/maintenance/*` (which is exactly how the importer's `maintenance-runner.ts` builds them from the GraphQL base URL). Everywhere below, **Path = the literal server-mounted path**.
- **Object-store media is NOT served by a Nest controller.** File downloads/thumbnails are presigned MinIO URLs the frontend fetches via a separate same-origin `/static/*` proxy (Vite `proxy['/static']`, target `:9000`, rewrites `^/static`→`''`, forces the signing `Host`; `vite.config.ts:160-170`). `FilesController` has **no** `download`/`thumbnail` route — only `upload` and `PATCH :id`.

### Body-size limits (`common/middleware/BodyParserMiddleware.ts`)

`bodyParser: false` at bootstrap; a custom middleware (`application.ts:120`, `forRoutes('*')`) parses bodies with a per-route limit:

| Route | JSON body limit | Source |
|-------|-----------------|--------|
| `POST /graphql` | **10 mb** | `BodyParserMiddleware.ts` (path-matched; importer bulk mutations) |
| `/v1/*` (whole machine-ingest plane) | **10 mb** JSON | `BodyParserMiddleware.ts` (CI-Applet perception snapshots, `{records}` bulk envelopes) |
| `/v1/*` with `Content-Type: application/x-ndjson` | **no overall cap** — middleware bypassed, raw stream handed to the route handler | `BodyParserMiddleware.ts` NDJSON bypass; per-line 1 MB ceiling enforced in `domains/ingest/ndjson.ts` |
| Any route with `@BodyLimit('…')` | that value | `BodyParserMiddleware.ts` |
| **Everything else (default)** | **100 kb** | `BodyParserMiddleware.ts` |

`FilesController` `upload` and `POST /v1/files` bypass this (multipart via Multer, own per-file caps — see Files section).

### Auth guards (`common/guards/`)

| Guard | Accepts | Notes |
|-------|---------|-------|
| `JwtOrApiKeyAuthGuard` | Passport `jwt` **or** `api-key` strategy, **or** a Portal-brokered OIDC Bearer when `auth.portal.enabled` (`JwtOrApiKeyAuthGuard.ts:22,30-44`) | The default guard on almost every data route. 401 on failure. |
| `ApiKeyGuard` | `api-key` strategy only (`ApiKeyGuard.ts:6`) | Agent-facing `/memory/*` routes — machine callers with an `x-api-key`. |
| `JwtAuthGuard` | `jwt` strategy only (`JwtAuthGuard.ts:6`) | Human-session-only routes (`/onboarding/onboard`, `/_internal/features`). |
| `HubForwardAuthGuard` | HMAC-signed `X-CI-Hub-User` header, verified against a shared secret; **fails closed** when `auth.hubForwardAuth.enabled` is false (`HubForwardAuthGuard.ts:25-60`) | Only on `GET /audit/forward-auth/whoami`. |

**Unauthenticated routes:** `GET /health`, `GET /_internal/features/global`.

See [auth-and-conventions.md](auth-and-conventions.md) for the full auth model.

---

## Ingest (bulk capture write path)

### `EventsIngestController` — `v1/events`  ·  `domains/memory/controllers/EventsIngestController.ts:21`

The unified capture-ingest surface (G1, event-ingest-spec) that every capture source is converging onto. Three layers per event: append-only raw log `ci.capture_events` (idempotent on `(user_id, source_system, source_id)`) → materialized `EventEntity` (idempotent) → the `EventCreatedEvent` enrichment bus.

| Verb | Path | Auth | Purpose |
|------|------|------|---------|
| POST | `/v1/events` | `JwtOrApiKeyAuthGuard` (`:28`) | Set-based bulk ingest; re-POSTing a `(source_system, source_id)` returns `duplicate+1`, not an error (`:44-58`). |

**Request** (`domains/memory/types/captureEvent.ts`, validated by `ValidationPipe(ingestEventsSchema)`, `:32`): JSON object `{ events: CaptureEvent[] }`, **1–1000 events per request** (`captureEvent.ts:19-21`). Each `CaptureEvent`: `source_system` (str, req), `source_id` (str, req), `kind` (str, req; open text in v1), `occurred_at` (ISO datetime, req), `observed_at?` (ISO), `title?`, `description?`, `payload` (record, default `{}`), `confidence_score?` (0–1).
The **request body is a single JSON envelope**, not newline-delimited; 10 mb limit applies. Content-Type `application/json`.
**Response** `IngestEventsResponse` (`:33`): `{ ingested: number, duplicate: number, rejected: {index, reason}[] }`. Per-event failures are collected into `rejected` (the whole batch does not 500).

### `BulkIngestController` — `v1/*` bulk kinds  ·  `domains/ingest/controllers/BulkIngestController.ts`

The rest of the REST bulk-ingest plane: one batch route per bulk kind, all `JwtOrApiKeyAuthGuard`, all delegating to the existing chunk-safe, provenance-deduped bulk services with **deferred indexing** (no per-row enrichment fan-out — call `POST /v1/ingest/finish` after the load).

| Verb | Path | Destination service |
|------|------|---------------------|
| POST | `/v1/communications` | `CommunicationService.createMany` |
| POST | `/v1/contents` | `ContentService.createMany` |
| POST | `/v1/inventory` | `ItemService.createMany` |
| POST | `/v1/browser-activity` | `BrowserActivityService.createMany` |
| POST | `/v1/positions` | `PositionService.create` (bulk) |

Every route speaks **two encodings**, switched on `Content-Type`:

**1. NDJSON — the default bulk contract** (`application/x-ndjson`). One JSON record per line (same per-kind record schema as the envelope, `domains/ingest/types.ts`). The raw stream is parsed incrementally and flushed to the service in **batches of 1,000 as it arrives** — no overall request-size cap, bounded memory, suitable for unbounded exports. Defensive limits: **1 MB per line** (oversized lines are rejected, stream continues), rejection detail list capped at 1,000 (`rejectedTruncated: true` past that). Malformed / schema-invalid lines and failed batches are rejected **without aborting the stream**; batch flushes are idempotent on the provenance triple, so retrying a broken stream is safe. Blank lines and CRLF are tolerated.

```bash
curl -sS http://ci-server.localhost/v1/communications \
  -H 'x-api-key: <key>' \
  -H 'content-type: application/x-ndjson' \
  --data-binary @records.ndjson
```

**Response** (single JSON document once the stream ends): `{ ingested, duplicate, rejected: [{line, reason}] }` — `line` is **1-based**; `duplicate` counts records the service collapsed intra-request (same provenance triple / same position time); an idempotent re-send of already-stored rows counts as `ingested`.

**2. JSON envelope** (`application/json`): `{ records: [...] }`, **1–10,000 records per request**, 10 mb body limit. **Response**: `{ ingested, duplicate, rejected: [{index, reason}] }` (rejected is always empty on 200 — a bad envelope is a 400, a failed batch an HTTP error).

### `IngestLifecycleController` — `v1/ingest`  ·  `domains/ingest/controllers/IngestLifecycleController.ts`

| Verb | Path | Purpose |
|------|------|---------|
| POST | `/v1/ingest/finish` | Run post-load enrichment: default = full orchestration; `{ stages: [...] }` for a subset; `{ searchIndexOnly: true }` for just the embed backfill. The two knobs are mutually exclusive (400). One orchestration per user at a time (409). |
| GET | `/v1/ingest/status` | Ingest snapshot: table counts, search-index coverage, queue depth — poll until drained. |

A complete bulk load is therefore: stream NDJSON batches → `POST /v1/ingest/finish` → poll `GET /v1/ingest/status`.

### `BulkFilesController` — `v1/files`  ·  `domains/files/controllers/BulkFilesController.ts`

Batch upload lane (the bulk counterpart to `POST /files/upload`, whose `[{id}]` response is ambiguous for multi-file batches).

| Verb | Path | Auth | Purpose |
|------|------|------|---------|
| POST | `/v1/files` | `JwtOrApiKeyAuthGuard` | Multipart batch upload, field **`files`**, **max 50 files/request** (51st → 400), **1 GB per file** (single-file lane `/files/upload` allows 10 GB). Optional form fields `skipDescription` / `inventoryCapture` / `model` as on `/files/upload`. |

Reuses the exact `/files/upload` pipeline (`FileService.uploadWithDedupInfo`: sha-256 hash-dedup, MinIO storage, preview/description fan-out). **Response — one entry per INPUT file, in input order**:

```json
[{ "filename": "a.jpg", "sha256": "…", "id": "…", "deduped": false }]
```

`deduped: true` = no new file was created: the input repeated earlier bytes within the batch (same `id` as the first occurrence) or the content was already stored server-side. A bulk client can therefore map every input to its id without guessing.

```bash
curl -sS http://ci-server.localhost/v1/files \
  -H 'x-api-key: <key>' \
  -F files=@a.jpg -F files=@b.jpg -F skipDescription=true
```

### `BrowserActivityController` — `browser-activity`  ·  `domains/browser-activity/controllers/BrowserActivityController.ts:12`

| Verb | Path | Auth | Purpose |
|------|------|------|---------|
| POST | `/browser-activity` | `JwtOrApiKeyAuthGuard` (`:16`) | Create one or many browser-activity records. |

**Request**: `ValidationPipe(createBrowserActivitySchema)` (`:20`); `@Body` is `CreateBrowserActivityDto` **or** `CreateBrowserActivityDto[]`. **Response**: the created record(s). A unique violation (same time+device) → **409 Conflict** (`:28-30`).

### `PositionController` — `position`  ·  `domains/position/controllers/PositionController.ts:36`

| Verb | Path | Auth | Purpose |
|------|------|------|---------|
| POST | `/position` | `JwtOrApiKeyAuthGuard` (`:40`) | Bulk-create positions; body must be a **non-empty array** of `CreatePositionDto` (`:44-49`). Dup time+user → 409 (`:54-56`). |
| GET | `/position/range` | `JwtOrApiKeyAuthGuard` (`:113`) | Positions within `?start=&end=` (ISO 8601, both required) (`:114-125`). |
| GET | `/position/geofence` | `JwtOrApiKeyAuthGuard` (`:127`) | Positions inside a geofence. `?type=radius\|polygon`; radius needs `centerLon,centerLat,radius`; polygon needs `coordinates` (JSON array ≥3 pts); optional `start`/`end` (`:128-145`). |
| GET | `/position/:id` | `JwtOrApiKeyAuthGuard` (`:62`) | Fetch by id; 404 if missing. |
| PATCH | `/position/:id` | `JwtOrApiKeyAuthGuard` (`:76`) | Update; `ValidationPipe(updatePositionSchema)`; 404 if missing. |
| DELETE | `/position/:id` | `JwtOrApiKeyAuthGuard` (`:94`) | Delete; **204 No Content** (`:96`). |

> Route-ordering note: `:id` is declared before `range`/`geofence`, but Nest matches static segments first, so `/position/range` and `/position/geofence` resolve correctly.

---

## Files / media

### `FilesController` — `files`  ·  `domains/files/controllers/FilesController.ts:24`

| Verb | Path | Auth | Purpose |
|------|------|------|---------|
| POST | `/files/upload` | `JwtOrApiKeyAuthGuard` (`:28`) | Multipart binary upload; hash-dedupes, stores to MinIO/S3, kicks off preview + (optional) Ollama image description. |
| PATCH | `/files/:id` | `JwtOrApiKeyAuthGuard` (`:111`) | Overwrite a file's user-facing `title`/`description`. |

**Upload request**: `multipart/form-data`, field name **`files`** (`FilesInterceptor('files', …)`, `:31`), **per-file limit 10 GB** (`limits.fileSize: 10*1024³`, `:33`), temp `dest: tmpdir()`. Optional form fields: `inventoryCapture` (`'true'`/bool), `skipDescription` (`'true'`/bool), `model` (str) (`:39-49`). Uploads are content-hash de-duplicated within the batch (`:54-72`); 400 if no files (`:43`). **Response**: `[{ id }]`, one per unique file (`:89-91`). Temp files always unlinked in `finally` (`:92-102`).
**PATCH request**: `@Body` `title?`/`description?` (at least one required else 400, `:128-130`); 404 if file not found. **Response**: `{ id }`.

> Bulk clients that need to map inputs → ids deterministically should use `POST /v1/files` (see the Ingest section), which returns one `{ filename, sha256, id, deduped }` entry per input file in input order.

---

## Maintenance / enrichment — `api/maintenance` · `domains/maintenance/controllers/MaintenanceController.ts:374`

**Class-level `JwtOrApiKeyAuthGuard`** (`:373`). Server-mounted at `/api/maintenance/*`. Every POST body is `ValidationPipe`-validated; **all body fields optional unless stated**. Several long-running legs support **opt-in NDJSON streaming** via `?stream=1` (any truthy value except `0`/`false`) **or** `Accept: application/x-ndjson` (`wantsStream`, `:1176-1182`); streamed responses emit one `{type:'progress',…}` line per unit then a final `{type:'result',…}` line (`streamNdjson`, `:1133-1168`).

### Enrichment legs (the importer's post-push chain)

| Verb | Path | Handler | Stream? | Purpose |
|------|------|---------|:---:|---------|
| POST | `/api/maintenance/extract-people-from-communications` | `extractPeopleFromCommunications` (`:687`) | — | Scan `communications.participants_metadata.{from,to,cc,bcc}`, create stub `Person` entities + `entity_identifiers`. **Run before link-communications.** |
| POST | `/api/maintenance/link-communications` | `linkCommunications` (`:620`) | ✅ | Resolve raw participant strings to entity ids via `entity_identifiers`; fill NULL `from_entity_id`/`to_entity_ids`. Idempotent, windowed. |
| POST | `/api/maintenance/link-events` | `linkEvents` (`:727`) | ✅ | Parse organizer/attendee emails from `event.metadata`, resolve to entity ids, fill NULL `organizer_entity_id`/`participant_entity_ids`. |
| POST | `/api/maintenance/extract-graph` | `extractGraph` (`:784`) | ✅ | Sample comms+events, run **local Ollama** to extract preferences → `Concept` nodes + PREFERS/DISLIKES edges, and family relations → edges between `Person` nodes. |
| POST | `/api/maintenance/geocode-locations` | `geocodeLocations` (`:392`) | — | Forward-geocode: events with `location_name` but no coordinates → enqueue on `geocode` queue. |
| POST | `/api/maintenance/reverse-geocode-locations` | `reverseGeocodeLocations` (`:451`) | — | Reverse: events **with** coordinates but no name → enqueue with `direction:'reverse'`. |
| POST | `/api/maintenance/estimate-locations` | `estimateLocations` (`:505`) | — | Temporal estimation: fill coordinate-less presence events from nearest-in-time location. **Run last.** |
| POST | `/api/maintenance/backfill-media-dimensions` | `backfillMediaDimensions` (`:557`) | — | Record `ci.files.width/height` for image/video files lacking them. |
| POST | `/api/maintenance/search-index/backfill` | `backfillSearchIndex` (`:958`) | — | Find rows with no `ci_search.embeddings` entry and re-emit their create event onto the **`search-index` queue only**; listeners do idempotent embed + tsvector upsert. Run after a bulk import. |
| POST | `/api/maintenance/orchestrate` | `orchestrate` (`:851`) | ✅ | One-shot: run all nine legs back-to-back in canonical order. |

**Async legs return an enqueue receipt**: `{ jobId, estimatedEventCount, status: 'enqueued'\|'noop' }` (geocode/reverse/estimate), `{ jobId, estimatedFileCount, status }` (media). A zero candidate count returns `status:'noop'` with no job.

**Synchronous / streamable legs return a work summary** (examined/linked/created counts + windows/range). Key body schemas: `linkCommunicationsSchema` (`:265-274`) `{ startTime?, endTime?, windowDays?(1-365, def 7), windowLimit?(1-50000, def 5000) }`; `extractGraphSchema` (`:297-304`) `{ maxCommunications?(0-5000, def 200), maxEvents?(0-5000, def 100), model? }`; `searchIndexBackfillSchema` (`:155-162`) `{ entityTypes?, batchSize?(1-50000, def 1000), limitPerType? }`.

#### `orchestrate` (`:851`)

Body `orchestrateSchema` (`:313-341`): `stages?` (subset of `ORCHESTRATE_STAGES` — unknown names 400; execution order is **always canonical**: extract_people → link_communications → link_events → extract_graph → geocode → reverse_geocode → estimate_locations → media_dimensions → search_index), `options?` (per-leg passthrough), `abortOnError?` (def false = fail-soft), `searchIndexDrain?.timeoutMs?`. **One orchestration per user at a time — a second concurrent call → 409 Conflict** (`:868-870`). Non-stream response: `{ ok, legs[], totalDurationMs }`. Stream: NDJSON of `leg-start`/`leg-progress`/`leg-result`/`leg-error`/`tick`/`done` lines.

### Index-deferral (bulk-load helper)

| Verb | Path | Handler | Purpose |
|------|------|---------|---------|
| POST | `/api/maintenance/indexes/drop` | `dropIndexes` (`:897`) | Drop deferrable secondary indexes before a huge load; returns each dropped index's exact recreate statement. Never drops PKs/provenance-unique indexes. |
| POST | `/api/maintenance/indexes/recreate` | `recreateIndexes` (`:907`) | Recreate them; body `{ dropped: {schema,name,definition}[] }` — the array from `/drop` verbatim. |

### Search-index hygiene & observability

| Verb | Path | Handler | Purpose |
|------|------|---------|---------|
| POST | `/api/maintenance/search-index/cleanup-orphans` | `cleanupSearchOrphans` (`:922`) | Delete `ci_search` rows whose source row is gone. Body `{ batchSize?, entityTypes?, dryRun? }`. |
| POST | `/api/maintenance/search-index/truncate` | `truncateSearchIndex` (`:938`) | **Destructive** — truncate both `ci_search` tables. Body must be exactly `{ confirm: true }` (`:148-150`) else 400. |
| GET | `/api/maintenance/search-index/embedded-count` | `embeddedCount` (`:985`) | Total `ci_search.embeddings` rows, optional `?types=` CSV. **Global, not user-scoped.** Returns `{ count, perType }`. Importer polls this for its embed-drain bar. |
| GET | `/api/maintenance/search/coverage` | `searchCoverage` (`:1028`) | Per `entity_type`: `total` vs `embedded` vs ratio; `alarms` lists rows-but-zero-embeddings types. |
| GET | `/api/maintenance/ingest-status` | `ingestStatus` (`:1045`) | Snapshot: row counts of the 5 bulk-ingest tables + `ci_search` embeddings/skip counts per type + `search-index` queue depth. |

### Full ingest reset

| Verb | Path | Handler | Purpose |
|------|------|---------|---------|
| POST | `/api/maintenance/ingest/reset` | `resetIngest` (`:1116`) | **Destructive across ALL users.** Truncate every bulk-ingest table + comms dedup + all `ci_search`, delete not-yet-run search-index jobs. Body must be exactly `{ confirm: 'RESET_ALL_INGESTED_DATA' }` (`:232-234`) else 400. |

---

## Memory / graph REST

### `GraphController` — `graph`  ·  `domains/memory/controllers/GraphController.ts:145`

Class-level `JwtOrApiKeyAuthGuard` (`:146`). All GET; each query zod-validated.

| Verb | Path | Handler | Purpose |
|------|------|---------|---------|
| GET | `/graph/context` | `getUserContext` (`:319`) | User context block for the LLM (knowledge-graph summary). |
| GET | `/graph/stats` | `getMemoryStats` (`:336`) | Memory totals: event count, entity/relationship counts, data-source breakdown, top tags. |
| GET | `/graph/data` | `getGraphData` (`:367`) | Full graph nodes+links, filterable by entity type / tags / event dimensions. |
| GET | `/graph/search` | `searchGraph` (`:471`) | Lexical/prefix node search, filter-scoped. |
| GET | `/graph/node` | `getNodeDetails` (`:634`) | Resolve+traverse one node with depth/limits. |

**Notes**: `graphDataSchema` — `includeTypes`, `tags`, `connectors/people/places/eventTypes` (CSV), `hasLocation` (bool), `from`/`to` (date range). `graphSearchSchema` = graphDataSchema + required `query` + `limit`(1-50, def 10). Overview capped at `NODE_LIMIT` (200 nodes).

### `MemoryController` (agent-facing) — `memory`  ·  `domains/agent/controllers/MemoryController.ts:47`

**Per-method guards.** The first four are `ApiKeyGuard` (machine callers with `x-api-key`); `compact` is `JwtOrApiKeyAuthGuard`.

| Verb | Path | Handler | Auth | Purpose |
|------|------|---------|------|---------|
| GET | `/memory/context` | `context` (`:70`) | `ApiKeyGuard` | L0 static profile block (markdown) for an agent system prompt. Returns `{ block }`. |
| POST | `/memory/recall` | `recall` (`:102`) | `ApiKeyGuard` | L1 hybrid keyword/semantic search with entity hydration. Body `{ query, maxResults? }`. |
| POST | `/memory/write` | `write` (`:120`) | `ApiKeyGuard` | Store a raw memory fragment verbatim. **201**. |
| POST | `/memory/turn` | `turn` (`:137`) | `ApiKeyGuard` | Ingest a conversation turn (dedup by SHA-256 UUIDv8). Body `{ sessionId, platform, messages[] }`. Returns `{ created, skipped }`. Driven by OpenClaw `afterTurn` / Hermes `sync_turn`. |
| POST | `/memory/compact` | `compact` (`:202`) | `JwtOrApiKeyAuthGuard` | Manually trigger compaction (background). Returns `{ queued }`. |

### `ThreadsController` — `threads`  ·  `domains/conversations/controllers/ThreadsController.ts:35`

Per-method `JwtOrApiKeyAuthGuard`.

| Verb | Path | Handler | Purpose |
|------|------|---------|---------|
| POST | `/threads` | `post` (`:44`) | Create a thread (`model` req; `name`/`description`/`userId` optional). |
| GET | `/threads` | `findAll` (`:55`) | All threads for the current user. |
| GET | `/threads/:id` | `findOne` (`:65`) | Thread by id; `?includeMessages=true\|false` (default true). |
| DELETE | `/threads/:id` | `delete` (`:93`) | Soft-delete. **204**. |

### `AnswersController` — `answers` · `:22`, `QuestionsController` — `questions` · `:32`, `ActionsController` — `actions` · `:8`

Per-method `JwtOrApiKeyAuthGuard`. Standard user-scoped CRUD (`answers`, `questions`) / read-only (`actions`). Deletes return **204**, missing → **404**. `questions` adds `GET /questions/unanswered` (first unanswered; **204** if none) declared before `:id`.

### `DeviceController` — `devices`  ·  `domains/devices/controllers/DeviceController.ts:25`

Per-method `JwtOrApiKeyAuthGuard`. CRUD + `PATCH /devices/:id/primary` (mark primary) + `PATCH /devices/:id/last-seen` (bump `last_seen`). `POST /devices` accepts one or many; unique violation → 409.

### Connections

#### `ConnectionsController` — `connections`  ·  `domains/connections/controllers/ConnectionsController.ts:86`

Per-method `JwtOrApiKeyAuthGuard`. Token secrets stripped from all read responses.

| Verb | Path | Handler | Purpose |
|------|------|---------|---------|
| POST | `/connections` | `create` (`:99`) | Create a connection. |
| GET | `/connections` | `findAll` (`:115`) | List (secrets stripped). |
| GET | `/connections/:id` | `findOne` (`:130`) | One (secrets stripped). |
| PATCH | `/connections/:id` | `update` (`:147`) | Update name/status/schedule/endpoints. |
| DELETE | `/connections/:id` | `delete` (`:168`) | Delete; **204**. |
| GET | `/connections/:id/connect` | `connect` (`:177`) | Begin OAuth: return authorization URL. |
| POST | `/connections/complete` | `completeCallback` (`:235`) | Complete OAuth callback (proxy vs direct); **204**. |
| POST | `/connections/openid/complete` | `completeOpenIDCallback` (`:336`) | Complete OpenID (Steam) callback; **204**. |

#### `ProvidersController` — `providers`  ·  `domains/connections/controllers/ProvidersController.ts:27`

`GET /providers` (list OAuth providers), `GET /providers/:id`, `POST /providers/:id` (create a connection + return `{ authorizationUrl }`).

---

## Agent / intents — `api/intents` · `domains/agent/controllers/IntentsController.ts:18`

Class-level `JwtOrApiKeyAuthGuard`. Publishes the CI Intent catalog (typed capability declaration) so any agent (Hermes, OpenClaw, external MCP client) reads one manifest. Server-mounted at `/api/intents/*`.

| Verb | Path | Handler | Purpose |
|------|------|---------|---------|
| GET | `/api/intents` | `getManifest` (`:23`) | Full `IntentManifest` (domains + entities + intents). |
| GET | `/api/intents/domains` | `getDomains` (`:29`) | `{ domains: IntentDomain[] }`. |
| GET | `/api/intents/entities` | `getEntities` (`:35`) | `{ entities: CiEntityDescriptor[] }`. |
| GET | `/api/intents/:name` | `getIntent` (`:41`) | One intent by dotted name (e.g. `memory.recall`); 404 if unknown. |

---

## LLM proxy — `llm` · `domains/llm/controllers/OllamaController.ts:49`

Per-method `JwtOrApiKeyAuthGuard`. Thin proxy in front of the local Ollama daemon.

| Verb | Path | Handler | Purpose |
|------|------|---------|---------|
| GET | `/llm/models` | `listModels` (`:69`) | List models (proxies Ollama `/api/tags`). |
| GET | `/llm/models/capabilities` | `getModelCapabilities` (`:76`) | `?model=` → `{ model, capabilities[], vision }`. |
| POST | `/llm/generate` | `generate` (`:90`) | Streaming chat completion. **200**. |

**`/llm/generate` streaming**: request `{ prompt, model?, threadId?, enableTools?, enableThinking?, fileIds? }`. Response is a **Server-Sent-Events stream** (`Content-Type: text/event-stream`, plus an `X-Thread-Id` header, `:151-156`), re-encoding Ollama chunks through a custom `FrameEncoder` on `Channel.TEXT` / `Channel.THINK` / `Channel.TOOL` (`:206-219`). Client disconnect handled via `AbortController`; assistant/tool messages persisted on completion.

---

## Jobs / Audit / Onboarding / Feature flags / Health

| Controller | Verb · Path | Auth | Purpose |
|-----------|-------------|------|---------|
| `JobsController` (`:8`) | GET `/jobs/dashboard` | `JwtOrApiKeyAuthGuard` | PGBoss job-monitor dashboard. |
| `AuditController` (`:23`) | GET `/audit/forward-auth/whoami` | **`HubForwardAuthGuard`** | Echo the verified Hub forward-auth username (HMAC `X-CI-Hub-User`). |
| `AuditController` | GET `/audit/deltas` | `JwtOrApiKeyAuthGuard` | Entity-evolution deltas (`entityId`, `limit`, `changeType`, `since`/`until`). |
| `OnboardingController` (`:10`) | POST `/onboarding/onboard` | **`JwtAuthGuard`** (session only) | Run onboarding. |
| `FeatureController` (`:7`) | GET `/_internal/features` | **`JwtAuthGuard`** | All feature flags (session required). |
| `FeatureController` | GET `/_internal/features/global` | **None — public** | All feature flags, no auth (gates the app before login). |
| `HealthController` (`:3`) | GET `/health` | **None — public** | Liveness probe. **200** `{ status: 'ok' }`. Pure liveness — does **not** check DB/Ollama/MinIO. |

---

## What the importer (CI-Import-Tools) drives during a run

Verified against `CI-Import-Tools/backend/src/ci-server/`. On `main` today the importer's **push** step uses **GraphQL bulk mutations**, and the binary + enrichment steps use these **REST** endpoints:

1. **Data push (GraphQL, not REST):** kind-routed batch mutations `createEvents` / `createCommunications` / `createInventoryItems` / `createContents` / `createBrowserActivities` (`graphql.ts`), dedup on the source triple → `POST /graphql` (10 mb body limit). **`POST /v1/events` is the convergence target** the importer is moving to.
2. **Media (REST):** binary upload → **`POST /files/upload`** (`media.ts`; the URL is derived from the GraphQL URL by swapping `/graphql`→`/files/upload`), then links the returned `{id}` into records.
3. **Post-push enrichment (REST, `api/maintenance/*`):** `maintenance-runner.ts` **prefers one `POST /api/maintenance/orchestrate`** call (streamed) covering all legs, and **falls back to the per-leg chain** when orchestrate is absent: `extract-people-from-communications`, `link-communications`, `link-events`, `extract-graph`, `geocode-locations`, `reverse-geocode-locations`, `estimate-locations`, `backfill-media-dimensions`, `search-index/backfill`.
4. **Graph sync (GraphQL):** entities + relationships via `bulkIngestGraph`, and item↔item edges (email→attachment, photo→album) via `bulkIngestItemRelationships`.
5. **Embed-drain progress (REST):** polls **`GET /api/maintenance/search-index/embedded-count`** to animate its stage-6 bar toward the enqueued count (best-effort).

---

## Cross-cutting conventions

- **Auth default:** `JwtOrApiKeyAuthGuard` on virtually all data routes; `ApiKeyGuard` on agent `/memory/*`; `JwtAuthGuard` on human-only (`/onboarding`, `/_internal/features`); `HubForwardAuthGuard` on `/audit/forward-auth/whoami`. Unauthenticated: `/health`, `/_internal/features/global`.
- **Validation:** zod schemas via a shared `ValidationPipe` (`@ci/common/pipes`); a schema failure → 400 before the handler runs.
- **Deletes** return **204**; **conflicts** (dup unique keys) return **409**; **missing resources** return **404**.
- **Streaming** lives in two places only: maintenance NDJSON progress streams (opt-in via `?stream=1` / `Accept: application/x-ndjson`) and `POST /llm/generate` (SSE). Everything else is plain JSON.

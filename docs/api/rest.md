# CI-Server — Non-GraphQL HTTP (REST) API Reference

Reference for every NestJS REST controller in CI-Server (`backend/apps/api/src`) — **52 controllers** as of 2026-08-23 (`grep -c '^@Controller(' -r backend/apps/api/src` excluding `__tests__`). The GraphQL surface (`POST /graphql`) is documented in [graphql.md](graphql.md); auth, the MCP JSON-RPC surface, and cross-cutting conventions are in [auth-and-conventions.md](auth-and-conventions.md).

Grounded in source; every route cites `file:line`.

---

## Global routing & prefix behavior

- **No `setGlobalPrefix`.** `main.ts` bootstraps with `bodyParser: false` (`:33`) and never calls `app.setGlobalPrefix(...)`. Every `@Controller('x')` string is the **literal mounted path** on the API server (e.g. `graph` → `/graph`, `v1/events` → `/v1/events`). There is no server-side `/api` mount.
- **The `/api` prefix is a proxy convention, not a server mount.** Browsers/clients call same-origin `/api/*`; the edge proxy strips `/api` before forwarding:
  - **Dev (`make dev`)** — Caddy strips `/api` and forwards to the API.
  - **Vite standalone** (`frontend/apps/web/vite.config.ts:149-157`) — `proxy['/api']` rewrites `^/api` → `''`, target `API_PROXY_TARGET`, `xfwd: true`.
  - So browser `/api/graph/stats` → server `/graph/stats`. A raw API client calls `/graph/stats` with **no** `/api`.
- **Four controllers bake `api/` into the path** — verified 2026-08-23:
  `MaintenanceController` (`@Controller('api/maintenance')`, `MaintenanceController.ts:416`),
  `IntentsController` (`@Controller(['api/intents', 'api/agent/intents'])`, `IntentsController.ts:44`),
  `ModelRoutingController` (`@Controller('api/model-routing')`, `ModelRoutingController.ts:27`) and
  `PrivacyController` (`@Controller('api/users/me')`, `PrivacyController.ts:31`).
  These mount at server paths `/api/maintenance/*`, `/api/intents/*`, `/api/agent/intents/*`,
  `/api/model-routing/*` and `/api/users/me/*`. Reached through the proxy the browser path is
  `/api/api/maintenance/*`; reached **directly** on the API host it is `/api/maintenance/*`.
  Everywhere below, **Path = the literal server-mounted path**.

  > **`PipelineController` used to be on this list and no longer is.** > `243b15945 refactor(pipeline): update API routes to remove '/api' prefix` changed it to
  > `@Controller('pipeline')` (`PipelineController.ts:186`), so it is now the ordinary case:
  > browser `/api/pipeline/*` → server `/pipeline/*`. A direct `curl` at the API host must
  > drop the `/api`, and any runbook that still says otherwise 404s.

- **Object-store media is NOT served by a Nest controller.** File downloads/thumbnails are presigned MinIO URLs the frontend fetches via a separate same-origin `/static/*` proxy (Vite `proxy['/static']`, target `:9000`, rewrites `^/static`→`''`, forces the signing `Host`; `vite.config.ts:170-180`). `FilesController` has **no** `download`/`thumbnail` route — only `upload` and `PATCH :id`.
- **CORS is enabled, narrowly** (`main.ts:53-60`): the native Capacitor webview origins (`capacitor://localhost`, `ionic://localhost`, `http(s)://localhost`) plus whatever `CORS_ALLOWED_ORIGINS` adds. The web app is same-origin and needs none of it.

### Body-size limits (`common/middleware/BodyParserMiddleware.ts`)

`bodyParser: false` at bootstrap; a custom middleware (`application.ts:172`, `forRoutes('*')`) parses bodies with a per-route limit:

| Route                                             | JSON body limit                                                                  | Source                                                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /graphql`                                   | **10 mb**                                                                        | `BodyParserMiddleware.ts:19-20,76-77` (path-matched; importer bulk mutations)                           |
| `/v1/*` (whole machine-ingest plane)              | **10 mb** JSON                                                                   | `BodyParserMiddleware.ts:33-34,78` (Companion Capture perception snapshots, `{records}` bulk envelopes) |
| `/v1/*` with `Content-Type: application/x-ndjson` | **no overall cap** — middleware bypassed, raw stream handed to the route handler | `BodyParserMiddleware.ts:85-87`; per-line 1 MB ceiling enforced in `domains/ingest/ndjson.ts:40`        |
| Any route with `@BodyLimit('…')`                  | that value (`POST /account/import` = **500 mb**)                                 | `BodyParserMiddleware.ts:67,91-92`                                                                      |
| **Everything else (default)**                     | **100 kb**                                                                       | `BodyParserMiddleware.ts:92`                                                                            |

> The middleware has a **second** explicit NDJSON bypass keyed on `PORTABILITY_IMPORT_PATH = '/api/account/import/stream'` (`BodyParserMiddleware.ts:36,79`), matched against `req.originalUrl`. It is **dead**: there is no `setGlobalPrefix`, so `AccountDataController` (`@Controller('account')` + `@Post('import/stream')`) mounts at `/account/import/stream`, and the edge proxy strips `/api` before forwarding (`infrastructure/gateway/nginx.conf:132`). Every request that actually reaches the handler therefore arrives as `/account/import/stream` and misses the check; the only URL that would match it routes to nothing and 404s. Behaviour is unaffected — the express `json()`/`urlencoded()` parsers below skip `application/x-ndjson` anyway, so the stream still reaches the handler unconsumed — but the bypass at `:85-87` fires only for `/v1/*`.

`FilesController` `upload`, `POST /v1/files` and `POST /import/uploads` bypass this (multipart via Multer, own per-file caps — see Files section). `server.requestTimeout` is set to `0` (`main.ts:83`) so a multi-hour upload is not killed by Node's 300 s total-request-lifetime default.

### Auth guards (`common/guards/`, `domains/auth/guards/`)

| Guard                     | Accepts                                                                                                                                                             | Notes                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JwtOrApiKeyAuthGuard`    | Passport `jwt` **or** `api-key` strategy, **or** a Portal-brokered OIDC Bearer (`auth.portal.enabled` is **true** by default) — `JwtOrApiKeyAuthGuard.ts:27-62`     | The default guard on almost every data route. 401 on failure. Also runs `enforceApiKeyScopes` + `enforceApiKeyCapability` (`:53-58`) once the strategy has populated `req.apiKeyScopes`. |
| `ApiKeyGuard`             | `api-key` strategy only, plus the same scope/capability enforcement (`ApiKeyGuard.ts:9,19-31`)                                                                      | Agent-facing `/memory/*` routes — machine callers with an API key, as `x-api-key` or `Authorization: Bearer <key>`.                                                                      |
| `JwtOrPortalAuthGuard`    | session `jwt` **or** a Portal OIDC bearer — never an API key (`JwtOrPortalAuthGuard.ts:29-54`)                                                                      | All five `/keys` routes.                                                                                                                                                                 |
| `JwtAuthGuard`            | `jwt` strategy only                                                                                                                                                 | Human-session-only routes (`/onboarding/*`, `/_internal/features`). **No longer guards `/keys`.**                                                                                        |
| `HubForwardAuthGuard`     | HMAC-signed `X-CI-Hub-User` header, verified against a shared secret; **fails closed** when `auth.hubForwardAuth.enabled` is false (`HubForwardAuthGuard.ts:25-60`) | `GET /audit/forward-auth/whoami`, plus the session bridge (`POST /authenticate/hub-bridge`, `GET /authenticate/hub-identity`) that replaces a stale Memory cookie when Traefik already named a different Hub person. |
| `ConnectRequestAuthGuard` | HMAC-signed CI-Hub server-to-server request with nonce replay protection (`domains/auth/guards/ConnectRequestAuthGuard.ts`)                                         | `POST /connect/{exchange,revoke,rotate}`.                                                                                                                                                |

**Scopes and capability.** A route may declare `@RequireScopes('memory'|'intents'|'mcp'|'capture')` and `@RequireCapability('read'|'write'|'full')`. Enforcement is **deny-by-default for scope-limited API keys**: such a key may reach a route only if the route grants a scope it holds. Session/JWT/Portal principals and empty-scope (legacy full-authority) keys are unaffected by the scope axis, but capability applies to _every_ api-key principal. See [auth-and-conventions.md §1.2](auth-and-conventions.md#12-api-keys-programmatic-clients).

**Unauthenticated routes (no auth guard):** `GET /health`, `GET /_internal/features/global` (the `PUBLIC_FEATURES` allowlist only), `GET /config/telemetry`, the `authenticate/*` + `/signup` + `authenticate/oidc/*` endpoints, `GET /connect`, `GET /graphiql` (flag-gated: `graphql.ide`, off in production), `GET /solid/profile/:userId` (flag-gated), and `POST /agent/v1/ask` (verifies a peer's Portal token inline).

See [auth-and-conventions.md](auth-and-conventions.md) for the full auth model.

---

## Ingest (bulk capture write path)

### `BulkIngestController` — the whole `v1/*` bulk plane · `domains/ingest/controllers/BulkIngestController.ts:239`

The unified capture-ingest surface (G1, event-ingest-spec) that every capture source is converging onto — **including `/v1/events`**, which used to live in a separate `EventsIngestController` under `domains/memory/`. That controller no longer exists; `/v1/events` is now one lane of this controller (`:266-310`) and is the **only `/v1` lane** that writes `ci.events` — not the only writer. Two other request-driven paths write it directly: the in-process importer's push stage (`domains/import/stages/PushStage.ts:1688,1807` → `EventService.createDetailed`), reached from `POST /import/push` and `POST /import/runs` via the `import-push` queue; and the GraphQL `createEvent` / `createEvents` mutations (`domains/graphql/resolvers/EventResolver.ts:79,97`) served at `POST /graphql`, which is also the importer's fallback when `/v1` is unavailable.

Every lane **except `/v1/notes`** runs the same three-layer `captureAndMaterialize` pipeline (`:312-336`) — notes carry no provenance triple, so `ingestNotes` calls `NoteService.captureMany` directly (`:585-591`):

1. **capture** — append-only raw log `ci.capture_events`, idempotent on `(user_id, destination, triple)`. `destination` is part of the key because one source item may legitimately present the same triple to two lanes (the importer's fan-out kinds send one item to both `/v1/events` and `/v1/contents`). Records with no provenance triple carry no capture identity and skip straight to materialization.
2. **materialize** — one batched call into the kind's existing chunk-safe, provenance-deduped bulk service with **`emitCreated:false` semantics** (no per-row `*CreatedEvent`, so search indexing and enrichment are **deferred** until `POST /v1/ingest/finish`). On failure the fresh raw-log rows are compensated away so a re-send materializes them instead of misreading its own stranded captures as duplicates.
3. **link** — one set-based `UPDATE` stamps `materialized_id` onto the log rows, matched by triple.

**Class-level authorization** (`:239-241`): `@RequireScopes('capture')` + `@RequireCapability('write')`, so a capture agent's scoped key opens the whole `/v1` plane rather than each route repeating the grant. Each route additionally carries `@UseGuards(JwtOrApiKeyAuthGuard)`.

| Verb | Path                   | Line   | Destination service                                                                                                                 |
| ---- | ---------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/v1/events`           | `:267` | `EventService.create` (bulk) — timeline events                                                                                      |
| POST | `/v1/communications`   | `:501` | `CommunicationService.createMany`                                                                                                   |
| POST | `/v1/contents`         | `:521` | `ContentService.createMany`                                                                                                         |
| POST | `/v1/things`           | `:541` | `ItemService.createMany` — `/v1/inventory` remains registered as a deprecated alias to the same handler                             |
| POST | `/v1/browser-activity` | `:561` | `BrowserActivityService.createMany`                                                                                                 |
| POST | `/v1/notes`            | `:605` | `NoteService` — **the one exception to the provenance triple**: notes carry none, so they dedupe on their client-minted primary key |
| POST | `/v1/positions`        | `:640` | `PositionService.create` (bulk)                                                                                                     |
| POST | `/v1/receipts`         | `:668` | `ReceiptService`                                                                                                                    |
| POST | `/v1/product-models`   | `:688` | `ProductModelService`                                                                                                               |
| POST | `/v1/observations`     | `:709` | `ObjectObservationService`                                                                                                          |

**Record shapes** live in `domains/ingest/types.ts`. Field naming is **snake_case for every kind except `things`**, which is camelCase (`CreateItemDto` is the one camelCase ingest DTO and stays the only one).

**Two lanes are JSON-envelope only** (no NDJSON), so their envelope validates as a plain `@Body` pipe: `/v1/events` and `/v1/notes` (`ingestNotes` takes `{ records: BulkNoteRecord[] }` through `ingestNotesSchema`, `:604-609` — nothing streams notes, and NDJSON's per-batch response has no way to carry that lane's 409 ownership conflict). The events envelope is `{ events: CaptureEvent[] }`, **1–1000 events per request** (`types.ts:96`). Each `CaptureEvent` (`types.ts:73-93`): `source_system` (str, req), `source_id` (str, req), `source_type?` (str — a bulk importer presents its real source type; capture sources omit it and keep the historical `'capture'` stamp), `kind` (str, req; open text in v1), `occurred_at` (ISO datetime, req), `ended_at?` (ISO — materializes as `events.end_time`), `observed_at?` (ISO), `title?`, `description?`, `payload` (record, default `{}`), `confidence_score?` (0–1).

The other **eight** lanes speak **two encodings**, switched on `Content-Type` by `isNdjsonRequest` (`BulkIngestController.ts:509,529,549,569,648,676,696,716` — communications, contents, things, browser-activity, positions, receipts, product-models, observations):

**1. NDJSON — the default bulk contract** (`application/x-ndjson`). One JSON record per line (same per-kind record schema as the envelope, `domains/ingest/types.ts`). The raw stream is parsed incrementally and flushed to the service in **batches of 1,000 as it arrives** — no overall request-size cap, bounded memory, suitable for unbounded exports. Defensive limits: **1 MB per line** (oversized lines are rejected, stream continues), rejection detail list capped at 1,000 (`rejectedTruncated: true` past that). Malformed / schema-invalid lines and failed batches are rejected **without aborting the stream**; batch flushes are idempotent on the provenance triple, so retrying a broken stream is safe. Blank lines and CRLF are tolerated.

```bash
curl -sS http://ci-server.localhost/v1/communications \
  -H 'x-api-key: <key>' \
  -H 'content-type: application/x-ndjson' \
  --data-binary @records.ndjson
```

**Response** (single JSON document once the stream ends): `{ ingested, duplicate, rejected: [{line, reason}] }` — `line` is **1-based**; `duplicate` counts records the service collapsed intra-request (same provenance triple / same position time); an idempotent re-send of already-stored rows counts as `ingested`.

**2. JSON envelope** (`application/json`): `{ records: [...] }`, **1–10,000 records per request** (`MAX_BULK_INPUT_SIZE`, the same ceiling the GraphQL bulk-create mutations enforce), 10 mb body limit. **Response**: `{ ingested, duplicate, rejected: [{index, reason}] }` — `rejected` is empty on a clean flush; a mid-batch materialize failure returns **200** with per-record `rejected` entries (the records are safely re-sendable), while a bad envelope is a 400 (`envelopeResponse`, `BulkIngestController.ts:150-168`).

### `IngestLifecycleController` — `v1/ingest` · `domains/ingest/controllers/IngestLifecycleController.ts:35`

Class-level `JwtOrApiKeyAuthGuard` (`:34`).

| Verb | Path                | Line  | Purpose                                                                                                                                                                                                                                    |
| ---- | ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST | `/v1/ingest/finish` | `:43` | Run post-load enrichment: default = full orchestration; `{ stages: [...] }` for a subset; `{ searchIndexOnly: true }` for just the embed backfill. The two knobs are mutually exclusive (400). One orchestration per user at a time (409). |
| GET  | `/v1/ingest/status` | `:65` | Ingest snapshot: table counts, search-index coverage, queue depth — poll until drained.                                                                                                                                                    |

A complete bulk load is therefore: stream NDJSON batches → `POST /v1/ingest/finish` → poll `GET /v1/ingest/status`.

> ⚠️ Unlike `BulkIngestController`, this controller declares **no `@RequireScopes`**, so a scope-limited `capture` key is refused here by deny-by-default enforcement. Drive the finish step with a full-authority (empty-scope) key or a session until that is reconciled.

### `BulkFilesController` — `v1/files` · `domains/files/controllers/BulkFilesController.ts:55`

Batch upload lane (the bulk counterpart to `POST /files/upload`, whose `[{id}]` response is ambiguous for multi-file batches).

| Verb | Path        | Auth                           | Purpose                                                                                                                                                                                                                                                                                                 |
| ---- | ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/v1/files` | `JwtOrApiKeyAuthGuard` (`:59`) | Multipart batch upload, field **`files`**, **max 50 files/request** (51st → 400), **1 GB per file** (single-file lane `/files/upload` allows 10 GB). Optional form fields `skipDescription` / `thingCapture` / `model` as on `/files/upload` (`inventoryCapture` still accepted as a deprecated alias). |

> ⚠️ Same gap as `/v1/ingest`: this route carries **no `@RequireScopes`**, so the `capture` scope does not reach it even though `POST /files/upload` (which it mirrors) declares `@RequireScopes('capture')` + `@RequireCapability('write')`. A scope-limited capture key gets a 403 here.

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

### `BrowserActivityController` — `browser-activity` · `domains/browser-activity/controllers/BrowserActivityController.ts:12`

| Verb | Path                | Auth                           | Purpose                                      |
| ---- | ------------------- | ------------------------------ | -------------------------------------------- |
| POST | `/browser-activity` | `JwtOrApiKeyAuthGuard` (`:16`) | Create one or many browser-activity records. |

**Request**: `ValidationPipe(createBrowserActivitySchema)` (`:20`); `@Body` is `CreateBrowserActivityDto` **or** `CreateBrowserActivityDto[]`. **Response**: the created record(s). A unique violation (same time+device) → **409 Conflict** (`:28-29`).

### `PositionController` — `position` · `domains/position/controllers/PositionController.ts:36`

| Verb   | Path                 | Auth                            | Purpose                                                                                                                                                                                                                              |
| ------ | -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST   | `/position`          | `JwtOrApiKeyAuthGuard` (`:40`)  | Bulk-create positions; body must be a **non-empty array** of `CreatePositionDto`. Dup time+user → 409 (`:53-58`).                                                                                                                    |
| GET    | `/position/stats`    | `JwtOrApiKeyAuthGuard` (`:66`)  | Aggregate counts for the location settings UI (`:67-72`).                                                                                                                                                                            |
| GET    | `/position/range`    | `JwtOrApiKeyAuthGuard` (`:125`) | Positions within `?start=&end=` (ISO 8601, both required) (`:126-137`). **Unreachable — 404s today, see note below.**                                                                                                                |
| GET    | `/position/geofence` | `JwtOrApiKeyAuthGuard` (`:139`) | Positions inside a geofence. `?type=radius\|polygon`; radius needs `centerLon,centerLat,radius`; polygon needs `coordinates` (JSON array ≥3 pts); optional `start`/`end` (`:140-157`). **Unreachable — 404s today, see note below.** |
| GET    | `/position/:id`      | `JwtOrApiKeyAuthGuard` (`:74`)  | Fetch by id; 404 if missing.                                                                                                                                                                                                         |
| PATCH  | `/position/:id`      | `JwtOrApiKeyAuthGuard` (`:88`)  | Update; `ValidationPipe(updatePositionSchema)`; 404 if missing.                                                                                                                                                                      |
| DELETE | `/position/:id`      | `JwtOrApiKeyAuthGuard` (`:106`) | Delete; **204 No Content** (`:108`).                                                                                                                                                                                                 |

> ⚠️ **Route-ordering bug — `range` and `geofence` are shadowed.** Nest/Express matches in
> **declaration order**, not static-segment-first. `@Get(':id')` is declared at `:75`, while
> `@Get('range')` is at `:126` and `@Get('geofence')` at `:140`, so both static paths are
> captured by the param route. The global `IdFormatGuard` (`common/guards/IdFormatGuard.ts:20-22`,
> registered as `APP_GUARD` at `application.ts:153-156`) then rejects any `*id` param that is not a
> UUID, so `GET /position/range` and `GET /position/geofence` return **404** and their handlers
> never run. `stats` is the one that works, precisely because it is declared _before_ `:id` (`:67`);
> its own comment (`:63-64`) says that placement is why. Nothing in the repo calls the two shadowed
> routes — the only `position` read the web app makes is `/api/position/stats`
> (`frontend/apps/web/src/pages/SettingsPage/sections/LocationSection.tsx:48`). Fixing it means
> moving the two `@Get` declarations above `@Get(':id')`.

---

## Files / media

### `FilesController` — `files` · `domains/files/controllers/FilesController.ts:25`

Both routes carry `@RequireScopes('capture')` + `@RequireCapability('write')` (`:35-36`, `:122-123`) — this is how Companion Capture and the browser extension hand over screenshots and attachments, and how a capture agent writes back the title/description it generated in place of the server's Ollama image description.

| Verb  | Path            | Auth                            | Purpose                                                                                                             |
| ----- | --------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| POST  | `/files/upload` | `JwtOrApiKeyAuthGuard` (`:34`)  | Multipart binary upload; hash-dedupes, stores to MinIO/S3, kicks off preview + (optional) Ollama image description. |
| PATCH | `/files/:id`    | `JwtOrApiKeyAuthGuard` (`:121`) | Overwrite a file's user-facing `title`/`description`.                                                               |

**Upload request**: `multipart/form-data`, field name **`files`** (`FilesInterceptor('files', …)`, `:39`), **per-file limit 10 GB** (`limits.fileSize: 10*1024³`, `:41`), temp `dest: tmpdir()`. Optional form fields: `thingCapture` (`'true'`/bool; `inventoryCapture` still accepted as a deprecated alias), `skipDescription` (`'true'`/bool), `model` (str). Uploads are content-hash de-duplicated within the batch (`:63-95`); 400 if no files (`:52`). **Response**: `[{ id }]`, one per unique file (`:97-99`). Temp files always unlinked in `finally` (`:100-110`).
**PATCH request**: `@Body` `title?`/`description?` (at least one required else 400, `:141`); 404 if file not found (`:147`). **Response**: `{ id }`.

> Bulk clients that need to map inputs → ids deterministically should use `POST /v1/files` (see the Ingest section), which returns one `{ filename, sha256, id, deduped }` entry per input file in input order.

---

## Maintenance / enrichment — `api/maintenance` · `domains/maintenance/controllers/MaintenanceController.ts:415`

**Class-level `JwtOrApiKeyAuthGuard`** (`:414`). Server-mounted at `/api/maintenance/*`. Every POST body is `ValidationPipe`-validated; **all body fields optional unless stated**. Several long-running legs support **opt-in NDJSON streaming** via `?stream=1` (any truthy value except `0`/`false`) **or** `Accept: application/x-ndjson` (`wantsStream`); streamed responses emit one `{type:'progress',…}` line per unit then a final `{type:'result',…}` line (`streamNdjson`).

### Enrichment legs (the post-push chain)

| Verb | Path                                                  | Handler                                    | Stream? | Purpose                                                                                                                                                                                                                                                                                                                                       |
| ---- | ----------------------------------------------------- | ------------------------------------------ | :-----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/api/maintenance/extract-people-from-communications` | `extractPeopleFromCommunications` (`:734`) |    —    | Scan `communications.participants_metadata.{from,to,cc,bcc}`, create stub `Person` entities + `entity_identifiers`. **Run before link-communications.**                                                                                                                                                                                       |
| POST | `/api/maintenance/link-communications`                | `linkCommunications` (`:667`)              |   ✅    | Resolve raw participant strings to entity ids via `entity_identifiers`; fill NULL `from_entity_id`/`to_entity_ids`. Idempotent, windowed.                                                                                                                                                                                                     |
| POST | `/api/maintenance/link-events`                        | `linkEvents` (`:774`)                      |   ✅    | Parse organizer/attendee emails from `event.metadata`, resolve to entity ids, fill NULL `organizer_entity_id`/`participant_entity_ids`.                                                                                                                                                                                                       |
| POST | `/api/maintenance/heal-self-collation`                | `healSelfCollation` (`:823`)               |    —    | Fold owner-representing `Person` stubs into the self `Person` when Autonomy trust allows; otherwise count candidates for Memory → People review. Idempotent.                                                                                                                                                                                  |
| POST | `/api/maintenance/materialize-edges`                  | `materializeEdges` (`:862`)                |   ✅    | Project the deterministic-edge matrix (comms from/to columns, event organizer/participants/location) into `ci.relationships`, resolving both endpoints through their merge tombstone. This is what makes graph traversal — which only walks `ci.relationships` — see a person's emails and event attendance. **Run after the two link legs.** |
| POST | `/api/maintenance/normalize-relationships`            | `normalizeRelationships` (`:911`)          |    —    | Rewrite alias relationship types, deactivate `IS`, stamp bidirectional flags. Idempotent.                                                                                                                                                                                                                                                     |
| POST | `/api/maintenance/derive-relationships`               | `deriveRelationships` (`:927`)             |    —    | L2 aggregates (`COMMUNICATES_WITH`, `FREQUENTS`) and household `Group` reification. Idempotent.                                                                                                                                                                                                                                               |
| POST | `/api/maintenance/fold-notes`                         | `foldNotes` (`:942`)                       |    —    | Fold `ci.notes` into CTI `Content` nodes (provenance `user_created`).                                                                                                                                                                                                                                                                         |
| POST | `/api/maintenance/extract-graph`                      | `extractGraph` (`:967`)                    |   ✅    | Sample comms+events, run **local Ollama** to extract preferences → `Concept` nodes + PREFERS/DISLIKES edges, and family relations → edges between `Person` nodes.                                                                                                                                                                             |
| POST | `/api/maintenance/geocode-locations`                  | `geocodeLocations` (`:439`)                |    —    | Forward-geocode: events with `location_name` but no coordinates → enqueue on `geocode` queue.                                                                                                                                                                                                                                                 |
| POST | `/api/maintenance/reverse-geocode-locations`          | `reverseGeocodeLocations` (`:498`)         |    —    | Reverse: events **with** coordinates but no name → enqueue with `direction:'reverse'`.                                                                                                                                                                                                                                                        |
| POST | `/api/maintenance/estimate-locations`                 | `estimateLocations` (`:552`)               |    —    | Temporal estimation: fill coordinate-less presence events from nearest-in-time location. **Run last of the location legs.**                                                                                                                                                                                                                   |
| POST | `/api/maintenance/backfill-media-dimensions`          | `backfillMediaDimensions` (`:604`)         |    —    | Record `ci.files.width/height` for image/video files lacking them.                                                                                                                                                                                                                                                                            |
| POST | `/api/maintenance/search-index/backfill`              | `backfillSearchIndex` (`:1144`)            |    —    | Find rows with no `ci_search.embeddings` entry and re-emit their create event onto the **`search-index` queue only**; listeners do idempotent embed + tsvector upsert. Run after a bulk import.                                                                                                                                               |
| POST | `/api/maintenance/orchestrate`                        | `orchestrate` (`:1037`)                    |   ✅    | One-shot: run every leg back-to-back in canonical order.                                                                                                                                                                                                                                                                                      |

**Async legs return an enqueue receipt**: `{ jobId, estimatedEventCount, status: 'enqueued'\|'noop' }` (geocode/reverse/estimate), `{ jobId, estimatedFileCount, status }` (media). A zero candidate count returns `status:'noop'` with no job.

**Synchronous / streamable legs return a work summary** (examined/linked/created counts + windows/range). Key body schemas: `linkCommunicationsSchema` (`:280`) `{ startTime?, endTime?, windowDays?, windowLimit? }`; `extractGraphSchema` (`:336`) `{ maxCommunications?, maxEvents?, model? }`; `searchIndexBackfillSchema` (`:170`) `{ entityTypes?, batchSize?, limitPerType? }`.

> The backfill leg is _not_ the only search-index path any more. The pipeline domain owns versioned index sweeps, and the `maintenance.search-index-backfill-request` event (queue `search-index-backfill`) is now consumed by `domains/pipeline/listeners/SearchIndexSweepRequestListener.ts`, which starts a pipeline sweep rather than the old embedding-exists backfill. The event id and queue name are unchanged; only the consumer moved.

#### `orchestrate` (`:1037`)

Body `orchestrateSchema` (`:352-381`): `stages?` (subset of `ORCHESTRATE_STAGES` — unknown names 400), `options?` (per-leg passthrough), `abortOnError?` (def false = fail-soft), `searchIndexDrain?.timeoutMs?`. Execution order is **always canonical**, whatever subset is named (`ORCHESTRATE_STAGES`, `services/MaintenanceOrchestratorService.ts:51-68`) — sixteen stages:

`extract_people` → `link_communications` → `link_events` → `heal_self_collation` → `materialize_edges` → `normalize_relationships` → `derive_relationships` → `fold_notes` → `extract_graph` → `geocode` → `reverse_geocode` → `reverse_position` → `reverse_object` → `estimate_locations` → `media_dimensions` → `search_index`

The order encodes real data dependencies: `extract_people` seeds the identifier index the two link legs resolve against; `materialize_edges` projects the columns those legs just filled; geocoding lands before the estimator so it only fills what nothing else could; `search_index` runs last so the embeds cover the enriched rows.

**One orchestration per user at a time — a second concurrent call → 409 Conflict** (`:1054-1056`, checked _before_ the stream headers are committed so the second caller gets a real 409 rather than a 200 that fails mid-stream). Non-stream response: `{ ok, legs[], totalDurationMs }`. Stream: NDJSON of `leg-start`/`leg-progress`/`leg-result`/`leg-error`/`tick`/`done` lines.

### Index-deferral (bulk-load helper)

| Verb | Path                                | Handler                     | Purpose                                                                                                                                                 |
| ---- | ----------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/api/maintenance/indexes/drop`     | `dropIndexes` (`:1083`)     | Drop deferrable secondary indexes before a huge load; returns each dropped index's exact recreate statement. Never drops PKs/provenance-unique indexes. |
| POST | `/api/maintenance/indexes/recreate` | `recreateIndexes` (`:1093`) | Recreate them; body `{ dropped: {schema,name,definition}[] }` — the array from `/drop` verbatim.                                                        |

### Search-index hygiene & observability

| Verb | Path                                            | Handler                                    | Purpose                                                                                                                                                                                        |
| ---- | ----------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/api/maintenance/search-index/cleanup-orphans` | `cleanupSearchOrphans` (`:1108`)           | Delete `ci_search` rows whose source row is gone. Body `{ batchSize?, entityTypes?, dryRun? }`.                                                                                                |
| POST | `/api/maintenance/search-index/truncate`        | `truncateSearchIndex` (`:1124`)            | **Destructive** — truncate both `ci_search` tables. Body must be exactly `{ confirm: true }` (`:163`) else 400.                                                                                |
| GET  | `/api/maintenance/search-index/embedded-count`  | `embeddedCount` (`:1171`)                  | Total `ci_search.embeddings` rows, optional `?types=` CSV. **Global, not user-scoped**, mirroring the backfill it tracks. Returns `{ count, perType }`. Drives the importer's embed-drain bar. |
| GET  | `/api/maintenance/search/coverage`              | `searchCoverage` (`:1214`)                 | Per `entity_type`: `total` vs `embedded` vs ratio; `alarms` lists rows-but-zero-embeddings types.                                                                                              |
| GET  | `/api/maintenance/content/external-id-kind`     | `contentExternalIdKindIntegrity` (`:1240`) | Integrity report over `ci.content.external_id` kinds.                                                                                                                                          |
| GET  | `/api/maintenance/ingest-status`                | `ingestStatus` (`:1253`)                   | Snapshot: row counts of the bulk-ingest tables + `ci_search` embeddings/skip counts per type + `search-index` queue depth.                                                                     |

### Full ingest reset

| Verb | Path                            | Handler                 | Purpose                                                                                                                                                                                                                    |
| ---- | ------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/api/maintenance/ingest/reset` | `resetIngest` (`:1329`) | **Destructive across ALL users.** Truncate every bulk-ingest table + comms dedup + all `ci_search`, delete not-yet-run search-index jobs. Body must be exactly `{ confirm: 'RESET_ALL_INGESTED_DATA' }` (`:247`) else 400. |

---

## Pipeline (versioned enrichment runs) — `api/pipeline` · `domains/pipeline/controllers/PipelineController.ts:183`

Class-level `JwtOrApiKeyAuthGuard` (`:184`), server-mounted at `/api/pipeline/*`. The operator answer to "is my import finished?", "what failed?", "how do I stop this?".

**No `@RequireScopes`, deliberately** (`:162-166`): because enforcement is deny-by-default, an un-annotated route is one a scope-limited key cannot reach _at all_ — which is the correct answer for a control plane. Granting it a scope would be the change that opened it up. `@RequireCapability` is the second axis and **does** apply, because it also binds empty-scope legacy keys: reads need `read`, the three control routes plus replay need `write`. Nothing here is `full` — nothing here deletes anything. Route `:id` params are validated by the global `IdFormatGuard`, so a malformed id 404s before any `::uuid` cast.

| Verb | Path                                    | Handler | Cap   | Purpose                                                                               |
| ---- | --------------------------------------- | ------- | ----- | ------------------------------------------------------------------------------------- |
| GET  | `/api/pipeline/state`                   | `:211`  | read  | Current pipeline state snapshot.                                                      |
| GET  | `/api/pipeline/runs`                    | `:220`  | read  | List runs.                                                                            |
| GET  | `/api/pipeline/runs/:id`                | `:243`  | read  | One run with its stages.                                                              |
| POST | `/api/pipeline/runs/:id/pause`          | `:258`  | write | Pause a run. **200**.                                                                 |
| POST | `/api/pipeline/runs/:id/resume`         | `:266`  | write | Resume a run. **200**.                                                                |
| POST | `/api/pipeline/runs/:id/cancel`         | `:282`  | write | Cancel a run. **200**.                                                                |
| GET  | `/api/pipeline/dead-letters`            | `:296`  | read  | The DLQ listing.                                                                      |
| POST | `/api/pipeline/dead-letters/replay`     | `:331`  | write | Replay a selection of dead letters. **200**.                                          |
| POST | `/api/pipeline/dead-letters/:id/replay` | `:356`  | write | Replay one dead letter. **200**.                                                      |
| POST | `/api/pipeline/quarantine/release`      | `:387`  | write | Release `ci.pipeline_state` quarantine so `claim()` can hand work out again. **200**. |

---

## Memory / graph REST

### `GraphController` — `graph` · `domains/memory/controllers/GraphController.ts:256`

Class-level `JwtOrApiKeyAuthGuard` (`:257`). All GET except `POST /graph/edges`; each query/body zod-validated.

| Verb | Path             | Handler                    | Purpose                                                                                                                                                                                                                                                                                                                                     |
| ---- | ---------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/graph/context` | `getUserContext` (`:430`)  | User context block for the LLM (knowledge-graph summary).                                                                                                                                                                                                                                                                                   |
| GET  | `/graph/stats`   | `getMemoryStats` (`:446`)  | Memory-wide totals for the stats page plus the life series (spend, time, conversations, social). Inventory/tag/source breakdowns stay all-time; `from`/`to` filter only the life series.                                                                                                                                                    |
| GET  | `/graph/data`    | `getGraphData` (`:490`)    | Full graph nodes+links, filterable by entity type / tags / event dimensions.                                                                                                                                                                                                                                                                |
| GET  | `/graph/dots`    | `getGraphDots` (`:720`)    | The **dots overview**: thousands of minimal nodes (`{id, type, name, degree}` + `event_type` for events), **zero edges** — the zoomed-out canvas payload. Same scarcest-first waterfill as the classic overview, but each type's share is highest-degree hubs first. Also returns `connectivity` (`related` / `isolated` / `relatedRatio`). |
| POST | `/graph/edges`   | `getGraphEdges` (`:869`)   | Section-edge fetch: the relationships among an explicit node-id set (the client's viewport past the LOD threshold). Both endpoints are constrained to the set server-side and the result is capped, so a hub in view cannot drag in its off-screen edges.                                                                                   |
| GET  | `/graph/search`  | `searchGraph` (`:895`)     | Lexical/prefix node search, filter-scoped.                                                                                                                                                                                                                                                                                                  |
| GET  | `/graph/source`  | `getNodeSource` (`:1087`)  | The record behind a graph node: `{ type, id }` in the `GlobalUID` vocabulary, or `null` when nothing addressable sits behind it. A deliberately tiny separate call — the dots overview ships thousands of nodes and only the clicked one needs resolving.                                                                                   |
| GET  | `/graph/node`    | `getNodeDetails` (`:1105`) | Resolve+traverse one node with depth/limits.                                                                                                                                                                                                                                                                                                |

**Notes**: `graphDataSchema` — `includeTypes`, `tags`, `connectors/people/places/eventTypes` (CSV), `hasLocation` (bool), `from`/`to` (date range). `graphSearchSchema` = graphDataSchema + required `query` + `limit`(1-50, def 10). The classic overview is capped at `NODE_LIMIT` (200 nodes, `:195`), of which an anchor neighborhood may consume at most half (`:240`).

> A **GraphQL `graph` query** now exists alongside this controller and reads the same `ci.entities` / `ci.relationships` spine; its own description marks it "preferred over REST `/api/graph/*`". See [graphql.md §3.4](graphql.md#34-graph-domain).

### `MemoryController` (agent-facing) — `memory` · `domains/agent/controllers/MemoryController.ts:54`

**Per-method guards.** The first four are `ApiKeyGuard` (machine callers with an API key, as `x-api-key` or `Authorization: Bearer <key>`); `compact` is `JwtOrApiKeyAuthGuard`. Every route declares `@RequireScopes('memory')` and a `@RequireCapability` floor.

| Verb | Path              | Handler            | Auth                   | Cap   | Purpose                                                                                                                                                                                         |
| ---- | ----------------- | ------------------ | ---------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/memory/context` | `context` (`:78`)  | `ApiKeyGuard`          | read  | L0 static profile block (markdown) for an agent system prompt. Returns `{ block }`.                                                                                                             |
| POST | `/memory/recall`  | `recall` (`:114`)  | `ApiKeyGuard`          | read  | L1 hybrid keyword/semantic search with entity hydration. Body `{ query, maxResults? }` — `maxResults` is an integer 1–20 (anything else is a 400).                                               |
| POST | `/memory/write`   | `write` (`:134`)   | `ApiKeyGuard`          | write | Store a raw memory fragment verbatim. **201**.                                                                                                                                                  |
| POST | `/memory/turn`    | `turn` (`:153`)    | `ApiKeyGuard`          | write | Ingest a conversation turn (dedup by SHA-256 UUIDv8). Body `{ sessionId, platform, messages[] }`. Returns `{ created, skipped }`. Driven by OpenClaw `afterTurn` / Hermes `sync_turn` / CI-Mentra. **201**. |
| POST | `/memory/compact` | `compact` (`:225`) | `JwtOrApiKeyAuthGuard` | write | Manually trigger compaction (background). Returns `{ queued }`. **200**.                                                                                                                        |

**Callers:** the chat agents (CI-Hermes, CI-OpenClaw) and **CI-Mentra** (the Mentra smart-glasses bridge), which uses `context`, `recall` (`maxResults: 6`), `turn` (`platform: "mentra"`) and `write` (`source: "mentra"`) with a Hub connect key for app `ci-mentra` — scopes `['memory']`, capability `write` (`scopesForApp` / `capabilityForApp` in `domains/auth/services/ConnectService.ts`).

### `PersonaIntelligenceController` — `v1/intelligence` · `domains/persona/controllers/PersonaIntelligenceController.ts:64`

Persona × task intelligence for the web UI and connect keys (Hermes/OpenClaw). All routes use `JwtOrApiKeyAuthGuard`, require `@RequireScopes('memory')`, and declare `@RequireCapability` per method so scoped connect keys can reach them.

| Verb | Path                                    | Handler              | Capability | Purpose                                                                                                                               |
| ---- | --------------------------------------- | -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/v1/intelligence/agent-harnesses`      | `agentHarnesses`     | read       | Linked agent apps (Hermes/OpenClaw) with reachable URLs for “Open with agent”. Returns `{ harnesses }`.                               |
| POST | `/v1/intelligence/how-youd-do-it`       | `howYoudDoIt`        | read       | Multi-prompt persona compose for a task. Body `{ task, includeRecall?, candidateId? }`. Returns approach steps, evidence, confidence. |
| POST | `/v1/intelligence/how-youd-do-it/apply` | `applyHowYoudDoIt`   | write      | Write compose approach steps onto the Possibilities slate. Body `{ result }` (full `HowYoudDoItResult`). Returns `{ added }`.         |
| GET  | `/v1/intelligence/about-you`            | `aboutYou`           | read       | Read dossier, preferences, recent answers for Settings → About you.                                                                   |
| POST | `/v1/intelligence/about-you/correction` | `aboutYouCorrection` | write      | Teach-loop correction; writes Q&A and invalidates compose cache. Body `{ text }`.                                                     |

**MCP:** the same compose pipeline is exposed as native intent `persona.compose` (executable name `persona_compose`) for keys carrying `intents`.

### `ThreadsController` — `threads` · `domains/conversations/controllers/ThreadsController.ts:35`

Per-method `JwtOrApiKeyAuthGuard`.

| Verb   | Path           | Handler           | Purpose                                                                |
| ------ | -------------- | ----------------- | ---------------------------------------------------------------------- |
| POST   | `/threads`     | `post` (`:43`)    | Create a thread (`model` req; `name`/`description`/`userId` optional). |
| GET    | `/threads`     | `findAll` (`:54`) | All threads for the current user.                                      |
| GET    | `/threads/:id` | `findOne` (`:64`) | Thread by id; `?includeMessages=true\|false` (default true).           |
| DELETE | `/threads/:id` | `delete` (`:91`)  | Soft-delete. **204**.                                                  |

### `AnswersController` — `answers` · `:22`, `QuestionsController` — `questions` · `:39`, `ActionsController` — `actions` · `:9`

Per-method `JwtOrApiKeyAuthGuard`. Standard user-scoped CRUD (`answers`, `questions`) / read-only (`actions`). Deletes return **204**, missing → **404**.

`questions` adds two static routes, both declared **before** `:id` (Nest matches in declaration order):

| Verb | Path                    | Handler                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ----------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/questions/catalogue`  | `findCatalogue` (`:84`)     | The browsable, paged catalogue, each row carrying the caller's answer when it has one — `GET /questions` returns every active row at once, which is unusable at catalogue size. Query (`domains/intelligence/types.ts`): `search?`, `category?`, `answerTier?`, `status`(`active`\|`inactive`\|`all`, def `active`), `answered`(`answered`\|`unanswered`\|`all`, def `all`), `limit`(1–100, def 25), `offset`(def 0), plus two comma-separated allow-lists — `ids?` (question uuids) and `keys?` (`question_key` slugs), max 100 each, ANDed with everything else and with each other. **A fixed, curated caller must use `keys`, never `ids`:** `question_id` defaults to `gen_uuid_v7()`, so a seed migration mints a different uuid on every appliance and hardcoded ids match nothing anywhere else — the failure is silent, since the rows simply do not come back. Each row reports its own `key` (null for the rows nobody names) so a `keys` caller can index the response by it. |
| GET  | `/questions/unanswered` | `findOneUnanswered` (`:95`) | First unanswered question; **204** if none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

> **`question_key`.** A stable, appliance-independent slug on `ci.questions`, written only by seed migrations — no API accepts one, so an edit cannot rename or steal a key. Unique per `(question_key, is_private_to)` with `NULLS NOT DISTINCT`, which lets a user's copy-on-write fork carry the same key as the shared row it replaces (`QuestionService.forkSharedQuestion` copies it deliberately: the origin is hidden from whoever forked it, so a keyless copy would drop that question from every curated surface for that one user). The Self page's "Life details" grid is the first consumer; its keys are seeded by `20260824234643_seed_life_details_question_keys.sql` and cross-checked against the client list by `lifeDetails.catalogue.node.test.ts`.

> **Naming.** The web UI renamed this surface **Questions → Reflections** (route `/self/reflections` since 2026-08-23; `/memory/reflections` and `/prompts` still redirect there), but the API did **not**: the controller is still `@Controller('questions')`, the GraphQL type is still `QuestionType`, and the table is still `ci.questions`. Keep saying "questions" in API docs and "Reflections" in UI docs. Retired catalogue rows are deactivated (`is_active = false`), never deleted, because `ci.answers` and `ci.feed_queue` cascade off them.

### `DeviceController` — `devices` · `domains/devices/controllers/DeviceController.ts:25`

Per-method `JwtOrApiKeyAuthGuard`. CRUD + `PATCH /devices/:id/primary` (mark primary) + `PATCH /devices/:id/last-seen` (bump `last_seen`). `POST /devices` accepts one or many; unique violation → 409.

### Connections

#### `ConnectionsController` — `connections` · `domains/connections/controllers/ConnectionsController.ts:92`

Per-method `JwtOrApiKeyAuthGuard`. Token secrets stripped from all read responses.

| Verb   | Path                           | Handler                                                                 | Purpose                                                                              |
| ------ | ------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| POST   | `/connections`                 | `create` (`:105`)                                                       | Create a connection.                                                                 |
| GET    | `/connections`                 | `findAll` (`:120`)                                                      | List (secrets stripped).                                                             |
| GET    | `/connections/:id`             | `findOne` (`:134`)                                                      | One (secrets stripped).                                                              |
| PATCH  | `/connections/:id`             | `update` (`:150`)                                                       | Update name/status/schedule/endpoints.                                               |
| DELETE | `/connections/:id`             | `delete` (`:170`)                                                       | Delete; **204**.                                                                     |
| GET    | `/connections/:id/connect`     | `connect` (`:179`)                                                      | Begin OAuth: return authorization URL.                                               |
| POST   | `/connections/complete`        | `completeCallback` (`:237`)                                             | Complete OAuth callback (proxy vs direct); **204**.                                  |
| POST   | `/connections/openid/complete` | `completeOpenIDCallback` (`:348`)                                       | Complete OpenID (Steam) callback; **204**.                                           |
| POST   | `/connections/sync-now`        | `SyncNowController` (`domains/etl/controllers/SyncNowController.ts:13`) | Kick a connection's sync immediately. Same `connections` mount, separate controller. |

#### `ProvidersController` — `providers` · `domains/connections/controllers/ProvidersController.ts:28`

`GET /providers` (`:42`, list OAuth providers), `GET /providers/:id` (`:50`), `POST /providers/:id` (`:58`, create a connection + return `{ authorizationUrl }`). Per-method `JwtOrApiKeyAuthGuard`.

### BlueBubbles

Not part of the `providers`/`connections` OAuth system above — one appliance-wide config row (`BlueBubblesConfigService.getOrCreate`), the same shape the LLM endpoint config uses, since there is one BlueBubbles server per appliance rather than one per account. The web UI surfaces it at Settings → BlueBubbles and as its own card on Sources → Services (`/sources/connect`), outside the `SERVICE_PROVIDERS` catalogue.

#### `BlueBubblesConfigController` — `bluebubbles` · `domains/bluebubbles/controllers/BlueBubblesConfigController.ts:31`

Per-method `JwtOrApiKeyAuthGuard`.

| Verb | Path                           | Handler                   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/bluebubbles/config`          | `getConfig` (`:65`)       | Masked read: `hasPassword` stands in for the raw `password` column, which never leaves the server. `webhookPath` is the deliberate exception and _is_ a credential — without it the webhook URL was unconstructible outside Postgres, so the whole live-ingestion half of the feature was unreachable. A path rather than an absolute URL: the browser's own origin is prepended client-side, because the appliance is reached at whatever address the caller used. |
| PUT  | `/bluebubbles/config`          | `updateConfig` (`:72`)    | Update host/port/useHttps/hasPrivateApi/enabled. `password` omitted keeps the existing stored value — the same "blank means unchanged" contract `ApiKeysSection` uses. **400** when `enabled: true` is saved with no password on either side, which would otherwise be a connector that can never authenticate.                                                                                                                                                     |
| POST | `/bluebubbles/test-connection` | `testConnection` (`:102`) | Cheap round trip against the server described in the body (falls back to the saved config for any field omitted). Persists nothing.                                                                                                                                                                                                                                                                                                                                 |
| POST | `/bluebubbles/sync-now`        | `syncNow` (`:127`)        | Fire-and-forget: kicks off `BlueBubblesSyncService.runSync()`; progress and failures land on the config row / Import Runs, not in this response. **202**. Concurrency-safe: the pass takes the appliance-wide claim on the config row (`claimSync`), so repeated clicks — and the cron ticking in both the api and worker processes — produce one pass, not four.                                                                                                   |

#### `BlueBubblesWebhookController` — `bluebubbles/webhook` · `domains/bluebubbles/controllers/BlueBubblesWebhookController.ts:41`

`POST /bluebubbles/webhook/:secret` (`:52`) — **no guard**. BlueBubbles' own outgoing webhooks carry no header/bearer auth, so the unguessable `:secret` path segment (minted at config-row creation, `BlueBubblesConfigEntity.webhookSecret`) _is_ the credential, compared with `timingSafeEqual` via `BlueBubblesConfigService.secretsMatch`. A mismatch is a generic **404**, not 401 — a 401 would confirm to a prober that a BlueBubbles integration exists here at all. Only `new-message`/`updated-message` event types ingest (`INGESTABLE_TYPES`); every other BlueBubbles event type (`typing-indicator`, `hello-world`, …) still gets **200**, just no ingestion work.

Because the secret rides in the path, two things follow. `RequestLoggerMiddleware` redacts that segment (`redactRequestPath`) — it is mounted `forRoutes('*')` and logs `req.originalUrl`, so every delivery used to write the credential in plaintext to the app log. And the handler reads the config row with `find()` rather than `getOrCreate()`, so an unauthenticated prober cannot cause the row — and with it the webhook secret — to be minted.

Deliveries are **coalesced**, not ingested one at a time: a delivery joins an in-memory queue that flushes as a single import run a couple of seconds later. One run per inbound text meant a run row, a stage row per kind, a `PushStage.run` (`pg_database_size` included) and three pg-boss sweep enqueues _per message_. A live message never advances `last_sync_cursor`; that cursor belongs to the backfill alone, or one new text arriving mid-backfill would ratchet it to "now" and skip the history behind it.

---

## Agent / intents — `api/agent/intents` + `api/intents` · `domains/agent/controllers/IntentsController.ts:44`

Class-level `JwtOrApiKeyAuthGuard` (`:42`) + `@RequireScopes('intents')` (`:43`). Publishes the CI Intent catalog and executes those intents through `ToolRegistry`. One controller mounts **both** prefixes: `/api/agent/intents/*` is canonical for CI-Hermes / CI-OpenClaw and `/api/intents/*` is the legacy prefix, still served. GET requires capability `read`. POST uses `read` as the HTTP floor; `ToolRegistry.executeTool` is the verb gate (a write intent such as `suggestions.feedback` still needs a write key).

| Verb | Path                               | Handler               | Purpose                                                                                                                                                                                                                                                  |
| ---- | ---------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/api/agent/intents`               | `getManifest` (`:58`) | Full `IntentManifest` (domains + entities + intents). `?tier=local` additionally attaches this server's own dispatch ruling to each intent, so the on-device tier reads `dispatch.decision` instead of shipping a Kotlin and a Swift copy of the policy. |
| GET  | `/api/agent/intents/domains`       | `getDomains` (`:65`)  | `{ domains: IntentDomain[] }`.                                                                                                                                                                                                                           |
| GET  | `/api/agent/intents/entities`      | `getEntities` (`:72`) | `{ entities: CiEntityDescriptor[] }`.                                                                                                                                                                                                                    |
| GET  | `/api/agent/intents/:name`         | `getIntent` (`:79`)   | One intent by dotted name (e.g. `memory.recall`); 404 if unknown.                                                                                                                                                                                        |
| POST | `/api/agent/intents/:name/execute` | `execute` (`:98`)     | Raw JSON body = tool input. Name may be dotted or underscored. Unknown → **404**. Known → **200 `ToolResult`**.                                                                                                                                          |

**Intent names are dotted, not camelCase.** The pre-window camelCase tool names are gone with no aliases — use `memory.recall`, `memory.remember`, `memory.forget`, `knowledge.search`, `knowledge.preferences`, `people.relationships`, `media.entertainmentPreferences`, `media.streamingAvailability` (advertised to models and MCP in the underscored executable form `memory_recall`, …). Execution emits `tool.invoked` on the telemetry queue; there is no `intent.invoked` event and no `IntentDonationService`.

> **Δ 2026-08-23 — this paragraph used to say the opposite, and was wrong.** It read
> "There is **no** model-tier router and no `POST /api/model-routing/plan` — that
> prototype was removed." A model-tier router landed on `main` in
> [#2267](https://github.com/companionintelligence/CI-Server/pull/2267)
> (`2a7b85930`) and is documented in its own section below.

---

## Model tier routing — `api/model-routing` · `domains/model-routing/controllers/ModelRoutingController.ts:27`

Class-level `JwtOrApiKeyAuthGuard`. Answers "which tier should I run this task
on?" — **on-device** or **private cloud** — so an agent (CI-Hermes, CI-OpenClaw,
a client) can ask before the call instead of unconditionally escalating to a
third-party API. It **decides**, it does not execute: nothing here runs a model.

| Verb | Path                       | Handler            | Purpose                                                                                                                                                                                                                                                                                                                                       |
| ---- | -------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/api/model-routing/tiers` | `getTiers` (`:32`) | The static `TierProfile[]` (on-device vs private-cloud).                                                                                                                                                                                                                                                                                      |
| POST | `/api/model-routing/plan`  | `plan` (`:38`)     | Body is zod-validated and **stripped** of unknown keys: `estimatedInputTokens`, `reasoningLevel` (`light`/`moderate`/`deep`), `toolDepth`, `requiresLargeContext`, `localOnly`, `cloudAvailable`, `forceTier` (`on_device`/`private_cloud`) — all optional. Returns a `RoutingDecision`. Invalid body → **400** with the joined zod messages. |

## Account deletion (privacy) — `api/users/me` · `domains/privacy/controllers/PrivacyController.ts:31`

| Verb | Path                   | Handler                                               | Purpose                                                                                                                                                                  |
| ---- | ---------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| POST | `/api/users/me/delete` | `deleteMe` (`:41`, per-method `JwtOrApiKeyAuthGuard`) | CASA-V8 user-data deletion plus OAuth-token revocation. Distinct from `DELETE /account` — see [`architecture/account-deletion.md`](../architecture/account-deletion.md). |

---

## LLM / chat — `llm` · `domains/llm/controllers/OllamaController.ts:42` + `domains/llm/controllers/LlmEndpointController.ts:15`

Per-method `JwtOrApiKeyAuthGuard`. **No longer a thin proxy.** Generation is a durable, queued turn: `POST /llm/generate` enqueues a `chat.generate` pg-boss job on the serial `llm` queue and streams from a `ChatGenerationBroker`, so a dropped connection can re-attach instead of losing the turn. The backend behind it need not be Ollama — when an `apiBase` is configured (`LLM_API_BASE` / `LLM_API_KEY` / `LLM_DEFAULT_CHAT_MODEL`) an OpenAI-compatible `/v1` driver is used instead.

| Verb  | Path                            | Handler                         | Purpose                                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET   | `/llm/models`                   | `listModels` (`:56`)            | List available models.                                                                                                                                                                                                                                                                                     |
| GET   | `/llm/models/capabilities`      | `getModelCapabilities` (`:62`)  | `?model=` → `{ model, capabilities[], vision }`.                                                                                                                                                                                                                                                           |
| POST  | `/llm/generate`                 | `generate` (`:77`)              | Enqueue a chat turn and stream it back. **200**; **409 Conflict** if the thread is already generating.                                                                                                                                                                                                     |
| GET   | `/llm/threads/:threadId/stream` | `stream` (`:150`)               | Re-attach to an in-flight turn's stream. **204** when the thread is idle and the broker holds nothing; **404** for an unknown thread.                                                                                                                                                                      |
| POST  | `/llm/threads/:threadId/cancel` | `cancel` (`:174`)               | Abort the broker and reset the thread to `idle`. **204**; **404** for an unknown thread.                                                                                                                                                                                                                   |
| GET   | `/llm/endpoint`                 | `LlmEndpointController` (`:20`) | Read the effective endpoint: `{ backend, port, hostGateway, endpoint, locked, apiKeyConfigured }`. Credentials are never returned. **200**.                                                                                                                                                                |
| GET   | `/llm/endpoint/preflight`       | `LlmEndpointController`         | Bounded reachability/model-list check from the API process. Returns `{ ok, backend, endpoint, models, message?, status? }`; a failed backend check is still **200** so a UI/CLI can render the actionable result.                                                                                          |
| PATCH | `/llm/endpoint`                 | `LlmEndpointController` (`:27`) | Update an appliance-owned endpoint with `{ backend, port, apiKey?, clearApiKey? }`; `apiKey` is write-only and `clearApiKey` removes the appliance-saved key. The two cannot be combined. Syncs `app.env` `LLM_*` for the summary service. **200**; **409** when Hub/host configuration owns the endpoint. |

**`/llm/generate` contract**: request `{ prompt, model?, threadId?, enableTools?, enableThinking?, fileIds? }` (`promptSchema`, `:30-37`). Without `threadId` a thread is created. The prompt and an empty assistant message are persisted first, generation status is set to `queued`, then the job is enqueued with the caller's api-key `capability` attached (so tool calls made during the turn are authorized at the caller's level) and the broker pipes the stream to the response.

**Default model**: `DEFAULT_CHAT_MODEL = 'gemma4:e4b'` (`configuration.ts:33`) — **not** the retired `gemma3:1b`. `qwen3:14b` / `gemma3:27b` are reached only behind the `pinned.demo.models` feature flag. The embedding model is unchanged at `nomic-embed-text`.

---

## Account, identity & device surfaces

### `AccountController` — `account` · `domains/auth/controllers/AccountController.ts:36`

| Verb   | Path       | Auth                           | Purpose                                                                                                                                        |
| ------ | ---------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| DELETE | `/account` | `JwtOrApiKeyAuthGuard` (`:60`) | Delete the authenticated account: revoke access now, purge the data later. **204**. Body `{ confirmEmail }` — the account's own email retyped. |

Two deliberate choices worth knowing: the guard is `JwtOrApiKeyAuthGuard`, **not** `JwtAuthGuard`, because the native app never holds a JWT (it trades one for a durable API key at login), and a JWT-only route would be unreachable from exactly the App Store build the store requirement is about. And the confirmation is the **email**, not the password: OIDC-provisioned accounts are given a random password the user has never seen, so requiring it would make deletion impossible for them.

### `AccountDataController` — `account` · `domains/auth/controllers/AccountDataController.ts:55`

Class-level `JwtOrApiKeyAuthGuard` (`:56`). Export/import the caller's Memory data as a portable archive.

| Verb | Path                     | Handler | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/account/export`        | `:63`   | Stream the full archive out.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST | `/account/import/stream` | `:69`   | **NDJSON streaming import** — `Content-Type: application/x-ndjson` required (400 otherwise), confirmation via the **`X-Confirm-Email` header** (400 if absent). Neither side buffers the archive: the express body parsers skip `application/x-ndjson`, so the handler gets the raw stream. (The middleware's explicit bypass constant is `/api/account/import/stream` and never matches this mount — see the body-limit note above.) **200**. |
| POST | `/account/import`        | `:91`   | Legacy small-archive JSON import: `{ confirmEmail, archive: { version: 1, exportedAt, userId, profile, tables, fileBlobs } }`, `@BodyLimit('500mb')`. **200**.                                                                                                                                                                                                                                                                                 |

### `ConnectController` — `connect` · `domains/auth/controllers/ConnectController.ts:130`

How CI-Hub brokers connecting an agent app (CI-OpenClaw / CI-Hermes) to the user's Companion Memory.

| Verb | Path                | Auth                                  | Purpose                                                                                                                                                                                                                       |
| ---- | ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/connect`          | **none** (`:145`)                     | Consent page. Validates the CI-Hub return URL, signs the user in first (bouncing through OIDC and back) if needed.                                                                                                            |
| POST | `/connect/approve`  | **none** — hidden-field CSRF (`:284`) | Mint a scoped key, hand back a one-time code. Returns a **rendered meta-refresh page**, not a 302: the gateway's `form-action 'self'` makes Chrome refuse to follow a redirect from this form POST to a cross-origin Hub URL. |
| POST | `/connect/exchange` | `ConnectRequestAuthGuard` (`:379`)    | CI-Hub swaps the one-time code for the raw key (S2S). The raw key leaves the server **only** here.                                                                                                                            |
| POST | `/connect/revoke`   | `ConnectRequestAuthGuard` (`:395`)    | CI-Hub revokes the app's key.                                                                                                                                                                                                 |
| POST | `/connect/rotate`   | `ConnectRequestAuthGuard` (`:409`)    | CI-Hub rotates the app's key before expiry.                                                                                                                                                                                   |

> **Naming trap:** `/connect` means opposite things on the two sides, so always say which you mean.
> On the **API**, `/connect/*` is the CI-Hub app-connect flow above; _Sources_ — OAuth account
> connections — are `/connections` (`ConnectionsController.ts:92`) and `/providers`
> (`ProvidersController.ts:28`). In the **web SPA** `/connect` is Sources (it redirects to
> `/sources/connect`, `frontend/apps/web/src/App.tsx:456`) and native device connect is
> `/device-connect` (`App.tsx:204`, `pages/DeviceConnectPage/` — Portal cloud-connect, with
> `/server` as the Advanced-URL fallback). Both of those are **client** routes; there is no
> `/device-connect` on the API.

### `PeerAskController` — `agent/v1` · `domains/peers/controllers/PeerAskController.ts:35`

`POST /agent/v1/ask` (`:48`) — **the only route another Companion can reach**, and deliberately not on `JwtOrApiKeyAuthGuard` (whose Portal path JIT-provisions a local account, exactly what must not happen for a peer). It verifies the peer's Portal token **claims only**, then hands `(issuer, subject)` to the peer-link layer.

Three independent gates, each returning **503** so the surface is indistinguishable from a box that has none: the `ask` feature flag (now **`true`** by default in `config/default.json:213` — the local ask/grant GraphQL surface is live out of the box), a configured `peers.audience` (`:67-71`; without it a token minted for _any_ first-party client would verify), and a matching `ci.peer_links` row. Rate-limiting runs on the verified peer identity _before_ the peer-link lookup, so an unlinked caller cannot hammer it for free.

### Solid facade — `domains/solid/controllers/`

| Verb | Path                                      | Auth                                                  | Purpose                                                                                                                                                                                                           |
| ---- | ----------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/solid/profile/:userId`                  | **none** (`WebIdController.ts:35`)                    | The WebID Profile Document, content-negotiated Turtle/JSON-LD. Unauthenticated **by design** — a relying party must be able to dereference it before any token exists. Carries only already-public profile facts. |
| GET  | `/solid/storage/:userId/entity`           | `JwtOrApiKeyAuthGuard` (`StorageController.ts:41,51`) | Entity container listing.                                                                                                                                                                                         |
| GET  | `/solid/storage/:userId/entity/:entityId` | `JwtOrApiKeyAuthGuard` (`:67`)                        | One entity as a Solid resource.                                                                                                                                                                                   |

The whole facade is gated on the **`solid.protocol` feature flag, off by default** — with it off, every route 404s, indistinguishable from "no such route".

### `PowerSyncController` — `powersync` · `domains/powersync/controllers/PowerSyncController.ts:8`

`GET /powersync/token` (`:22`), `JwtOrApiKeyAuthGuard`. Returns **503 `PowerSync is not configured`** until both `powersync.url` and `powersync.jwtSecret` are set (`services/PowerSyncTokenService.ts:47-50`) — the PowerSync container carries `profiles: ["staging", "production"]` (`docker-compose.yml:142`), so `make dev` never starts it and clients fall back to GraphQL.

### Config endpoints

Two tiny controllers share the `config` mount (`DeviceController` itself is under **Memory / graph REST** above):

| Verb | Path                | Auth                                                                     | Purpose                                                                          |
| ---- | ------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| GET  | `/config/maps`      | `JwtOrApiKeyAuthGuard` (`common/controllers/MapsConfigController.ts:16`) | Map tile/style configuration. **200**.                                           |
| GET  | `/config/telemetry` | **None — public** (`common/controllers/TelemetryConfigController.ts:20`) | Telemetry (Sentry) configuration the SPA needs before it has a session. **200**. |

---

## Import runs (the in-process importer)

The importer ported out of the retired CI-Import-Tools runs **inside this server**, and exposes its own controllers. All routes are per-method `JwtOrApiKeyAuthGuard`.

### `ImportRunsController` — `import` · `domains/import/controllers/ImportRunsController.ts:152`

| Verb | Path                                        | Line   | Purpose                                                    |
| ---- | ------------------------------------------- | ------ | ---------------------------------------------------------- |
| GET  | `/import/sources`                           | `:168` | The datasources this build can parse.                      |
| GET  | `/import/sources/catalog`                   | `:181` | The full source catalog.                                   |
| POST | `/import/recognize`                         | `:206` | Recognize what a drop contains before committing to a run. |
| POST | `/import/runs`                              | `:221` | Start a run.                                               |
| GET  | `/import/runs`                              | `:253` | List runs.                                                 |
| GET  | `/import/runs/unpushed`                     | `:280` | Runs with parsed-but-unpushed data.                        |
| GET  | `/import/runs/active`                       | `:320` | The currently-running run, if any.                         |
| GET  | `/import/runs/:runId`                       | `:337` | One run with its stages.                                   |
| GET  | `/import/runs/:runId/recognized`            | `:358` | What that run recognized.                                  |
| POST | `/import/runs/:runId/cancel`                | `:387` | Cancel a run.                                              |
| POST | `/import/push`                              | `:417` | Push parsed data into memory.                              |
| POST | `/import/runs/:runId/push/retry`            | `:441` | Retry a failed push.                                       |
| POST | `/import/runs/:runId/stages/:stageId/retry` | `:457` | Retry one stage.                                           |

Import stage work is dispatched over **per-kind pg-boss queues** — `import-unpack`, `import-parse`, `import-media`, `import-push` (`domains/import/constants.ts` `IMPORT_STAGE_QUEUE_BY_KIND`). The old single `import-stages` queue (`IMPORT_QUEUE`, `constants.ts:33`) is kept as a **drain** for jobs an older release left queued, and its worker is still registered (`listeners/ImportStageListener.ts:169`). New work goes to the per-kind queues with **one exception**: when a stage's `kind` cannot be resolved — a deleted stage racing the enqueue — `ImportRunService.enqueueStage` falls back to `IMPORT_QUEUE` (`services/ImportRunService.ts:1485`), so `import-stages` does still receive new jobs on that path rather than dropping them.

### The other three import controllers

| Controller                        | Routes                                                                                                     | Purpose                                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ImportInboxController` (`:29`)   | GET `/import/inbox` (`:35`), POST `/import/inbox/runs` (`:42`)                                             | Scan a mounted folder the user drops export archives into, and start **one run per unit**. Everything in it is a copy the importer owns — **consumed by the run that claims it, deleted with the completed run**. Per-unit errors ride inside a **200** ("forty started, one was already claimed" is a result, not a failure). |
| `ImportUploadsController` (`:68`) | POST `/import/uploads` (`:109`), GET `/import/uploads` (`:168`), DELETE `/import/uploads/:dropId` (`:183`) | Multipart upload of an archive (this is the route `server.requestTimeout = 0` exists for), listing, and removal.                                                                                                                                                                                                               |
| `ImportDoctorController` (`:41`)  | GET `/import/doctor/checks` (`:53`), GET `/import/doctor` (`:69`)                                          | The post-import integrity checks and their results.                                                                                                                                                                                                                                                                            |

> The CLI counterpart is `ci`, whose run-listing command is **`runs`** (there is no `jobs` subcommand — that name belongs to the pg-boss operator page at `/jobs`). See [docs/cli/ci.md](../cli/ci.md).

---

## Personalization & context prompts

| Controller                                                                                                                                    | Verb · Path                                       | Purpose                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------- |
| `PersonalizationController` (`domains/personalization/controllers/PersonalizationController.ts:11`, class-level `JwtOrApiKeyAuthGuard` `:10`) | GET `/personalization/profile` (`:18`)            | The personalization profile.           |
|                                                                                                                                               | POST `/personalization/trust-mode` (`:25`)        | Set the autonomy/trust mode.           |
|                                                                                                                                               | GET `/personalization/image-description` (`:39`)  | Read the image-description preference. |
|                                                                                                                                               | POST `/personalization/image-description` (`:46`) | Set it.                                |
| `ContextPromptController` (`domains/personalization/controllers/ContextPromptController.ts:11`, class-level guard `:10`)                      | GET `/context-prompts/pending` (`:18`)            | Prompts awaiting an answer.            |
|                                                                                                                                               | POST `/context-prompts/:id/respond` (`:28`)       | Answer one.                            |
|                                                                                                                                               | POST `/context-prompts/:id/skip` (`:48`)          | Skip one.                              |

---

## Jobs / Audit / Onboarding / Feature flags / Health

| Controller                                                                                                         | Verb · Path                                                                                                | Auth                                                                                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JobsController` (`domains/events/controllers/JobsController.ts:69`)                                               | GET `/jobs/dashboard` (`:77`)                                                                              | `JwtOrApiKeyAuthGuard`                                                                         | pg-boss job-monitor dashboard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `JobsController`                                                                                                   | GET `/jobs` (`:130`)                                                                                       | `JwtOrApiKeyAuthGuard`                                                                         | The queryable job list behind the dashboard table. Optional filters compose; `state` accepts pg-boss's own states **plus the synthetic `dead-letter`**, which selects the DLQ copies (they are stored as `created`, so without it they are unfindable).                                                                                                                                                                                                                                                                                                   |
| `JobsController`                                                                                                   | GET `/jobs/history` (`:160`)                                                                               | `JwtOrApiKeyAuthGuard`                                                                         | Job history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `JobsController`                                                                                                   | GET `/jobs/types` (`:246`)                                                                                 | `JwtOrApiKeyAuthGuard`                                                                         | Distinct job types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `JobsController`                                                                                                   | GET `/jobs/controls`                                                                                       | `JwtOrApiKeyAuthGuard` + `@RequireCapability('read')`                                          | The persisted operator controls, plus the defaults and ceilings needed to render them honestly. Appliance-wide, not per-user.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `JobsController`                                                                                                   | POST `/jobs/crons/run`                                                                                     | `JwtOrApiKeyAuthGuard` + `ApplianceAdminGuard` + `@RequireCapability('full')`                  | Fire every Nest `@Cron` (or one named via `?name=`) the way the scheduler would. `full`, not `write`, because the set is every registered schedule — including `AccountPurgeCron.purgeDueAccounts`, which permanently deletes accounts. Formerly unguarded and "loopback-only" via `request.socket.remoteAddress`, which is the immediate peer: both proxies in this repo (dev Caddy, Vite `/api`) dial the API on localhost, so any caller on the network passed it.                                                                                     |
| `JobsController`                                                                                                   | PUT `/jobs/controls`                                                                                       | `JwtOrApiKeyAuthGuard` + `ApplianceAdminGuard` + `@RequireCapability('write')`                 | A PUT that behaves like a PATCH: names only the controls it changes. `write`, not `full` — nothing here deletes and every value is reversible.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `JobsController`                                                                                                   | POST `/jobs/clear`                                                                                         | `JwtOrApiKeyAuthGuard` + `ApplianceAdminGuard` + `@RequireCapability('full')`                  | Delete terminal jobs named by a Health verdict. `full`, not `write`, because it is a hard `DELETE` and `write` is defined as "mutating, but nothing that deletes" — and `write` is also `DEFAULT_API_KEY_CAPABILITY`. `dead-letter` deletes ONLY letters `DeadLetterReaperListener` has already copied into `ci.pipeline_dead_letters` and returns the rest as `retained`; `failed` deletes from `pgboss.archive` as well as `pgboss.job`, because the count it retires spans both.                                                                       |
| `AuditController` (`:23`, class-level `JwtOrApiKeyAuthGuard` `:24`)                                                | GET `/audit/forward-auth/whoami` (`:41`)                                                                   | **Both**: `JwtOrApiKeyAuthGuard` (class, `:24`) **then** `HubForwardAuthGuard` (method, `:42`) | Echo the verified Hub forward-auth username (HMAC `X-CI-Hub-User`). Nest **concatenates** guards `[global, class, method]` (`@nestjs/core` `helpers/context-creator.js` `createContext`, run in order by `GuardsConsumer`); a method-level guard does **not** override a class-level one. So the class guard runs first and 401s any caller without a JWT/API key before the signature is ever checked — a valid session or API key is required **in addition to** the signed header. The source comment at `:38-39` calls it an override; that is wrong. |
| `AuditController`                                                                                                  | GET `/audit/deltas` (`:53`)                                                                                | `JwtOrApiKeyAuthGuard`                                                                         | Entity-evolution deltas (`entityId`, `limit`, `changeType`, `since`/`until`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `OnboardingController` (`:15`)                                                                                     | GET `/onboarding/progress` (`:20`), PUT `/onboarding/progress` (`:26`), POST `/onboarding/onboard` (`:35`) | **`JwtAuthGuard`** (session only)                                                              | Read/save onboarding progress; run onboarding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PythonFunctionCallbackController` (`domains/python-functions/controllers/PythonFunctionCallbackController.ts:17`) | POST `/function-runs/callback` (`:27`)                                                                     | `JwtOrApiKeyAuthGuard`                                                                         | Completion webhook for the pg-boss-dispatched Python functions (`/functions/run` in the summary and HBPE services). **204**.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `FeatureController` (`:7`)                                                                                         | GET `/_internal/features` (`:12`)                                                                          | **`JwtAuthGuard`**                                                                             | All feature flags (session required). **200**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `FeatureController`                                                                                                | GET `/_internal/features/global` (`:20`)                                                                   | **None — public**                                                                              | All feature flags, no auth (gates the app before login). **200**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `HealthController` (`common/controllers/HealthController.ts:5`)                                                    | GET `/health` (`:7`)                                                                                       | **None — public**                                                                              | Liveness probe. **200** `{ status: 'ok' }`. Pure liveness — does **not** check DB/Ollama/MinIO.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GraphQLController` (`domains/graphql/controllers/GraphQLController.ts:5`)                                         | GET `/graphiql` (`:12`)                                                                                    | **None — public**                                                                              | The GraphiQL IDE page, inlined as a string so it ships in the `tsc` `dist`. Deliberately kept **off** `/graphql` so it never collides with the Apollo mount.                                                                                                                                                                                                                                                                                                                                                                                              |

> **`ApplianceAdminGuard` is the principal axis, and `@RequireCapability` is not it.** > `enforceApiKeyCapability` returns early when `request.apiKeyScopes` is `undefined`
> — every JWT, Portal and session principal — so a capability alone leaves an
> appliance-wide route open to any signed-in user. The guard requires
> `role === 'admin'`, and admits a non-admin only on an appliance that has **no**
> admin at all, because nothing in application code writes that role (see
> `AdminOnlyGuard`'s doc and migration `20260825233952`). Both are needed: the
> capability is the only control on an appliance with no admin, and the guard is
> the only control on a session.

---

## What the importer drives during a run

CI-Server's own native import domain (`backend/apps/api/src/domains/import/`) drives this
flow **in-process** today — it is not an external client. The sequence below was originally
verified against the now-retired CI-Import-Tools (renamed `ZARCHIVED-CI-Import-Tools`) and
still documents the REST/GraphQL contract any importer client uses. Prefer **REST `/v1/*`**
when the server advertises it (`GET /v1/ingest/status`); GraphQL bulk mutations remain the
fallback for older servers.

1. **Data push (REST `/v1/*`, preferred):** NDJSON batches to `/v1/{communications,contents,things,browser-activity,positions,receipts,product-models,observations}`, dedup on the source triple; `/v1/events` and `/v1/notes` take the JSON envelope instead — they have no NDJSON lane. Falls back to GraphQL `create*` mutations when `/v1` is unavailable.
2. **Media (REST):** binary upload → **`POST /v1/files`** (or `/files/upload`), then links the returned `{id}` into records.
3. **Post-push enrichment:** `POST /v1/ingest/finish` (`searchIndexOnly` / staged orchestration) when available; otherwise `api/maintenance/*` (`orchestrate` or the per-leg chain ending in `search-index/backfill`). A `browser-activity`-scoped search backfill also indexes dual-written `event` + `content` rows on the server.
4. **Graph sync (GraphQL):** entities + relationships via `bulkIngestGraph`, and item↔item edges (email→attachment, photo→album) via `bulkIngestItemRelationships`.
5. **Embed-drain progress (REST):** polls ingest status / embedded-count endpoints to animate the drain bar (best-effort).

> **Destination ordering matters.** The in-process push writes destinations in the order
> `product_models → communications → events → content → receipts → things → observations → browser_activity → position`
> (`domains/import/stages/PushStage.ts:152-159`). `events` comes **before** `content` because
> `ContentService.createManyDetailed` resolves `ci.content.event_id` from the provenance triple
> at INSERT time — writing content first left that column NULL for every row of every import.

---

## Cross-cutting conventions

- **Auth default:** `JwtOrApiKeyAuthGuard` on virtually all data routes; `ApiKeyGuard` on agent `/memory/*`; `JwtOrPortalAuthGuard` on `/keys`; `JwtAuthGuard` on human-only (`/onboarding/*`, `/_internal/features`); `HubForwardAuthGuard` stacked _after_ `JwtOrApiKeyAuthGuard` on `/audit/forward-auth/whoami`; `ConnectRequestAuthGuard` on the three `/connect` S2S routes. The unauthenticated list is in [Auth guards](#auth-guards-commonguards-domainsauthguards) above.
- **Validation:** zod schemas via a shared `ValidationPipe` (`@ci/common/pipes`); a schema failure → 400 before the handler runs.
- **Deletes** return **204**; **conflicts** (dup unique keys, or an operation already in flight) return **409**; **missing resources** return **404**. A flag-gated-off surface returns **404** (Solid) or **503** (peer asks, PowerSync), deliberately — "no such route" rather than "route exists but is closed".
- **Streaming** lives in three places: maintenance NDJSON progress streams (opt-in via `?stream=1` / `Accept: application/x-ndjson`), the `/llm` chat broker (`POST /llm/generate`, `GET /llm/threads/:threadId/stream`), and the account portability export/import streams. Everything else is plain JSON.

---

_Route catalog, guards, scopes/capabilities and every `file:line` citation re-verified against `backend/apps/api/src` on **2026-08-19**._

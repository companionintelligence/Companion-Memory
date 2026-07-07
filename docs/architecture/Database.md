# Database Architecture

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**
>
> Last verified against the migration set on **2026-07-06**
> (`backend/apps/api/db/postgres/migrations/`, 159 files). The hand-written SQL
> migrations are the **source of truth** for the schema; the TypeORM entities under
> `backend/apps/api/src/domains/*/entities/` must be kept in sync with them — see
> [Migration workflow](#migration-workflow).
>
> Related: [API reference](../api/README.md) ·
> [GraphQL bulk-ingest contract](../api/graphql.md#47-bulk-ingest-mutations-the-importer-surface--detailed) ·
> [Bulk load runbook](../../backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md) ·
> [Ingest reset runbook](../../backend/apps/api/db/postgres/INGEST_RESET_RUNBOOK.md)

## Engine & extensions

PostgreSQL **18.4** with **TimescaleDB 2**, **pgvector**, and **PostGIS 3**, built in
[`infrastructure/database/Dockerfile`](../../infrastructure/database/Dockerfile)
(`postgres:18.4-bookworm` + `postgresql-18-postgis-3`, `postgresql-18-pgvector`,
`timescaledb-2-postgresql-18`; started with `shared_preload_libraries=timescaledb`).

- **UUIDv7 primary keys** use PG18's native `uuidv7()` builtin — no extension
  (migration `20260611030000_use_native_uuidv7.sql`; `ci.gen_uuid_v7()` wraps it).
- There is **no Apache AGE** graph extension. The knowledge graph is plain relational
  tables (`ci.entities` + `ci.relationships`) — older diagrams that show AGE are historical.
- The job queue is **PGBoss**, living in the same instance under the `pgboss` schema
  (migration `20251001000000_setup_pgboss_schema.sql`).

## Schemas

| Schema | Purpose |
|---|---|
| **`ci`** | All core personal data: timeline records, the knowledge graph, conversations, intelligence, connectors, auth. Tables were consolidated here by `20251214211043_move_ci_tables_to_ci_schema.sql`. |
| **`ci_search`** | The search index: `embeddings` (pgvector, 768-dim), `vectors` (tsvector), `index_skips` (permanent skip markers), `tags` + `entity_tag` (user tag vocabulary + membership). |
| **`ci_etl`** | Connector sync bookkeeping: `connection_sync_jobs` (`20260210182932_create_sync_jobs.sql`). |
| **`hbpe`** | Behavioral-prediction engine state, read/written by the Python sidecar (`backend/apps/hbpe`): `token_stream`, `l1_clusters`/`l2_clusters` + pending pools, `prediction_log`, `content_context`, vocab/labeling logs (`20260227000001_hbpe_all_tables.sql`). |
| **`pgboss`** | PGBoss job queue tables (jobs, archive, schedules, queues). |

> `ci_core` is vestigial: it briefly held `users`/`connections`/`providers` in Oct 2025;
> everything was moved into `ci` in Dec 2025.

## Key tables by domain

All tables are user-scoped (a `user_id` / `owner_user_id` column) unless noted.
Authoritative column lists live in the migrations and the matching TypeORM entities.

### Timeline & capture (the bulk-ingest destinations)

| Table | What it holds | Entity |
|---|---|---|
| `ci.events` | Timeline events (calendar, photos-as-events, captures) — PostGIS coordinates, provenance, participants, confidence | `memory/entities/EventEntity.ts` |
| `ci.communications` | Email/SMS/chat/calls — **TimescaleDB hypertable**, see [Hypertables](#hypertables) | `memory/entities/CommunicationEntity.ts` |
| `ci.communications_source_dedup` | Companion idempotency table for the hypertable — see [Idempotency](#idempotency--dedup-design) | — |
| `ci.content` | Rich content records (articles, media payloads), optional link to an event | `memory/entities/ContentEntity.ts` |
| `ci.inventory` | Items the user owns | `memory/entities/ItemEntity.ts` |
| `ci.browser_activity` | Page visits from the browser extension | `browser-activity/entities/BrowserActivityEntity.ts` |
| `ci.capture_events` | Append-only raw capture log behind `POST /v1/events`, soft link to the materialized `ci.events` row (`20260621021634`) | — |
| `ci.files` | File metadata (MinIO-backed objects, previews) | `files/entities/FileEntity.ts` |
| `ci.notes` | First-class user notes | `notes/entities/NoteEntity.ts` |

### Knowledge graph

| Table | What it holds |
|---|---|
| `ci.entities` | Graph nodes — one physical table, **single-table-inheritance** discriminated by `entity_type` (`Person`, `Place`, `Concept`, `Thing`, `File`, …; see `memory/entities/BaseEntity.ts`). Each row carries a mutable **JSONB `properties`** bag. |
| `ci.relationships` | Directed, typed edges between entities (`PREFERS`, `KNOWS`, `LIVES_IN`, …) with their own JSONB `properties`; unique on the directed `(from_entity_id, to_entity_id, relationship_type)` while active (`relationships_unique_directed_idx … WHERE is_active = TRUE`). |
| `ci.entity_identifiers` | Normalized email/phone identifiers per entity (`20260624140000`) — powers communications↔people linking. Unique on `(owner_user_id, kind, value_normalized)`. |
| `ci.item_relationships` | Item↔item edges (email→attachment, photo→album) keyed by **provenance triples on both endpoints**, table-agnostic (`20260707000001`). |
| `ci.graph_deltas` | Audit log of graph changes (`audit/entities/DeltaEntity.ts`). |

**The `properties` JSONB convention.** Entities and relationships store most of their
information in a mutable JSONB `properties` field (e.g. a Person's
`{"first_name": "John", "occupation": "Software Engineer"}`, a `PREFERS` edge's
`{"strength": 0.8, "since": …}`). JSONB is queryable, so this stays searchable — but it is
totally mutable, so **the onus is on application-layer code to use consistent field names**
within each entity type. Retain as much source data as possible; let the sub-schemas evolve
with the user.

**Where to put what — `entities` vs. `inventory`.** If the user owns an item, it belongs in
`ci.inventory`; it *additionally* becomes a graph entity only when the user has a real
relationship with it (the heirloom car gets an entity; a box of screws does not). The same
pattern holds for files: `ci.files` records every known file, and only emotionally
significant ones also get a `File` entity in the graph.

### Conversations & intelligence

`ci.threads` / `ci.messages` (chat; messages carry their own `message_embedding` vector +
FTS index), `ci.questions` / `ci.answers` (the "ask my memory" surface), `ci.actions`
(suggestion cards), `ci.summaries` (period rollups), `ci.feed_queue`.

### Connectors, auth, misc

`ci.providers` / `ci.connections` / `ci.provider_keys` (OAuth connector catalog +
instances), `ci_etl.connection_sync_jobs`; `ci.users`, `ci.sessions`, `ci.signup_code`,
`ci.api_keys`; `ci.devices`, `ci.position` (GPS/relative-coordinate **hypertable**, supports
AR headpose), `ci.geocode_cache` (`20260622120000`), `ci.saved_searches` (captured explorer
`filters` JSONB + `is_public`/`share_token` sharing — see
[saved-search-sharing.md](../saved-search-sharing.md)), `ci.agent_memories`.

### Dropped tables (historical)

`measurements`, `sensors`, `documents`, `document_chunks`, `facts`, `goals`, `habits`,
`voice_recordings`, `activities`, `screen_captures`, and the pre-graph `people`/`places`/
`contacts`/`things`/`locations` tables were all removed
(`20251006113900_prune_old_tables.sql`, `20260212191500_drop_unused_tables…`,
`20260213131500_drop_screen_captures_and_sensors.sql`). Older docs describing the
documents→chunks→facts pipeline or the devices→sensors→measurements hierarchy refer to
these dead tables.

## Idempotency & dedup design

Every capture/import record carries the **provenance triple**
`(source_type, source_system, source_id)`. Re-ingesting the same triple must be a no-op
(find-or-return), enforced in SQL by partial unique indexes and set-based
`INSERT … ON CONFLICT` (see `common/persistence/bulkUpsert.ts` —
`bulkInsertIdempotent`). The convention is documented from the API side in
[auth-and-conventions.md §4.5](../api/auth-and-conventions.md#45-provenance-triple-idempotency-convention)
and [graphql.md §4.7](../api/graphql.md#47-bulk-ingest-mutations-the-importer-surface--detailed).

| Table | Idempotency arbiter | Migration |
|---|---|---|
| `ci.events` | `events_source_triple_uniq (source_type, source_system, source_id) WHERE source_id IS NOT NULL` — note: **no user scope** | `20260620213807` |
| `ci.content` | `content_source_triple_uniq (user_id, + triple) WHERE source_id IS NOT NULL` | `20260623120300` |
| `ci.inventory` | `inventory_source_triple_uniq (owner_user_id, + triple) WHERE source_id IS NOT NULL` | `20260623120000` |
| `ci.browser_activity` | `browser_activity_source_triple_uniq (user_id, + triple) WHERE source_id IS NOT NULL` | `20260623120200` |
| `ci.communications` | **companion table** `ci.communications_source_dedup`, PK `(user_id, source_type, source_system, source_id)` — see below | `20260702012519` |
| `ci.entities` | `entities_linked_uniq (owner_user_id, entity_type, linked_table, linked_id) WHERE linked_table IS NOT NULL` — importer-stable graph upserts | `20260621020120` |
| `ci.capture_events` | `UNIQUE (user_id, source_system, source_id)` | `20260621021634` |
| `ci.item_relationships` | `item_relationships_edge_uniq (user_id, from-triple, to-triple, relation)` | `20260707000001` |
| `ci_search.embeddings` / `ci_search.vectors` | `UNIQUE (entity_type, entity_id)` — index writes are upserts | `20251210022334` / `20251210040404` |

**Why communications is special.** `ci.communications` is a hypertable, and TimescaleDB
requires every UNIQUE index to include the partition column (`time`) — which breaks pure
triple dedup (the same message re-imported with a corrected timestamp would duplicate). The
old `communications_source_triple_uniq` index (which had to include `time`) was **dropped**
and replaced by the non-hypertable `ci.communications_source_dedup` table keyed on the pure
triple, with a soft pointer (`communication_id`, `communication_time`) back to the canonical
row. An `AFTER DELETE` trigger on the hypertable removes the dedup row so a deleted
communication can be re-ingested. **Gotcha:** `TRUNCATE` does *not* fire that per-row
trigger — truncating `ci.communications` without truncating the dedup table in the same
statement leaves poison rows that silently swallow the next re-import (see the
[ingest reset runbook](../../backend/apps/api/db/postgres/INGEST_RESET_RUNBOOK.md)).
The communications path is also the only one that **self-heals** selected source-derived
columns on conflict (`ON CONFLICT … DO UPDATE`; the per-entity contract is
`INGEST_REFRESH_COLUMNS` in `common/persistence/ingestRefreshColumns.ts`).

## Indexing

| Kind | Index | Purpose |
|---|---|---|
| **pgvector HNSW** | `ci_search.embeddings_embedding_hnsw_idx` (`hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL`, `20260701120100`) | ANN semantic search — the primary vector read path and the single most expensive index to maintain during bulk loads |
| **pgvector HNSW** | `ci.messages_embedding_idx` | chat-message semantic search |
| **GIN (tsvector)** | `ci_search.vectors_vector_gin_idx` (`20260704030000`) | full-text search over the unified index |
| **GIN (tsvector)** | `entities_fts_idx`, `messages_fts_idx` | per-table FTS |
| **GIN** | `communications_to_idx` on `to_entity_ids` | recipient membership |
| **GIST** | `events_location_coordinates_gix` (`(location_coordinates::geometry) WHERE … IS NOT NULL`, `20260621120000`) | map/bbox queries |
| **btree hot paths** | `events_user_time_idx (user_id, start_time DESC)`, `ci_search.embeddings_user_id_idx` (`20260701120000`), `capture_events_kind_idx` | timeline reads, per-user embed coverage scans |
| **partial unique** | the provenance-triple arbiters above | idempotency |

For very large imports, the expensive secondary indexes (FTS GIN + HNSW + the
communications/events secondaries) can be **dropped and rebuilt around the load** via the
opt-in deferral helper (`maintenance/services/IndexDeferralService.ts`,
`POST /api/maintenance/indexes/drop|recreate`). Unique/constraint indexes are hard-guarded
against dropping. See the
[bulk load runbook](../../backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md).

## Hypertables

Two TimescaleDB hypertables remain (the others — `measurements`, `event_history`,
`activities` — were dropped with their features):

| Table | Partitioning | Compression policy |
|---|---|---|
| `ci.communications` | `create_hypertable('communications', 'time', 'user_id', 4)` | columnar after **30 days** |
| `ci.position` | `create_hypertable('position', 'time', 'user_id', 4)` | columnar after **7 days** |

Notes:

- `ci.communications` has a **surrogate composite PK** `(time, user_id, id)`
  (`20260624130000`) — the `id` is a `uuidv7()`, and the triple-dedup invariant lives in the
  companion table, not a hypertable index (see above).
- Every UNIQUE index on a hypertable must include the partition column — this constraint is
  why the dedup companion table exists.
- Inserting into already-compressed chunks (older than the policy window) is slow; deep
  historical backfills should pause/re-add the compression policy — procedure in the
  [bulk load runbook §4](../../backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md#4-timescaledb-aware-loading).

## Search index & deferred indexing

`ci_search.embeddings` (768-dim `nomic-embed-text` vectors) and `ci_search.vectors`
(tsvector) are populated **asynchronously** by the `search-index` PGBoss queue listeners
(`domains/search-ingress/listeners/*SearchIndexListener.ts`), keyed `(entity_type,
entity_id)`. `ci_search.index_skips` (`20260701000000`) records rows deliberately skipped
(e.g. no indexable text) so backfills don't re-attempt them forever.

Two write modes feed the queue:

- **Interactive creates** (single-row `createX` mutations / REST) emit a per-row
  `*CreatedEvent` → indexed live.
- **Bulk ingest** (the GraphQL list mutations the importer uses) suppresses per-row events
  (`emitCreated:false`) for throughput; rows become searchable only after the post-load
  sweep `POST /api/maintenance/search-index/backfill` re-emits create events for rows with
  no index entry. See
  [graphql.md §4.7](../api/graphql.md#47-bulk-ingest-mutations-the-importer-surface--detailed)
  and [rest.md — maintenance](../api/rest.md#maintenance--enrichment--apimaintenance--domainsmaintenancecontrollersmaintenancecontrollerts374).

The **768 dimension is hard-coupled** across the schema (`VECTOR(768)` columns) — swapping
to a different-dimension embedding model breaks the vector store (see
[hub-inference-integration.md](hub-inference-integration.md)).

## Migration workflow

Migrations are **dbmate-style hand-written SQL** in
`backend/apps/api/db/postgres/migrations/` — `-- migrate:up` / `-- migrate:down` blocks,
timestamp-prefixed filenames, applied state tracked in dbmate's `schema_migrations` table.

```bash
# from backend/apps/api (or via the root Makefile: make migrate)
yarn migrate:make <name>    # create a new migration file (offline)
yarn migrate                # check versions + dbmate up
yarn migrate:down           # roll back the last migration
yarn dbshell                # psql into the configured database
```

Rules:

1. **SQL first.** The migration is the source of truth. After changing the schema, update
   the matching TypeORM entity so reads/writes agree — entities never auto-migrate the
   schema.
2. `yarn migrate` runs `scripts/check-migration-versions.ts` before `dbmate up`; CI runs a
   migration-integrity check on PRs that touch `db/postgres/migrations/`.
3. The dbmate wrapper (`bin/dbmate.js`) builds the connection URL from the same
   `node-config` `db` block the API uses, and refuses destructive `--execute-file` scripts
   without confirmation.
4. Destructive resets during development: `make dbclear` (data only) / `make dbdestroy`
   (tables too) from the repo root.

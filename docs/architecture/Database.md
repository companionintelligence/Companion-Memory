# Database Architecture

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**
>
> Last verified against the migration set on **2026-08-19**
> (`backend/apps/api/db/postgres/migrations/`, 282 files). The hand-written SQL migrations
> are the **source of truth** for the schema; the TypeORM entities under
> `backend/apps/api/src/domains/*/entities/` must be kept in sync with them — see
> [Migration workflow](#migration-workflow). Schema consolidation status:
> [schema-consolidation.md](./schema-consolidation.md).
>
> Related: [API reference](../api/README.md) ·
> [GraphQL bulk-ingest contract](../api/graphql.md#47-bulk-ingest-mutations-the-importer-surface--detailed) ·
> [Bulk load runbook](../../backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md) ·
> [Ingest reset runbook](../../backend/apps/api/db/postgres/INGEST_RESET_RUNBOOK.md)

## Engine & extensions

PostgreSQL **18.4** with **TimescaleDB 2**, **pgvector**, and **PostGIS 3**, built in
[`infrastructure/database/Dockerfile`](../../infrastructure/database/Dockerfile)
(`postgres:18.4-bookworm` + `postgresql-18-postgis-3`, `postgresql-18-pgvector`,
`timescaledb-2-postgresql-18`).

The server is started with four load-bearing settings, all in the image's `CMD`:
`shared_preload_libraries=timescaledb` (required for Timescale at all),
`max_connections=200` (the API runs a TypeORM pool *and* a separate pg-boss pool,
alongside the Python sidecars), and `wal_level=logical` with
`max_replication_slots=10` / `max_wal_senders=10` (logical replication, which the
PowerSync service consumes). The two sets are independent — dropping either breaks
something different.

Extensions are created by the `setup-database` one-shot
([`infrastructure/setup-database/entrypoint.sh`](../../infrastructure/setup-database/entrypoint.sh)):
`timescaledb`, `postgis`, `vector`, `pg_stat_statements`, `btree_gist`. `uuid-ossp`
comes from a migration instead.

- **UUIDv7 primary keys** use PG18's native `uuidv7()` builtin — no extension.
  `ci.gen_uuid_v7()` (the default for 50 tables) wraps it as of
  `20260930141141_fix_ci_gen_uuid_v7_native_uuidv7.sql`. The earlier
  `20260611030000_use_native_uuidv7.sql` replaced the name unqualified, so it only created a
  twin, `public.gen_uuid_v7()`, which 12 tables default to. Until the fix, `ci.gen_uuid_v7()`
  silently minted **UUIDv4**: rows it minted on the PG18 image, and every row an older migration
  seeds on a fresh install (most of `ci.questions`), carry random ids. Never read id order as
  creation order — order by a timestamp.
- There is **no Apache AGE** graph extension, and no code anywhere references one.
  The knowledge graph is plain relational tables (`ci.entities` + `ci.relationships`)
  — older diagrams that show AGE are historical.
- The job queue is **PGBoss**, living in the same instance under the `pgboss` schema
  (migration `20251001000000_setup_pgboss_schema.sql`). It is the appliance's **only**
  scheduler; the Temporal orchestrator was removed in Aug 2026.

## Schemas

| Schema | Purpose |
|---|---|
| **`ci`** | All core personal data: timeline records, the knowledge graph, conversations, intelligence, connectors, auth, the pipeline ledger. Tables were consolidated here by `20251214211043_move_ci_tables_to_ci_schema.sql`. |
| **`ci_search`** | The search index: `embeddings` (pgvector, 768-dim), `vectors` (tsvector), `index_skips` (permanent skip markers), `tags` + `entity_tag` (user tag vocabulary + membership). |
| **`ci_import`** | Importer staging (`20260810164304_create_ci_import_schema.sql`): `import_runs`, `import_stages`, `staged_sources`, `staged_items`, `staged_entities`, `staged_relationships`, `entity_mappings`. Rows land here first and are promoted into `ci.*` by the push stage. |
| **`ci_derived`** | Computed, re-derivable analytics: `daily_metrics` (`20260817180000`), the place tables `place_clusters` / `place_transitions` / `place_forecast_log` (`20260817200000`), and the findings tables `metric_anomalies` / `metric_correlations` / `metric_suggestions` / `suggestion_arms` (`20260817210000`). Everything here is a *derivation* of `ci.*` — safe to recompute. |
| **`ci_etl`** | Connector sync bookkeeping: `connection_sync_jobs` (`20260210182932_create_sync_jobs.sql`). |
| **`hbpe`** | Behavioral-prediction engine state, read/written by the Python sidecar (`backend/apps/hbpe`): `token_stream`, `l1_clusters`/`l2_clusters` + pending pools, `prediction_log`, `content_context`, vocab/labeling logs (`20260227000001_hbpe_all_tables.sql`), plus `occurrence_log` + `recurrence_profiles` (`20260808150000`) and `prediction_score` (`20260817190000` — the accuracy loop that scores each issued forecast against the observed outcome). |
| **`pgboss`** | PGBoss job queue tables (jobs, archive, schedules, queues). |

> `ci_core` is vestigial: it briefly held `users`/`connections`/`providers` in Oct 2025;
> everything was moved into `ci` in Dec 2025.

## Key tables by domain

All tables are user-scoped (a `user_id` / `owner_user_id` column) unless noted.
Authoritative column lists live in the migrations and the matching TypeORM entities.

### Timeline & capture (the bulk-ingest destinations)

| Table | What it holds | Entity |
|---|---|---|
| `ci.events` | Timeline events (calendar, photos-as-events, captures, planned blocks) — PostGIS coordinates, provenance, participants, confidence. **CTI detail table**: every row requires a `ci.entities` `'Event'` base row sharing its uuid | `memory/entities/EventEntity.ts` (+ `EventBaseEntity.ts`) |
| `ci.communications` | Email/SMS/chat/calls — **plain table** (de-hypertabled; see [Hypertables](#hypertables)). **CTI detail table** (`'Communication'`) | `memory/entities/CommunicationEntity.ts` (+ `CommunicationBaseEntity.ts`) |
| `ci.content` | Rich content records (articles, media, web pages), optional FK to an event (`content.event_id`). **CTI detail table** (`'Content'`) | `memory/entities/ContentEntity.ts` (+ `ContentBaseEntity.ts`) |
| `ci.objects` | The owned **units** — one row per physical thing, with `product_id` pointing at the catalog model. **CTI detail table** (`'Item'`) | `memory/entities/ItemEntity.ts` (+ `ItemBaseEntity.ts`) |
| `ci.browser_activity` | Page visits from the browser extension — **the sole home for them**. Wave D folded these into `ci.events` (`view`) + `ci.content` (`web-page`) on 2026-08-08 and that was **reverted** four days later (`20260812144811`): page views are not timeline events — the fold flooded the schedule calendar and silently changed the HBPE training corpus. `BrowserActivityService` no longer dual-writes | `browser-activity/entities/BrowserActivityEntity.ts` |
| `ci.capture_events` | Append-only raw capture log behind `POST /v1/*`, soft link to the materialized row (`20260621021634`) | — |
| `ci.files` | File metadata (MinIO-backed objects, previews). Every uploaded file also gets a `'File'` graph entity — `FileService.handleFileUploaded` calls `findOrCreateForFile` on every `FileUploadedEvent` | `files/entities/FileEntity.ts` |
| `ci.file_chunks` | Extracted document text, chunked, from `domains/parsing` (MarkItDown extractor → chunker). Indexed under the `file-chunk` search type | `parsing/entities/FileChunkEntity.ts` |
| `ci.notes` | First-class user notes | `notes/entities/NoteEntity.ts` |

**Class-table inheritance (CTI).** Four detail tables — `events`, `communications`,
`content`, `inventory` — were converted in August 2026 (`20260811061402`,
`20260811061409`, `20260811061411`, `20260811200000`) so that each row *requires* a
`ci.entities` base row carrying the same uuid, discriminated by `entity_type`, behind a
`DEFERRABLE INITIALLY DEFERRED` composite FK on `(id, entity_type)` with
`ON DELETE CASCADE`. For `events` and `inventory` the base row is the **sole owner** of
both the title/name and the description — the detail-table copies were moved into it and
dropped, so a read composes the pair. For `content` only the title moved
(`20260811200000` drops `title` alone): `ci.content` never had a `description` column,
so there was none to move, and the backfill writes `NULL` into the base row's
`description` — where it stays, since `ContentService` only ever sets `name`.
`communications` is the exception: nothing was dropped there
(subject/content/preview/summary are domain data), and the base row's `name` is a
*derived* display label (subject → preview → a 140-char clip) that
`CommunicationService` re-derives on write. Either way, all four now land in the
`ci.entities` `search_vector` and so become findable in graph text search.

Graph-ingest rows of the same `entity_type` that carry a different
`linked_table` provenance (`import:<source>`) are **not** detail-table mirrors and
survive these rebuilds with their own ids and relationships.

### Knowledge graph

| Table | What it holds |
|---|---|
| `ci.entities` | Graph nodes — one physical table, discriminated by `entity_type`. The full vocabulary is `ENTITY_TYPES` in `memory/graph.types.ts`: `Person`, `Pet`, `Group`, `Concept`, `Location`, `Object`, `Event`, `Goal`, `File`, `Place`, `Contact`, `Content`, `Communication`, `Item`, `Thing`, `Product`, `Tag`. Typed columns for Person identity and Place geography (`location_point`, `location_boundary`, `place_kind`, `parent_place_id` — `20260803213950`) plus the merge tombstone `merged_into_entity_id` (`20260803211455`); remaining fields in mutable **JSONB `properties`**. |
| `ci.relationships` | Directed, typed edges between entities (`PREFERS`, `KNOWS`, `LIVES_IN`, …) with their own JSONB `properties`; unique on the directed `(from_entity_id, to_entity_id, relationship_type)` while active (`relationships_unique_directed_idx … WHERE is_active = TRUE`). The writable vocabulary is `RelationshipType` in `graph/types.ts`. |
| `ci.entity_identifiers` | Normalized email/phone identifiers per entity (`20260624140000`) — powers communications↔people linking. Unique on `(owner_user_id, kind, value_normalized)`. |
| `ci.object_identifiers` | The same idea for things: serials, GTINs, MACs and the rest, per owned unit or catalog model (`20260803223016`). Polymorphic `subject_type` (`object_instance` / `product_model`), deliberately FK-less. |
| `ci.identifier_claims` | Claims staged by the `enrich.person_link` pipeline stage before they become identifiers (`20260809183010`). |
| `ci.item_relationships` | Item↔item edges (email→attachment, photo→album) keyed by **provenance triples on both endpoints**, table-agnostic (`20260707000001`). |
| `ci.entity_merges` / `ci.merge_candidates` / `ci.entity_merge_blocks` | The merge machinery: an audit log of performed merges, the scored review queue written by the `clean.duplicate_detect` pipeline stage, and an entity-agnostic "never ask again" table. |
| `ci.graph_deltas` | Audit log of graph changes (`audit/entities/DeltaEntity.ts`), written **explicitly** by `GraphDeltaWriter` (memory domain), which joins the domain write's transaction and records `change_source` as a service name. Database triggers briefly wrote this table in Aug 2026 and were dropped two days later (`20260811210000`) — do not document them as current. |

**The `properties` JSONB convention.** Entities and relationships store most of their
information in a mutable JSONB `properties` field (e.g. a Person's
`{"first_name": "John", "occupation": "Software Engineer"}`, a `PREFERS` edge's
`{"strength": 0.8, "since": …}`). JSONB is queryable, so this stays searchable — but it is
totally mutable, so **the onus is on application-layer code to use consistent field names**
within each entity type. Retain as much source data as possible; let the sub-schemas evolve
with the user.

**Where to put what — `entities` vs. `objects`.** This used to read: an item becomes a
graph entity *only* when the user has a real relationship with it (the heirloom car gets
an entity; a box of screws does not), and only emotionally significant files get a `File`
entity. **Both halves stopped being true in August 2026.** Under CTI every `ci.objects`
row *requires* an `Item` base row in `ci.entities` (`objects_object_id_entities_fk`),
and that base row is the only place the item's name and description live — the same is
true of `ci.events`, `ci.communications` and `ci.content`. And
`FileService.handleFileUploaded` creates a `File` entity for **every** uploaded file.

What survives of the old heuristic is the softer judgement it was really making: which
things deserve *relationships*, identifiers and product links — not which things get a
row. A `ci.objects` unit points at its catalog model through the plain
`objects.product_id` column, **not** through a graph edge; `INSTANCE_OF`,
`PURCHASED_AT`, `PURCHASED_FROM` and `SEEN_AT` exist only in the memory domain's
filter-side `RELATIONSHIP_TYPES` mirror and cannot be written by `RelationshipService`.

### Conversations & intelligence

`ci.threads` / `ci.messages` (chat; the FTS index `messages_fts_idx` is live, but the
per-row `message_embedding` vector column and its HNSW index were **dropped** in
`20260213113000` — message vectors live in `ci_search.embeddings` like everything
else), `ci.questions` / `ci.answers` (the "ask my memory" surface — the *product* name
for it is now **Reflections**; the tables, GraphQL types and REST routes still say
`question`), `ci.actions` (suggestion cards), `ci.summaries` (period rollups),
`ci.feed_queue`, `ci.context_prompts` (`20260816010000`).

> **The reflections catalogue is a shared seed set.** `20260818235602` replaced the
> abstract catalogue with a curated one carrying an `answer_tier`
> (`factual` / `preference` / `narrative`), so the product can ask functional questions
> before reflective ones. Seed rows (`is_seed_question`, `is_private_to IS NULL`) are
> **read-only** to a user: an edit mints a private copy owned by them
> (`is_private_to = <them>`, `forked_from_question_id` → the origin, `20260819051642`),
> and the origin is filtered out of that user's selections. Retiring a question sets
> `is_active = false` rather than deleting it, because `ci.answers` and `ci.feed_queue`
> cascade off `ci.questions` — which is also why the fork edge is `ON DELETE SET NULL`
> and not `CASCADE`. **Any new user-scoped `ci.questions` selector must carry
> `excludeForkedOriginsSql`** (`domains/intelligence/questionScope.ts`), or retired
> reflections come back.
>
> **Never order the catalogue by `question_id`.** The seeded rows carry random v4 ids on
> every fresh install and share one `created_at` per seed batch, so id order is a
> different shuffle on every appliance. `seed_position` (`20260930153606`) records the
> order the seed files list them; the inference rotation takes the catalogue round-robin
> across categories in that order, from `domains/intelligence/questionOrder.ts`, and a
> migration that seeds more questions should write `seed_position` too.

### Commerce & object identity

`ci.product_models` (the catalog **model**), `ci.receipts` + `ci.receipt_line_items`
(acquisition provenance, and the source `ObjectMintService` mints units from), and
`ci.object_observations` (sightings, resolved back to owned units by
`ObjectResolutionService`). These are **no longer pre-implementation**: PR
[#2176](https://github.com/companionintelligence/CI-Server/pull/2176) landed the
services, a GraphQL surface (`productModels`, `receipts`,
`itemDuplicates`, `unresolvedObservations`, `objectByIdentifier`, `mergeItems`,
`mergeProductModels`, `linkItemToProduct`, …) and three `/v1` ingest lanes
(`/v1/receipts`, `/v1/product-models`, `/v1/observations`). Merges are audited in
`ci.entity_merges` under the entity types `ObjectInstance` and `ProductModel`, keeping
the unit-vs-model distinction. This section previously described the tables as
"pre-implementation — schema present, product surface not shipped".

### Background work & operations

`ci.pipeline_state` (the versioned enrichment ledger — see
[Search index & deferred indexing](#search-index--deferred-indexing)),
`ci.pipeline_runs` / `ci.pipeline_shards` / `ci.pipeline_turns` /
`ci.pipeline_dead_letters` / `ci.pipeline_schedule` / `ci.record_rejections`
(the control plane, `20260809032723` + `20260809194756` + `20260810050759`);
`ci.job_metrics` (`20260817030000`) and `ci.cron_runs` (`20260818130100`) behind the
operator Jobs page; `ci.activity_rollup` (`20260724033417`);
`ci.tasks` / `ci.task_dependencies` / `ci.task_pending_changes` and
`ci.event_candidates` / `ci.rhythms` (planning + schedule); `ci.account_purges`
(`20260813223114`, the deferred hard-delete queue behind `DELETE /account`).

### Federation

`ci.asks` / `ci.ask_grants` / `ci.ask_answers` / `ci.ask_audit` (the interpersonal
Ask and the standing consent grants that gate it), `ci.federated_identities`
(`20260803233730`) and `ci.peer_links` (`20260803233731`), and `ci.connect_codes`
(`20260708115548` — short-lived single-use authorization codes for the app-connect
flow; CI-Hub exchanges the code server-to-server and the API key is minted then,
never at consent time). The old device-pairing table `ci.pairings` used to sit here;
it and its whole backend were removed — see [Dropped tables](#dropped-tables-historical).

### Connectors, auth, misc

`ci.providers` / `ci.connections` / `ci.provider_keys` (OAuth connector catalog +
instances — Slack and Reddit were added on 2026-08-19), `ci_etl.connection_sync_jobs`;
`ci.users`, `ci.sessions`, `ci.signup_code`,
`ci.api_keys` (which carry both `scopes` and a `capability` of read/write/full);
`ci.devices`, `ci.position` (GPS/relative-coordinate **time-only
hypertable**, supports AR headpose),
`ci.geocode_cache` (`20260622120000`; gained a `bounds` JSONB in `20260819173404` so a
cached place keeps its footprint), `ci.saved_searches` (captured explorer
`filters` JSONB + `is_public`/`share_token` sharing — see
[saved-search-sharing.md](../saved-search-sharing.md)), `ci.agent_memories`.

### Dropped tables (historical)

`measurements`, `sensors`, `documents`, `document_chunks`, `facts`, `goals`, `habits`,
`voice_recordings`, `activities`, `screen_captures`, the pre-graph `people`/`places`/
`contacts`/`things`/`locations` tables, chat-agent `ci.agents` / `ci.agent_messages`,
and the communications hypertable companion `ci.communications_source_dedup` were
removed (`20251006113900_prune_old_tables.sql`, `20260212191500_drop_unused_tables…`,
`20260213131500_drop_screen_captures_and_sensors.sql`,
`20260807072321_dehypertable_communications.sql`,
`20260808150100_schema_consolidation.sql`). Older docs describing the
documents→chunks→facts pipeline, the devices→sensors→measurements hierarchy, or
the agents chat tables refer to these dead tables.

Note that **document parsing itself came back** — as `domains/parsing` writing
`ci.file_chunks` (`20260406000002`), not as the old `documents`/`document_chunks`/`facts`
chain. And `ci.promotion_candidates` was dropped in `20260816010000` when
`ci.context_prompts` replaced it. Also dropped but easy to mistake for current: the
`graph_deltas` **database triggers** (created `20260809182943`, dropped
`20260811210000` — an explicit service writer replaced them), and the Wave D
`browser_activity` → `events`/`content` fold (reverted `20260812144811`). Both are
shipped-then-reverted pairs; neither is the current design.

**Device pairing is gone entirely.** `ci.pairings` (created `20260414000001`) was
dropped by `20260820001224_drop_pairings_table.sql`, and the backend went with it:
the `pairing` domain (`PairingController` / `PairingService` / `PairingEntity`),
`PairingResolver` with its `startPairing` / `pairingStatus` operations and the
`StartPairingPayload` / `PairingStatusPayload` types, `POST /pairing/complete`, and
the web `AppletPairPage`. It was unreachable code — `startPairing` handed back a
`/pair?token=…` path that was never a registered route in
`frontend/apps/web/src/App.tsx`. The migration is a bare `DROP TABLE ci.pairings`
with no archival step, so any rows an appliance still held are destroyed on
`migrate`; the appliance it was checked against held 0. Any doc that still lists a
`pairing` domain, a pre-auth `PairingResolver` exception, or `ci.pairings` under
Federation is stale. **This is not the app-connect flow:** `ci.connect_codes`, the
`/connect` server-to-server routes and the web `/device-connect` page are unrelated
and current.

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
| `ci.events` | `events_source_triple_uniq (user_id, + triple) WHERE source_id IS NOT NULL` | `20260620213807` (user-scoped `20260808065724`) |
| `ci.content` | `content_source_triple_uniq (user_id, + triple) WHERE source_id IS NOT NULL` | `20260623120300` |
| `ci.objects` | `objects_source_triple_uniq (owner_user_id, + triple) WHERE source_id IS NOT NULL` | `20260623120000` |
| `ci.browser_activity` | `browser_activity_source_triple_uniq (user_id, + triple) WHERE source_id IS NOT NULL` | `20260623120200` |
| `ci.communications` | `communications_source_triple_uniq (user_id, + triple) WHERE source_id IS NOT NULL` on the plain table | `20260807072321` (replaces retired `communications_source_dedup`) |
| `ci.entities` | `entities_linked_uniq (owner_user_id, entity_type, linked_table, linked_id) WHERE linked_table IS NOT NULL` — importer-stable graph upserts | `20260621020120` |
| `ci.capture_events` | `UNIQUE (user_id, destination, source_type, source_system, source_id)` | `20260621021634` / `20260716131500` |
| `ci.item_relationships` | `item_relationships_edge_uniq (user_id, from-triple, to-triple, relation)` | `20260707000001` |
| `ci_search.embeddings` / `ci_search.vectors` | `UNIQUE (entity_type, entity_id)` — index writes are upserts | `20251210022334` / `20251210040404` |

**Communications (plain table).** `ci.communications` used to be a hypertable, which
forced `time` into any UNIQUE index and broke pure triple dedup — hence the temporary
`communications_source_dedup` companion. After `20260807072321` it is a **plain table**
with `communications_source_triple_uniq` on `(user_id, source_type, source_system,
source_id)` and the companion table is gone. The communications path still
**self-heals** selected source-derived columns on conflict (`ON CONFLICT … DO UPDATE`;
see `INGEST_REFRESH_COLUMNS` in `common/persistence/ingestRefreshColumns.ts`).

## Indexing

| Kind | Index | Purpose |
|---|---|---|
| **pgvector HNSW** | `ci_search.embeddings_embedding_hnsw_idx` (`hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL`, `20260701120100`) | ANN semantic search — the primary vector read path and the single most expensive index to maintain during bulk loads |
| **pgvector HNSW** | `ci_search.embeddings_item_embedding_hnsw_idx` (`… WHERE entity_type = 'item' AND embedding IS NOT NULL`, `20260819173813`) | `ObjectResolutionService`'s "which owned unit is nearest this sighting's crop vector?" — `item` is ~0.16 % of the corpus, so the whole-corpus HNSW was the *wrong* plan for it (measured 530 ms ordered scan vs 0.8 ms on this one). The query repeats the predicate verbatim, because a partial index is only usable when the planner can prove the query implies it |
| **pgvector HNSW** | `object_observations_embedding_hnsw_idx` (`20260803223022`) | sighting-crop vectors |
| **GIN (tsvector)** | `ci_search.vectors_vector_gin_idx` (`20260704030000`) | full-text search over the unified index |
| **GIN (tsvector)** | `entities_fts_idx`, `messages_fts_idx` | per-table FTS |
| **GIN** | `communications_to_idx` on `to_entity_ids` (recreated by `20260807072321`) | recipient membership |
| **GIST (PostGIS)** | `events_location_coordinates_gix` (`(location_coordinates::geometry) WHERE … IS NOT NULL`, `20260621120000`) | map/bbox queries |
| **GIST (PostGIS)** | `entities_location_point_gix` (`20260803213950`) | `placesNear` (`ST_DWithin`) |
| **GIST (PostGIS)** | `entities_location_boundary_gix` (`WHERE entity_type = 'Location' AND location_boundary IS NOT NULL`, `20260819173404`) | `placesContaining` (`ST_Covers`, smallest footprint first) — the boundary column shipped without one, so containment queries seq-scanned every Location |
| **GIST (PostGIS)** | `position_location_idx` (`20260807071631`), `ci_derived.place_clusters_centroid_idx` (`20260817200000`) | position fixes; proximity matching on derived place clusters |
| **btree hot paths** | `events_user_time_idx (user_id, start_time DESC)`, `ci_search.embeddings_user_id_idx` (`20260701120000`), `capture_events_kind_idx`, `inventory_product_idx`, `ci_search.entity_tag_tag_id_idx` (`20260819013739`), `position_id_idx` (`20260819000439`) | timeline reads, per-user embed coverage scans, tag membership, position lookups by surrogate id |
| **partial unique** | the provenance-triple arbiters above | idempotency |

No **searchable** type carries its own embedding index any more. `ci.entities.embedding` /
`entities_embedding_idx` and `ci.messages.message_embedding` / `messages_embedding_idx`
were dropped in `20260213113000` — a single `ci_search.embeddings` table keyed
`(entity_type, entity_id)` replaced 25 `*_embedding` columns across 21 tables. Docs that
still list `ci.messages_embedding_idx` as live (this one did) describe a dropped index.
The one per-table vector still standing is `ci.object_observations.embedding` with its own
`object_observations_embedding_hnsw_idx` (`20260803223022`, row above) — crop-matching
state, not a search index: `ObjectResolutionService.buildEmbeddingQuery` reads that column
by `observation_id` as the *probe* vector and runs the ANN over `ci_search.embeddings`.

For very large imports, the expensive secondary indexes (FTS GIN + HNSW + the
communications/events secondaries) can be **dropped and rebuilt around the load** via the
opt-in deferral helper (registry in `maintenance/deferrableIndexes.ts`, driven only by the
`bulk-load-indexes` CLI — the HTTP twin was removed 2026-09-24 as unused attack surface).
Unique/constraint indexes are hard-guarded against dropping. The two narrow indexes above — `embeddings_user_id_idx` and
`embeddings_item_embedding_hnsw_idx` — are deliberately **not** in
`DEFERRABLE_INDEXES`: they build in under a second, so deferring them buys nothing. See
the [bulk load runbook](../../backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md).

## Hypertables

Hypertables that remain (criteria in [ADR-0002](./adr/0002-timescaledb-hypertable-criteria.md);
`ci.communications` was de-hypertabled):

| Table | Partitioning | Notes |
|---|---|---|
| `ci.position` | **time-only** hypertable on `time`, `chunk_time_interval => 1 month` | space partition removed (`20260807071631`); sensor stream. The month-scale chunk is deliberate: the table is backfilled with years of history, and the 7-day default would have produced ~1,300 chunks on day one |
| `hbpe.prediction_log` | time hypertable on `predicted_at` | reference specimen in ADR-0002; the only one that was configured correctly from the start, and the only one with a real (90-day) retention policy |

Twelve tables have been hypertables at some point (fourteen `create_hypertable` calls on
the way up — `ci.position` and `ci.user_snapshots` were each re-created when their space
partition was removed); these two are what is left. `ci.user_snapshots` was dropped outright in
`20260826202515_retire_user_snapshots`: it had no `SELECT` anywhere in the repo, and its ingest
mutation had no reachable caller, so it was unbounded growth with no consumer. Seven of those tables were dropped
outright, `browser_activity` was de-partitioned (`20260104075933`), and `communications`
was rebuilt as a plain table (`20260807072321`) after its
partition-column-in-the-unique-index requirement produced duplicate rows. Nothing new
has been hypertabled since ADR-0002.

Notes:

- **Never space-partition** on `user_id` for this appliance (1–5 users) — empty buckets
  multiply chunk count for no upside.
- Every UNIQUE index on a hypertable must include the partition column — this is why
  communications could not stay a hypertable while keeping a pure provenance triple key.
- Inserting into already-compressed chunks (older than the policy window) is slow; deep
  historical backfills should pause/re-add the compression policy — procedure in the
  [bulk load runbook §4](../../backend/apps/api/db/postgres/BULK_LOAD_RUNBOOK.md#4-timescaledb-aware-loading).

## Search index & deferred indexing

`ci_search.embeddings` (768-dim `nomic-embed-text` vectors) and `ci_search.vectors`
(tsvector) are populated **asynchronously** by the `search-index` PGBoss queue listeners
(`domains/search-ingress/listeners/*SearchIndexListener.ts`), keyed `(entity_type,
entity_id)`. `ci_search.index_skips` (`20260701000000`) records rows deliberately skipped
(e.g. no indexable text) so backfills don't re-attempt them forever. The document text a
row is indexed *by* is built once, in `search-ingress/searchTexts.ts`, so the listeners
and the pipeline's `index.*` stages produce byte-identical text for the same row.

Two write modes feed the queue:

- **Interactive creates** (single-row `createX` mutations / REST) emit a per-row
  `*CreatedEvent` → indexed live.
- **Bulk ingest** (the `/v1` lanes and the importer's push stage) suppresses per-row
  events (`emitCreated:false`) for throughput; rows become searchable when a sweep
  reaches them. See
  [graphql.md §4.7](../api/graphql.md#47-bulk-ingest-mutations-the-importer-surface--detailed)
  and [rest.md — maintenance](../api/rest.md#maintenance--enrichment--apimaintenance--domainsmaintenancecontrollersmaintenancecontrollerts374).

**Who owns the sweep changed in August 2026.** Bulk (re)indexing now belongs to
`ci.pipeline_state`, the versioned ledger in `domains/pipeline`: an `index.embed*` /
`index.vector*` stage records, per `(entity_type, entity_id, stage)`, that it ran, what
it decided and **which stage version** decided it. Candidate selection is
`stage_version < $current`, so re-embedding the corpus is an integer bump in
`versions.ts` rather than a backfill script — and `index.embed`'s version is *derived*
from the embedding model, so changing `CI_EMBED_MODEL` re-embeds by itself (cosine
distance between two models' vectors is meaningless, so a mixed index is silently
wrong). `POST /api/maintenance/search-index/backfill` survives as a safety net: it
re-emits create events only for rows the pipeline has **never** recorded an outcome
for, joining `ci.pipeline_state` and skipping anything the ledger owns. Its old
"no embedding row = not done" anti-join is exactly the defect the ledger exists to
delete — a `skipped` verdict lives in the ledger, not in the embeddings table.

The **768 dimension is hard-coupled** across the schema (`VECTOR(768)` columns) — swapping
to a different-dimension embedding model breaks the vector store (see
[hub-inference-integration.md](hub-inference-integration.md)).

## Migration workflow

Migrations are **dbmate-style hand-written SQL** in
`backend/apps/api/db/postgres/migrations/` — `-- migrate:up` / `-- migrate:down` blocks,
timestamp-prefixed filenames, applied state tracked in dbmate's `schema_migrations` table.

```bash
# from backend/apps/api (or via the root Makefile: make migrate)
yarn migrate:make <name>    # create a new migration file (offline) — wraps `dbmate new`
yarn migrate                # check:migrations + dbmate up
yarn migrate:down           # roll back the last migration
yarn dbshell                # psql into the configured database
```

Rules:

1. **SQL first.** The migration is the source of truth. After changing the schema, update
   the matching TypeORM entity so reads/writes agree — entities never auto-migrate the
   schema.
2. **Never hand-write the timestamp prefix.** dbmate keys `schema_migrations` on it, so
   two files sharing a prefix break `migrate` for everyone — the second fails its version
   insert with a duplicate key. Hand-picked round timestamps have collided across
   parallel branches before. `migrate:make` stamps the real UTC time to the second.
3. `yarn migrate` runs `bin/check-migration-versions.js` (the `check:migrations` script)
   before `dbmate up`. The checker is dependency-free CommonJS *by design*, because
   `migrate` runs it inside the production image, which installs dependencies only
   (`yarn workspaces focus --production`) and never copies `scripts/` in — a ts-node
   entrypoint there exits 127 and takes the whole install with it. `make smoke-api`
   proves that before any release is pushed.
4. The `Migrations` GitHub Actions workflow is **`workflow_dispatch`-only** (as is every
   other workflow in this repo, since 2026-08-17). It no longer runs on PRs touching
   `db/postgres/migrations/`, so silence from it means nobody dispatched it. Run it
   deliberately: `gh workflow run migration-integrity-check.yml --ref <branch>`, adding
   `-f base_ref=<branch>` and `-f mode=fix` when reissuing or renaming a migration.
5. The dbmate wrapper (`bin/dbmate.js`) builds the connection URL from the same
   `node-config` `db` block the API uses, and refuses destructive `--execute-file` scripts
   without confirmation.
6. Destructive resets during development: `make dbclear` (data only) / `make dbdestroy`
   (tables too) from the repo root.

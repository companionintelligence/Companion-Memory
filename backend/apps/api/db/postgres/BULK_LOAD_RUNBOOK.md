# Bulk ingest runbook

High-throughput load path for the importer (CI-Server's native import domain,
`backend/apps/api/src/domains/import/` — ported from the now-retired CI-Import-Tools) and
any other very large (~1M-row) historical load. Companion to the
[ingest reset runbook](INGEST_RESET_RUNBOOK.md); schema background in
[docs/architecture/Database.md](../../../../../docs/architecture/Database.md).

> **History:** an NDJSON→COPY sibling path under the `/v1/bulk/*` prefix existed briefly and
> was **removed** in #1552 (`86ab0e2a`). If you find references to `/v1/bulk/*`, they are
> stale — the machine-ingest plane that exists today is `/v1/*` with no `bulk` segment
> (§1), and it writes through the same services the GraphQL mutations do.

---

## 1. The write paths

Which one you are on depends on who is loading:

- **The native import domain** (the `ci` CLI, and the `/sources/import` wizard) uses no HTTP
  at all. `PushStage` injects the destination services and calls them in-process —
  `CommunicationService`, `ContentService`, `EventService`, `ItemService`, `PositionService`,
  `BrowserActivityService`, `GraphIngestService` — reading and pushing staged rows
  `PUSH_BATCH = 500` at a time
  (`src/domains/import/stages/PushStage.ts`). Body limits and 413 splitting do not apply to it.
- **The `/v1/*` machine-ingest plane** is the contract for an external bulk client:
  `POST /v1/{events,communications,contents,inventory,browser-activity,positions,notes,receipts,product-models,observations}`.
  `application/x-ndjson` is the default — one record per line, parsed off the raw request
  stream and flushed to the same services in batches of 1,000, no overall size cap — with
  `{ records: [...] }` JSON as the alternative (max 10,000 records under the 10 MB `/v1/*`
  body limit). The load is a three-step conversation that never needs
  `/api/maintenance/*`: POST the batches → `POST /v1/ingest/finish` →
  poll `GET /v1/ingest/status` (`src/domains/ingest/controllers/`).
- **The GraphQL list mutations** — `createEvents`, `createCommunications`, `createContents`,
  `createInventoryItems`, `createBrowserActivities`, plus `bulkIngestGraph` /
  `bulkIngestItemRelationships` for the graph — remain for clients already speaking GraphQL.
  Full contract (shapes, arbiters, error semantics):
  [docs/api/graphql.md §4.7–4.9](../../../../../docs/api/graphql.md#47-bulk-ingest-mutations-the-importer-surface--detailed).

The load-relevant properties of the two HTTP paths:

- **One round-trip carries an array** (`mutation(input: [CreateXInput!]!)`); both `/graphql`
  and the whole `/v1` prefix have a **10 MB** body limit
  (`common/middleware/BodyParserMiddleware.ts`) — size JSON batches to stay under it. NDJSON
  on `/v1/*` bypasses the body parser entirely and is bounded per line (1 MB), not overall.
  `MaxArraySizePipe` independently caps any single GraphQL input array at
  **10,000 elements** (`MAX_BULK_INPUT_SIZE`).
- **Idempotent on the provenance triple** `(source_type, source_system, source_id)` via
  set-based `INSERT … ON CONFLICT` against partial unique indexes
  (`common/persistence/bulkUpsert.ts`). Re-pushing the same rows is a no-op; rows without a
  `source_id` always insert. Communications now arbitrate on the same pure triple in the
  database — `communications_source_triple_uniq`, restored when the table stopped being a
  hypertable (`20260807072321_dehypertable_communications.sql`, which also dropped the
  `ci.communications_source_dedup` companion table the old hypertable needed) — and
  **self-heal** selected source-derived columns on re-sync (`INGEST_REFRESH_COLUMNS`).
- **Chunking is internal.** `bulkInsertIdempotent` splits any input into
  bind-param-budget-sized sub-batches inside one transaction (#1667) — callers never hit
  the 65535-parameter cliff and don't need their own sub-batching beyond the HTTP body
  limit.
- **Auth:** `JwtOrApiKeyAuthGuard` — same guard as `/api/maintenance/*`. Reuse an existing
  API key (`x-api-key`). The `/v1` plane additionally requires the `capture` scope and the
  `write` capability on the key (class-level `@RequireScopes` / `@RequireCapability` on
  `BulkIngestController`); empty-scope keys and session/JWT callers are unaffected.
- **Paths are literal against the API host.** There is no `setGlobalPrefix`; the edge
  proxy strips a browser's `/api`. `/graphql` and `/v1/*` are ordinary mounts, but
  `MaintenanceController` bakes `api/` into its own path, so `/api/maintenance/*` works
  when you point `curl` at the API's host:port and not at the proxy host.

## 2. Deferred indexing — bulk rows are NOT searchable until the sweep

Every batch path — in-process push, `/v1/*`, GraphQL list mutation alike — runs with
`emitCreated:false` semantics: **no per-row `*CreatedEvent` is emitted** (at ~1M rows the
per-row PGBoss fan-out was the dominant cost; #1552). Single-row `create` still emits, so
interactive creates index live.

Consequences for a bulk load:

- Rows are persisted and idempotent immediately, but have **no `ci_search.embeddings` /
  `ci_search.vectors` entries** until you run the post-load sweep:

  ```
  POST /api/maintenance/search-index/backfill
  ```

  which finds unindexed rows (LEFT JOIN) and re-emits their create events **onto the
  `search-index` queue only**, driving the idempotent `*SearchIndexListener` upserts with
  batched Ollama embedding.
- Or run the whole enrichment chain in canonical order with
  `POST /api/maintenance/orchestrate` (`extract_people → link_communications →
  link_events → heal_self_collation → materialize_edges → normalize_relationships →
  derive_relationships → fold_notes → extract_graph → geocode → reverse_geocode →
  reverse_position → reverse_object → estimate_locations → media_dimensions →
  search_index`; `ORCHESTRATE_STAGES` in
  `src/domains/maintenance/services/MaintenanceOrchestratorService.ts`). `POST
  /v1/ingest/finish` is the same call for a `/v1` client, and takes
  `searchIndexOnly: true` for just the embed sweep. Per-leg endpoints and the full chain:
  [docs/api/rest.md — maintenance](../../../../../docs/api/rest.md#maintenance--enrichment--apimaintenance--domainsmaintenancecontrollersmaintenancecontrollerts374).
- Watch progress with `GET /api/maintenance/search-index/embedded-count` and
  `GET /api/maintenance/ingest-status` (or `GET /v1/ingest/status`). Drain speed is usually
  bounded by the queue worker concurrency (`queues.concurrency` / `queues.fetchBatchSize` /
  `queues.perQueueConcurrency` in config — `CI_QUEUE_CONCURRENCY`,
  `CI_QUEUE_FETCH_BATCH_SIZE`, `CI_QUEUE_PER_QUEUE_CONCURRENCY`), not by Ollama.

---

## 3. Index-deferral helper — OPT-IN, reversible

The classic bulk-load pattern: drop expensive secondary indexes before a very
large load, recreate them after (one bulk build beats N row-by-row updates).

**Never automatic. Never a migration.** Two equivalent front-ends:

### CLI (preferred for an offline load window)

```bash
# 1. before the load — drop deferrable secondary indexes; defs saved to
#    ./.bulk-load-indexes.json so recreate is byte-for-byte reversible
yarn workspace @ci/be-api run exec scripts/bulk-load-indexes.ts drop

# 2. run the import (the `ci` CLI, /v1/*, or the GraphQL bulk mutations)

# 3. after the load — recreate every dropped index from the saved defs
yarn workspace @ci/be-api run exec scripts/bulk-load-indexes.ts recreate
```

> `run exec` is not a typo. `exec` is also a Yarn builtin, and
> `yarn workspace @ci/be-api exec scripts/…` resolves to the builtin, which tries to
> execute the `.ts` file directly and dies with `permission denied`. `run exec` reaches
> the package script (`ts-node` + path aliases + `DOTENV_CONFIG_PATH`), which is what
> the CLI needs.

### HTTP (operator endpoints)

```
POST /api/maintenance/indexes/drop       → { dropped: [{schema,name,definition}], skipped: [...] }
POST /api/maintenance/indexes/recreate   ← body: { dropped: [...] }  (the array from /drop)
```

Pass the `dropped` array from `/drop` back into `/recreate`.

### What is dropped — and what is NOT

Dropped (see `DEFERRABLE_INDEXES` in
`src/domains/maintenance/services/IndexDeferralService.ts`; entries whose index no longer
exists are skipped harmlessly):

- FTS GIN tsvector indexes: `entities_fts_idx`, `document_chunks_fts_idx`,
  `messages_fts_idx`
- pgvector HNSW: `ci_search.embeddings_embedding_hnsw_idx`
- secondary btree/GIN on the bulk destinations:
  `communications_{thread,from,to,category,direction_type,device}_idx`,
  `events_{type_category,status,source}_idx`

(`facts_fts_idx` and `messages_embedding_idx` used to be on that list and were removed
from it — `ci.facts` and `ci.messages.message_embedding` no longer exist, so dropping
them could only ever no-op.)

**Never dropped** (a hard guard refuses any unique/constraint index even if the
list drifts):

- the provenance idempotency arbiters — `*_source_triple_uniq`, the `ON CONFLICT`
  targets (`communications_source_triple_uniq` among them since the de-hypertable)
- primary keys / hypertable partition constraints
- `ci_search.embeddings` & `ci_search.vectors` `UNIQUE (entity_type, entity_id)`

> **pgvector index**: the ANN index on `ci_search.embeddings.embedding` is
> `embeddings_embedding_hnsw_idx` (HNSW, `vector_cosine_ops`; migration
> `20260701120100_add_embeddings_hnsw_index.sql`). It is the single most
> expensive index to maintain during a load, so it IS dropped/rebuilt by the
> deferral helper. The companion `embeddings_user_id_idx` btree(user_id)
> (`20260701120000`) is a cheap scalar btree and is intentionally NOT deferred.
> `events_user_time_idx` (the main read path) is likewise kept — it is cheap and
> helps post-load queries. A second, much smaller HNSW —
> `embeddings_item_embedding_hnsw_idx`, partial on the `item` rows
> (`20260819173813`) — is also not on the deferral list; it covers ~0.2% of the
> corpus and is cheap to maintain.
>
> **Appliance memory caveat**: HNSW build memory on ~400k × 768-dim rows is not
> yet quantified on appliance hardware. On a live appliance with a large existing
> corpus, build the index out-of-band with `CREATE INDEX CONCURRENTLY` and tune
> `maintenance_work_mem` rather than letting a blocking migration run it inline.

---

## 4. TimescaleDB-aware loading

> **Changed 2026-08-07.** `ci.communications` is **no longer a hypertable**.
> `20260807072321_dehypertable_communications.sql` rebuilt it as a plain table with the
> surrogate `id` as its PK and the pure provenance triple as its unique key, and dropped
> the old table together with its chunks and its compression job. The case is in
> [docs/architecture/hypertable-audit.md](../../../../../docs/architecture/hypertable-audit.md).
> Anything you read elsewhere about space partitions, 30-day compression or
> `set_chunk_time_interval('communications', …)` describes the pre-August table.

Of the bulk-ingest destinations, **only `ci.position` is still a hypertable** —
time-only (the `user_id` space partition was dropped in
`20260807071631_departition_position.sql`), `chunk_time_interval` 1 month, with
**columnar compression after 7 days** (`add_compression_policy('ci.position', INTERVAL
'7 days')`). `ci.events`, `ci.communications`, `ci.content`, `ci.objects` and
`ci.browser_activity` are all plain tables — the index-deferral helper alone is the
relevant optimization there.

Guidance for a very large historical `position` load:

1. **Insert in time order where possible.** Group/sort each batch by
   `time` so a request lands in as few chunks as possible (less chunk
   thrashing, better cache locality). One request per day/week of source data
   is a good unit.

2. **Mind compressed chunks.** Inserting rows whose `time` falls in an
   already-compressed chunk (older than 7 days) is far slower and can error on
   some constraints. Options, in order of preference:
   - load newest→oldest only within the uncompressed window; OR
   - temporarily pause the policy for a deep historical backfill:
     ```sql
     SELECT remove_compression_policy('ci.position');        -- before
     -- … bulk load …
     SELECT add_compression_policy('ci.position', INTERVAL '7 days');  -- after
     SELECT compress_chunk(c) FROM show_chunks('ci.position',
            older_than => INTERVAL '7 days') c;              -- optional manual recompress
     ```
     This is an explicit operator step (like the index helper) — not automated
     here, because it changes a storage policy on a live table.

3. **Chunk interval.** The 1-month interval is fine for steady ingest. If a single
   backfill spans decades, a wider `chunk_time_interval` reduces chunk count; set it
   before the load via
   `SELECT set_chunk_time_interval('ci.position', INTERVAL '3 months');`.

4. **Session knobs for the load window** (set per-session by the loader, not
   globally): larger `maintenance_work_mem` speeds the index **rebuild** in
   step 3 of the deferral helper; `SET synchronous_commit = off;` trades a tiny
   durability window for throughput on the load transactions. Both are safe to
   apply only during the load.

---

## 5. Suggested end-to-end procedure for a 1M-row load

```bash
# 0. (optional, deep historical position backfill) pause the ci.position
#    compression policy in psql
# 1. drop deferrable secondary indexes
yarn workspace @ci/be-api run exec scripts/bulk-load-indexes.ts drop
# 2. push the data, time-ordered — `ci` for an archive, or NDJSON to
#    POST /v1/{events,communications,contents,inventory,browser-activity,positions},
#    or the GraphQL bulk mutations (createEvents / createCommunications /
#    createContents / createInventoryItems / createBrowserActivities); then sync
#    the graph (bulkIngestGraph + bulkIngestItemRelationships)
# 3. recreate indexes
yarn workspace @ci/be-api run exec scripts/bulk-load-indexes.ts recreate
# 4. (optional) re-add compression policy / recompress old chunks in psql
# 5. run the enrichment chain: POST /api/maintenance/orchestrate
#    (or POST /v1/ingest/finish; at minimum POST /api/maintenance/search-index/backfill)
# 6. poll GET /api/maintenance/ingest-status until the search-index queue drains
```

To wipe everything and start over, see the
[ingest reset runbook](INGEST_RESET_RUNBOOK.md).

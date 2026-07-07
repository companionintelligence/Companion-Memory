# Bulk ingest runbook

High-throughput load path for the importer (CI-Import-Tools) and any other very large
(~1M-row) historical load. Companion to the
[ingest reset runbook](INGEST_RESET_RUNBOOK.md); schema background in
[docs/architecture/Database.md](../../../../../docs/architecture/Database.md).

> **History:** an NDJSON→COPY sibling path (`POST /v1/bulk/communications|events`) existed
> briefly and was **removed** in #1552 (`86ab0e2a`) — the importer never used it, and the
> GraphQL list mutations write straight to the final tables with the same idempotency.
> If you find references to `/v1/bulk/*`, they are stale.

---

## 1. The write path: GraphQL bulk mutations

All bulk loads go through the **GraphQL list mutations** — `createEvents`,
`createCommunications`, `createContents`, `createInventoryItems`,
`createBrowserActivities`, plus `bulkIngestGraph` / `bulkIngestItemRelationships` for the
graph. Full contract (shapes, arbiters, error semantics):
[docs/api/graphql.md §4.7–4.9](../../../../../docs/api/graphql.md#47-bulk-ingest-mutations-the-importer-surface--detailed).

The load-relevant properties:

- **One round-trip carries an array** (`mutation(input: [CreateXInput!]!)`); the `/graphql`
  route has a **10 MB** body limit (`common/middleware/BodyParserMiddleware.ts`) — size
  batches to stay under it (the importer defaults to 200 rows/request, tunable via
  `CI_PUSH_BATCH_SIZE`, and splits on 413).
- **Idempotent on the provenance triple** `(source_type, source_system, source_id)` via
  set-based `INSERT … ON CONFLICT` against partial unique indexes
  (`common/persistence/bulkUpsert.ts`). Re-pushing the same rows is a no-op; rows without a
  `source_id` always insert. Communications dedups via the companion table
  `ci.communications_source_dedup` (hypertable UNIQUE indexes must include `time`, so the
  pure-triple invariant lives off-table) and **self-heals** selected source-derived columns
  on re-sync (`INGEST_REFRESH_COLUMNS`).
- **Chunking is internal.** `bulkInsertIdempotent` splits any input into
  bind-param-budget-sized sub-batches inside one transaction (#1667) — callers never hit
  the 65535-parameter cliff and don't need their own sub-batching beyond the HTTP body
  limit.
- **Auth:** `JwtOrApiKeyAuthGuard` — same guard as `/v1/events` and `/api/maintenance/*`.
  Reuse an existing API key (`x-api-key`).

## 2. Deferred indexing — bulk rows are NOT searchable until the sweep

The bulk mutations pass `emitCreated:false`: **no per-row `*CreatedEvent` is emitted** (at
~1M rows the per-row PGBoss fan-out was the dominant cost; #1552). Single-row `createX`
mutations still emit, so interactive creates index live.

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
  link_events → extract_graph → geocode → reverse_geocode → estimate_locations →
  media_dimensions → search_index`; `ORCHESTRATE_STAGES` in
  `src/domains/maintenance/services/MaintenanceOrchestratorService.ts`). Per-leg
  endpoints and the full chain:
  [docs/api/rest.md — maintenance](../../../../../docs/api/rest.md#maintenance--enrichment--apimaintenance--domainsmaintenancecontrollersmaintenancecontrollerts374).
- Watch progress with `GET /api/maintenance/search-index/embedded-count` and
  `GET /api/maintenance/ingest-status`. Drain speed is usually bounded by the queue worker
  concurrency (`queues.concurrency` / `queues.fetchBatchSize` in config), not by Ollama.

---

## 3. Index-deferral helper — OPT-IN, reversible

The classic bulk-load pattern: drop expensive secondary indexes before a very
large load, recreate them after (one bulk build beats N row-by-row updates).

**Never automatic. Never a migration.** Two equivalent front-ends:

### CLI (preferred for an offline load window)

```bash
# 1. before the load — drop deferrable secondary indexes; defs saved to
#    ./.bulk-load-indexes.json so recreate is byte-for-byte reversible
yarn workspace @ci/be-api exec scripts/bulk-load-indexes.ts drop

# 2. run the import (GraphQL bulk mutations)

# 3. after the load — recreate every dropped index from the saved defs
yarn workspace @ci/be-api exec scripts/bulk-load-indexes.ts recreate
```

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

- FTS GIN tsvector indexes: `entities_fts_idx`, `messages_fts_idx`
- pgvector HNSW: `messages_embedding_idx`,
  `ci_search.embeddings_embedding_hnsw_idx`
- secondary btree/GIN on the bulk destinations:
  `communications_{thread,from,to,category,direction_type,device}_idx`,
  `events_{type_category,status,source}_idx`

**Never dropped** (a hard guard refuses any unique/constraint index even if the
list drifts):

- the provenance idempotency arbiters — `*_source_triple_uniq` and the
  `ci.communications_source_dedup` PK (the `ON CONFLICT` targets)
- primary keys / hypertable partition constraints
- `ci_search.embeddings` & `ci_search.vectors` `UNIQUE (entity_type, entity_id)`

> **pgvector index**: the ANN index on `ci_search.embeddings.embedding` is
> `embeddings_embedding_hnsw_idx` (HNSW, `vector_cosine_ops`; migration
> `20260701120100_add_embeddings_hnsw_index.sql`). It is the single most
> expensive index to maintain during a load, so it IS dropped/rebuilt by the
> deferral helper. The companion `embeddings_user_id_idx` btree(user_id)
> (`20260701120000`) is a cheap scalar btree and is intentionally NOT deferred.
> `events_user_time_idx` (the main read path) is likewise kept — it is cheap and
> helps post-load queries.
>
> **Appliance memory caveat**: HNSW build memory on ~400k × 768-dim rows is not
> yet quantified on appliance hardware. On a live appliance with a large existing
> corpus, build the index out-of-band with `CREATE INDEX CONCURRENTLY` and tune
> `maintenance_work_mem` rather than letting a blocking migration run it inline.

---

## 4. TimescaleDB-aware loading

`ci.communications` is a hypertable partitioned on `(time, user_id)`, 4 space
partitions, with **columnar compression after 30 days**
(`add_compression_policy('communications', INTERVAL '30 days')`).

Guidance for a very large historical load:

1. **Insert in time order where possible.** Group/sort each batch by
   `time` so a request lands in as few chunks as possible (less chunk
   thrashing, better cache locality). One request per day/week of source data
   is a good unit.

2. **Mind compressed chunks.** Inserting rows whose `time` falls in an
   already-compressed chunk (older than 30 days) is far slower and can error on
   some constraints. Options, in order of preference:
   - load newest→oldest only within the uncompressed window; OR
   - temporarily pause the policy for a deep historical backfill:
     ```sql
     SELECT remove_compression_policy('communications');     -- before
     -- … bulk load …
     SELECT add_compression_policy('communications', INTERVAL '30 days');  -- after
     SELECT compress_chunk(c) FROM show_chunks('communications',
            older_than => INTERVAL '30 days') c;             -- optional manual recompress
     ```
     This is an explicit operator step (like the index helper) — not automated
     here, because it changes a storage policy on a live table.

3. **Chunk interval.** The default chunk interval is fine for steady ingest. If
   a single backfill spans years, a wider `chunk_time_interval` reduces chunk
   count; set it before the load via
   `SELECT set_chunk_time_interval('communications', INTERVAL '7 days');`.

4. **Session knobs for the load window** (set per-session by the loader, not
   globally): larger `maintenance_work_mem` speeds the index **rebuild** in
   step 3 of the deferral helper; `SET synchronous_commit = off;` trades a tiny
   durability window for throughput on the load transactions. Both are safe to
   apply only during the load.

Events (`ci.events`) is a **plain** table — none of the hypertable caveats
apply; the index-deferral helper alone is the relevant optimization there.

---

## 5. Suggested end-to-end procedure for a 1M-row load

```bash
# 0. (optional, deep historical) pause communications compression policy in psql
# 1. drop deferrable secondary indexes
yarn workspace @ci/be-api exec scripts/bulk-load-indexes.ts drop
# 2. push the data, time-ordered, via the GraphQL bulk mutations
#    (createEvents / createCommunications / createContents / createInventoryItems /
#     createBrowserActivities), then sync the graph (bulkIngestGraph +
#     bulkIngestItemRelationships)
# 3. recreate indexes
yarn workspace @ci/be-api exec scripts/bulk-load-indexes.ts recreate
# 4. (optional) re-add compression policy / recompress old chunks in psql
# 5. run the enrichment chain: POST /api/maintenance/orchestrate
#    (or at minimum POST /api/maintenance/search-index/backfill)
# 6. poll GET /api/maintenance/ingest-status until the search-index queue drains
```

To wipe everything and start over, see the
[ingest reset runbook](INGEST_RESET_RUNBOOK.md).

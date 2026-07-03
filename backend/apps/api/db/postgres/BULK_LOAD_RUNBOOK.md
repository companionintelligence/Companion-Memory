# Bulk ingest runbook (issues #11, #12, #15)

High-throughput load path for the importer (CI-Import-Tools), the COPY-backed
sibling of the GraphQL batch mutations. Use it for very large loads
(~1M timeline rows) where per-mutation GraphQL overhead and the JSON body limit
make the GraphQL path slow / 413-prone.

This is a tested **vertical slice**: `communications` and `events`.
`inventory` and `browser_activity` generalize by adding one `BulkTableSpec`
(see `src/domains/memory/services/bulkTableSpecs.ts`).

---

## 1. HTTP contract (#11)

```
POST /v1/bulk/communications
POST /v1/bulk/events
Content-Type: application/x-ndjson          # REQUIRED — see note
Authorization: ApiKey <key>                 # or: Bearer <jwt>
```

- **Auth**: `JwtOrApiKeyAuthGuard` — the same guard `/v1/events` (unified
  capture ingest) and `/api/maintenance/*` use. Reuse an existing API key.
- **Why `application/x-ndjson` matters**: `BodyParserMiddleware` only buffers
  `application/json`. NDJSON sails past it un-buffered, so the body is bounded
  by time, not the 100 kb JSON limit that 413'd. Do **not** send
  `application/json`.
- **Body**: newline-delimited JSON — one record object per line. Blank lines
  are tolerated. Send it as a stream (chunked) for best throughput; there is no
  fixed per-request row cap, but ~10k–50k rows/request keeps memory and the
  per-request transaction bounded.

### Response `200`

```jsonc
{
  "received": 50000,   // non-blank lines read
  "inserted": 49873,   // rows actually written (RETURNING count)
  "deduped":  120,     // rows skipped by ON CONFLICT (already present)
  "rejected": [        // per-line parse/validation failures; rest still loaded
    { "line": 41, "reason": "invalid JSON" },
    { "line": 88, "reason": "Invalid enum value..." }
  ]
}
```

`received === inserted + deduped + rejected.length`.

### Record shapes

`communications` (one per line):

```jsonc
{
  "time": "2026-01-02T03:04:05Z",  // ISO-8601 or epoch millis. Required.
  "communication_type": "email",    // email|sms|call|chat|video_call|voice_note|post
  "direction": "inbound",           // inbound|outbound|internal|async|ongoing
  "content": "message body",         // required
  "subject": "…", "preview": "…", "thread_id": "…",
  "category": "…", "connection_id": "…",
  // provenance triple — see idempotency below
  "source_type": "import", "source_system": "gmail", "source_id": "msg-123"
}
```

`events` (one per line):

```jsonc
{
  "title": "Standup",                  // required
  "start_time": "2026-01-02T09:00:00Z",// ISO-8601 or epoch millis. Required.
  "end_time": "2026-01-02T09:15:00Z",  // optional
  "description": "…", "event_type": "meeting", "category": "…",
  "location_name": "…", "confidence_score": 0.9,
  "source_type": "import", "source_system": "gcal", "source_id": "evt-123"
}
```

`curl` example:

```bash
curl -sS -X POST https://ci-server.localhost/v1/bulk/communications \
  -H "Authorization: ApiKey $CI_API_KEY" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @communications.ndjson
```

---

## 2. Idempotency + event emission (preserved exactly)

**Idempotency** is identical to the GraphQL path. The fold is a set-based
`INSERT … SELECT … FROM <temp staging> ON CONFLICT (<triple>)
WHERE source_id IS NOT NULL DO NOTHING RETURNING id`, targeting the SAME
partial unique indexes:

| Destination          | Conflict target (partial unique index)                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `ci.communications`  | `communications_source_triple_uniq` = `(user_id, time, source_type, source_system, source_id)`  |
| `ci.events`          | `events_source_triple_uniq` = `(source_type, source_system, source_id)`                         |

Both indexes are partial on `source_id IS NOT NULL`. Rows **without** a
`source_id` always insert (no dedupe key), matching the per-row services. A full
re-sync of the same source rows is a no-op (counted as `deduped`).
The communications index includes the hypertable partition columns
(`user_id`, `time`) because every UNIQUE index on a TimescaleDB hypertable must.

**Event emission**: for every row the INSERT actually wrote (i.e. each
`RETURNING` id), the service emits the SAME signalling event the per-row service
emits — `CommunicationCreatedEvent { communicationId }` /
`EventCreatedEvent { eventId }`. Those drive the `search-index` queue listeners
that generate the embedding (`ci_search.embeddings`) and tsvector
(`ci_search.vectors`) so bulk-loaded rows are searchable just like API-created
rows. Deduped rows emit **nothing** (no re-index on re-sync). Emission happens
**after commit**, so a rolled-back row is never signalled.

> Throughput note: emitting N events still enqueues N search-index jobs. The
> COPY makes the **write** fast; embedding generation remains the downstream
> bottleneck and runs out-of-band on the `search-index` queue. For a 1M-row
> load, defer/throttle the embedding workers as needed — the rows are persisted
> and idempotent regardless.

---

## 3. Index-deferral helper (#12) — OPT-IN, reversible

The classic bulk-load pattern: drop expensive secondary indexes before a very
large load, recreate them after (one bulk build beats N row-by-row updates).

**Never automatic. Never a migration.** Two equivalent front-ends:

### CLI (preferred for an offline load window)

```bash
# 1. before the load — drop deferrable secondary indexes; defs saved to
#    ./.bulk-load-indexes.json so recreate is byte-for-byte reversible
yarn workspace @ci/be-api exec scripts/bulk-load-indexes.ts drop

# 2. run the import (POST /v1/bulk/...)

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
`src/domains/maintenance/services/IndexDeferralService.ts`):

- FTS GIN tsvector indexes: `entities_fts_idx`, `facts_fts_idx`,
  `document_chunks_fts_idx`, `messages_fts_idx`
- pgvector HNSW: `messages_embedding_idx`,
  `ci_search.embeddings_embedding_hnsw_idx`
- secondary btree/GIN on the bulk destinations:
  `communications_{thread,from,to,category,direction_type,device}_idx`,
  `events_{type_category,status,source}_idx`

**Never dropped** (a hard guard refuses any unique/constraint index even if the
list drifts):

- `*_source_triple_uniq` — provenance idempotency (the `ON CONFLICT` target)
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
> yet quantified on appliance hardware (plan §5 flags a measure-first spike).
> On a live appliance with a large existing corpus, build the index out-of-band
> with `CREATE INDEX CONCURRENTLY` and tune `maintenance_work_mem` rather than
> letting the blocking migration run it inline.

---

## 4. TimescaleDB-aware loading (#15)

`ci.communications` is a hypertable partitioned on `(time, user_id)`, 4 space
partitions, with **columnar compression after 30 days**
(`add_compression_policy('communications', INTERVAL '30 days')`).

Guidance for a very large historical load:

1. **Insert in time order where possible.** Group/sort each NDJSON request by
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
   durability window for throughput on the COPY transactions. Both are safe to
   apply only during the load.

Events (`ci.events`) is a **plain** table — none of the hypertable caveats
apply; the index-deferral helper alone is the relevant optimization there.

---

## 5. Suggested end-to-end procedure for a 1M-row load

```bash
# 0. (optional, deep historical) pause communications compression policy in psql
# 1. drop deferrable secondary indexes
yarn workspace @ci/be-api exec scripts/bulk-load-indexes.ts drop
# 2. stream the data, time-ordered, ~10k–50k rows/request
#    POST /v1/bulk/communications  and  /v1/bulk/events   (application/x-ndjson)
# 3. recreate indexes
yarn workspace @ci/be-api exec scripts/bulk-load-indexes.ts recreate
# 4. (optional) re-add compression policy / recompress old chunks in psql
# 5. let the search-index queue drain (embeddings/tsvectors for the new rows)
```

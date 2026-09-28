// =====================================================================
// Index-deferral helper (issue #12) — OPT-IN, reversible, never auto-run
// =====================================================================
// The classic bulk-load pattern: before a very large load, DROP the
// expensive secondary indexes that COPY/INSERT would otherwise maintain
// row-by-row; recreate them once after the load (a single bulk build is
// far cheaper than N incremental updates). This is a MAINTENANCE routine,
// exposed ONLY through the bulk-load-indexes CLI (scripts/bulk-load-indexes.ts,
// run on the box by the operator) — it is NOT a migration and must be triggered
// explicitly.
//
// It used to have an HTTP twin, `POST /api/maintenance/indexes/{drop,recreate}`,
// reachable by any signed-in principal. The recreate half executed the CREATE
// statements handed back in the request body verbatim — an arbitrary-SQL
// primitive — and nothing in the product ever called either route (the CLI
// has always carried its own SQL and state file). Both were removed 2026-09-24
// rather than hardened: an unused endpoint is pure attack surface. This file is
// what survives — the registry of WHICH indexes are safe to defer, and the
// shape the CLI records for each one.
//
// Safety rules baked in:
//   - We DROP only the named "deferrable" secondary indexes below.
//   - We NEVER touch provenance unique indexes (*_source_identity_uniq) —
//     dropping them would break the ON CONFLICT idempotency the bulk path
//     relies on — nor primary keys, nor any UNIQUE constraint.
//   - Drop captures each index's exact CREATE statement first, so recreate
//     is byte-for-byte reversible even if this list drifts.

/**
 * The secondary indexes safe to drop before a large load and rebuild after.
 * Grepped from db/postgres/migrations (the source of truth) as of 2026-06.
 *
 * Deliberately EXCLUDED (do not add):
 *   - *_source_identity_uniq  → provenance idempotency (ON CONFLICT target)
 *   - *_pkey / PRIMARY KEY   → identity + hypertable partition constraints
 *   - ci_search.embeddings / ci_search.vectors UNIQUE (entity_type, entity_id)
 *
 * The pgvector HNSW index on ci_search.embeddings.embedding
 * (`embeddings_embedding_hnsw_idx`, migration 20260701120100) IS listed below:
 * it is the single most expensive index to maintain at load, so the bulk path
 * drops and rebuilds it. The btree(user_id) index (embeddings_user_id_idx,
 * 20260701120000) is deliberately NOT listed — a plain scalar btree is cheap to
 * maintain incrementally, so there is no benefit to dropping it around a load.
 */
export const DEFERRABLE_INDEXES: ReadonlyArray<{ schema: string; name: string; note: string }> = [
  // --- Full-text (GIN tsvector) — rebuilt cheaply in bulk -----------------
  { schema: 'ci', name: 'entities_fts_idx', note: 'GIN(search_vector) on ci.entities' },
  { schema: 'ci', name: 'document_chunks_fts_idx', note: 'GIN(content_search_vector) on ci.document_chunks' },
  { schema: 'ci', name: 'messages_fts_idx', note: 'GIN(search_vector) on ci.messages' },
  // NB: 'facts_fts_idx' (ci.facts table dropped) and 'messages_embedding_idx'
  // (ci.messages.message_embedding column removed) were removed from this list —
  // both no longer exist in the schema, so dropDeferredIndexes() would only ever
  // no-op on them. Verified absent via pg_indexes / to_regclass('ci.facts').
  // --- pgvector ANN (HNSW) on the search embeddings table -----------------
  // The single most expensive index to maintain during a large load; the
  // primary search read path (semantic/boosted/hybrid cosine). See migration
  // 20260701120100_add_embeddings_hnsw_index.sql.
  {
    schema: 'ci_search',
    name: 'embeddings_embedding_hnsw_idx',
    note: 'HNSW(embedding vector_cosine_ops) on ci_search.embeddings',
  },
  // --- Secondary btree/GIN on the bulk-ingest destinations ----------------
  { schema: 'ci', name: 'communications_thread_idx', note: 'btree(thread_id) on ci.communications' },
  { schema: 'ci', name: 'communications_from_idx', note: 'btree(from_entity_id) on ci.communications' },
  { schema: 'ci', name: 'communications_to_idx', note: 'GIN(to_entity_ids) on ci.communications' },
  { schema: 'ci', name: 'communications_category_idx', note: 'btree(category) on ci.communications' },
  { schema: 'ci', name: 'communications_direction_type_idx', note: 'btree(direction, communication_type)' },
  { schema: 'ci', name: 'communications_device_idx', note: 'btree(device_id) on ci.communications' },
  { schema: 'ci', name: 'events_type_category_idx', note: 'btree(event_type, category) on ci.events' },
  { schema: 'ci', name: 'events_status_idx', note: 'btree(status) on ci.events' },
  { schema: 'ci', name: 'events_source_idx', note: 'btree(source_type, source_system) on ci.events' },
  // events_user_time_idx is the main read path; kept (cheap, helps the fold's
  // post-load queries). events_source_identity_uniq is EXCLUDED on purpose.
];

export interface DroppedIndex {
  schema: string;
  name: string;
  /** The exact `CREATE INDEX …` recreate statement, captured before the drop. */
  definition: string;
}

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

// =====================================================================
// Index-deferral helper (issue #12) — OPT-IN, reversible, never auto-run
// =====================================================================
// The classic bulk-load pattern: before a very large load, DROP the
// expensive secondary indexes that COPY/INSERT would otherwise maintain
// row-by-row; recreate them once after the load (a single bulk build is
// far cheaper than N incremental updates). This is a MAINTENANCE routine,
// exposed via a service method + the bulk-load-indexes CLI — it is NOT a
// migration and must be triggered explicitly by an operator.
//
// Safety rules baked in:
//   - We DROP only the named "deferrable" secondary indexes below.
//   - We NEVER touch provenance unique indexes (*_source_triple_uniq) —
//     dropping them would break the ON CONFLICT idempotency the bulk path
//     relies on — nor primary keys, nor any UNIQUE constraint.
//   - Drop captures each index's exact CREATE statement first, so recreate
//     is byte-for-byte reversible even if this list drifts.

/**
 * The secondary indexes safe to drop before a large load and rebuild after.
 * Grepped from db/postgres/migrations (the source of truth) as of 2026-06.
 *
 * Deliberately EXCLUDED (do not add):
 *   - *_source_triple_uniq  → provenance idempotency (ON CONFLICT target)
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
  { schema: 'ci', name: 'facts_fts_idx', note: 'GIN(fact_search_vector) on ci.facts' },
  { schema: 'ci', name: 'document_chunks_fts_idx', note: 'GIN(content_search_vector) on ci.document_chunks' },
  { schema: 'ci', name: 'messages_fts_idx', note: 'GIN(search_vector) on ci.messages' },
  // --- pgvector ANN (HNSW) on messages ------------------------------------
  { schema: 'ci', name: 'messages_embedding_idx', note: 'HNSW(message_embedding) on ci.messages' },
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
  // post-load queries). events_source_triple_uniq is EXCLUDED on purpose.
];

export interface DroppedIndex {
  schema: string;
  name: string;
  /** The exact `CREATE INDEX …` recreate statement, captured before the drop. */
  definition: string;
}

export interface DeferralResult {
  dropped: DroppedIndex[];
  skipped: { schema: string; name: string; reason: string }[];
}

export interface RecreateResult {
  recreated: string[];
  failed: { name: string; reason: string }[];
}

@Injectable()
export class IndexDeferralService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(IndexDeferralService.name);
  }

  /**
   * Drop the deferrable secondary indexes, returning each one's exact recreate
   * statement so the caller can persist it and restore later. A guard refuses to
   * drop anything that is a unique index, a primary key, or a constraint-backing
   * index — so even if {@link DEFERRABLE_INDEXES} drifts, idempotency is safe.
   */
  async dropDeferredIndexes(): Promise<DeferralResult> {
    const dropped: DroppedIndex[] = [];
    const skipped: { schema: string; name: string; reason: string }[] = [];

    for (const { schema, name } of DEFERRABLE_INDEXES) {
      const meta: { indexdef: string; is_unique: boolean; is_constraint: boolean }[] =
        await this.dataSource.query(
          `SELECT i.indexdef,
                  ix.indisunique AS is_unique,
                  (con.conindid IS NOT NULL) AS is_constraint
             FROM pg_indexes i
             JOIN pg_class c ON c.relname = i.indexname
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
             JOIN pg_index ix ON ix.indexrelid = c.oid
             LEFT JOIN pg_constraint con ON con.conindid = c.oid
            WHERE i.schemaname = $1 AND i.indexname = $2`,
          [schema, name],
        );

      if (meta.length === 0) {
        skipped.push({ schema, name, reason: 'not found' });
        continue;
      }

      const { indexdef, is_unique, is_constraint } = meta[0];

      // Hard safety net: never drop a unique/constraint index regardless of list.
      if (is_unique || is_constraint) {
        skipped.push({ schema, name, reason: 'unique/constraint index — refusing to drop' });
        this.logger.warn('Refusing to drop unique/constraint index', { schema, name });
        continue;
      }

      await this.dataSource.query(`DROP INDEX IF EXISTS "${schema}"."${name}"`);
      dropped.push({ schema, name, definition: indexdef });
      this.logger.log('Dropped deferred index', { schema, name });
    }

    return { dropped, skipped };
  }

  /**
   * Recreate the previously-dropped indexes from their captured definitions.
   * Pass the `dropped` array returned by {@link dropDeferredIndexes}. Each
   * CREATE is run independently so one failure does not abort the rest.
   *
   * NOTE: these run as plain (blocking) CREATE INDEX, which is correct for the
   * "load window" pattern (no concurrent traffic). For an online rebuild use
   * the captured definitions with CONCURRENTLY out-of-band instead.
   */
  async recreateDeferredIndexes(dropped: DroppedIndex[]): Promise<RecreateResult> {
    const recreated: string[] = [];
    const failed: { name: string; reason: string }[] = [];

    for (const { name, definition } of dropped) {
      try {
        await this.dataSource.query(definition);
        recreated.push(name);
        this.logger.log('Recreated deferred index', { name });
      } catch (err) {
        failed.push({ name, reason: (err as Error).message });
        this.logger.error('Failed to recreate deferred index', { name, error: (err as Error).message });
      }
    }

    return { recreated, failed };
  }
}

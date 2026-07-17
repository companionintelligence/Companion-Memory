import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { SEARCH_TABLES } from '@ci/domains/search-ingress';

/** The pgboss queue the *SearchIndexListeners consume (see SearchIndexBackfillService). */
const SEARCH_INDEX_QUEUE = 'search-index';

/**
 * Bulk-ingest destination tables cleared by a reset. ci.communications_source_dedup
 * MUST be cleared in lockstep with ci.communications: TRUNCATE does not fire the
 * per-row AFTER DELETE trigger that normally keeps the dedup table consistent, so
 * leaving it populated makes every triple in the next re-import dedupe against a
 * pointer to a deleted row — the "0 communications after reset" incident.
 */
const INGEST_TABLES = [
  { schema: 'ci', table: 'events' },
  { schema: 'ci', table: 'communications' },
  { schema: 'ci', table: 'communications_source_dedup' },
  { schema: 'ci', table: 'content' },
  { schema: 'ci', table: 'inventory' },
  { schema: 'ci', table: 'browser_activity' },
] as const;

export interface IngestResetResult {
  /** Row count per (schema-qualified) table at the moment before truncation. */
  countsBefore: Record<string, number>;
  /** Every table truncated, schema-qualified, in execution order. */
  truncated: string[];
  /** Pending ('created'/'active'/'retry') search-index pgboss jobs deleted. */
  searchIndexJobsDeleted: number;
}

/**
 * Full ingest reset: wipe every bulk-ingest destination table, the
 * communications dedup structure, the whole `ci_search` index (embeddings,
 * vectors, index_skips — via the shared {@link SEARCH_TABLES} list, so the two
 * can't drift), and the not-yet-run `search-index` queue jobs, all in ONE
 * transaction. Leaves the database ready for a clean re-import.
 *
 * DESTRUCTIVE and unscoped (all users' ingested data). The controller gates it
 * behind an exact confirm literal; there is deliberately no partial mode — a
 * partial reset is what desynchronizes the dedup table from the hypertable.
 *
 * The importer keeps its own push watermark (`ci_server.last_push` in its
 * SQLite settings table) — reset that too or the next sync pushes nothing.
 * See db/postgres/INGEST_RESET_RUNBOOK.md.
 */
@Injectable()
export class IngestResetService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(IngestResetService.name);
  }

  async reset(): Promise<IngestResetResult> {
    const targets = [
      ...INGEST_TABLES.map(({ schema, table }) => ({ schema, table })),
      ...SEARCH_TABLES.map(({ schema, table }) => ({ schema, table })),
    ];

    const result = await this.dataSource.transaction(async (manager) => {
      const countsBefore: Record<string, number> = {};

      for (const { schema, table } of targets) {
        const rows = (await manager.query(
          `SELECT count(*)::bigint AS count FROM "${schema}"."${table}"`,
        )) as Array<{ count: string }>;

        countsBefore[`${schema}.${table}`] = Number(rows[0]?.count ?? 0);
      }

      // One statement for the ci.* set so FK references among them cannot
      // order-fail; CASCADE also clears any dependent rows outside the list.
      const ingestRefs = INGEST_TABLES.map(({ schema, table }) => `"${schema}"."${table}"`);
      await manager.query(`TRUNCATE TABLE ${ingestRefs.join(', ')} RESTART IDENTITY CASCADE`);

      // The ci_search index tables carry no FK edges — plain truncates, same as
      // OrphanCleanupService.truncateSearchIndex but inside THIS transaction.
      for (const { schema, table } of SEARCH_TABLES) {
        await manager.query(`TRUNCATE TABLE "${schema}"."${table}"`);
      }

      // Drop the not-yet-run index jobs: they reference rows that no longer
      // exist and would drain as pure entity-not-found noise. Completed/failed
      // history is left alone.
      const deleteResult = (await manager.query(
        `DELETE FROM pgboss.job WHERE name = $1 AND state IN ('created', 'active', 'retry')`,
        [SEARCH_INDEX_QUEUE],
      )) as unknown;
      // node-postgres DELETE returns [[], affectedRowCount]; normalise both shapes.
      const searchIndexJobsDeleted = Array.isArray(deleteResult) ? Number(deleteResult[1] ?? 0) : 0;

      return {
        countsBefore,
        truncated: targets.map(({ schema, table }) => `${schema}.${table}`),
        searchIndexJobsDeleted,
      };
    });

    this.logger.warn('Ingest reset executed — all ingested data truncated', {
      countsBefore: result.countsBefore,
      searchIndexJobsDeleted: result.searchIndexJobsDeleted,
    });

    return result;
  }
}

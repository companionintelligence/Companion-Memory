import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { INDEXABLE_ENTITIES, type IndexableEntity } from '@ci/domains/search-next';

import { ENTITY_SOURCE_MAP, type EntitySource } from '../entitySourceMap';

/**
 * `ci_search` tables that hold `(entity_type, entity_id)`-keyed index rows and so
 * can accumulate orphans / must be truncated on a data reset.
 */
const SEARCH_TABLES = [
  { schema: 'ci_search', table: 'embeddings' },
  { schema: 'ci_search', table: 'vectors' },
] as const;

type SearchTable = (typeof SEARCH_TABLES)[number];

/** Per-(table, type) orphan-deletion tally. */
export interface OrphanTypeResult {
  searchTable: string;
  entityType: IndexableEntity;
  deleted: number;
}

export interface OrphanCleanupResult {
  /** Per-(table, type) counts of orphan index rows deleted. */
  results: OrphanTypeResult[];
  /** Sum of every `deleted` above. */
  totalDeleted: number;
  /** True when this was a dry run (counted, did not delete). */
  dryRun: boolean;
}

export interface OrphanCleanupOptions {
  /**
   * Max rows to delete per statement. Bounds lock footprint + transaction size so
   * this is safe to run against the live index without a long lock. Default 5000.
   */
  batchSize?: number;
  /**
   * Restrict the sweep to these entity types (default: all INDEXABLE_ENTITIES).
   */
  entityTypes?: IndexableEntity[];
  /**
   * Count orphans without deleting them. Useful to size a cleanup before running.
   */
  dryRun?: boolean;
}

export interface TruncateSearchIndexResult {
  truncated: string[];
}

const DEFAULT_BATCH_SIZE = 5000;

/**
 * Maintenance routine that keeps `ci_search.embeddings` / `ci_search.vectors`
 * consistent with the source rows they index.
 *
 * Two concerns, both re-runnable and safe against the live index:
 *
 *  1. {@link cleanOrphans} — deletes index rows whose `entity_id` no longer
 *     exists in its source table (per the {@link ENTITY_SOURCE_MAP}). This is the
 *     historical-orphan backfill complementing the per-event cascade-delete the
 *     `*SearchIndexListener`s now do on `*RemovedEvent`.
 *
 *  2. {@link truncateSearchIndex} — wipes both index tables wholesale. A data
 *     reset MUST call this (or otherwise truncate `ci_search`) or it re-orphans
 *     the whole index: the reset clears `ci.*` but the index keeps pointing at
 *     the now-deleted rows.
 *
 * All identifiers come from the trusted internal {@link ENTITY_SOURCE_MAP}, never
 * from request input, so they are safe to interpolate; row values are always
 * bound parameters.
 */
@Injectable()
export class OrphanCleanupService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(OrphanCleanupService.name);
  }

  /**
   * Sweep `ci_search.embeddings` and `ci_search.vectors` for rows whose source
   * row no longer exists, deleting them in bounded batches per entity type.
   * Idempotent and re-runnable: a clean index deletes nothing.
   */
  async cleanOrphans(options: OrphanCleanupOptions = {}): Promise<OrphanCleanupResult> {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const entityTypes = options.entityTypes ?? [...INDEXABLE_ENTITIES];
    const dryRun = options.dryRun ?? false;

    if (batchSize <= 0) {
      throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
    }

    const results: OrphanTypeResult[] = [];

    for (const searchTable of SEARCH_TABLES) {
      for (const entityType of entityTypes) {
        const source = ENTITY_SOURCE_MAP[entityType];

        if (source == null) {
          // Defensive: the compile-time guard in entitySourceMap already prevents
          // this, but never silently skip a type we were asked to clean.
          throw new Error(`No source mapping for entity type "${entityType}"`);
        }

        const deleted = dryRun
          ? await this.countOrphans(searchTable, entityType, source)
          : await this.deleteOrphans(searchTable, entityType, source, batchSize);

        if (deleted > 0) {
          this.logger.log(dryRun ? 'Counted orphan index rows' : 'Deleted orphan index rows', {
            searchTable: `${searchTable.schema}.${searchTable.table}`,
            entityType,
            deleted,
          });
        }

        results.push({
          searchTable: `${searchTable.schema}.${searchTable.table}`,
          entityType,
          deleted,
        });
      }
    }

    const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);

    this.logger.log(dryRun ? 'Orphan cleanup dry run complete' : 'Orphan cleanup complete', {
      totalDeleted,
      dryRun,
    });

    return { results, totalDeleted, dryRun };
  }

  /**
   * Truncate both `ci_search` index tables. Use as part of a full data reset so
   * the cleared `ci.*` data does not leave a fully-orphaned index behind.
   */
  async truncateSearchIndex(): Promise<TruncateSearchIndexResult> {
    const truncated: string[] = [];

    for (const { schema, table } of SEARCH_TABLES) {
      const qualified = `"${schema}"."${table}"`;
      await this.dataSource.query(`TRUNCATE TABLE ${qualified}`);
      truncated.push(`${schema}.${table}`);
      this.logger.log('Truncated search index table', { table: `${schema}.${table}` });
    }

    return { truncated };
  }

  /**
   * Build the `EXISTS (SELECT 1 FROM <source> …)` predicate that is TRUE when the
   * index row's source row still exists. The caller negates it to find orphans.
   * `$1` is bound to `entity_type`; the source-existence subquery correlates on
   * the index row's `entity_id`, plus the discriminator value (bound as `$2`)
   * when the source table is multi-type.
   */
  private buildSourceExistsClause(
    searchAlias: string,
    source: EntitySource,
  ): { clause: string; discriminatorParam: string | null } {
    const sourceRef = `"${source.schema}"."${source.table}"`;
    const idMatch = `src."${source.idColumn}"::text = ${searchAlias}.entity_id::text`;

    if (source.discriminator) {
      return {
        clause: `EXISTS (SELECT 1 FROM ${sourceRef} src WHERE ${idMatch} AND src."${source.discriminator.column}" = $2)`,
        discriminatorParam: source.discriminator.value,
      };
    }

    return {
      clause: `EXISTS (SELECT 1 FROM ${sourceRef} src WHERE ${idMatch})`,
      discriminatorParam: null,
    };
  }

  private async deleteOrphans(
    searchTable: SearchTable,
    entityType: IndexableEntity,
    source: EntitySource,
    batchSize: number,
  ): Promise<number> {
    const searchRef = `"${searchTable.schema}"."${searchTable.table}"`;
    const { clause, discriminatorParam } = this.buildSourceExistsClause('s', source);

    // Delete in bounded batches: select up to `batchSize` orphan ids (PK `id`)
    // and delete exactly those, looping until a batch comes back short. This caps
    // the lock + WAL footprint of each statement so the sweep is safe online.
    const sql = `
      WITH victims AS (
        SELECT s.id
        FROM ${searchRef} s
        WHERE s.entity_type = $1
          AND NOT ${clause}
        LIMIT ${batchSize}
      )
      DELETE FROM ${searchRef} t
      USING victims
      WHERE t.id = victims.id
    `;

    const params: string[] = [entityType];

    if (discriminatorParam != null) {
      params.push(discriminatorParam);
    }

    let total = 0;

    for (;;) {
      const result = await this.dataSource.query(sql, params);
      // node-postgres DELETE returns [[], affectedRowCount]; normalise both shapes.
      const affected = Array.isArray(result) ? (result[1] ?? 0) : 0;

      total += affected;

      if (affected < batchSize) {
        break;
      }
    }

    return total;
  }

  private async countOrphans(
    searchTable: SearchTable,
    entityType: IndexableEntity,
    source: EntitySource,
  ): Promise<number> {
    const searchRef = `"${searchTable.schema}"."${searchTable.table}"`;
    const { clause, discriminatorParam } = this.buildSourceExistsClause('s', source);

    const sql = `
      SELECT COUNT(*)::int AS count
      FROM ${searchRef} s
      WHERE s.entity_type = $1
        AND NOT ${clause}
    `;

    const params: string[] = [entityType];

    if (discriminatorParam != null) {
      params.push(discriminatorParam);
    }

    const rows = await this.dataSource.query(sql, params);

    return rows[0]?.count ?? 0;
  }
}

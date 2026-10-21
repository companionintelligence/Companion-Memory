import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { INDEXABLE_ENTITIES, type IndexableEntity } from '@ci/domains/search-next';

import { ENTITY_SOURCE_MAP, type EntitySource } from '../entitySourceMap';

/**
 * `ci_search` tables that hold `(entity_type, entity_id)`-keyed index rows and so
 * can accumulate orphans / must be truncated on a data reset. `keyColumns` is the
 * table's primary key — embeddings/vectors have a surrogate uuid `id`, while
 * index_skips is keyed directly on the `(entity_type, entity_id)` pair — used by
 * the batched orphan delete to address exactly the victim rows.
 *
 * Exported so a data reset (maintenance ingest/reset) truncates the SAME set of
 * tables — drift here is how a reset leaves a fully-orphaned index behind.
 */
export const SEARCH_TABLES = [
  { schema: 'ci_search', table: 'embeddings', keyColumns: ['id'] },
  // Before `vectors`: it references vectors(id) ON DELETE CASCADE, so the
  // orphan sweep finds nothing here that the vectors pass would not also take,
  // but TRUNCATE refuses a table another one still points at.
  { schema: 'ci_search', table: 'mobile_search_documents', keyColumns: ['id'] },
  { schema: 'ci_search', table: 'vectors', keyColumns: ['id'] },
  { schema: 'ci_search', table: 'index_skips', keyColumns: ['entity_type', 'entity_id'] },
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
  /**
   * Per-statement ceiling, applied to the connection this sweep pins. Default
   * {@link DEFAULT_ORPHAN_STATEMENT_TIMEOUT_MS}.
   */
  statementTimeoutMs?: number;
}

export interface TruncateSearchIndexResult {
  truncated: string[];
  /** `ci.pipeline_state` rows of the index stages re-opened so the pipeline re-embeds them. */
  ledgerRowsReopened: number;
}

/**
 * Re-open the index stages' decided ledger rows: `stage_version` back to 0 on
 * every `done` / `skipped` row of an `index.*` stage (`index.embed*`,
 * `index.vector*`), the same move as `PipelineStateService.reopen`. `$1` is a
 * user id, or NULL for every account.
 *
 * Needed by anything that empties `ci_search` without emptying the sources.
 * The ledger is how the pipeline decides what is left to index, and both it
 * and `SearchIndexBackfillService` skip an entity whose ledger row says the
 * stage is done. Truncate the index and leave the ledger, and those entities
 * stay unsearchable however many backfills run. A re-opened row satisfies the
 * sweep's `stage_version < current` arm, so the next index sweep embeds it
 * again. `running` rows are live claims and `failed` rows have their own
 * retry gate, so both are left alone.
 *
 * Wrapped in a CTE so the driver returns rows rather than `[rows, count]`
 * (see `PipelineStateService.reopen`).
 */
export const REOPEN_INDEX_LEDGER_SQL = `
  WITH reopened AS (
    UPDATE ci.pipeline_state
       SET stage_version = 0,
           updated_at    = now()
     WHERE stage LIKE 'index.%'
       AND status IN ('done', 'skipped')
       AND stage_version > 0
       AND ($1::uuid IS NULL OR user_id = $1::uuid)
    RETURNING 1
  )
  SELECT count(*)::int AS count FROM reopened`;

const DEFAULT_BATCH_SIZE = 5000;

/**
 * Per-statement ceiling for the sweep, matching the one
 * `EmbedCoverageTelemetryService` puts on its nightly counts.
 *
 * The sweep issues up to 54 statements (3 index tables x 18 indexable types)
 * per pass, each an anti-join between an index table and a source table, and it
 * runs unattended at 02:50. Without a ceiling one pathological plan pins a
 * connection out of a 25-connection pool for as long as it likes. A statement
 * that exceeds this throws, which surfaces as a failed tick in `ci.cron_runs` —
 * the honest signal — rather than a sweep nobody can see is stuck.
 */
export const DEFAULT_ORPHAN_STATEMENT_TIMEOUT_MS = 120_000;

/** Runs one statement on the connection the sweep has pinned. */
type Executor = (sql: string, params?: unknown[]) => Promise<unknown>;

/**
 * Maintenance routine that keeps `ci_search.embeddings` / `ci_search.vectors` /
 * `ci_search.index_skips` consistent with the source rows they index.
 *
 * Two concerns, both re-runnable and safe against the live index:
 *
 *  1. {@link cleanOrphans} — deletes index rows whose `entity_id` no longer
 *     exists in its source table (per the {@link ENTITY_SOURCE_MAP}). This is the
 *     historical-orphan backfill complementing the per-event cascade-delete the
 *     `*SearchIndexListener`s now do on `*RemovedEvent`.
 *
 *  2. {@link truncateSearchIndex} — wipes the index tables wholesale. A data
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
   * Sweep every {@link SEARCH_TABLES} table (embeddings, vectors, index_skips)
   * for rows whose source row no longer exists, deleting them in bounded batches
   * per entity type. Skip markers are reaped like index rows: a deleted entity's
   * marker is dead weight, and reaping it means a re-created entity with the same
   * id is re-examined rather than silently treated as skipped.
   * Idempotent and re-runnable: a clean index deletes nothing.
   *
   * Every statement runs on ONE pinned connection under a
   * {@link DEFAULT_ORPHAN_STATEMENT_TIMEOUT_MS} ceiling, rather than taking a
   * fresh connection out of the pool 54 times with no bound on how long each
   * holds it.
   */
  async cleanOrphans(options: OrphanCleanupOptions = {}): Promise<OrphanCleanupResult> {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const entityTypes = options.entityTypes ?? [...INDEXABLE_ENTITIES];
    const dryRun = options.dryRun ?? false;
    const timeoutMs = options.statementTimeoutMs ?? DEFAULT_ORPHAN_STATEMENT_TIMEOUT_MS;

    if (batchSize <= 0) {
      throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
    }

    const results: OrphanTypeResult[] = [];

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    const execute: Executor = (sql, params) => runner.query(sql, params);

    try {
      // Session-scoped, not SET LOCAL: the runner owns this connection until
      // release, and the batched delete deliberately runs each batch as its own
      // transaction, so there is no enclosing one to scope the GUC to.
      await execute(`SET statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);

      for (const searchTable of SEARCH_TABLES) {
        for (const entityType of entityTypes) {
          const source = ENTITY_SOURCE_MAP[entityType];

          if (source == null) {
            // Defensive: the compile-time guard in entitySourceMap already prevents
            // this, but never silently skip a type we were asked to clean.
            throw new Error(`No source mapping for entity type "${entityType}"`);
          }

          const deleted = dryRun
            ? await this.countOrphans(searchTable, entityType, source, execute)
            : await this.deleteOrphans(searchTable, entityType, source, batchSize, execute);

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
    } finally {
      // RESET before release so the pooled connection goes back unmodified even
      // when a statement threw.
      await execute('RESET statement_timeout').catch(() => undefined);
      await runner.release();
    }

    const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);

    this.logger.log(dryRun ? 'Orphan cleanup dry run complete' : 'Orphan cleanup complete', {
      totalDeleted,
      dryRun,
    });

    return { results, totalDeleted, dryRun };
  }

  /**
   * Truncate every `ci_search` index table (embeddings, vectors, index_skips).
   * Use as part of a full data reset so the cleared `ci.*` data does not leave a
   * fully-orphaned index behind.
   */
  async truncateSearchIndex(): Promise<TruncateSearchIndexResult> {
    // One transaction: the index and the ledger that says what is in it move
    // together, or not at all. See REOPEN_INDEX_LEDGER_SQL for why the ledger
    // has to move.
    return this.dataSource.transaction(async (manager) => {
      const truncated: string[] = [];

      for (const { schema, table } of SEARCH_TABLES) {
        await manager.query(`TRUNCATE TABLE "${schema}"."${table}"`);
        truncated.push(`${schema}.${table}`);
      }

      const reopened = (await manager.query(REOPEN_INDEX_LEDGER_SQL, [null])) as Array<{ count: number }>;
      const ledgerRowsReopened = Number(reopened[0]?.count ?? 0);

      this.logger.log('Truncated the search index and re-opened its ledger', {
        truncated,
        ledgerRowsReopened,
      });

      return { truncated, ledgerRowsReopened };
    });
  }

  /**
   * Build the `EXISTS (SELECT 1 FROM <source> …)` predicate that is TRUE when the
   * index row's source row still exists. The caller negates it to find orphans.
   * `$1` is bound to `entity_type`; the source-existence subquery correlates on
   * the index row's `entity_id`, plus the discriminator value (bound as `$2`)
   * when the source table is multi-type.
   *
   * The correlation is uuid = uuid, UNCAST, and that is the whole performance
   * story. `ci_search.{embeddings,vectors,index_skips}.entity_id` is `uuid` and
   * every `ENTITY_SOURCE_MAP` id column is the uuid primary key of its table, so
   * `::text` on both sides was gratuitous — and fatal: casting the source side
   * makes the PK index unusable, and the planner falls back to hashing the ENTIRE
   * source table to anti-join against a couple of hundred index rows (measured:
   * 400k-row seq scan + 1.3k temp blocks, vs an index-only probe per index row).
   * A source column that is ever NOT uuid needs its own branch here; it must not
   * bring the symmetric cast back.
   */
  private buildSourceExistsClause(
    searchAlias: string,
    source: EntitySource,
  ): { clause: string; discriminatorParam: string | null } {
    const sourceRef = `"${source.schema}"."${source.table}"`;
    const idMatch = `src."${source.idColumn}" = ${searchAlias}.entity_id`;

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
    execute: Executor,
  ): Promise<number> {
    const searchRef = `"${searchTable.schema}"."${searchTable.table}"`;
    const { clause, discriminatorParam } = this.buildSourceExistsClause('s', source);
    const keyColumns = searchTable.keyColumns.map((column) => `"${column}"`);

    // Delete in bounded batches: select up to `batchSize` orphan primary keys
    // and delete exactly those, looping until a batch comes back short. This caps
    // the lock + WAL footprint of each statement so the sweep is safe online.
    const sql = `
      WITH victims AS (
        SELECT ${keyColumns.map((column) => `s.${column}`).join(', ')}
        FROM ${searchRef} s
        WHERE s.entity_type = $1
          AND NOT ${clause}
        LIMIT ${batchSize}
      )
      DELETE FROM ${searchRef} t
      USING victims
      WHERE ${keyColumns.map((column) => `t.${column} = victims.${column}`).join(' AND ')}
    `;

    const params: string[] = [entityType];

    if (discriminatorParam != null) {
      params.push(discriminatorParam);
    }

    let total = 0;

    for (;;) {
      const result = await execute(sql, params);
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
    execute: Executor,
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

    const rows = (await execute(sql, params)) as Array<{ count: number }>;

    return rows[0]?.count ?? 0;
  }
}

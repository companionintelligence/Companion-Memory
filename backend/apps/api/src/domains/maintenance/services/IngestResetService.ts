import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { SEARCH_TABLES } from '@ci/domains/search-ingress';

/** The pgboss queue the *SearchIndexListeners consume (see SearchIndexBackfillService). */
const SEARCH_INDEX_QUEUE = 'search-index';

/**
 * Bulk-ingest destination tables cleared by a reset, DEPENDENTS FIRST.
 *
 * They go out in one `TRUNCATE ... CASCADE`, which is order-insensitive, so the
 * ordering is documentation rather than mechanism — but it is the ordering a
 * per-table delete would need, and getting it wrong here is how someone later
 * splits the statement and discovers the FK graph the hard way. The object
 * plane's edges:
 *
 *   ci.object_observations  -> ci.objects, ci.product_models
 *   ci.receipt_line_items   -> ci.receipts (CASCADE), ci.objects, ci.product_models
 *   ci.receipts             -> ci.events
 *   ci.objects            -> ci.product_models, ci.receipts, ci.receipt_line_items
 *   ci.product_models       -> (nothing in this set)
 *
 * `ci.objects` and `ci.receipt_line_items` reference EACH OTHER
 * (acquisition_line_item_id / minted_object_id), so no order satisfies both —
 * which is the concrete reason this has to be one CASCADE statement and cannot
 * become a delete loop.
 */
const INGEST_TABLES = [
  { schema: 'ci', table: 'events' },
  { schema: 'ci', table: 'communications' },
  { schema: 'ci', table: 'content' },
  { schema: 'ci', table: 'browser_activity' },
  { schema: 'ci', table: 'object_observations' },
  { schema: 'ci', table: 'receipt_line_items' },
  { schema: 'ci', table: 'receipts' },
  { schema: 'ci', table: 'objects' },
  { schema: 'ci', table: 'product_models' },
] as const;

/**
 * Every table this reset TRUNCATES that carries a `user_id`, checked before it
 * runs so the wipe can never take data belonging to someone other than the
 * caller.
 *
 * `ci_search.index_skips` is deliberately absent: it has no `user_id` because
 * it records only that an (entity_type, entity_id) pair was examined and not
 * embedded. Losing it costs a re-examination, not data.
 */
const USER_SCOPED_TABLES = [
  ...INGEST_TABLES,
  { schema: 'ci_search', table: 'embeddings' },
  { schema: 'ci_search', table: 'vectors' },
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
 * Full ingest reset: wipe every bulk-ingest destination table, the whole
 * `ci_search` index (embeddings, vectors, index_skips — via the shared
 * {@link SEARCH_TABLES} list, so the two can't drift), and the not-yet-run
 * `search-index` queue jobs, all in ONE transaction. Leaves the database
 * ready for a clean re-import.
 *
 * DESTRUCTIVE and TABLE-WIDE — it truncates, so it cannot take only one user's
 * rows. There is deliberately no partial mode: a partial reset desynchronizes
 * tables that dedupe against each other.
 *
 * Which is why {@link assertNobodyElsesData} runs first. The route is behind
 * ordinary user auth (there is no admin role on this appliance) and an exact
 * confirm literal, and neither of those says anything about WHOSE data is
 * about to go: any signed-in account could wipe every other account's imported
 * memory in one call. So the reset now refuses unless the caller is the only
 * person with data in the tables it would clear — which is the normal state of
 * a personal appliance, and a refusal with a clear reason on any box where it
 * is not.
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

  async reset(ctx: UserServiceContext): Promise<IngestResetResult> {
    await this.assertNobodyElsesData(ctx.userId);

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

      // Object/event/communication rows are CTI aggregates: each detail
      // row has a discriminated base row in ci.entities sharing its uuid.
      // TRUNCATE only follows FKs POINTING AT the truncated tables, so the
      // base rows survive it — delete them explicitly or the reset strands
      // orphan base entities.
      //
      // Scoped by provenance (linked_table): 'Item'/'Event'/'Communication'
      // entities created by graph ingest (linked_table 'import:<source>') are
      // real graph entities, not mirrors of the truncated tables, and must
      // survive the reset.
      //
      // Bulk CTI base delete — no GraphDeltaWriter call (maintenance reset is
      // not a user-visible graph change; writers only fire on app domain paths).
      await manager.query(
        `DELETE FROM ci.entities
         WHERE entity_type IN ('Item', 'Event', 'Communication')
           AND linked_table IN ('objects', 'events', 'communications')`,
      );

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
      userId: ctx.userId,
      countsBefore: result.countsBefore,
      searchIndexJobsDeleted: result.searchIndexJobsDeleted,
    });

    return result;
  }

  /**
   * Refuse the reset when it would destroy someone else's rows.
   *
   * One bounded probe per table — `EXISTS` over a `user_id <> $1` predicate, so
   * it stops at the first foreign row rather than counting a hypertable. The
   * message names the tables rather than the users: which accounts exist is not
   * this caller's business, but "there is other data here" is exactly what they
   * need to know to stop.
   */
  private async assertNobodyElsesData(userId: string): Promise<void> {
    const occupied: string[] = [];

    for (const { schema, table } of USER_SCOPED_TABLES) {
      const rows = (await this.dataSource.query(
        `SELECT EXISTS (SELECT 1 FROM "${schema}"."${table}" WHERE user_id <> $1::uuid) AS present`,
        [userId],
      )) as Array<{ present: boolean }>;

      if (rows[0]?.present === true) {
        occupied.push(`${schema}.${table}`);
      }
    }

    if (occupied.length === 0) {
      return;
    }

    throw new ForbiddenException(
      `This reset truncates whole tables, and ${occupied.join(', ')} still hold another user's ` +
        `rows — running it would delete their imported memory too. Remove the other accounts' data ` +
        `first, or perform the reset directly against the database (db/postgres/INGEST_RESET_RUNBOOK.md).`,
    );
  }
}

import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { PgErrorCode } from '@ci/common/constants';
import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { REOPEN_INDEX_LEDGER_SQL, SEARCH_TABLES } from '@ci/domains/search-ingress';

/** The pgboss queue the *SearchIndexListeners consume (see SearchIndexBackfillService). */
const SEARCH_INDEX_QUEUE = 'search-index';

/**
 * How long the reset waits for its table locks before giving up. It takes
 * ACCESS EXCLUSIVE on every table it clears, and a lock request that waits also
 * blocks every reader queued behind it, so on a busy appliance it is better to
 * fail and say so than to stall the app while it waits.
 */
const LOCK_TIMEOUT = '15s';

/**
 * Turn the lock timeout into a 409 that says what happened. Left alone it is a
 * bare QueryFailedError (55P03), which the client sees as a 500 and Sentry
 * records as a crash, when all it means is "the appliance is busy, nothing was
 * changed, try again".
 */
function lockTimeoutAsConflict(error: unknown): unknown {
  const { code, driverError } = (error ?? {}) as { code?: unknown; driverError?: { code?: unknown } };

  if (code !== PgErrorCode.LOCK_NOT_AVAILABLE && driverError?.code !== PgErrorCode.LOCK_NOT_AVAILABLE) {
    return error;
  }

  return new ConflictException(
    `The reset could not lock the tables it clears within ${LOCK_TIMEOUT}, because other work is ` +
      'using them. Nothing was changed. Try again when the appliance is idle.',
  );
}

interface TableRef {
  schema: string;
  table: string;
}

/**
 * Bulk-ingest destination tables cleared by a reset, DEPENDENTS FIRST.
 *
 * They go out in one `TRUNCATE`, which is order-insensitive, so the ordering is
 * documentation rather than mechanism. But it is the ordering a per-table
 * delete would need, and getting it wrong here is how someone later splits the
 * statement and discovers the FK graph the hard way. The object plane's edges:
 *
 *   ci.object_observations  -> ci.objects, ci.product_models
 *   ci.receipt_line_items   -> ci.receipts (CASCADE), ci.objects, ci.product_models
 *   ci.receipts             -> ci.events
 *   ci.objects            -> ci.product_models, ci.receipts, ci.receipt_line_items
 *   ci.product_models       -> (nothing in this set)
 *
 * `ci.objects` and `ci.receipt_line_items` reference EACH OTHER
 * (acquisition_line_item_id / minted_object_id), so no order satisfies both —
 * which is the concrete reason this has to be one statement and cannot become
 * a delete loop.
 */
const INGEST_TABLES: readonly TableRef[] = [
  { schema: 'ci', table: 'events' },
  { schema: 'ci', table: 'communications' },
  { schema: 'ci', table: 'content' },
  { schema: 'ci', table: 'browser_activity' },
  { schema: 'ci', table: 'object_observations' },
  { schema: 'ci', table: 'receipt_line_items' },
  { schema: 'ci', table: 'receipts' },
  { schema: 'ci', table: 'objects' },
  { schema: 'ci', table: 'product_models' },
];

/**
 * Every table with a foreign key into {@link INGEST_TABLES}, followed
 * transitively. Postgres will not truncate a table another table references
 * unless that one is truncated in the same statement, so these are emptied
 * whole by the reset too. They always were, through `CASCADE`, without being
 * named or checked.
 *
 * Naming them is the point. The statement has no `CASCADE` any more, so a
 * foreign key added later into an ingest table makes the reset FAIL with
 * "cannot truncate a table referenced in a foreign key constraint" rather than
 * silently empty one more table for every account. Add the table here (and
 * think about whose rows it holds) when that happens.
 *
 * What the caller loses with them, beyond the ingested rows: uploaded files
 * (`ci.files`, the bytes stay in object storage), their document chunks, chat
 * attachments and link previews, every reminder, the capture-event log,
 * planning candidates, and HBPE's per-content context and cluster links.
 *
 * `ownedVia`: the three tables with no user column. Each has a NOT NULL foreign
 * key into a probed table, so once that table holds only the caller's rows,
 * so do they.
 */
const DEPENDENT_TABLES: ReadonlyArray<TableRef & { ownedVia?: string }> = [
  { schema: 'ci', table: 'message_files', ownedVia: 'ci.files (file_id)' },
  { schema: 'ci', table: 'file_chunks' },
  { schema: 'ci', table: 'unfurls' },
  { schema: 'ci', table: 'files' },
  { schema: 'ci', table: 'reminders' },
  { schema: 'ci', table: 'capture_events' },
  { schema: 'ci', table: 'event_candidates' },
  { schema: 'hbpe', table: 'content_context' },
  { schema: 'hbpe', table: 'l1_event_cluster', ownedVia: 'ci.events (event_id)' },
  { schema: 'hbpe', table: 'l2_content_cluster', ownedVia: 'ci.content (content_id)' },
];

/**
 * Every table the reset empties that says whose rows it holds, probed for
 * another account's rows before anything is cleared.
 *
 * `ci_search.index_skips` is deliberately absent: it has no `user_id` because
 * it records only that an (entity_type, entity_id) pair was examined and not
 * embedded. Losing it costs a re-examination, not data.
 */
const USER_SCOPED_TABLES: readonly TableRef[] = [
  ...INGEST_TABLES,
  ...DEPENDENT_TABLES.filter((ref) => ref.ownedVia === undefined),
  { schema: 'ci_search', table: 'embeddings' },
  { schema: 'ci_search', table: 'vectors' },
];

const qualified = ({ schema, table }: TableRef): string => `"${schema}"."${table}"`;
const named = ({ schema, table }: TableRef): string => `${schema}.${table}`;

export interface IngestResetResult {
  /** Row count per (schema-qualified) table at the moment before truncation. */
  countsBefore: Record<string, number>;
  /** Every table truncated, schema-qualified, in execution order. */
  truncated: string[];
  /** This caller's pending ('created'/'active'/'retry') search-index pgboss jobs deleted. */
  searchIndexJobsDeleted: number;
  /** This caller's index-stage ledger rows re-opened so the pipeline re-embeds what remains. */
  ledgerRowsReopened: number;
}

/**
 * Full ingest reset: wipe every bulk-ingest destination table and every table
 * that hangs off them by foreign key, the whole `ci_search` index (embeddings,
 * vectors, index_skips, from the shared {@link SEARCH_TABLES} list so the two
 * can't drift), and this caller's not-yet-run `search-index` queue jobs, all
 * in ONE transaction. Leaves the database ready for a clean re-import.
 *
 * DESTRUCTIVE and TABLE-WIDE — it truncates, so it cannot take only one user's
 * rows. There is deliberately no partial mode: a partial reset desynchronizes
 * tables that dedupe against each other.
 *
 * Which is why {@link assertNobodyElsesData} runs first, inside the same
 * transaction and after every table is locked: the reset refuses unless the
 * caller is the only person with data in ANY table it would clear, which is
 * the normal state of a personal appliance and a refusal with a clear reason
 * on any box where it is not. It used to probe the eleven tables it named on
 * its own connection before the transaction opened, while `TRUNCATE ...
 * CASCADE` also emptied ten tables it never looked at, for every account, and
 * rows could land between the probe and the truncate.
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
    const truncateTargets: TableRef[] = [...INGEST_TABLES, ...DEPENDENT_TABLES];
    const targets: TableRef[] = [
      ...truncateTargets,
      ...SEARCH_TABLES.map(({ schema, table }) => ({ schema, table })),
    ];

    const resetting = this.dataSource.transaction(async (manager) => {
      // Lock first, probe second: nothing can write a row into these tables
      // between the check and the truncate. TRUNCATE takes the same lock, so
      // this widens nothing; it only moves the lock ahead of the probe.
      await manager.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await manager.query(`LOCK TABLE ${targets.map(qualified).join(', ')} IN ACCESS EXCLUSIVE MODE`);

      await this.assertNobodyElsesData(manager, ctx.userId);

      const countsBefore: Record<string, number> = {};

      for (const ref of targets) {
        const rows = (await manager.query(
          `SELECT count(*)::bigint AS count FROM ${qualified(ref)}`,
        )) as Array<{
          count: string;
        }>;

        countsBefore[named(ref)] = Number(rows[0]?.count ?? 0);
      }

      // One statement for the ci.* set so FK references among them cannot
      // order-fail. No CASCADE: see DEPENDENT_TABLES.
      await manager.query(`TRUNCATE TABLE ${truncateTargets.map(qualified).join(', ')} RESTART IDENTITY`);

      // Object/event/communication rows are CTI aggregates: each detail
      // row has a discriminated base row in ci.entities sharing its uuid.
      // TRUNCATE only follows FKs POINTING AT the truncated tables, so the
      // base rows survive it — delete them explicitly or the reset strands
      // orphan base entities.
      //
      // Scoped by provenance (linked_table): 'Item'/'Event'/'Communication'
      // entities created by graph ingest (linked_table 'import:<source>') are
      // real graph entities, not mirrors of the truncated tables, and must
      // survive the reset. And scoped to the caller: ci.entities is the whole
      // household's graph, and another account's base rows are not this
      // reset's to remove.
      //
      // Bulk CTI base delete — no GraphDeltaWriter call (maintenance reset is
      // not a user-visible graph change; writers only fire on app domain paths).
      await manager.query(
        `DELETE FROM ci.entities
         WHERE entity_type IN ('Item', 'Event', 'Communication')
           AND linked_table IN ('objects', 'events', 'communications')
           AND owner_user_id = $1::uuid`,
        [ctx.userId],
      );

      // The ci_search index tables carry no FK edges — plain truncates, same as
      // OrphanCleanupService.truncateSearchIndex but inside THIS transaction.
      for (const ref of SEARCH_TABLES) {
        await manager.query(`TRUNCATE TABLE ${qualified(ref)}`);
      }

      // The caller's other rows (notes, people, messages...) lost their index
      // entries with that truncate. Re-open their ledger so the pipeline embeds
      // them again; see REOPEN_INDEX_LEDGER_SQL.
      const reopened = (await manager.query(REOPEN_INDEX_LEDGER_SQL, [ctx.userId])) as Array<{
        count: number;
      }>;

      // Drop the caller's not-yet-run index jobs: they reference rows that no
      // longer exist and would drain as pure entity-not-found noise. Another
      // account's jobs, and jobs whose payload names no account (the backfill
      // sends only an id), are left to run: for a row that no longer exists
      // they are a no-op. Completed/failed history is left alone.
      const deleteResult = (await manager.query(
        `DELETE FROM pgboss.job
          WHERE name = $1
            AND state IN ('created', 'active', 'retry')
            AND data->>'userId' = $2`,
        [SEARCH_INDEX_QUEUE, ctx.userId],
      )) as unknown;
      // node-postgres DELETE returns [[], affectedRowCount]; normalise both shapes.
      const searchIndexJobsDeleted = Array.isArray(deleteResult) ? Number(deleteResult[1] ?? 0) : 0;

      return {
        countsBefore,
        truncated: targets.map(named),
        searchIndexJobsDeleted,
        ledgerRowsReopened: Number(reopened[0]?.count ?? 0),
      };
    });

    const result = await resetting.catch((error: unknown) => {
      throw lockTimeoutAsConflict(error);
    });

    this.logger.warn('Ingest reset executed — all ingested data truncated', {
      userId: ctx.userId,
      countsBefore: result.countsBefore,
      searchIndexJobsDeleted: result.searchIndexJobsDeleted,
      ledgerRowsReopened: result.ledgerRowsReopened,
    });

    return result;
  }

  /**
   * Refuse the reset when it would destroy someone else's rows.
   *
   * One bounded probe per table — `EXISTS` over a `user_id <> $1` predicate, so
   * it stops at the first foreign row rather than counting a hypertable. Runs
   * on the reset's own transaction, after the locks, so what it saw is what
   * the truncate takes. The message names the tables rather than the users:
   * which accounts exist is not this caller's business, but "there is other
   * data here" is exactly what they need to know to stop.
   */
  private async assertNobodyElsesData(manager: Pick<EntityManager, 'query'>, userId: string): Promise<void> {
    const occupied: string[] = [];

    for (const ref of USER_SCOPED_TABLES) {
      const rows = (await manager.query(
        `SELECT EXISTS (SELECT 1 FROM ${qualified(ref)} WHERE user_id <> $1::uuid) AS present`,
        [userId],
      )) as Array<{ present: boolean }>;

      if (rows[0]?.present === true) {
        occupied.push(named(ref));
      }
    }

    if (occupied.length === 0) {
      return;
    }

    throw new ForbiddenException(
      `This reset truncates whole tables, and ${occupied.join(', ')} still hold another user's ` +
        `rows, so running it would delete their data too. Remove the other accounts' data ` +
        `first, or perform the reset directly against the database (db/postgres/INGEST_RESET_RUNBOOK.md).`,
    );
  }
}

/** Exported for the live-schema spec, which checks these lists against the catalog. */
export const INGEST_RESET_TABLES = {
  ingest: INGEST_TABLES,
  dependents: DEPENDENT_TABLES,
  probed: USER_SCOPED_TABLES,
} as const;

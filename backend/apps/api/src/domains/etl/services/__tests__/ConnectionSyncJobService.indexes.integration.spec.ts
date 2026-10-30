import { randomUUID } from 'node:crypto';

import { DataSource, type Logger as TypeOrmLogger } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { ConnectionEntity, ProviderEntity } from '@ci/domains/connections';
import { UserEntity } from '@ci/domains/user';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../__tests__/support/scratchDatabase';
import { ConnectionSyncJobEntity } from '../../entities/ConnectionSyncJobEntity';
import { ConnectionSyncJobService } from '../ConnectionSyncJobService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Postgres PLANS the indexes on `ci_etl.connection_sync_jobs`. Not just has them.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The table shipped with a UUID primary key and no other index —
 * `SELECT indexname FROM pg_indexes WHERE tablename = 'connection_sync_jobs'`
 * returned exactly one row — so every read below was a sequential scan, on the
 * busiest polling loops the appliance runs: `SyncOrchestrator.executeSyncJobs`
 * every 30 seconds, `orchestrateSyncJobs` and `executeTransformJobs` every
 * minute. Nothing prunes the table either; its only DELETE is a per-id GraphQL
 * mutation. So the scans get longer for as long as the appliance is used.
 *
 * ── Why this asks the planner instead of `pg_indexes` ──────────────────────
 *
 * An index nothing plans to use is worse than no index: it is paid for on every
 * write and it buys nothing. A test that only asserted the three indexes exist
 * would pass just as happily on three indexes whose columns are in an order no
 * query can use — which is the failure mode that actually happens, because
 * column order is where index design goes wrong and it is invisible in the DDL.
 *
 * So each case here runs a REAL call, takes the statement the driver issued for
 * it, and puts `EXPLAIN` in front of that statement — not in front of a
 * hand-copied approximation of it. If `search()` stops sorting on `updated_at`,
 * or a caller's predicate moves, these cases EXPLAIN the new SQL and report the
 * index that no longer serves it.
 *
 * ── What "used" means here ────────────────────────────────────────────────
 *
 * Two assertions per shape: the plan names the index this shape was indexed
 * for, and the plan contains no sequential scan of the table. The second is not
 * redundant — a plan can reach the index for one leg of a join and still scan
 * the table for another, which is precisely what the dispatch query did before
 * `connection_sync_jobs_active_idx` existed.
 *
 * Skips (loudly) when there is no administrative connection; see
 * `domains/__tests__/support/scratchDatabase.ts`.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[ConnectionSyncJobService.indexes.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

/**
 * Rows to plan against.
 *
 * The planner's choice is a cost comparison, so an empty table proves nothing:
 * on zero pages a sequential scan wins every time and would keep winning with
 * the indexes in place. This is the smallest population that makes a scan of
 * the whole table visibly the wrong answer — a few hundred heap pages — while
 * still seeding in about a second.
 */
const SEEDED_ROWS = 20_000;

/** Distinct connections in the seed. Sync jobs accumulate per connection endpoint. */
const SEEDED_CONNECTIONS = 40;

/** Distinct endpoint names per connection. */
const SEEDED_ENDPOINTS = 12;

describeWithDatabase(
  `ci_etl.connection_sync_jobs index usage, against real Postgres (${availability.target})`,
  () => {
    let scratch: ScratchDatabase;
    let mapped: DataSource;
    let service: ConnectionSyncJobService;

    /** Every statement the mapped DataSource issued, with its parameters. */
    const issued: Array<{ sql: string; parameters: unknown[] }> = [];

    const SYSTEM_CONTEXT = { userId: SYSTEM_USER } as ServiceContext;

    /** The user every seeded row belongs to, and the one the scoped shapes pass. */
    const userId = randomUUID();
    const USER_CONTEXT = { userId } as UserServiceContext;

    /** A connection with a long history in the seed, and one of its endpoints. */
    const connectionId = connectionUuid(7);
    const endpointName = 'endpoint_7';

    /** Deterministic connection ids, so a case can name the one it seeded. */
    function connectionUuid(index: number): string {
      return `10000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
    }

    beforeAll(async () => {
      scratch = await ScratchDatabase.create({
        createdBy: 'ConnectionSyncJobService.indexes.integration.spec',
      });

      await scratch.assertOwn();

      const { host, port, username, password, database } = scratch.dataSource
        .options as PostgresConnectionOptions;

      const captureLogger: TypeOrmLogger = {
        logQuery: (sql: string, parameters?: unknown[]) => {
          issued.push({ sql, parameters: parameters ?? [] });
        },
        logQueryError: () => undefined,
        logQuerySlow: () => undefined,
        logSchemaBuild: () => undefined,
        logMigration: () => undefined,
        log: () => undefined,
      };

      // A second DataSource on the same scratch database, this one with the
      // entities mapped: `search()` builds its statement through the
      // repository's query builder, so it needs real entity metadata to produce
      // the real SQL this file EXPLAINs. `synchronize` stays off — the
      // migrations the scratch database already ran are the schema, and pointed
      // at anything else TypeORM would "fix" the drift rather than report it.
      mapped = new DataSource({
        type: 'postgres',
        host,
        port,
        username,
        password,
        database,
        entities: [ConnectionSyncJobEntity, ConnectionEntity, ProviderEntity, UserEntity],
        synchronize: false,
        logging: ['query'],
        logger: captureLogger,
        extra: { max: 4 },
      });

      await mapped.initialize();

      const logger = {
        setContext: () => undefined,
        log: () => undefined,
        debug: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      };

      service = new ConnectionSyncJobService(mapped.getRepository(ConnectionSyncJobEntity), logger as never);

      await seed();
    });

    afterAll(async () => {
      await mapped?.destroy();
      await scratch?.drop();
    });

    /**
     * The shape of a lived-in table: a long history of finished jobs, a handful
     * of live ones.
     *
     * That ratio is the whole argument for the two partial indexes, so the seed
     * has to reproduce it rather than spread the statuses evenly — an even
     * split would make `status` selective on its own and quietly validate an
     * index design that does not work on the real table. `ON CONFLICT DO
     * NOTHING` is for `connection_sync_jobs_live_job_idx`, which permits one
     * live job per (connection, endpoint, type).
     */
    async function seed(): Promise<void> {
      await scratch.dataSource.query(
        `INSERT INTO ci_etl.connection_sync_jobs
           (id, user_id, connection_id, endpoint_name, status, type, last_transformed, updated_at)
         SELECT gen_random_uuid(),
                $1::uuid,
                ('10000000-0000-0000-0000-' || lpad((g % $3)::text, 12, '0'))::uuid,
                'endpoint_' || (g % $4),
                CASE WHEN g % 2000 = 0 THEN 'pending'
                     WHEN g % 2000 = 1 THEN 'in_progress'
                     ELSE 'success' END::ci_etl.job_status,
                CASE WHEN g % 2 = 0 THEN 'incremental' ELSE 'historical' END,
                CASE WHEN g % 2000 IN (0, 1, 2) THEN NULL ELSE now() END,
                now() - (g || ' seconds')::interval
           FROM generate_series(1, $2) g
         ON CONFLICT DO NOTHING`,
        [userId, SEEDED_ROWS, SEEDED_CONNECTIONS, SEEDED_ENDPOINTS],
      );

      // Without statistics the planner is working from a default guess about a
      // table it has never looked at, and its choice says nothing about the
      // indexes. Autovacuum would get here eventually; the test cannot wait.
      await scratch.dataSource.query('ANALYZE ci_etl.connection_sync_jobs');
    }

    /**
     * Runs `call`, then EXPLAINs the last statement it issued against
     * `connection_sync_jobs`, returning the plan as text.
     *
     * The statement is taken from the driver rather than written out here, so
     * these cases cannot drift into EXPLAINing SQL no caller issues. Plain
     * `EXPLAIN`, never `ANALYZE`: one of the shapes is the transform claim, an
     * `UPDATE ... RETURNING`, and `EXPLAIN ANALYZE` would run it.
     */
    async function planFor(call: () => Promise<unknown>): Promise<string> {
      issued.length = 0;

      await call();

      const statement = issued.filter((entry) => entry.sql.includes('connection_sync_jobs')).at(-1);

      if (statement == null) {
        throw new Error(
          'the call under test issued no statement against ci_etl.connection_sync_jobs — ' +
            `captured: ${issued.map((entry) => entry.sql).join(' | ') || '(nothing)'}`,
        );
      }

      const rows = (await scratch.dataSource.query(
        `EXPLAIN (FORMAT JSON) ${statement.sql}`,
        statement.parameters,
      )) as Array<{ 'QUERY PLAN': unknown }>;

      return JSON.stringify(rows[0]?.['QUERY PLAN']);
    }

    /** Both halves of "used": the index is in the plan, and the table is not scanned. */
    function expectServedBy(plan: string, index: string): void {
      expect(plan).toContain(index);
      expect(plan).not.toContain('Seq Scan');
    }

    describe('the migration', () => {
      it('creates the three query indexes, and nothing has to be told they exist', async () => {
        const rows = (await scratch.dataSource.query(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = 'ci_etl' AND tablename = 'connection_sync_jobs'
            ORDER BY indexname`,
        )) as Array<{ indexname: string }>;

        expect(rows.map((row) => row.indexname)).toEqual(
          expect.arrayContaining([
            'connection_sync_jobs_active_idx',
            'connection_sync_jobs_endpoint_recent_idx',
            'connection_sync_jobs_untransformed_idx',
          ]),
        );
      });
    });

    describe('connection_sync_jobs_endpoint_recent_idx', () => {
      it('serves the per-endpoint history read `orchestrateSyncJobs` runs every minute', async () => {
        const plan = await planFor(() =>
          service.search(USER_CONTEXT, {
            connectionId,
            userId,
            endpointName,
            type: 'incremental',
            orderBy: 'updated_at:DESC',
          }),
        );

        expectServedBy(plan, 'connection_sync_jobs_endpoint_recent_idx');
      });

      it('serves the same read without `type`, which is how `SyncNowService` asks', async () => {
        // The reason `type` is not an index column: it holds two values, so
        // dropping it from the index costs this shape nothing and lets one
        // index serve both callers.
        const plan = await planFor(() =>
          service.search(USER_CONTEXT, {
            connectionId,
            userId,
            endpointName,
            orderBy: 'updated_at:DESC',
          }),
        );

        expectServedBy(plan, 'connection_sync_jobs_endpoint_recent_idx');
      });
    });

    describe('connection_sync_jobs_active_idx', () => {
      it('serves the pending sweep `executeSyncJobs` runs every 30 seconds', async () => {
        const plan = await planFor(() =>
          service.search(SYSTEM_CONTEXT, { status: 'pending', orderBy: 'updated_at:ASC' }),
        );

        expectServedBy(plan, 'connection_sync_jobs_active_idx');
      });

      it('serves the in-progress count, which stops at the dispatch budget', async () => {
        const plan = await planFor(() => service.countInProgress(SYSTEM_CONTEXT, 5));

        expectServedBy(plan, 'connection_sync_jobs_active_idx');
      });

      it('serves BOTH legs of the dispatch query, including its anti-join', async () => {
        // The shape the index's column order exists for: with `status` fixed by
        // an equality, `(connection_id, updated_at, id)` IS the `DISTINCT ON`
        // sort, and the correlated `NOT EXISTS` against in-flight jobs is a
        // lookup on the same index's `(status, connection_id)` prefix. Before
        // this index the plan was two parallel sequential scans hash-joined
        // together — hence the assertion that no `Seq Scan` survives.
        const plan = await planFor(() => service.findDispatchablePending(SYSTEM_CONTEXT, 5));

        expectServedBy(plan, 'connection_sync_jobs_active_idx');
      });

      it('serves the user-scoped liveness check behind sync-now', async () => {
        const plan = await planFor(() =>
          service.search(USER_CONTEXT, { status: 'in_progress', orderBy: 'updated_at:DESC' }),
        );

        expectServedBy(plan, 'connection_sync_jobs_active_idx');
      });
    });

    describe('connection_sync_jobs_untransformed_idx', () => {
      it('serves the transform sweep `executeTransformJobs` runs every minute', async () => {
        const plan = await planFor(() =>
          service.search(SYSTEM_CONTEXT, {
            status: 'success',
            lastTransformed: null,
            orderBy: 'updated_at:DESC',
            limit: 2,
          }),
        );

        expectServedBy(plan, 'connection_sync_jobs_untransformed_idx');
      });

      it('serves it user-scoped, which is the third leg of the sync-now preflight', async () => {
        const plan = await planFor(() =>
          service.search(USER_CONTEXT, {
            status: 'success',
            lastTransformed: null,
            orderBy: 'updated_at:DESC',
          }),
        );

        expectServedBy(plan, 'connection_sync_jobs_untransformed_idx');
      });
    });

    describe('the claims', () => {
      it('resolve on the primary key, which is why no index was added for them', async () => {
        // Stated as a test rather than left as a claim in the migration: both
        // claims are keyed on `id`, so the conditions that follow — the status,
        // the null `last_transformed`, the staleness of `transform_claimed_at` —
        // are a recheck of one already-located row, not a search.
        const plan = await planFor(() => service.claimTransform(SYSTEM_CONTEXT, randomUUID()));

        expectServedBy(plan, 'connection_sync_jobs_pkey');
      });
    });
  },
);

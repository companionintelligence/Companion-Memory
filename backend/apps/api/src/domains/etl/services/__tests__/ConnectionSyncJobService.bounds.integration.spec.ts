import { randomUUID } from 'node:crypto';

import { DataSource, type Logger as TypeOrmLogger } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';
import { ConnectionEntity, ProviderEntity } from '@ci/domains/connections';
import { UserEntity } from '@ci/domains/user';

import { ScratchDatabase, scratchDatabaseAvailability } from '../../../__tests__/support/scratchDatabase';
import { ConnectionSyncJobEntity } from '../../entities/ConnectionSyncJobEntity';
import { ConnectionSyncJobService } from '../ConnectionSyncJobService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The bounds `SyncOrchestrator` relies on, against real Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `executeSyncJobs` (every 30 seconds) and `executeTransformJobs` (every
 * minute) used to read `ci_etl.connection_sync_jobs` with no bound of any kind
 * and then throw nearly all of it away in JavaScript — a `.slice(0, 2)` in the
 * transform case, a set-building loop in the execute case. The table has a UUID
 * primary key and no other index, and nothing prunes it.
 *
 * Moving those bounds into SQL is only safe if the SQL still makes the same
 * selection, and a mocked repository cannot answer that: `take()`, the
 * `DISTINCT ON`, the anti-join against in-flight jobs, and the tie behaviour of
 * a LIMIT over a non-unique sort key are all properties of Postgres. So this
 * runs the real statements against a database of this run's own making, and
 * reads the SQL the driver actually issued.
 *
 * Skips (loudly) when there is no administrative connection; see
 * `domains/__tests__/support/scratchDatabase.ts`.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[ConnectionSyncJobService.bounds.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

describeWithDatabase(
  `ConnectionSyncJobService bounds, against real Postgres (${availability.target})`,
  () => {
    let scratch: ScratchDatabase;
    let mapped: DataSource;
    let service: ConnectionSyncJobService;

    /** Every statement the mapped DataSource issues, newest last. */
    const issuedSql: string[] = [];

    const SYSTEM_CONTEXT = { userId: SYSTEM_USER } as ServiceContext;
    const userId = randomUUID();

    beforeAll(async () => {
      scratch = await ScratchDatabase.create({
        createdBy: 'ConnectionSyncJobService.bounds.integration.spec',
      });

      await scratch.assertOwn();

      // A second DataSource on the same scratch database, this one with the
      // entities mapped: `search()` builds its statement through the
      // repository's query builder, so unlike the raw claim statements it needs
      // real entity metadata to produce real SQL. `synchronize` stays off — the
      // migrations the scratch database already ran are the schema.
      const { host, port, username, password, database } = scratch.dataSource
        .options as PostgresConnectionOptions;

      const captureLogger: TypeOrmLogger = {
        logQuery: (query: string) => {
          issuedSql.push(query);
        },
        logQueryError: () => undefined,
        logQuerySlow: () => undefined,
        logSchemaBuild: () => undefined,
        logMigration: () => undefined,
        log: () => undefined,
      };

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
    });

    afterAll(async () => {
      await mapped?.destroy();
      await scratch?.drop();
    });

    beforeEach(async () => {
      await scratch.dataSource.query('DELETE FROM ci_etl.connection_sync_jobs');
      issuedSql.length = 0;
    });

    /**
     * One sync job row, in whatever state the case under test needs.
     *
     * Each row gets an endpoint name of its own unless the case names one:
     * `connection_sync_jobs_live_job_idx` allows a single live job per
     * (connection, endpoint, type), and several cases here deliberately give one
     * connection more than one pending job.
     */
    let seedCount = 0;

    async function seedSyncJob(
      overrides: {
        id?: string;
        connectionId?: string;
        endpointName?: string;
        status?: string;
        updatedAt?: Date;
        lastTransformed?: Date | null;
        transformClaimedAt?: Date | null;
        userId?: string;
      } = {},
    ): Promise<string> {
      const id = overrides.id ?? randomUUID();

      seedCount += 1;

      await scratch.dataSource.query(
        `INSERT INTO ci_etl.connection_sync_jobs
         (id, user_id, connection_id, endpoint_name, status, type, updated_at, last_transformed, transform_claimed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::ci_etl.job_status, 'incremental', $6, $7, $8)`,
        [
          id,
          overrides.userId ?? userId,
          overrides.connectionId ?? randomUUID(),
          overrides.endpointName ?? `messages-${seedCount}`,
          overrides.status ?? 'pending',
          overrides.updatedAt ?? new Date(),
          overrides.lastTransformed ?? null,
          overrides.transformClaimedAt ?? null,
        ],
      );

      return id;
    }

    const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

    /** What `executeTransformJobs` asks for, minus the cap under test. */
    const transformQuery = {
      status: 'success',
      lastTransformed: null,
      orderBy: 'updated_at:DESC',
    } as const;

    describe('search', () => {
      it('carries the cap into the statement as a LIMIT, rather than trimming the result afterwards', async () => {
        for (let i = 0; i < 6; i += 1) {
          await seedSyncJob({ status: 'success', updatedAt: minutesAgo(i) });
        }

        const bounded = await service.search(SYSTEM_CONTEXT, { ...transformQuery, limit: 2 });

        expect(bounded).toHaveLength(2);
        // The row count alone cannot tell a LIMIT from a `.slice()`; the SQL can.
        expect(issuedSql.at(-1)).toMatch(/LIMIT/i);
      });

      it('issues no LIMIT when no cap is asked for', async () => {
        for (let i = 0; i < 4; i += 1) {
          await seedSyncJob({ status: 'success', updatedAt: minutesAgo(i) });
        }

        const all = await service.search(SYSTEM_CONTEXT, transformQuery);

        expect(all).toHaveLength(4);
        expect(issuedSql.at(-1)).not.toMatch(/LIMIT/i);
      });

      it('returns the newest rows under a DESC cap, not an arbitrary two', async () => {
        const newest = await seedSyncJob({ status: 'success', updatedAt: minutesAgo(1) });
        const second = await seedSyncJob({ status: 'success', updatedAt: minutesAgo(2) });
        await seedSyncJob({ status: 'success', updatedAt: minutesAgo(3) });
        await seedSyncJob({ status: 'success', updatedAt: minutesAgo(4) });

        const bounded = await service.search(SYSTEM_CONTEXT, { ...transformQuery, limit: 2 });

        expect(bounded.map((row) => row.id)).toEqual([newest, second]);
      });

      it('breaks ties on the primary key, so a capped search answers the same way every tick', async () => {
        // Every row shares an `updated_at`. Without a tiebreaker the LIMIT takes
        // an arbitrary member of the tied group, and Postgres is under no
        // obligation to take the same one twice.
        const tied = new Date();
        const ids = [
          '00000000-0000-4000-8000-00000000000a',
          '00000000-0000-4000-8000-00000000000b',
          '00000000-0000-4000-8000-00000000000c',
          '00000000-0000-4000-8000-00000000000d',
        ];

        for (const id of ids) {
          await seedSyncJob({ id, status: 'success', updatedAt: tied });
        }

        const bounded = await service.search(SYSTEM_CONTEXT, { ...transformQuery, limit: 2 });

        expect(bounded.map((row) => row.id)).toEqual([ids[3], ids[2]]);
        expect(issuedSql.at(-1)).toMatch(/ORDER BY .*updated_at.* DESC, .*id.* DESC/i);
      });

      it('orders a capped search on the primary key when the caller passes no sort at all', async () => {
        const ids = ['00000000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-00000000000f'];

        for (const id of ids) {
          await seedSyncJob({ id, status: 'success' });
        }

        const bounded = await service.search(SYSTEM_CONTEXT, { status: 'success', limit: 1 });

        expect(bounded.map((row) => row.id)).toEqual([ids[0]]);
      });
    });

    describe('countInProgress', () => {
      it('counts what is in flight', async () => {
        await seedSyncJob({ status: 'in_progress' });
        await seedSyncJob({ status: 'in_progress' });
        await seedSyncJob({ status: 'pending' });
        await seedSyncJob({ status: 'success' });

        await expect(service.countInProgress(SYSTEM_CONTEXT, 5)).resolves.toBe(2);
      });

      it('stops counting at the cap, so the scan need not read the whole table', async () => {
        for (let i = 0; i < 9; i += 1) {
          await seedSyncJob({ status: 'in_progress' });
        }

        await expect(service.countInProgress(SYSTEM_CONTEXT, 5)).resolves.toBe(5);
      });

      it('counts only the caller-owned rows when the context is user-scoped', async () => {
        await seedSyncJob({ status: 'in_progress' });
        await seedSyncJob({ status: 'in_progress', userId: randomUUID() });

        await expect(service.countInProgress({ userId } as ServiceContext, 5)).resolves.toBe(1);
      });
    });

    describe('findDispatchablePending', () => {
      it('returns one job per connection — the oldest of them', async () => {
        const connectionId = randomUUID();
        const oldest = await seedSyncJob({ connectionId, updatedAt: minutesAgo(10) });
        await seedSyncJob({ connectionId, updatedAt: minutesAgo(5) });
        await seedSyncJob({ connectionId, updatedAt: minutesAgo(1) });

        await expect(service.findDispatchablePending(SYSTEM_CONTEXT, 5)).resolves.toEqual([oldest]);
      });

      it('skips a connection that already has a job in flight', async () => {
        const busy = randomUUID();
        const free = randomUUID();

        await seedSyncJob({ connectionId: busy, status: 'in_progress', updatedAt: minutesAgo(20) });
        await seedSyncJob({ connectionId: busy, status: 'pending', updatedAt: minutesAgo(19) });
        const runnable = await seedSyncJob({
          connectionId: free,
          status: 'pending',
          updatedAt: minutesAgo(1),
        });

        await expect(service.findDispatchablePending(SYSTEM_CONTEXT, 5)).resolves.toEqual([runnable]);
      });

      it('spends a short budget on the connections that have waited longest', async () => {
        // The trap a global LIMIT falls into: capping a plain `status =
        // 'pending'` read at two rows returns the two oldest ROWS, which here
        // are both on one connection — one dispatch where two were available.
        const busiest = randomUUID();
        const oldestOnBusiest = await seedSyncJob({ connectionId: busiest, updatedAt: minutesAgo(30) });
        await seedSyncJob({ connectionId: busiest, updatedAt: minutesAgo(29) });
        const second = await seedSyncJob({ connectionId: randomUUID(), updatedAt: minutesAgo(20) });
        await seedSyncJob({ connectionId: randomUUID(), updatedAt: minutesAgo(10) });

        await expect(service.findDispatchablePending(SYSTEM_CONTEXT, 2)).resolves.toEqual([
          oldestOnBusiest,
          second,
        ]);
      });

      it('never returns more than the budget', async () => {
        for (let i = 0; i < 8; i += 1) {
          await seedSyncJob({ connectionId: randomUUID(), updatedAt: minutesAgo(i) });
        }

        await expect(service.findDispatchablePending(SYSTEM_CONTEXT, 3)).resolves.toHaveLength(3);
      });

      it('breaks ties on the primary key, so a tied budget is spent the same way every tick', async () => {
        const tied = new Date();
        const ids = [
          '00000000-0000-4000-8000-0000000000a1',
          '00000000-0000-4000-8000-0000000000a2',
          '00000000-0000-4000-8000-0000000000a3',
        ];

        for (const id of ids) {
          await seedSyncJob({ id, connectionId: randomUUID(), updatedAt: tied });
        }

        await expect(service.findDispatchablePending(SYSTEM_CONTEXT, 2)).resolves.toEqual([ids[0], ids[1]]);
      });

      it('returns nothing for an exhausted budget', async () => {
        await seedSyncJob({ connectionId: randomUUID() });

        await expect(service.findDispatchablePending(SYSTEM_CONTEXT, 0)).resolves.toEqual([]);
      });

      it('skips a transform already in flight, which the claim would only discard', async () => {
        const free = await seedSyncJob({ status: 'success', updatedAt: minutesAgo(1) });
        await seedSyncJob({
          status: 'success',
          updatedAt: minutesAgo(2),
          transformClaimedAt: minutesAgo(5),
        });

        const claimable = await service.search(SYSTEM_CONTEXT, {
          ...transformQuery,
          transformClaimable: true,
        });

        expect(claimable.map((row) => row.id)).toEqual([free]);
      });

      it('still offers a claim gone stale, so a killed worker is retried not stranded', async () => {
        const stale = await seedSyncJob({
          status: 'success',
          updatedAt: minutesAgo(90),
          transformClaimedAt: minutesAgo(90),
        });

        const claimable = await service.search(SYSTEM_CONTEXT, {
          ...transformQuery,
          transformClaimable: true,
        });

        expect(claimable.map((row) => row.id)).toContain(stale);
      });

      it('returns only the caller-owned jobs when the context is user-scoped', async () => {
        const mine = await seedSyncJob({ connectionId: randomUUID(), updatedAt: minutesAgo(5) });
        await seedSyncJob({ connectionId: randomUUID(), updatedAt: minutesAgo(1), userId: randomUUID() });

        await expect(service.findDispatchablePending({ userId } as ServiceContext, 5)).resolves.toEqual([
          mine,
        ]);
      });
    });
  },
);

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource } from 'typeorm';

import { ConnectionEntity, ProviderEntity, type Connection } from '@ci/domains/connections';
import { UserEntity } from '@ci/domains/user';

import {
  ScratchDatabase,
  resolveAdminConnection,
  scratchDatabaseAvailability,
} from '../../../__tests__/support/scratchDatabase';
import { ConnectionSyncJobEntity } from '../../entities/ConnectionSyncJobEntity';
import { ConnectionSyncJobService } from '../../services/ConnectionSyncJobService';
import { SyncOrchestrator } from '../SyncOrchestrator';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * One live sync job per endpoint, against real Postgres.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `orchestrateSyncJobs` decides whether to enqueue a sync by reading the
 * endpoint's state and then, in a later statement, inserting. Nothing holds
 * between the two. The cron's own overlap flag does not close that gap — it is
 * per process, and two ticks that matter are the ones in two processes (a
 * role-split or replicated deployment), plus `SyncNowService` racing the cron
 * from an HTTP request. A duplicate is not cosmetic: each copy is dispatched on
 * its own, so the provider is fetched twice and the same page transformed twice.
 *
 * So the invariant lives in the database — the partial unique index
 * `connection_sync_jobs_live_job_idx` — and that is a property no mocked test
 * can establish. It is Postgres deciding which of two concurrent INSERTs it
 * admits, and the driver reporting the other one as a 23505 carrying the index
 * name that `ConnectionSyncJobService.create` keys its "already exists" branch
 * on. A mock can only assert the intent it was written with.
 *
 * The orchestrator case below therefore uses TWO orchestrator instances over
 * one database: the per-process flag cannot see across them, which is exactly
 * the deployment the index exists for.
 *
 * Skips (loudly) when there is no administrative connection; see
 * `domains/__tests__/support/scratchDatabase.ts`.
 */

const availability = scratchDatabaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[SyncOrchestrator.duplicateJobs.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(600_000);

describeWithDatabase(`One live sync job per endpoint (${availability.target})`, () => {
  let scratch: ScratchDatabase;
  let dataSource: DataSource;
  let service: ConnectionSyncJobService;

  const userId = randomUUID();

  const logger = {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  beforeAll(async () => {
    scratch = await ScratchDatabase.create({
      createdBy: 'SyncOrchestrator.duplicateJobs.integration.spec',
    });

    await scratch.assertOwn();

    // A DataSource of this suite's own, on the scratch database: `create()` goes
    // through the repository (TypeORM's save, its INSERT, its error), which the
    // entity-less scratch DataSource cannot provide. The other three entities
    // are registered only because TypeORM refuses to build metadata for a
    // relation whose target is missing; nothing here reads their tables.
    //
    // The columns are not foreign keys (see
    // `20260210182932_create_sync_jobs.sql`), so no user or connection row has
    // to exist for these inserts to be legal.
    const admin = resolveAdminConnection()!;

    dataSource = new DataSource({
      type: 'postgres',
      host: admin.host,
      port: admin.port,
      username: admin.username,
      password: admin.password,
      database: scratch.name,
      entities: [ConnectionSyncJobEntity, ConnectionEntity, ProviderEntity, UserEntity],
      synchronize: false,
    });

    await dataSource.initialize();

    service = new ConnectionSyncJobService(
      dataSource.getRepository(ConnectionSyncJobEntity),
      logger as never,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }

    await scratch?.drop();
  });

  async function liveJobs(connectionId: string, type: string): Promise<Array<{ id: string }>> {
    return (await scratch.dataSource.query(
      `SELECT id FROM ci_etl.connection_sync_jobs
        WHERE connection_id = $1::uuid AND type = $2 AND status IN ('pending', 'in_progress')`,
      [connectionId, type],
    )) as Array<{ id: string }>;
  }

  describe('ConnectionSyncJobService.create', () => {
    it('admits one of two concurrent creates for the same endpoint and hands the loser the winner', async () => {
      const connectionId = randomUUID();

      const both = await Promise.all([
        service.create(
          { userId },
          { userId, connectionId, endpointName: 'messages', type: 'incremental', status: 'pending' },
        ),
        service.create(
          { userId },
          { userId, connectionId, endpointName: 'messages', type: 'incremental', status: 'pending' },
        ),
      ]);

      expect(await liveJobs(connectionId, 'incremental')).toHaveLength(1);
      expect(both[0].id).toBe(both[1].id);
    });

    it('constrains only live jobs, so an endpoint keeps its history', async () => {
      const connectionId = randomUUID();

      for (const status of ['success', 'failed', 'success'] as const) {
        await scratch.dataSource.query(
          `INSERT INTO ci_etl.connection_sync_jobs (id, user_id, connection_id, endpoint_name, status, type)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'messages', $4::ci_etl.job_status, 'incremental')`,
          [randomUUID(), userId, connectionId, status],
        );
      }

      await expect(
        service.create(
          { userId },
          { userId, connectionId, endpointName: 'messages', type: 'incremental', status: 'pending' },
        ),
      ).resolves.toEqual(expect.objectContaining({ status: 'pending' }));
    });

    it('frees the endpoint once the live job reaches a terminal status', async () => {
      const connectionId = randomUUID();

      const first = await service.create(
        { userId },
        { userId, connectionId, endpointName: 'messages', type: 'incremental', status: 'pending' },
      );

      await service.markAsCompleted({ userId }, first.id, 'success');

      const second = await service.create(
        { userId },
        { userId, connectionId, endpointName: 'messages', type: 'incremental', status: 'pending' },
      );

      expect(second.id).not.toBe(first.id);
      expect(await liveJobs(connectionId, 'incremental')).toHaveLength(1);
    });

    it('keeps the two iteration types independent — a historical job is not a duplicate of an incremental one', async () => {
      const connectionId = randomUUID();

      await service.create(
        { userId },
        { userId, connectionId, endpointName: 'messages', type: 'incremental', status: 'pending' },
      );
      await service.create(
        { userId },
        { userId, connectionId, endpointName: 'messages', type: 'historical', status: 'pending' },
      );

      expect(await liveJobs(connectionId, 'incremental')).toHaveLength(1);
      expect(await liveJobs(connectionId, 'historical')).toHaveLength(1);
    });
  });

  describe('the migration that adds the index', () => {
    it('resolves duplicates already in the table, so it can be applied to an appliance that has some', async () => {
      // The one statement in this change that can fail on somebody else's data.
      // `CREATE UNIQUE INDEX` refuses a table that already violates it, and a
      // migration that fails mid-way blocks `migrate` for everyone — so the
      // dedupe pass runs first, and is exercised here rather than assumed. The
      // duplicates are inserted with the index dropped, which is the state every
      // appliance is in before this migration runs.
      const connectionId = randomUUID();

      await scratch.dataSource.query(`DROP INDEX ci_etl.connection_sync_jobs_live_job_idx`);

      const ids = [randomUUID(), randomUUID(), randomUUID()];

      for (const [index, id] of ids.entries()) {
        await scratch.dataSource.query(
          `INSERT INTO ci_etl.connection_sync_jobs
             (id, user_id, connection_id, endpoint_name, status, type, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'messages', 'pending', 'incremental', now() - make_interval(mins => $4))`,
          [id, userId, connectionId, ids.length - index],
        );
      }

      const migration = readFileSync(
        path.resolve(
          __dirname,
          '../../../../../db/postgres/migrations/20260821064758_add_connection_sync_jobs_live_job_unique.sql',
        ),
        'utf8',
      );
      const up = migration.slice(
        migration.indexOf('-- migrate:up') + '-- migrate:up'.length,
        migration.indexOf('-- migrate:down'),
      );

      await scratch.dataSource.query(up);

      // The newest live row survives; the rest are failed, with a reason, and
      // still there — nothing about this is a delete.
      const rows = (await scratch.dataSource.query(
        `SELECT id, status, error FROM ci_etl.connection_sync_jobs WHERE connection_id = $1::uuid`,
        [connectionId],
      )) as Array<{ id: string; status: string; error: { error?: string } | null }>;

      expect(rows).toHaveLength(3);
      expect(rows.filter((row) => row.status === 'pending').map((row) => row.id)).toEqual([ids[2]]);

      for (const row of rows.filter((candidate) => candidate.status === 'failed')) {
        expect(row.error?.error).toBe('Superseded duplicate live sync job');
      }

      // And the index is back, so the rest of this suite still has one.
      await expect(
        scratch.dataSource.query(
          `INSERT INTO ci_etl.connection_sync_jobs (id, user_id, connection_id, endpoint_name, status, type)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'messages', 'pending', 'incremental')`,
          [randomUUID(), userId, connectionId],
        ),
      ).rejects.toThrow('connection_sync_jobs_live_job_idx');
    });
  });

  describe('SyncOrchestrator.orchestrateSyncJobs', () => {
    function buildOrchestrator(connection: Connection) {
      const connectionService = {
        findActiveConnections: async () => [{ connection, lastSyncedAt: null }],
      };

      return new SyncOrchestrator(
        connectionService as never,
        service,
        { send: async () => ['job-id'] } as never,
        { getSyncFunction: () => undefined, getTransformFunction: () => undefined } as never,
        { getClientByProviderId: () => ({}) } as never,
        { isFeatureEnabled: async () => true } as never,
        logger as never,
      );
    }

    it('creates one job, not two, when two orchestrators sweep the same endpoint at once', async () => {
      const connectionId = randomUUID();
      const connection = {
        id: connectionId,
        userId,
        active: true,
        activeEndpoints: ['messages'],
        provider: {
          id: randomUUID(),
          name: 'signal',
          endpoints: [{ name: 'messages', iterationType: 'incremental' }],
        },
      } as unknown as Connection;

      // Two instances, one database: the per-process overlap flag is no help
      // across processes, which is the case this index exists for.
      await Promise.all([
        buildOrchestrator(connection).orchestrateSyncJobs(),
        buildOrchestrator(connection).orchestrateSyncJobs(),
      ]);

      expect(await liveJobs(connectionId, 'incremental')).toHaveLength(1);
    });
  });
});

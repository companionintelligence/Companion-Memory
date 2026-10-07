import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER } from '@ci/common/context';
import { ConnectionEntity, ProviderEntity } from '@ci/domains/connections';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ConnectionSyncJobEntity } from '../../entities/ConnectionSyncJobEntity';
import { ConnectionSyncJobService } from '../ConnectionSyncJobService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TRANSFORM SWEEP TAKES ONLY WHAT THE EXECUTOR FETCHED — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A job's `data` decides what the transforms write and, for Facebook media,
 * what the server downloads. Clients could write it (and `status`) through
 * GraphQL, and the sweep picked such a row up within a minute, even on a
 * connection that never finished signing in. The sweep now asks for rows the
 * executor marked (`fetched_by_executor`) on active connections; the second is
 * a correlated subquery against the sweep's own alias, so it is checked here.
 *
 * Every test runs in one transaction on one connection and rolls back.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[ConnectionSyncJobService.transformSweep.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = {
  setContext: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function migrationUp(): string {
  const file = path.resolve(
    __dirname,
    '../../../../../db/postgres/migrations/20261006070904_connection_sync_jobs_fetched_by_executor.sql',
  );
  const sql = readFileSync(file, 'utf8');

  return sql.slice(sql.indexOf('-- migrate:up') + '-- migrate:up'.length, sql.indexOf('-- migrate:down'));
}

describeWithDb(`transform sweep selection (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let service: ConnectionSyncJobService;
  let userId: string;
  let activeConnection: string;
  let inactiveConnection: string;

  const connection = async (active: boolean, providerId: string) => {
    const id = uuidv7();
    await runner.query(
      `INSERT INTO ci.connections (id, user_id, provider_id, name, active) VALUES ($1, $2, $3, 'Facebook', $4)`,
      [id, userId, providerId, active],
    );

    return id;
  };

  const job = async (
    connectionId: string,
    fields: { status?: string; fetched?: boolean; transformed?: boolean } = {},
  ) => {
    const id = uuidv7();
    await runner.query(
      `INSERT INTO ci_etl.connection_sync_jobs
         (id, user_id, connection_id, endpoint_name, status, type, data, fetched_by_executor, last_transformed)
       VALUES ($1, $2, $3, 'Photos', $4, 'incremental', '{"photos": []}', $5, $6)`,
      [
        id,
        userId,
        connectionId,
        fields.status ?? 'success',
        fields.fetched ?? true,
        fields.transformed ? new Date() : null,
      ],
    );

    return id;
  };

  /** Exactly what `SyncOrchestrator.executeTransformJobs` asks for, minus the limit. */
  const sweep = async () =>
    (
      await service.search(
        { userId: SYSTEM_USER },
        {
          status: 'success',
          lastTransformed: null,
          transformClaimable: true,
          fetchedByExecutor: true,
          connectionActive: true,
          orderBy: 'updated_at:ASC',
        },
      )
    )
      .map((row) => row.id)
      .filter((id) => mine.has(id));

  const mine = new Set<string>();

  beforeAll(async () => {
    const resolved = resolveConnection(ENV);

    if (resolved == null) {
      throw new Error('availability said yes but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(resolved.url != null
        ? { url: resolved.url }
        : {
            host: resolved.host,
            port: resolved.port,
            username: resolved.username,
            password: resolved.password,
            database: resolved.database,
          }),
      entities: [ConnectionSyncJobEntity, ConnectionEntity, ProviderEntity, UserEntity],
      synchronize: false,
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'ConnectionSyncJobService.transformSweep');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    mine.clear();

    userId = await createSyntheticTestUser((sql, params) => runner.query(sql, params), 'transform-sweep');
    const facebook = uuidv7();
    await runner.query(`INSERT INTO ci.providers (id, name) VALUES ($1, 'facebook')`, [facebook]);
    activeConnection = await connection(true, facebook);
    inactiveConnection = await connection(false, facebook);

    service = new ConnectionSyncJobService(
      runner.manager.getRepository(ConnectionSyncJobEntity),
      logger as never,
    );
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it('selects an executor-fetched job on an active connection, and nothing a client could have written', async () => {
    const fetched = await job(activeConnection);
    const clientWritten = await job(activeConnection, { fetched: false });
    const onInactive = await job(inactiveConnection);
    const transformed = await job(activeConnection, { transformed: true });

    for (const id of [fetched, clientWritten, onInactive, transformed]) {
      mine.add(id);
    }

    expect(await sweep()).toEqual([fetched]);
  });

  it('picks a paused connection back up once it is active again', async () => {
    const waiting = await job(inactiveConnection);
    mine.add(waiting);

    expect(await sweep()).toEqual([]);

    await runner.query(`UPDATE ci.connections SET active = true WHERE id = $1`, [inactiveConnection]);

    expect(await sweep()).toEqual([waiting]);
  });

  it('the migration marks the jobs already waiting to be transformed, and nothing else', async () => {
    const waiting = await job(activeConnection, { fetched: false });
    const pending = await job(activeConnection, { status: 'pending', fetched: false });
    const done = await job(activeConnection, { fetched: false, transformed: true });

    await runner.query(migrationUp());

    const rows = (await runner.query(
      `SELECT id, fetched_by_executor FROM ci_etl.connection_sync_jobs WHERE id = ANY($1::uuid[])`,
      [[waiting, pending, done]],
    )) as Array<{ id: string; fetched_by_executor: boolean }>;
    const flag = Object.fromEntries(rows.map((row) => [row.id, row.fetched_by_executor]));

    expect(flag).toEqual({ [waiting]: true, [pending]: false, [done]: false });
  });
});

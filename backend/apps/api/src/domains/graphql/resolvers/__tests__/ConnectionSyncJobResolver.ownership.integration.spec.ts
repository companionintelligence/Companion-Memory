import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/context';
import { ConnectionEntity, ConnectionService, ProviderEntity } from '@ci/domains/connections';
import { ConnectionSyncJobEntity, ConnectionSyncJobService } from '@ci/domains/etl';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ConnectionLoader } from '../../loaders/ConnectionLoader';
import type { CreateConnectionSyncJobInput } from '../../types/CreateConnectionSyncJobInput';
import { GlobalUID } from '../../types/GlobalUID';
import { ConnectionSyncJobResolver } from '../ConnectionSyncJobResolver';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * `createConnectionSyncJob` WRITES ONLY THE CALLER'S OWN JOB — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The mutation is behind `JwtOrApiKeyAuthGuard` and nothing else, and it took
 * three ids from its input that decide whose job it writes:
 *
 * - `userId` — used in place of the caller's own. The transform files what a
 *   job fetched under the job's `userId`, so this put the caller's provider
 *   data into another user's memory.
 * - `connectionId` — never checked against the caller. The fetch runs on the
 *   connection's own credentials, so a job on another user's connection pulled
 *   that user's provider data into the caller's memory.
 * - `id` — handed to a save() that UPDATEs whatever row holds it (see
 *   `ConnectionSyncJobService.foreignId.integration.spec.ts`).
 *
 * The service writes whatever it is handed (the control), so the resolver is
 * where the first two are refused; the third is refused by the service.
 *
 * Every test runs in one transaction on one connection and rolls back. Opt-in:
 * skips with the reason when nothing listens at `MEMORY_TEST_DATABASE_URL` /
 * `DATABASE_URL`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[ConnectionSyncJobResolver.ownership.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = {
  setContext: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describeWithDb(`createConnectionSyncJob ownership (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let service: ConnectionSyncJobService;
  let resolver: ConnectionSyncJobResolver;
  let alice: string;
  let bob: string;
  let alicesConnection: string;
  let bobsConnection: string;
  let bobsJob: string;

  const newUser = (label: string) =>
    createSyntheticTestUser((sql: string, params?: unknown[]) => runner.query(sql, params), label);

  const googleConnection = async (userId: string, providerId: string) => {
    const id = uuidv7();
    await runner.query(
      `INSERT INTO ci.connections (id, user_id, provider_id, name, access_token, refresh_token)
       VALUES ($1, $2, $3, 'Google', 'access-token', 'refresh-token')`,
      [id, userId, providerId],
    );

    return id;
  };

  /** Every job row on this connection or for this user — what a refused call must leave alone. */
  const jobsTouching = async (userId: string, connectionId: string) =>
    runner.query(
      `SELECT ctid::text AS ctid, id, user_id, connection_id, status::text AS status, data
         FROM ci_etl.connection_sync_jobs
        WHERE user_id = $1 OR connection_id = $2
        ORDER BY id`,
      [userId, connectionId],
    );

  /** Alice's request, as `JwtOrApiKeyAuthGuard` leaves it. */
  const asAlice = (): RequestContext => ({ userId: alice });

  const aliceInput = (
    overrides: Partial<CreateConnectionSyncJobInput> = {},
  ): CreateConnectionSyncJobInput => ({
    userId: GlobalUID.encode('user', alice),
    connectionId: GlobalUID.encode('connection', alicesConnection),
    endpointName: 'messages',
    type: 'incremental',
    ...overrides,
  });

  beforeAll(async () => {
    const connection = resolveConnection(ENV);

    if (connection == null) {
      throw new Error('availability said yes but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      entities: [ConnectionSyncJobEntity, ConnectionEntity, ProviderEntity, UserEntity],
      synchronize: false,
    });
    await dataSource.initialize();

    // SHARED: these tests row-lock ci.users inside their transaction. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'ConnectionSyncJobResolver.ownership');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    alice = await newUser('ConnectionSyncJobResolver-ownership-alice');
    bob = await newUser('ConnectionSyncJobResolver-ownership-bob');

    const google = uuidv7();
    await runner.query(`INSERT INTO ci.providers (id, name) VALUES ($1, 'google')`, [google]);
    alicesConnection = await googleConnection(alice, google);
    bobsConnection = await googleConnection(bob, google);

    bobsJob = uuidv7();
    await runner.query(
      `INSERT INTO ci_etl.connection_sync_jobs (id, user_id, connection_id, endpoint_name, status, type, data)
       VALUES ($1, $2, $3, 'messages', 'success', 'incremental', '{"messages": [{"id": "18c2a"}]}')`,
      [bobsJob, bob, bobsConnection],
    );

    service = new ConnectionSyncJobService(
      runner.manager.getRepository(ConnectionSyncJobEntity),
      logger as never,
    );
    resolver = new ConnectionSyncJobResolver(
      service,
      new ConnectionLoader(
        new ConnectionService(runner.manager.getRepository(ConnectionEntity)),
        logger as never,
      ),
    );
  });

  afterEach(async () => {
    await runner.rollbackTransaction();
    await runner.release();
  });

  it('control: the service writes the job for whatever user and connection it is handed', async () => {
    // Alice's call, carrying the `userId` and `connectionId` the resolver used
    // to pass through from her input unchecked.
    const job = await service.create(
      { userId: alice },
      { userId: bob, connectionId: bobsConnection, endpointName: 'calendar', type: 'incremental' },
    );

    expect(job).toMatchObject({ userId: bob, connectionId: bobsConnection, status: 'pending' });
  });

  it('refuses a userId naming another user, and writes nothing', async () => {
    const before = await jobsTouching(bob, bobsConnection);

    await expect(
      resolver.createConnectionSyncJob(asAlice(), aliceInput({ userId: GlobalUID.encode('user', bob) })),
    ).rejects.toThrow(ForbiddenException);

    expect(await jobsTouching(bob, bobsConnection)).toEqual(before);
    expect(await jobsTouching(alice, alicesConnection)).toEqual([]);
  });

  it("refuses another user's connection as absent, and writes nothing", async () => {
    const before = await jobsTouching(bob, bobsConnection);

    await expect(
      resolver.createConnectionSyncJob(
        asAlice(),
        aliceInput({ connectionId: GlobalUID.encode('connection', bobsConnection) }),
      ),
    ).rejects.toThrow(NotFoundException);

    expect(await jobsTouching(bob, bobsConnection)).toEqual(before);
    expect(await jobsTouching(alice, alicesConnection)).toEqual([]);
  });

  it("refuses an id another user's job holds, and leaves that job where it was", async () => {
    const before = await jobsTouching(bob, bobsConnection);

    await expect(resolver.createConnectionSyncJob(asAlice(), aliceInput({ id: bobsJob }))).rejects.toThrow(
      `is not owned by ${alice}`,
    );

    expect(await jobsTouching(bob, bobsConnection)).toEqual(before);
  });

  it("creates the caller's own job on the caller's own connection", async () => {
    const payload = await resolver.createConnectionSyncJob(asAlice(), aliceInput());

    expect(payload.success).toBe(true);
    expect(payload.connectionSyncJob).toMatchObject({
      userId: GlobalUID.encode('user', alice),
      connectionId: GlobalUID.encode('connection', alicesConnection),
      endpointName: 'messages',
      status: 'pending',
    });
    expect(await jobsTouching(alice, alicesConnection)).toEqual([
      expect.objectContaining({ user_id: alice, connection_id: alicesConnection, status: 'pending' }),
    ]);
  });
});

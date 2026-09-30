import { ForbiddenException } from '@nestjs/common';
import { DataSource, type QueryRunner, type Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { ConnectionEntity, ProviderEntity } from '@ci/domains/connections';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ConnectionSyncJobEntity } from '../../entities/ConnectionSyncJobEntity';
import { ConnectionSyncJobService } from '../ConnectionSyncJobService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A SYNC JOB CREATED UNDER AN ID ANOTHER USER'S ROW HOLDS — REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ci_etl.connection_sync_jobs`' primary key is `id` alone. create() built a
 * row under whatever id it was handed and gave it to TypeORM's save(), which
 * decides insert-vs-update by loading the primary key alone. So an id held by
 * another user's job became an UPDATE of that job: `user_id` flipped to the
 * caller, its connection, endpoint, status, type, cursor and properties
 * overwritten — and `data`, the provider payload the job had fetched and not
 * yet transformed, left where it was. The caller could then read it back
 * through `connectionSyncJob(id)`, and a `success` status queued it for a
 * transform that files it under the job's new `user_id`.
 *
 * Reachable from the `createConnectionSyncJob` mutation, which passes
 * `input.id` straight through.
 *
 * What only Postgres can show: the takeover itself (the control), the refusal
 * leaving the row byte-for-byte where it was, and the INSERT failing on
 * `connection_sync_jobs_pkey` when the id is taken after the read. The live-job
 * index path is covered on its own connections by
 * `SyncOrchestrator.duplicateJobs.integration.spec.ts`: a failed INSERT aborts
 * the transaction these tests roll back, so its follow-up read cannot run here.
 *
 * Every test runs in one transaction on one connection and rolls back. Opt-in
 * like the sibling suites: skips with the reason when nothing listens at
 * `MEMORY_TEST_DATABASE_URL` / `DATABASE_URL`.
 */
const ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[ConnectionSyncJobService.foreignId.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = {
  setContext: () => undefined,
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** What a finished Gmail fetch leaves in `data` for the transform to pick up. */
const FETCHED_PAYLOAD = {
  messages: [{ id: '18c2a', subject: 'Lab results', from: 'clinic@example.com' }],
};

interface StoredJob {
  /** The tuple's physical address: any UPDATE — even one writing the same values — moves it. */
  ctid: string;
  user_id: string;
  connection_id: string;
  job_id: string | null;
  endpoint_name: string;
  status: string;
  type: string;
  data: Record<string, unknown>;
  cursor: Record<string, unknown> | null;
  next_cursor: Record<string, unknown> | null;
  properties: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  completed_at: Date | null;
  last_transformed: Date | null;
}

describeWithDb(`ConnectionSyncJobService.create under a caller-named id (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let runner: QueryRunner;
  let jobs: Repository<ConnectionSyncJobEntity>;
  let service: ConnectionSyncJobService;
  let alice: string;
  let bob: string;
  /** `connection_id` carries no foreign key, so neither connection needs a row. */
  let alicesConnection: string;
  let bobsConnection: string;
  /** Bob's fetched-but-untransformed Gmail job — the row Alice's creates must never land on. */
  let bobsJob: string;
  let bobsJobAsFetched: StoredJob;

  const newUser = (label: string) =>
    createSyntheticTestUser((sql: string, params?: unknown[]) => runner.query(sql, params), label);

  /** A job as the executor leaves it: fetched, successful, awaiting its transform. */
  const fetchedJob = async (userId: string, connectionId: string) => {
    const id = uuidv7();
    await runner.query(
      `INSERT INTO ci_etl.connection_sync_jobs
         (id, user_id, connection_id, endpoint_name, status, type, data, cursor, next_cursor,
          properties, completed_at)
       VALUES ($1, $2, $3, 'messages', 'success', 'incremental', $4::jsonb, '{"page": 3}',
               '{"page": 4}', '{"label": "inbox"}', now())`,
      [id, userId, connectionId, JSON.stringify(FETCHED_PAYLOAD)],
    );

    return id;
  };

  const stored = async (id: string): Promise<StoredJob> => {
    const [row] = await runner.query(
      `SELECT ctid::text AS ctid, user_id, connection_id, job_id, endpoint_name, status::text AS status,
              type, data, cursor, next_cursor, properties, error, completed_at, last_transformed
         FROM ci_etl.connection_sync_jobs
        WHERE id = $1`,
      [id],
    );

    return row;
  };

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
      // The last three only because TypeORM refuses to build metadata for a
      // relation whose target is missing.
      entities: [ConnectionSyncJobEntity, ConnectionEntity, ProviderEntity, UserEntity],
      synchronize: false,
    });
    await dataSource.initialize();

    // SHARED: these tests row-lock ci.users inside their transaction. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'ConnectionSyncJobService.foreignId');
  });

  afterAll(async () => {
    await schemaLock?.release();
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    alice = await newUser('ConnectionSyncJob-foreignId-alice');
    bob = await newUser('ConnectionSyncJob-foreignId-bob');
    alicesConnection = uuidv7();
    bobsConnection = uuidv7();
    bobsJob = await fetchedJob(bob, bobsConnection);
    bobsJobAsFetched = await stored(bobsJob);

    jobs = runner.manager.getRepository(ConnectionSyncJobEntity);
    service = new ConnectionSyncJobService(jobs, logger as never);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await runner.rollbackTransaction();
    await runner.release();
  });

  it("control: save() of a job built under an id another user's row holds takes that row over, payload and all", async () => {
    // Field for field the row create() used to build for
    // `createConnectionSyncJob(input: { id: <Bob's job>, status: "success", ... })`
    // from Alice, and the save() it handed it to.
    await jobs.save(
      jobs.create({
        id: bobsJob,
        userId: alice,
        connectionId: alicesConnection,
        jobId: null,
        endpointName: 'messages',
        status: 'success',
        type: 'incremental',
        cursor: {},
        properties: null,
      }),
    );

    expect(await stored(bobsJob)).toMatchObject({
      user_id: alice,
      connection_id: alicesConnection,
      cursor: {},
      properties: null,
      // Never in the create, so never overwritten: Bob's mail, now Alice's row,
      // still waiting for a transform that files it under `user_id`.
      data: FETCHED_PAYLOAD,
      last_transformed: null,
    });
    // And Alice's own owner-scoped read hands it to her.
    expect((await service.findById({ userId: alice }, bobsJob))?.data).toEqual(FETCHED_PAYLOAD);
  });

  it('refuses an id whose row belongs to another user, and leaves that row untouched', async () => {
    const create = service.create(
      { userId: alice },
      {
        id: bobsJob,
        userId: alice,
        connectionId: alicesConnection,
        endpointName: 'messages',
        type: 'incremental',
        status: 'success',
      },
    );

    await expect(create).rejects.toThrow(ForbiddenException);
    await expect(create).rejects.toThrow(`is not owned by ${alice}`);
    expect(await stored(bobsJob)).toEqual(bobsJobAsFetched);
    expect(await service.findById({ userId: alice }, bobsJob)).toBeNull();
  });

  it("raises on the primary key when another user's row takes the id between the read and the INSERT", async () => {
    // As if Bob's row committed just after this create looked the id up.
    jest.spyOn(jobs, 'findOne').mockResolvedValueOnce(null);

    await runner.query('SAVEPOINT before_write');
    await expect(
      service.create(
        { userId: alice },
        {
          id: bobsJob,
          userId: alice,
          connectionId: alicesConnection,
          endpointName: 'messages',
          type: 'incremental',
        },
      ),
    ).rejects.toThrow('connection_sync_jobs_pkey');
    await runner.query('ROLLBACK TO SAVEPOINT before_write');

    expect(await stored(bobsJob)).toEqual(bobsJobAsFetched);
  });

  it('inserts under an id the caller names when no row holds it, and returns it with the defaults', async () => {
    const id = uuidv7();

    const job = await service.create(
      { userId: alice },
      {
        id,
        userId: alice,
        connectionId: alicesConnection,
        endpointName: 'messages',
        type: 'historical',
        cursor: { page: 1 },
      },
    );

    expect(job).toMatchObject({
      id,
      userId: alice,
      connectionId: alicesConnection,
      status: 'pending',
      cursor: { page: 1 },
      // Filled in by Postgres and handed back by the INSERT.
      data: {},
      nextCursor: {},
    });
    expect(job.createdAt).toBeInstanceOf(Date);
    expect(await stored(id)).toMatchObject({
      user_id: alice,
      connection_id: alicesConnection,
      endpoint_name: 'messages',
      status: 'pending',
      type: 'historical',
      data: {},
      cursor: { page: 1 },
      properties: null,
    });
  });

  it('mints an id when the caller names none', async () => {
    const job = await service.create(
      { userId: alice },
      { userId: alice, connectionId: alicesConnection, endpointName: 'messages', type: 'incremental' },
    );

    expect(await stored(job.id)).toMatchObject({ user_id: alice, status: 'pending' });
  });

  it("updates the caller's own row under an id it already holds, as before", async () => {
    const alicesJob = await fetchedJob(alice, alicesConnection);
    const before = await stored(alicesJob);

    const job = await service.create(
      { userId: alice },
      {
        id: alicesJob,
        userId: alice,
        connectionId: alicesConnection,
        endpointName: 'messages',
        type: 'incremental',
        status: 'pending',
        cursor: { page: 9 },
      },
    );

    expect(job.id).toBe(alicesJob);

    const after = await stored(alicesJob);
    expect(after.ctid).not.toBe(before.ctid);
    expect(after).toMatchObject({
      user_id: alice,
      status: 'pending',
      cursor: { page: 9 },
      // Not in the create, so untouched — exactly what save() always did here.
      data: FETCHED_PAYLOAD,
      next_cursor: { page: 4 },
    });
  });
});

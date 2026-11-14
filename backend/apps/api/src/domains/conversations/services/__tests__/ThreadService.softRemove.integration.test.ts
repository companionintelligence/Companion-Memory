import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { ServiceContext } from '@ci/common/context';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ThreadEntity } from '../../entities/ThreadEntity';
import { ThreadService } from '../ThreadService';

/**
 * Deleting a chat while it answers must leave its row `idle` in Postgres. The model queues count `queued` and
 * `running` rows as someone waiting on the model, and the stopped turn cannot clear the status itself once the
 * thread is archived: its write goes through `update`, which skips archived threads.
 *
 * Opt-in like its neighbours: set `CONVERSATIONS_TEST_DATABASE_URL` to a migrated database of your OWN, or run
 * `make test-db`, which provides one.
 */
const availability = databaseAvailability({ urlEnvVar: 'CONVERSATIONS_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[conversations/ThreadService.softRemove.integration] SKIPPED: ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ThreadService.softRemove leaves a deleted chat idle (${availability.target})`, () => {
  const ownerId = uuidv7();
  const owner = { userId: ownerId } as ServiceContext;

  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: ThreadService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection({ urlEnvVar: 'CONVERSATIONS_TEST_DATABASE_URL' }),
      entities: [ThreadEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'conversations/ThreadService.softRemove');
    await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ThreadDelete', ownerId);

    service = new ThreadService(
      dataSource.getRepository(ThreadEntity),
      { findByThreadId: jest.fn(async () => []), softRemove: jest.fn(async () => true) } as never,
      { send: jest.fn(async () => []) } as never,
      { emit: jest.fn() } as never,
    );
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci.threads WHERE user_id = $1', [ownerId]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ownerId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  async function runningThread(): Promise<string> {
    const rows: Array<{ thread_id: string }> = await dataSource.query(
      "INSERT INTO ci.threads (user_id, generation_status) VALUES ($1, 'running') RETURNING thread_id",
      [ownerId],
    );

    return rows[0].thread_id;
  }

  async function rowOf(id: string): Promise<{ is_archived: boolean; generation_status: string }> {
    const rows: Array<{ is_archived: boolean; generation_status: string }> = await dataSource.query(
      'SELECT is_archived, generation_status FROM ci.threads WHERE thread_id = $1',
      [id],
    );

    return rows[0];
  }

  it('archives a running chat and sets it idle', async () => {
    const id = await runningThread();

    await expect(service.softRemove(owner, id)).resolves.toBe(true);

    expect(await rowOf(id)).toEqual({ is_archived: true, generation_status: 'idle' });
  });

  it('stays idle when the stopped turn writes its status afterwards', async () => {
    const id = await runningThread();

    await service.softRemove(owner, id);

    await expect(service.update(owner, id, { generationStatus: 'running' })).resolves.toBeNull();
    expect(await rowOf(id)).toEqual({ is_archived: true, generation_status: 'idle' });
  });
});

import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { ServiceContext } from '@ci/common/context';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ThreadEntity } from '../../entities/ThreadEntity';
import { ThreadUpdatedEvent } from '../../events';
import { ThreadService } from '../ThreadService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A STAND-IN TITLE NEVER REPLACES A REAL ONE. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * When the model cannot name a thread, the title job settles for the person's own first words. That
 * write races everything else that can name a thread — a later turn's title job, a rename — and it is
 * only safe because it is ONE conditional UPDATE: the row decides whether it still has no title. The
 * unit test checks the statement's shape against a fake query builder; whether that statement runs
 * against the real `ci.threads` columns, and matches exactly the rows it should, is a property of rows.
 *
 * Opt-in like its neighbours: set `CONVERSATIONS_TEST_DATABASE_URL` to a migrated database of your
 * OWN, or run `make test-db`, which provides one.
 */
const availability = databaseAvailability({ urlEnvVar: 'CONVERSATIONS_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[conversations/ThreadService.nameIfUnnamed.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ThreadService.nameIfUnnamed names only an unnamed thread (${availability.target})`, () => {
  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as ServiceContext;

  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: ThreadService;

  const eventService = { send: jest.fn(async () => []) };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection({ urlEnvVar: 'CONVERSATIONS_TEST_DATABASE_URL' }),
      entities: [ThreadEntity, UserEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'conversations/ThreadService.nameIfUnnamed');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ThreadTitle', userId);
    }

    service = new ThreadService(
      dataSource.getRepository(ThreadEntity),
      {} as never,
      eventService as never,
      { emit: jest.fn() } as never,
    );
  });

  beforeEach(() => {
    eventService.send.mockClear();
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci.threads WHERE user_id = ANY($1::uuid[])', [[ownerId, strangerId]]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  async function thread(userId: string, title: string | null, archived = false): Promise<string> {
    const rows: Array<{ thread_id: string }> = await dataSource.query(
      'INSERT INTO ci.threads (user_id, title, is_archived) VALUES ($1, $2, $3) RETURNING thread_id',
      [userId, title, archived],
    );

    return rows[0].thread_id;
  }

  async function titleOf(id: string): Promise<string | null> {
    const rows: Array<{ title: string | null }> = await dataSource.query(
      'SELECT title FROM ci.threads WHERE thread_id = $1',
      [id],
    );

    return rows[0].title;
  }

  it.each([
    ['no title at all', null],
    ['a blank title', '   '],
  ])('writes the title into a thread with %s, and announces it', async (_label, title) => {
    const id = await thread(ownerId, title);

    await expect(service.nameIfUnnamed(owner, id, 'Plan dinner')).resolves.toBe(true);

    expect(await titleOf(id)).toBe('Plan dinner');
    expect(eventService.send).toHaveBeenCalledWith(ThreadUpdatedEvent, { threadId: id });
  });

  it('leaves a real title alone — whoever wrote it, however recently — and announces nothing', async () => {
    const id = await thread(ownerId, 'Moving to Lisbon');

    await expect(service.nameIfUnnamed(owner, id, 'Plan dinner')).resolves.toBe(false);

    expect(await titleOf(id)).toBe('Moving to Lisbon');
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('never names a thread that was deleted', async () => {
    const id = await thread(ownerId, null, true);

    await expect(service.nameIfUnnamed(owner, id, 'Plan dinner')).resolves.toBe(false);

    expect(await titleOf(id)).toBeNull();
  });

  it('never names another person’s thread', async () => {
    const id = await thread(strangerId, null);

    await expect(service.nameIfUnnamed(owner, id, 'Plan dinner')).resolves.toBe(false);

    expect(await titleOf(id)).toBeNull();
  });

  it('keeps the first of two stand-ins that race for the same unnamed thread', async () => {
    const id = await thread(ownerId, null);

    const results = await Promise.all([
      service.nameIfUnnamed(owner, id, 'First words'),
      service.nameIfUnnamed(owner, id, 'Other words'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(['First words', 'Other words']).toContain(await titleOf(id));
  });
});

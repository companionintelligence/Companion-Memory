import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { ServiceContext } from '@ci/common/context';
import { FileEntity } from '@ci/domains/files';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { MessageEntity } from '../../entities/MessageEntity';
import { ThreadEntity } from '../../entities/ThreadEntity';
import { MessageService } from '../MessageService';

/**
 * The paged reads behind `Thread.messages`, against a real Postgres: the
 * batched first page of several threads (ranked in one read, with the total
 * and a "more" sentinel per thread), and a single thread's page past a cursor
 * in either direction. Oldest first throughout, by id (v7 UUIDs).
 */
const ENV = { urlEnvVar: 'CONVERSATIONS_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[MessageService.threadPages.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`MessageService thread pages (${availability.target})`, () => {
  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as ServiceContext;
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: MessageService;
  let chatty: string;
  let quiet: string;
  let empty: string;
  /** Oldest first, as inserted. */
  const chattyIds: string[] = [];

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(ENV),
      entities: [MessageEntity, ThreadEntity, UserEntity, FileEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'conversations/MessageService.threadPages');

    for (const userId of [ownerId, strangerId]) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ThreadPages', userId);
    }

    service = new MessageService(
      dataSource.getRepository(MessageEntity),
      {} as never,
      { send: async () => [] } as never,
    );

    const thread = async (userId: string): Promise<string> => {
      const rows: Array<{ thread_id: string }> = await dataSource.query(
        'INSERT INTO ci.threads (user_id, title) VALUES ($1, $2) RETURNING thread_id',
        [userId, 'thread'],
      );

      return rows[0].thread_id;
    };

    const message = async (
      threadId: string,
      userId: string,
      content: string,
      canceled = false,
    ): Promise<string> => {
      const id = uuidv7();
      await dataSource.query(
        `INSERT INTO ci.messages (message_id, role, content, user_id, thread_id, is_deleted)
         VALUES ($1, 'user', $2, $3, $4, $5)`,
        [id, content, userId, threadId, canceled],
      );

      return id;
    };

    chatty = await thread(ownerId);
    quiet = await thread(ownerId);
    empty = await thread(ownerId);

    for (const n of [1, 2, 3, 4, 5]) {
      chattyIds.push(await message(chatty, ownerId, `chatty ${n}`));
    }

    await message(chatty, ownerId, 'chatty canceled', true);
    await message(chatty, strangerId, 'not the owner');
    await message(quiet, ownerId, 'quiet 1');
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.messages WHERE user_id = ANY($1::uuid[])', [
        [ownerId, strangerId],
      ]);
      await dataSource.query('DELETE FROM ci.threads WHERE user_id = ANY($1::uuid[])', [
        [ownerId, strangerId],
      ]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [[ownerId, strangerId]]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  const idsOf = (page: { messages: Array<{ id: string }> } | undefined) => page?.messages.map((m) => m.id);

  it("reads each thread's first page, oldest first, with its own total and whether more follow — in one read", async () => {
    const pages = await service.findFirstPageByThreadIds(owner, [chatty, quiet, empty], 2);

    expect(idsOf(pages.get(chatty))).toEqual(chattyIds.slice(0, 2));
    expect(pages.get(chatty)).toMatchObject({ hasNextPage: true, hasPreviousPage: false, totalCount: 5 });
    expect(pages.get(quiet)).toMatchObject({ hasNextPage: false, totalCount: 1 });
    expect(pages.has(empty)).toBe(false);
  });

  it("leaves out canceled messages and another user's, from the rows and the total", async () => {
    const pages = await service.findFirstPageByThreadIds(owner, [chatty], 10);

    expect(idsOf(pages.get(chatty))).toEqual(chattyIds);
    expect(pages.get(chatty)?.totalCount).toBe(5);
  });

  it('pages one thread forward past a cursor, counting only when asked', async () => {
    const page = await service.findPageByThread(owner, chatty, { first: 2, afterId: chattyIds[1] });

    expect(idsOf(page)).toEqual(chattyIds.slice(2, 4));
    expect(page).toMatchObject({ hasNextPage: true, hasPreviousPage: true, totalCount: 5 });

    const uncounted = await service.findPageByThread(
      owner,
      chatty,
      { first: 2, afterId: chattyIds[3] },
      { countTotal: false },
    );

    expect(idsOf(uncounted)).toEqual(chattyIds.slice(4));
    expect(uncounted).toMatchObject({ hasNextPage: false, totalCount: null });
  });

  it('pages one thread backward, returning the page in forward order', async () => {
    const tail = await service.findPageByThread(owner, chatty, { last: 2 });
    expect(idsOf(tail)).toEqual(chattyIds.slice(3));
    expect(tail).toMatchObject({ hasNextPage: false, hasPreviousPage: true });

    const before = await service.findPageByThread(owner, chatty, { last: 2, beforeId: chattyIds[3] });
    expect(idsOf(before)).toEqual(chattyIds.slice(1, 3));
    expect(before).toMatchObject({ hasNextPage: true, hasPreviousPage: true });
  });
});

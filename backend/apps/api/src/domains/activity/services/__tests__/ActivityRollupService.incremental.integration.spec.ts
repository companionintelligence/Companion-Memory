import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';
import { MessageEntity, MessageService, ThreadEntity } from '@ci/domains/conversations';
import type { EventService } from '@ci/domains/events';
import { FileEntity, FileService } from '@ci/domains/files';
import { AnswerEntity, AnswerService, QuestionEntity } from '@ci/domains/intelligence';
import {
  BaseEntity,
  CalendarEventService,
  ContentBaseEntity,
  ContentEntity,
  ContentService,
  EventBaseEntity,
  EventEntity,
  GraphNodeEntity,
  GraphUtilityService,
} from '@ci/domains/memory';
import { NoteEntity, NoteService } from '@ci/domains/notes';
import { UserEntity, type UserService } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ActivityRollupService } from '../ActivityRollupService';

/**
 * The incremental pass against a live Postgres, over notes: the touched-bucket
 * predicate finds the hour a new note landed in and only that hour is written;
 * an hour nothing changed in is left as the full pass wrote it; a full pass
 * still removes a bucket whose rows were hard-deleted.
 */
const ENV = { urlEnvVar: 'ACTIVITY_TEST_DATABASE_URL' };
const availability = databaseAvailability(ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[ActivityRollupService.incremental.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ActivityRollupService incremental refresh (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: ActivityRollupService;
  let userId: string;
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const idle = { aggregateHourlyActivity: async () => [] } as never;

  const note = async (createdAt: string): Promise<string> => {
    const id = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.notes (id, user_id, title, content, created_at, updated_at)
       VALUES ($1, $2, 'note', 'body', $3::timestamptz, $3::timestamptz)`,
      [id, userId, createdAt],
    );

    return id;
  };

  const rollup = async () =>
    dataSource.query<Array<{ bucket_start: Date; count: number }>>(
      `SELECT bucket_start, count FROM ci.activity_rollup WHERE user_id = $1 AND source = 'notes' ORDER BY bucket_start`,
      [userId],
    );

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(ENV),
      entities: [NoteEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'activity/ActivityRollupService.incremental');
    userId = await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ActivityRollup');

    const notes = new NoteService(
      dataSource.getRepository(NoteEntity),
      { send: async () => [] } as unknown as EventService,
      logger as unknown as LoggerService,
    );
    service = new ActivityRollupService(
      dataSource,
      idle,
      idle,
      idle,
      notes,
      idle,
      idle,
      idle,
      idle,
      {} as unknown as UserService,
      logger as unknown as LoggerService,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.activity_rollup WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.notes WHERE user_id = $1', [userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('writes only the hour a change landed in, and a full pass still prunes what vanished', async () => {
    await note('2026-07-01T09:10:00Z');
    await note('2026-07-01T09:40:00Z');
    const lonely = await note('2026-07-01T11:05:00Z');

    await service.refreshAll();
    expect((await rollup()).map((r) => [r.bucket_start.toISOString(), r.count])).toEqual([
      ['2026-07-01T09:00:00.000Z', 2],
      ['2026-07-01T11:00:00.000Z', 1],
    ]);

    // A note lands in the 09:00 hour, stamped now; nothing else changed. Only
    // that hour is recounted — and in full, so it reads 3, not 1.
    const id = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.notes (id, user_id, title, content, created_at, updated_at)
       VALUES ($1, $2, 'note', 'body', '2026-07-01T09:50:00Z', now())`,
      [id, userId],
    );
    // And the 11:00 hour's row is made to look stale, to show it is not touched.
    await dataSource.query(
      `UPDATE ci.activity_rollup SET count = 9 WHERE user_id = $1 AND source = 'notes' AND bucket_start = '2026-07-01T11:00:00Z'`,
      [userId],
    );

    await service.refreshAll({ changedSince: new Date(Date.now() - 60_000) });
    expect((await rollup()).map((r) => [r.bucket_start.toISOString(), r.count])).toEqual([
      ['2026-07-01T09:00:00.000Z', 3],
      ['2026-07-01T11:00:00.000Z', 9],
    ]);

    // A hard delete leaves nothing for an incremental pass to find; the full pass sees it.
    await dataSource.query('DELETE FROM ci.notes WHERE id = $1', [lonely]);
    await service.refreshAll({ changedSince: new Date(Date.now() - 60_000) });
    expect((await rollup()).map((r) => r.bucket_start.toISOString())).toContain('2026-07-01T11:00:00.000Z');

    await service.refreshAll();
    expect((await rollup()).map((r) => [r.bucket_start.toISOString(), r.count])).toEqual([
      ['2026-07-01T09:00:00.000Z', 3],
    ]);
  });
});

describeWithDb(`every provider's incremental query runs on Postgres (${availability.target})`, () => {
  // Each provider's touched-bucket query names its table's columns in raw SQL,
  // which only Postgres can check. Nothing is seeded: an empty answer proves
  // the statement parses and every column it names exists.
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(ENV),
      entities: [
        EventEntity,
        GraphNodeEntity,
        ContentEntity,
        ContentBaseEntity,
        BaseEntity,
        EventBaseEntity,
        MessageEntity,
        ThreadEntity,
        AnswerEntity,
        QuestionEntity,
        FileEntity,
        UserEntity,
      ],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  const providers: Array<[string, new (...args: never[]) => object, string, new () => object]> = [
    ['events', CalendarEventService, 'eventRepository', EventEntity],
    ['entities', GraphUtilityService, 'entityRepo', GraphNodeEntity],
    ['content', ContentService, 'contentRepository', ContentEntity],
    ['messages', MessageService, 'messageRepository', MessageEntity],
    ['answers', AnswerService, 'answerRepository', AnswerEntity],
    ['files', FileService, 'fileRepository', FileEntity],
  ];

  it.each(providers)('%s', async (_source, Service, repositoryField, Entity) => {
    const provider = Object.assign(Object.create(Service.prototype), {
      [repositoryField]: dataSource.getRepository(Entity),
    }) as { aggregateHourlyActivity(options?: { changedSince?: Date }): Promise<unknown[]> };

    await expect(provider.aggregateHourlyActivity({ changedSince: new Date() })).resolves.toEqual([]);
    await expect(provider.aggregateHourlyActivity()).resolves.toEqual(expect.any(Array));
  });
});

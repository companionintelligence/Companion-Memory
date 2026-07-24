import { BadRequestException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import type { MessageService } from '@ci/domains/conversations';
import type { FileService } from '@ci/domains/files';
import type { AnswerService } from '@ci/domains/intelligence';
import type {
  CommunicationService,
  ContentService,
  EventService,
  GraphUtilityService,
} from '@ci/domains/memory';
import type { NoteService } from '@ci/domains/notes';
import type { UserService } from '@ci/domains/user';

import { ActivityRollupService, type ActivityBucketRow } from '../ActivityRollupService';

const userContext = { userId: 'user-1' };

const EXPECTED_SOURCES = [
  'communications',
  'events',
  'messages',
  'notes',
  'content',
  'files',
  'answers',
  'entities',
];

function makeService(
  queryResult: unknown[] = [],
  user: { timezone: string } | null = { timezone: 'America/New_York' },
) {
  const dataSource = { query: jest.fn().mockResolvedValue(queryResult) };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const userService = { findById: jest.fn().mockResolvedValue(user) };

  const aggregates = new Map<string, jest.Mock>(
    EXPECTED_SOURCES.map((source) => [source, jest.fn().mockResolvedValue([])]),
  );
  const provider = (source: string) => ({ aggregateHourlyActivity: aggregates.get(source) });

  const service = new ActivityRollupService(
    dataSource as unknown as DataSource,
    provider('communications') as unknown as CommunicationService,
    provider('events') as unknown as EventService,
    provider('messages') as unknown as MessageService,
    provider('notes') as unknown as NoteService,
    provider('content') as unknown as ContentService,
    provider('files') as unknown as FileService,
    provider('answers') as unknown as AnswerService,
    provider('entities') as unknown as GraphUtilityService,
    userService as unknown as UserService,
    logger as unknown as LoggerService,
  );

  return { service, dataSource, logger, aggregates, userService };
}

describe('ActivityRollupService.refreshAll', () => {
  it('asks each owning domain for its aggregate and writes one statement per source', async () => {
    const { service, dataSource, aggregates } = makeService();

    const rows: ActivityBucketRow[] = [
      { userId: 'user-1', bucketStart: new Date('2026-07-01T03:00:00Z'), count: 2 },
      { userId: 'user-2', bucketStart: new Date('2026-07-01T15:00:00Z'), count: 1 },
    ];
    aggregates.get('notes')!.mockResolvedValue(rows);

    await service.refreshAll();

    for (const aggregate of aggregates.values()) {
      expect(aggregate).toHaveBeenCalledTimes(1);
    }

    const writtenSources = dataSource.query.mock.calls.map(([, params]) => (params as unknown[])[0]);

    expect(writtenSources).toEqual(EXPECTED_SOURCES);

    const [, notesParams] = dataSource.query.mock.calls[EXPECTED_SOURCES.indexOf('notes')];

    expect(notesParams).toEqual([
      'notes',
      ['user-1', 'user-2'],
      [new Date('2026-07-01T03:00:00Z'), new Date('2026-07-01T15:00:00Z')],
      [2, 1],
    ]);
  });

  it('writes an empty aggregate too, so vanished sources are pruned', async () => {
    const { service, dataSource } = makeService();

    await service.refreshAll();

    const [, params] = dataSource.query.mock.calls[0];

    expect(params).toEqual(['communications', [], [], []]);
  });

  it('continues with the remaining sources when one aggregate fails', async () => {
    const { service, dataSource, logger, aggregates } = makeService();

    aggregates.get('events')!.mockRejectedValue(new Error('boom'));

    await service.refreshAll();

    expect(logger.error).toHaveBeenCalledTimes(1);

    const writtenSources = dataSource.query.mock.calls.map(([, params]) => (params as unknown[])[0]);

    expect(writtenSources).toEqual(EXPECTED_SOURCES.filter((source) => source !== 'events'));
  });
});

describe('ActivityRollupService.getDailyCounts', () => {
  it('queries the rollup scoped to the user with day boundaries in the profile timezone', async () => {
    const rows = [
      { date: '2026-07-01', count: 3 },
      { date: '2026-07-02', count: 7 },
    ];
    const { service, dataSource, userService } = makeService(rows);

    const result = await service.getDailyCounts(userContext, {
      start: '2026-07-01',
      end: '2026-07-31',
    });

    expect(result).toEqual(rows);
    expect(userService.findById).toHaveBeenCalledWith(userContext, 'user-1');

    const [, params] = dataSource.query.mock.calls[0];

    expect(params).toEqual(['user-1', '2026-07-01', '2026-07-31', 'America/New_York', null]);
  });

  it('falls back to UTC when the profile has no timezone', async () => {
    const { service, dataSource } = makeService([], null);

    await service.getDailyCounts(userContext, { start: '2026-07-01', end: '2026-07-02' });

    const [, params] = dataSource.query.mock.calls[0];

    expect(params[3]).toBe('UTC');
  });

  it('passes requested sources through when they are known', async () => {
    const { service, dataSource } = makeService();

    await service.getDailyCounts(userContext, {
      start: '2026-07-01',
      end: '2026-07-02',
      sources: ['communications', 'events'],
    });

    const [, params] = dataSource.query.mock.calls[0];

    expect(params[4]).toEqual(['communications', 'events']);
  });

  it('rejects malformed dates', async () => {
    const { service } = makeService();

    await expect(
      service.getDailyCounts(userContext, { start: '2026-7-1', end: '2026-07-02' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a start after end', async () => {
    const { service } = makeService();

    await expect(
      service.getDailyCounts(userContext, { start: '2026-07-03', end: '2026-07-02' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects unknown sources', async () => {
    const { service } = makeService();

    await expect(
      service.getDailyCounts(userContext, {
        start: '2026-07-01',
        end: '2026-07-02',
        sources: ['communications', 'position'],
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

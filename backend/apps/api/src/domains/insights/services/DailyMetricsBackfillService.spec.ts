import { DAILY_METRICS_QUEUE, DailyMetricsComputeRequestEvent } from '../events';

import { DailyMetricsBackfillService, planBackfillChunks } from './DailyMetricsBackfillService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT = { userId: USER };

const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

function makeService(minDate: string | null) {
  const repository = {
    query: jest.fn<Promise<Array<{ min_date: string | null }>>, [string, unknown[]]>(async () => [
      { min_date: minDate },
    ]),
  };
  const eventService = {
    send: jest.fn<Promise<string[]>, [string, Record<string, unknown>, { queue: string }]>(async () => [
      'job-1',
    ]),
  };

  const service = new DailyMetricsBackfillService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, repository, eventService };
}

describe('planBackfillChunks', () => {
  it('splits an exact multiple into equal chunks, oldest first', () => {
    expect(planBackfillChunks('2026-01-01', '2026-01-06', 3)).toEqual([
      { endDate: '2026-01-03', days: 3 },
      { endDate: '2026-01-06', days: 3 },
    ]);
  });

  it('gives the final chunk the remainder days', () => {
    expect(planBackfillChunks('2026-01-01', '2026-01-07', 3)).toEqual([
      { endDate: '2026-01-03', days: 3 },
      { endDate: '2026-01-06', days: 3 },
      { endDate: '2026-01-07', days: 1 },
    ]);
  });

  it('covers a single day and a range shorter than one chunk', () => {
    expect(planBackfillChunks('2026-07-06', '2026-07-06', 30)).toEqual([{ endDate: '2026-07-06', days: 1 }]);
    expect(planBackfillChunks('2026-07-01', '2026-07-06', 30)).toEqual([{ endDate: '2026-07-06', days: 6 }]);
  });

  it('crosses month boundaries without drift', () => {
    expect(planBackfillChunks('2026-06-25', '2026-07-04', 5)).toEqual([
      { endDate: '2026-06-29', days: 5 },
      { endDate: '2026-07-04', days: 5 },
    ]);
  });

  it('returns no chunks for an inverted range or a non-positive chunk size', () => {
    expect(planBackfillChunks('2026-07-06', '2026-07-01', 30)).toEqual([]);
    expect(planBackfillChunks('2026-07-01', '2026-07-06', 0)).toEqual([]);
  });
});

describe('DailyMetricsBackfillService.backfill', () => {
  it('enqueues one job per chunk on the daily-metrics queue', async () => {
    const { service, eventService } = makeService('2026-01-01');

    const result = await service.backfill(CONTEXT, {
      fromDate: '2026-07-01',
      toDate: '2026-07-06',
      chunkDays: 3,
      timezone: 'America/New_York',
    });

    expect(result).toEqual({
      status: 'enqueued',
      fromDate: '2026-07-01',
      toDate: '2026-07-06',
      days: 6,
      chunks: 2,
    });

    expect(eventService.send).toHaveBeenCalledTimes(2);

    const [name, payload, options] = eventService.send.mock.calls[0];

    expect(name).toBe(DailyMetricsComputeRequestEvent);
    expect(payload).toEqual({
      userId: USER,
      endDate: '2026-07-03',
      days: 3,
      timezone: 'America/New_York',
    });
    expect(options).toEqual({ queue: DAILY_METRICS_QUEUE });
  });

  it('derives fromDate from the earliest captured data when omitted', async () => {
    const { service, repository, eventService } = makeService('2026-07-04');

    const result = await service.backfill(CONTEXT, { toDate: '2026-07-06' });

    expect(repository.query).toHaveBeenCalledTimes(1);
    expect(repository.query.mock.calls[0][1]).toEqual([USER, 'UTC']);

    expect(result.status).toBe('enqueued');
    expect(result.fromDate).toBe('2026-07-04');
    expect(result.days).toBe(3);
    expect(eventService.send).toHaveBeenCalledTimes(1);
  });

  it('noops for a user with no captured data', async () => {
    const { service, eventService } = makeService(null);

    const result = await service.backfill(CONTEXT, { toDate: '2026-07-06' });

    expect(result).toEqual({ status: 'noop', fromDate: null, toDate: null, days: 0, chunks: 0 });
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('noops when fromDate is after toDate', async () => {
    const { service, eventService } = makeService('2026-01-01');

    const result = await service.backfill(CONTEXT, { fromDate: '2026-07-06', toDate: '2026-07-01' });

    expect(result.status).toBe('noop');
    expect(eventService.send).not.toHaveBeenCalled();
  });
});

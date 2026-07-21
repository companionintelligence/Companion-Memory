import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';

import { DailyMetricEntity } from '../entities/DailyMetricEntity';
import { DAILY_AGGREGATE_SQL } from '../metrics/dailyAggregateSql';
import type { DailyMetrics, MetricCoverage, MetricValues } from '../types';

import { DailyMetricsService } from './DailyMetricsService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER };

type FindArg = { where: { userId?: string }; order?: unknown };

function makeRepo() {
  return {
    query: jest.fn<Promise<Array<Record<string, unknown>>>, [string, unknown[]]>(async () => []),
    upsert: jest.fn<Promise<unknown>, [DailyMetricEntity, unknown]>(async () => ({})),
    find: jest.fn<Promise<DailyMetricEntity[]>, [FindArg]>(async () => []),
    findOne: jest.fn<Promise<DailyMetricEntity | null>, [FindArg]>(async () => null),
  };
}

const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

function makeService(repo: ReturnType<typeof makeRepo>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new DailyMetricsService(repo as any, logger as any);
}

const FULL_METRICS: MetricValues = {
  n_messages: 3,
  n_conversations: 3,
  n_unique_contacts: 2,
  outbound_ratio: 0.5,
  avg_sentiment: 0.1,
  n_places: 2,
  km_traveled: 1.5,
  screen_minutes: 30,
  n_domains: 4,
  spend_total: 9.99,
};

function entityFor(date: string, metrics: Partial<MetricValues> = {}): DailyMetricEntity {
  const dm: DailyMetrics = {
    userId: USER,
    date,
    timezone: 'UTC',
    metrics: { ...FULL_METRICS, ...metrics },
    coverage: Object.fromEntries(Object.keys(FULL_METRICS).map((k) => [k, 1])) as MetricCoverage,
    computedAt: new Date('2026-07-07T00:00:00Z'),
  };

  return DailyMetricEntity.fromDailyMetrics(dm);
}

describe('DailyMetricsService.computeForDay', () => {
  it('runs the aggregate SQL with (user, date, timezone) and assembles metrics', async () => {
    const repo = makeRepo();
    repo.query.mockResolvedValueOnce([
      { comms_rows: '3', comms_outbound: '1', comms_threads: '2', comms_nullthread_rows: '1' },
    ]);
    const service = makeService(repo);

    const result = await service.computeForDay(CONTEXT, '2026-07-06', 'America/New_York');

    expect(repo.query).toHaveBeenCalledTimes(1);
    expect(repo.query.mock.calls[0][0]).toBe(DAILY_AGGREGATE_SQL);
    expect(repo.query.mock.calls[0][1]).toEqual([USER, '2026-07-06', 'America/New_York']);

    expect(result.metrics.n_messages).toBe(3);
    expect(result.metrics.n_conversations).toBe(3); // 2 threads + 1 un-threaded
    expect(result.metrics.outbound_ratio).toBeCloseTo(1 / 3, 4);
    expect(result.coverage.n_messages).toBe(1);
    expect(result.timezone).toBe('America/New_York');
  });

  it('reports NULL metrics + zero coverage when the day has no rows (missing != zero)', async () => {
    const repo = makeRepo();
    repo.query.mockResolvedValueOnce([{}]);
    const service = makeService(repo);

    const result = await service.computeForDay(CONTEXT, '2026-07-06');

    expect(result.metrics.n_messages).toBeNull();
    expect(result.metrics.screen_minutes).toBeNull();
    expect(result.metrics.spend_total).toBeNull();
    expect(result.coverage.n_messages).toBe(0);
    expect(result.coverage.spend_total).toBe(0);
  });
});

describe('DailyMetricsService.computeAndStore', () => {
  it('upserts on the (userId, date) conflict target and returns the computed day', async () => {
    const repo = makeRepo();
    repo.query.mockResolvedValueOnce([{ comms_rows: '5' }]);
    const service = makeService(repo);

    const result = await service.computeAndStore(CONTEXT, '2026-07-06');

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const [entity, options] = repo.upsert.mock.calls[0];
    expect(entity.nMessages).toBe(5);
    expect(entity.userId).toBe(USER);
    expect(entity.date).toBe('2026-07-06');
    expect(options).toEqual({ conflictPaths: ['userId', 'date'] });
    expect(result.metrics.n_messages).toBe(5);
  });
});

describe('DailyMetricsService.getRange', () => {
  it('maps stored rows to DailyMetrics, scoped to the user and ordered by date', async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValueOnce([entityFor('2026-07-05'), entityFor('2026-07-06')]);
    const service = makeService(repo);

    const rows = await service.getRange(CONTEXT, '2026-07-05', '2026-07-06');

    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe('2026-07-05');
    expect(rows[0].metrics.n_messages).toBe(3);

    const findArg = repo.find.mock.calls[0][0];
    expect(findArg.where.userId).toBe(USER);
    expect(findArg.order).toEqual({ date: 'ASC' });
  });

  it('does not filter by user for a SYSTEM_USER context', async () => {
    const repo = makeRepo();
    repo.find.mockResolvedValueOnce([]);
    const service = makeService(repo);

    await service.getRange({ userId: SYSTEM_USER } as ServiceContext, '2026-07-01', '2026-07-02');

    const findArg = repo.find.mock.calls[0][0];
    expect(findArg.where.userId).toBeUndefined();
  });
});

import { SummaryBackfillService } from './SummaryBackfillService';

const USER = '00000000-0000-0000-0000-0000000000aa';

type PeriodType = 'hourly' | 'daily' | 'weekly' | 'monthly';

const FUNCTION_TO_PERIOD: Record<string, PeriodType> = {
  hourly_summary: 'hourly',
  daily_summary: 'daily',
  weekly_summary: 'weekly',
  monthly_summary: 'monthly',
};

interface DispatchCall {
  functionName: string;
  startTime: string;
  endTime: string;
  singletonKey: string;
}

interface FakeOptions {
  /** Pre-existing summary period_starts (epoch ms), per period type. */
  existing?: Partial<Record<PeriodType, number[]>>;
  /** UTC day-starts the activity pre-check should report as non-empty. */
  activityDays?: Date[];
  /** MIN/MAX(time) the auto-range query should answer when no explicit bounds are given. */
  minMax?: { min: Date; max: Date } | null;
  /** Dispatches that should be reported as "already pending" (dedup) instead of newly enqueued. */
  dedupeKeys?: Set<string>;
  /** Dispatches that should never land a summary row (simulates a stuck/failed job). */
  neverLandKeys?: Set<string>;
}

function makeService(opts: FakeOptions = {}) {
  const store: Record<PeriodType, Set<number>> = {
    hourly: new Set(opts.existing?.hourly ?? []),
    daily: new Set(opts.existing?.daily ?? []),
    weekly: new Set(opts.existing?.weekly ?? []),
    monthly: new Set(opts.existing?.monthly ?? []),
  };
  const activityDays = opts.activityDays ?? [];
  const minMax = opts.minMax ?? null;
  const dedupeKeys = opts.dedupeKeys ?? new Set<string>();
  const neverLandKeys = opts.neverLandKeys ?? new Set<string>();
  const dispatched: DispatchCall[] = [];

  const query = jest.fn(async (sql: string) => {
    if (sql.includes('MIN(t)')) {
      return [{ min_t: minMax?.min ?? null, max_t: minMax?.max ?? null }];
    }

    if (sql.includes("date_trunc('day'")) {
      return activityDays.map((day) => ({ day }));
    }

    return [];
  });

  interface FakeQueryBuilder {
    select: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    getRawMany: jest.Mock;
  }

  const getRepository = jest.fn(() => ({
    createQueryBuilder: jest.fn((): FakeQueryBuilder => {
      let periodType: PeriodType | null = null;
      const qb: FakeQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn((condition: string, params: Record<string, unknown>) => {
          if (condition.includes('periodType')) {
            periodType = params.periodType as PeriodType;
          }

          return qb;
        }),
        getRawMany: jest.fn(async () => {
          if (periodType == null) {
            return [];
          }

          return [...store[periodType]].map((t) => ({ periodStart: new Date(t) }));
        }),
      };

      return qb;
    }),
  }));

  const dataSource = { query, getRepository };

  const dispatch = jest.fn(
    async (
      _target: string,
      functionName: string,
      _userId: string,
      args: Record<string, unknown>,
      options: { singletonKey?: string },
    ) => {
      const singletonKey = options.singletonKey ?? '';
      dispatched.push({
        functionName,
        startTime: args.start_time as string,
        endTime: args.end_time as string,
        singletonKey,
      });

      // A dedup (singletonKey collision) means a job is ALREADY pending for
      // this window — it still lands its row on its own, just not as a NEW
      // enqueue from this call. Only `neverLandKeys` simulates a job that
      // never completes (exhausted retries).
      if (!neverLandKeys.has(singletonKey)) {
        const periodType = FUNCTION_TO_PERIOD[functionName];
        store[periodType].add(new Date(args.start_time as string).getTime());
      }

      return !dedupeKeys.has(singletonKey);
    },
  );

  const pythonFunctionService = { dispatch };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new SummaryBackfillService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dataSource as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pythonFunctionService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, dispatched, store };
}

describe('SummaryBackfillService.backfill', () => {
  it('returns an empty, range:null result when there is no activity and no explicit range', async () => {
    const { service, dispatched } = makeService({ minMax: null });

    const result = await service.backfill(USER);

    expect(result.range).toBeNull();
    expect(dispatched).toHaveLength(0);
  });

  it('cascades hourly -> daily -> weekly -> monthly over a 2-day window with no pre-existing summaries', async () => {
    // Two consecutive Mondays-in-the-same-week days, same month, so exactly
    // one weekly and one monthly window is expected alongside 2 daily / 48 hourly.
    const day1 = new Date('2023-01-16T00:00:00.000Z'); // Monday
    const day2 = new Date('2023-01-17T00:00:00.000Z'); // Tuesday
    const start = day1;
    const end = new Date('2023-01-18T00:00:00.000Z');

    const { service, dispatched, store } = makeService({ activityDays: [day1, day2] });

    const result = await service.backfill(USER, { startTime: start, endTime: end });

    expect(result.range).toEqual({ start: start.toISOString(), end: end.toISOString() });
    expect(result.daysWithActivity).toBe(2);
    expect(result.daysAlreadySummarized).toBe(0);
    expect(result.daysWithoutLandedHourly).toEqual([]);

    expect(result.hourly).toMatchObject({ enqueued: 48, deduped: 0, landed: 48, expected: 48, drained: true });
    expect(result.daily).toMatchObject({ enqueued: 2, deduped: 0, landed: 2, expected: 2, drained: true });
    expect(result.weekly).toMatchObject({ enqueued: 1, deduped: 0, landed: 1, expected: 1, drained: true });
    expect(result.monthly).toMatchObject({ enqueued: 1, deduped: 0, landed: 1, expected: 1, drained: true });

    // Every hourly dispatch carries the same singletonKey shape the live cron uses.
    const hourlyKeys = dispatched.filter((d) => d.functionName === 'hourly_summary').map((d) => d.singletonKey);
    expect(hourlyKeys).toContain(`fn:hourly_summary:${USER}:2023-01-16T00`);
    expect(hourlyKeys).toContain(`fn:hourly_summary:${USER}:2023-01-17T23`);

    expect(store.daily.size).toBe(2);
    expect(store.weekly.size).toBe(1);
    expect(store.monthly.size).toBe(1);
  });

  it('skips a day entirely (no hourly, no daily dispatch) when it already has a daily summary', async () => {
    const day1 = new Date('2023-01-16T00:00:00.000Z');
    const start = day1;
    const end = new Date('2023-01-17T00:00:00.000Z');

    const { service, dispatched } = makeService({
      activityDays: [day1],
      existing: { daily: [day1.getTime()] },
    });

    const result = await service.backfill(USER, { startTime: start, endTime: end });

    expect(result.daysWithActivity).toBe(1);
    expect(result.daysAlreadySummarized).toBe(1);
    expect(result.hourly.enqueued).toBe(0);
    expect(result.daily.enqueued).toBe(0);
    expect(dispatched).toHaveLength(0);
  });

  it('clamps the range to maxDays and reports truncated:true', async () => {
    const start = new Date('2023-01-01T00:00:00.000Z');
    const end = new Date('2023-01-20T00:00:00.000Z'); // 19 days

    const { service } = makeService({ activityDays: [] });

    const result = await service.backfill(USER, { startTime: start, endTime: end, maxDays: 2 });

    expect(result.truncated).toBe(true);
    expect(result.range).toEqual({
      start: start.toISOString(),
      end: new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  it('skips the daily rollup and reports the day when its hourly dispatch never lands', async () => {
    const day1 = new Date('2023-01-16T00:00:00.000Z');
    const start = day1;
    const end = new Date('2023-01-17T00:00:00.000Z');

    // Every hourly window for this day is dispatched but never lands a row —
    // simulates every job failing out its retries.
    const neverLandKeys = new Set<string>();
    for (let h = 0; h < 24; h += 1) {
      const hour = new Date(day1.getTime() + h * 60 * 60 * 1000);
      neverLandKeys.add(`fn:hourly_summary:${USER}:${hour.toISOString().slice(0, 13)}`);
    }

    const { service, dispatched } = makeService({ activityDays: [day1], neverLandKeys });

    const result = await service.backfill(USER, {
      startTime: start,
      endTime: end,
      drainTimeoutMs: 5,
      drainPollIntervalMs: 1,
    });

    expect(result.hourly.enqueued).toBe(24);
    expect(result.hourly.landed).toBe(0);
    expect(result.hourly.drained).toBe(false);
    expect(result.daysWithoutLandedHourly).toEqual(['2023-01-16']);
    expect(result.daily.enqueued).toBe(0);
    expect(dispatched.filter((d) => d.functionName === 'daily_summary')).toHaveLength(0);
  });

  it('counts a pg-boss singletonKey collision as deduped, not enqueued', async () => {
    const day1 = new Date('2023-01-16T00:00:00.000Z');
    const start = day1;
    const end = new Date('2023-01-16T01:00:00.000Z'); // one hour only

    const dedupeKeys = new Set([`fn:hourly_summary:${USER}:2023-01-16T00`]);
    const { service } = makeService({ activityDays: [day1], dedupeKeys });

    const result = await service.backfill(USER, {
      startTime: start,
      endTime: end,
      drainTimeoutMs: 1_000,
      drainPollIntervalMs: 1,
    });

    expect(result.hourly.enqueued).toBe(0);
    expect(result.hourly.deduped).toBe(1);
    expect(result.hourly.expected).toBe(1);
    // Deduped does not mean lost: the row still lands (another job owns it).
    expect(result.hourly.landed).toBe(1);
    expect(result.hourly.drained).toBe(true);
  });
});

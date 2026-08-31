/**
 * Regression tests for the corpus-anchored windows across the derivation
 * stack.
 *
 * The bug these pin down was measured live on 2026-08-30. Every ci_derived
 * table had a writer and every writer was dispatching on schedule, yet
 * `ci_derived.daily_metrics` held 30 rows whose thirteen metric columns were
 * NULL in all thirty, and the other seven tables held nothing at all. The
 * cause was not a missing producer; it was that three separate layers each
 * positioned their scan window on `now()` over a corpus that is a STATIC
 * historical import whose newest usable row was 2026-06-19:
 *
 *   1. `DailyMetricsService.refreshForUser`  — trailing 30 CALENDAR days
 *   2. the anomaly / correlation / suggestion engines — `today - 1`
 *   3. `PlaceClusterService.buildClusters`   — 90 days ending at `new Date()`
 *
 * Every assertion below was checked NON-VACUOUS by reverting the fix and
 * confirming the intended test fails.
 *
 * The shared fixture idea: each double serves rows ONLY inside the stale
 * corpus range and answers anything else with nothing. A wall-clock-anchored
 * caller therefore asks a question the data cannot answer and gets zero rows,
 * exactly as production did — which is what makes these tests fail without the
 * fix rather than merely assert the new call shape.
 */

import type { Repository } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { AnomalyEngine } from '../anomaly/AnomalyEngine';
import { CorrelationEngine } from '../correlation/CorrelationEngine';
import { shiftIso, todayIsoInTimezone } from '../dateUtil';
import type { DailyMetricEntity } from '../entities/DailyMetricEntity';
import type { PlaceClusterEntity } from '../entities/PlaceClusterEntity';
import { DAILY_AGGREGATE_SQL } from '../metrics/dailyAggregateSql';
import { PlaceClusterService } from '../places/PlaceClusterService';
import { DailyMetricsService } from '../services/DailyMetricsService';
import type { DailyMetrics, MetricCoverage, MetricValues } from '../types';

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER };

/**
 * The end of the real corpus on the appliance this was measured on: the newest
 * `ci.browser_activity` row. Deliberately a fixed historical date rather than
 * something derived from `Date.now()` — the whole point is that it is far
 * enough in the past that no trailing wall-clock window of any plausible width
 * reaches it, and it gets further away every day the test is not run.
 */
const CORPUS_END = '2026-06-19';

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
}

function userService(timezone = 'UTC') {
  return {
    findAllOnboarded: jest.fn(async () => [{ id: USER, timezone }]),
  };
}

// ---------------------------------------------------------------------------
// 1. the writer: which days get materialized
// ---------------------------------------------------------------------------

describe('DailyMetricsService.refreshForUser day selection', () => {
  function makeService(days: string[]) {
    const upsert = jest.fn<Promise<unknown>, [DailyMetricEntity, unknown]>(async () => ({}));
    const query = jest.fn<Promise<Array<Record<string, unknown>>>, [string, unknown[]]>(async (sql) =>
      sql.includes('WITH days AS') ? days.map((day) => ({ day })) : [],
    );
    const service = new DailyMetricsService(
      { query, upsert } as unknown as Repository<DailyMetricEntity>,
      logger(),
      userService() as never,
    );

    return { service, upsert, query };
  }

  it('materializes the days the corpus has, not the days the calendar has', async () => {
    const corpusDays = [CORPUS_END, shiftIso(CORPUS_END, -1), shiftIso(CORPUS_END, -2)];
    const { service, upsert } = makeService(corpusDays);

    await service.refreshForUser(CONTEXT, 3, 'UTC');

    // Oldest first: an interrupted run leaves the store contiguous from the back.
    expect(upsert.mock.calls.map((call) => call[0].date)).toEqual([...corpusDays].reverse());

    // The pre-fix implementation computed shiftIso(today, -n) for n in 0..2.
    // Naming today explicitly is what makes this fail on the old code rather
    // than merely describe the new code.
    const today = todayIsoInTimezone('UTC');
    const written = upsert.mock.calls.map((call) => call[0].date);
    expect(written).not.toContain(today);
    expect(written).not.toContain(shiftIso(today, -1));
  });

  it('asks for exactly windowDays days and clamps the selection to the local today', async () => {
    const { service, query } = makeService([CORPUS_END]);

    await service.refreshForUser(CONTEXT, 7, 'America/New_York');

    const selection = query.mock.calls.find((call) => call[0].includes('WITH days AS'));
    expect(selection).toBeDefined();
    // $1 user, $2 timezone, $3 local today (the clamp that stops a future-dated
    // calendar entry — this corpus has them out to 2026-10-15 — from taking a
    // slot away from a day that has already happened), $4 limit.
    expect(selection?.[1]).toEqual([USER, 'America/New_York', todayIsoInTimezone('America/New_York'), 7]);
  });

  it('writes nothing at all when the user has no capture data, instead of a window of holes', async () => {
    const { service, upsert } = makeService([]);

    await expect(service.refreshForUser(CONTEXT, 30, 'UTC')).resolves.toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. the analysis anchor the engines share
// ---------------------------------------------------------------------------

describe('DailyMetricsService.analysisAnchor', () => {
  function makeService(rows: Array<{ day: unknown }>) {
    const query = jest.fn<Promise<Array<{ day: unknown }>>, [string, unknown[]]>(async () => rows);
    const service = new DailyMetricsService(
      { query } as unknown as Repository<DailyMetricEntity>,
      logger(),
      userService() as never,
    );

    return { service, query };
  }

  it('returns the newest stored day and clamps the lookup to the local yesterday', async () => {
    const { service, query } = makeService([{ day: CORPUS_END }]);

    await expect(service.analysisAnchor(CONTEXT, 'UTC')).resolves.toBe(CORPUS_END);
    expect(query.mock.calls[0][1]).toEqual([USER, shiftIso(todayIsoInTimezone('UTC'), -1)]);
  });

  it('accepts a Date from the driver as readily as a string', async () => {
    const { service } = makeService([{ day: new Date(`${CORPUS_END}T00:00:00Z`) }]);

    await expect(service.analysisAnchor(CONTEXT, 'UTC')).resolves.toBe(CORPUS_END);
  });

  it('returns null for an empty store so callers can keep their old fallback', async () => {
    const { service } = makeService([{ day: null }]);

    await expect(service.analysisAnchor(CONTEXT, 'UTC')).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. the engines that read the store
// ---------------------------------------------------------------------------

function metricRow(date: string, value: number): DailyMetrics {
  return {
    userId: USER,
    date,
    timezone: 'UTC',
    metrics: { n_conversations: value } as unknown as MetricValues,
    coverage: { n_conversations: 1 } as unknown as MetricCoverage,
    computedAt: new Date(`${CORPUS_END}T00:00:00Z`),
  };
}

/**
 * A store that only holds the 60 days ending at {@link CORPUS_END}, with a
 * planted spike on the last of them. Asked for any other range it returns
 * nothing — which is precisely what the live store did to a caller asking for
 * the trailing 90 calendar days.
 */
function staleStore() {
  const rows = Array.from({ length: 60 }, (_, index) => {
    const date = shiftIso(CORPUS_END, -(59 - index));

    return metricRow(date, date === CORPUS_END ? 400 : 10 + (index % 3) * 0.2);
  });

  return {
    analysisAnchor: jest.fn(async () => CORPUS_END),
    getRange: jest.fn(async (_context: UserServiceContext, from: string, to: string) =>
      rows.filter((row) => row.date >= from && row.date <= to),
    ),
  };
}

function memoryRepo() {
  const store: Array<Record<string, unknown>> = [];

  return {
    rows: store,
    findOne: jest.fn(async () => null),
    create: jest.fn((seed: Record<string, unknown>) => ({ ...seed })),
    save: jest.fn(async (entity: Record<string, unknown>) => {
      store.push(entity);

      return entity;
    }),
    update: jest.fn(async () => ({})),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => []),
    })),
  };
}

describe('AnomalyEngine.scan window position', () => {
  it('finds the outlier at the end of a stale corpus that a wall-clock window sweeps past', async () => {
    const repo = memoryRepo();
    const metrics = staleStore();
    const engine = new AnomalyEngine(
      repo as never,
      {
        query: jest.fn().mockRejectedValue(Object.assign(new Error('no table'), { code: '42P01' })),
      } as never,
      metrics as unknown as DailyMetricsService,
      { create: jest.fn(), countDerivedOnLocalDay: jest.fn(async () => 0) } as never,
      { isFeatureEnabled: jest.fn(async () => false) } as never,
      logger(),
    );

    const persisted = await engine.scan(CONTEXT, 'UTC');

    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.some((row) => row.date === CORPUS_END)).toBe(true);

    // The width is unchanged; only the position moved. HISTORY_DAYS is 90.
    expect(metrics.getRange).toHaveBeenCalledWith(CONTEXT, shiftIso(CORPUS_END, -89), CORPUS_END);
  });
});

describe('CorrelationEngine.scan window position', () => {
  it('hangs its 180-day history off the newest stored day, not off the wall clock', async () => {
    const metrics = staleStore();
    const engine = new CorrelationEngine(
      memoryRepo() as never,
      metrics as unknown as DailyMetricsService,
      logger(),
    );

    await engine.scan(CONTEXT, 'UTC');

    expect(metrics.getRange).toHaveBeenCalledWith(CONTEXT, shiftIso(CORPUS_END, -179), CORPUS_END);
  });
});

// ---------------------------------------------------------------------------
// 4. the place engine
// ---------------------------------------------------------------------------

describe('PlaceClusterService.buildClusters window position', () => {
  /**
   * The measured shape of the live position corpus: dense in 2018-2020, then a
   * thin tail out to 2026-01-25. This is the case that a MAX(time) anchor does
   * NOT rescue — the 90 calendar days before the newest fix held six of them —
   * and it is why the window is positioned by counting days that HAVE fixes.
   */
  const NEWEST_FIX = '2026-01-25T09:21:46.000Z';
  const OLDEST_DAY = '2020-01-08T23:59:59.999999Z';

  function makeService() {
    const query = jest.fn<Promise<Array<Record<string, unknown>>>, [string, unknown[]]>(async (sql) => {
      if (sql.includes('WITH usable AS')) {
        return [{ oldest_day: OLDEST_DAY, newest_fix: NEWEST_FIX }];
      }

      // No clusters, no fixes: this test is about the window, not the maths.
      return [];
    });

    return {
      query,
      service: new PlaceClusterService({ query } as unknown as Repository<PlaceClusterEntity>, logger()),
    };
  }

  it('scans from the oldest day-with-fixes to the newest fix, not from now() backwards', async () => {
    const { service, query } = makeService();

    const result = await service.buildClusters(CONTEXT);

    const page = query.mock.calls.find((call) => call[0].includes('ORDER BY pos.time ASC'));
    expect(page).toBeDefined();
    expect(page?.[1][1]).toBe(new Date(OLDEST_DAY).toISOString());
    expect(page?.[1][2]).toBe(new Date(NEWEST_FIX).toISOString());

    // Exposed so the transition model can date its recency decay from the end
    // of the window it actually scanned rather than from the wall clock.
    expect(result.windowEnd.toISOString()).toBe(new Date(NEWEST_FIX).toISOString());
  });

  it('still honours an explicit endTime, so callers that pin the window are unaffected', async () => {
    const { service, query } = makeService();
    const endTime = new Date('2026-03-01T00:00:00.000Z');

    const result = await service.buildClusters(CONTEXT, { endTime, windowDays: 10 });

    expect(query.mock.calls.some((call) => call[0].includes('WITH usable AS'))).toBe(false);
    expect(result.windowEnd).toEqual(endTime);
  });

  it('falls back to a trailing window when the user has no usable fixes at all', async () => {
    const query = jest.fn<Promise<Array<Record<string, unknown>>>, [string, unknown[]]>(async () => []);
    const service = new PlaceClusterService({ query } as unknown as Repository<PlaceClusterEntity>, logger());

    await expect(service.buildClusters(CONTEXT)).resolves.toMatchObject({ clusters: [], visits: [] });
  });
});

// ---------------------------------------------------------------------------
// 5. the aggregate stays index-friendly
// ---------------------------------------------------------------------------

describe('DAILY_AGGREGATE_SQL shape', () => {
  it('bounds each day with a half-open range instead of casting the indexed column', () => {
    // The readable form — `(c.time AT TIME ZONE $3)::date = $2` — is equivalent
    // and was what this query used. It is also unindexable, and it cost 74.7
    // SECONDS per day against 326k communications + 254k browser_activity,
    // which is what made a backfill wide enough to feed CorrelationEngine's
    // 180-day window impossible. If you restore it, restore it knowingly.
    expect(DAILY_AGGREGATE_SQL).not.toMatch(/AT TIME ZONE [^)]*\)::date\s*=/);
    expect(DAILY_AGGREGATE_SQL).toContain('($2::date::timestamp AT TIME ZONE $3::text)');
    expect(DAILY_AGGREGATE_SQL).toContain('(($2::date + 1)::timestamp AT TIME ZONE $3::text)');
  });

  it('never gates a day on the wall clock', () => {
    // A `now()` anywhere in here would reintroduce the whole class of bug: the
    // statement is asked about a specific day and must answer identically no
    // matter when it is asked.
    expect(DAILY_AGGREGATE_SQL).not.toMatch(/\bnow\(\)/i);
    expect(DAILY_AGGREGATE_SQL).not.toMatch(/\bcurrent_date\b/i);
  });
});

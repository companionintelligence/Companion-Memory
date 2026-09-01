import { UnauthorizedException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';

import { categoryOfEvent, describeJob } from '../../taxonomy';
import { JobQueryService } from '../JobQueryService';

/**
 * `categoryHistory()` — the grouping key, the fold, and the live/sampled seam.
 *
 * Mocked rather than run against Postgres, and deliberately so for the things
 * asserted here: the failure this guards is not a SQL error the database would
 * raise, it is a WRONG COLUMN that every database on earth would happily group
 * by. `job.name` is a real column with a real value on every row — it is just
 * the literal `dead-letter` for 8,431 of 19,606 rows (43%) on a live appliance,
 * because pg-boss rewrites the queue on the copy it makes of a dead-lettered
 * job while copying `data` verbatim. Grouping on it returns a chart, not an
 * error, and the chart is missing two fifths of the appliance.
 *
 * `JobQueryService.stateCounts.spec.ts` guards the same invariant for the
 * category CHIPS. This file is its counterpart for the category SERIES, plus
 * the union logic that has no equivalent there.
 */

const CTX = { userId: 'user-1' } as RequestContext;
const NOW = new Date('2026-09-01T12:00:00.000Z');

interface LiveRow {
  at: Date;
  event: string | null;
  count: number;
}

interface MetricRow {
  at: Date;
  category: string;
  count: number;
}

interface Harness {
  service: JobQueryService;
  /** Every raw SQL statement issued against the pg-boss tables, in order. */
  queries: { sql: string; params: unknown[] }[];
  /** What the sampled-table QueryBuilder was asked for, if it was built at all. */
  metrics: {
    built: number;
    selects: string[];
    wheres: string[];
    groupBy: string;
    params: Record<string, unknown>;
  };
}

function makeService(options: {
  /** MIN(created_on) the live-coverage probe reports; null means pg-boss is empty. */
  oldest?: Date | null;
  liveRows?: LiveRow[];
  metricRows?: MetricRow[];
}): Harness {
  const queries: { sql: string; params: unknown[] }[] = [];

  const jobRepository = {
    createQueryBuilder: jest.fn(),
    manager: {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });

        return sql.includes('MIN(created_on)')
          ? [{ oldest: options.oldest === undefined ? null : options.oldest }]
          : (options.liveRows ?? []);
      }),
    },
  };

  const metrics: Harness['metrics'] = {
    built: 0,
    selects: [],
    wheres: [],
    groupBy: '',
    params: {},
  };

  const builder: Record<string, unknown> = {};
  const capture = (expression: string, parameters?: Record<string, unknown>) => {
    metrics.wheres.push(expression);
    Object.assign(metrics.params, parameters ?? {});

    return builder;
  };

  Object.assign(builder, {
    select: jest.fn((expression: string) => {
      metrics.selects.push(expression);

      return builder;
    }),
    addSelect: jest.fn((expression: string) => {
      metrics.selects.push(expression);

      return builder;
    }),
    where: jest.fn(capture),
    andWhere: jest.fn(capture),
    setParameter: jest.fn((key: string, value: unknown) => {
      metrics.params[key] = value;

      return builder;
    }),
    groupBy: jest.fn((expression: string) => {
      metrics.groupBy = expression;

      return builder;
    }),
    getRawMany: jest.fn(async () => options.metricRows ?? []),
  });

  const categoryMetricRepository = {
    createQueryBuilder: jest.fn(() => {
      metrics.built += 1;

      return builder;
    }),
  };

  const noop = { createQueryBuilder: jest.fn() };

  return {
    service: new JobQueryService(
      jobRepository as never,
      noop as never,
      noop as never,
      categoryMetricRepository as never,
    ),
    queries,
    metrics,
  };
}

/** The one raw statement that scans for arrivals (not the coverage probe). */
function liveQuery(harness: Harness): { sql: string; params: unknown[] } {
  const found = harness.queries.find((query) => !query.sql.includes('MIN(created_on)'));

  if (!found) {
    throw new Error('no live arrivals query was issued');
  }

  return found;
}

beforeAll(() => {
  // The seam between the two stores is computed from `Date.now()`, and the
  // bucket boundaries it rounds to are only assertable against a fixed clock.
  jest.useFakeTimers({ now: NOW });
});

afterAll(() => {
  jest.useRealTimers();
});

describe('JobQueryService.categoryHistory — the grouping key', () => {
  it('groups the live series on the event in the payload, never on the queue', async () => {
    const harness = makeService({ oldest: new Date('2026-09-01T00:07:00.000Z') });

    await harness.service.categoryHistory(CTX, { windowHours: 24 });

    const { sql } = liveQuery(harness);

    expect(sql).toContain(`live.data->>'name' AS event`);
    // The queue column may only ever appear as the dead-letter EXCLUSION below.
    // Projecting or grouping it would file 43% of the appliance under one
    // bucket that maps to no category at all.
    expect(sql).not.toMatch(/\bname\s+AS\s+(queue|event|category)\b/);
    expect(sql).toMatch(/GROUP BY 1, 2/);
  });

  it('excludes the dead-letter copies, whose created_on is the failure time and not an arrival', async () => {
    const harness = makeService({ oldest: new Date('2026-09-01T00:07:00.000Z') });

    await harness.service.categoryHistory(CTX, { windowHours: 24 });

    const { sql, params } = liveQuery(harness);

    // Both halves of the UNION, or the archive half re-admits them.
    expect(sql.match(/name <> \$3/g)).toHaveLength(2);
    expect(params[2]).toBe('dead-letter');
  });

  it('unions the archive, which holds the older half of the ~36h live window', async () => {
    const harness = makeService({ oldest: new Date('2026-09-01T00:07:00.000Z') });

    await harness.service.categoryHistory(CTX, { windowHours: 24 });

    const { sql } = liveQuery(harness);

    expect(sql).toContain('pgboss.job');
    expect(sql).toContain('pgboss.archive');
    expect(sql).toContain('UNION ALL');
  });
});

describe('JobQueryService.categoryHistory — the category fold', () => {
  it('folds events through JOB_TYPES and buckets the rest as unclassified', async () => {
    const at = new Date('2026-09-01T11:30:00.000Z');
    const harness = makeService({
      oldest: new Date('2026-09-01T00:00:00.000Z'),
      liveRows: [
        { at, event: 'note.created', count: 4 },
        { at, event: 'person.created', count: 1 },
        { at, event: 'zz.not-in-the-taxonomy', count: 7 },
        // A job whose payload carries no `name` at all — still countable, and
        // still the absence of a classification rather than a category.
        { at, event: null, count: 2 },
      ],
    });

    const result = await harness.service.categoryHistory(CTX, { windowHours: 24 });

    expect(result.points).toHaveLength(1);
    expect(result.points[0].counts).toEqual({ search: 5, unclassified: 9 });
    expect(result.categories).toEqual(['search', 'unclassified']);
  });

  /**
   * The reason the fold is `categoryOfEvent` and not `describeJob`.
   *
   * `content.created` has a JOB_TYPES_BY_QUEUE override, so describeJob answers
   * `pipeline` for the copy that runs on `pipeline-index` and `search` for the
   * other. The category FILTER cannot make that distinction — `applyFilters`
   * turns a category back into event names out of JOB_TYPES alone, because a
   * dead-lettered row no longer knows its queue. Folding the chart through
   * describeJob would draw a `pipeline` series that clicking `pipeline` does
   * not reproduce.
   */
  it('does not fold through describeJob, whose per-queue overrides the filter cannot follow', () => {
    expect(describeJob('content.created', null, 'pipeline-index').category).toBe('pipeline');
    expect(categoryOfEvent('content.created')).toBe('search');
  });
});

describe('JobQueryService.categoryHistory — the live/sampled seam', () => {
  it('reads only the sampled table when pg-boss holds nothing at all', async () => {
    const harness = makeService({
      oldest: null,
      metricRows: [{ at: new Date('2026-08-31T18:00:00.000Z'), category: 'ingest', count: 3 }],
    });

    const result = await harness.service.categoryHistory(CTX, { windowHours: 24 });

    // The coverage probe, and nothing else: no point scanning tables that are
    // empty.
    expect(harness.queries).toHaveLength(1);
    expect(harness.metrics.built).toBe(1);
    expect(result.source).toBe('metrics');
    expect(result.points[0].counts).toEqual({ ingest: 3 });
  });

  it('reads only pg-boss when live coverage already reaches the start of the window', async () => {
    const harness = makeService({
      // Older than `since` (2026-08-31T12:00Z) — nothing left for the sampled
      // table to add.
      oldest: new Date('2026-08-01T00:00:00.000Z'),
      liveRows: [{ at: new Date('2026-09-01T11:30:00.000Z'), event: 'note.created', count: 1 }],
    });

    const result = await harness.service.categoryHistory(CTX, { windowHours: 24 });

    expect(harness.metrics.built).toBe(0);
    expect(result.source).toBe('live');
  });

  it('splits the window at a bucket boundary and reports the join as mixed', async () => {
    const oldest = new Date('2026-09-01T00:07:00.000Z');
    const harness = makeService({
      oldest,
      liveRows: [{ at: new Date('2026-09-01T11:30:00.000Z'), event: 'note.created', count: 1 }],
      metricRows: [{ at: new Date('2026-08-31T18:00:00.000Z'), category: 'ingest', count: 3 }],
    });

    const result = await harness.service.categoryHistory(CTX, { windowHours: 24 });

    expect(result.source).toBe('mixed');

    const liveFrom = harness.metrics.params.liveFrom as Date;

    // Rounded UP to the next 30-minute boundary: the bucket containing the
    // oldest surviving row is only PARTLY covered by pg-boss, and drawing it
    // from a partial scan is a dip that never happened.
    expect(liveFrom.getTime() % (30 * 60_000)).toBe(0);
    expect(liveFrom.getTime()).toBeGreaterThan(oldest.getTime());
    expect(liveFrom.getTime() - oldest.getTime()).toBeLessThanOrEqual(30 * 60_000);

    // The same instant bounds both halves, which is what stops a row being
    // counted once live and once sampled.
    expect(liveQuery(harness).params[0]).toEqual(liveFrom);
    expect(harness.metrics.wheres).toContain('metric.sampled_at < :liveFrom');
    expect(harness.metrics.wheres).toContain('metric.sampled_at >= :since');
  });

  it('measures live coverage without the dead-letter queue, which is kept for 30 days', async () => {
    const harness = makeService({ oldest: new Date('2026-09-01T00:07:00.000Z') });

    await harness.service.categoryHistory(CTX, { windowHours: 24 });

    const probe = harness.queries.find((query) => query.sql.includes('MIN(created_on)'));

    // Work queues are pruned on pg-boss's ~36h cycle, but the DLQ carries a
    // 30-day retention and nothing consumes it. An unfiltered MIN would report
    // a MONTH of live coverage that exists only for dead-letter copies, and
    // every bucket older than 36h would then be answered by a live scan that
    // finds nothing — weeks of confident zeros instead of the sampled table.
    expect(probe?.sql.match(/name <> \$1/g)).toHaveLength(2);
    expect(probe?.params[0]).toBe('dead-letter');
  });

  it('sums the sampled ARRIVALS delta, not a gauge column', async () => {
    const harness = makeService({ oldest: null });

    await harness.service.categoryHistory(CTX, { windowHours: 24 });

    // `arrived` is the only column in ci.job_category_metrics that means the
    // same thing as the live count; summing `pending` (a gauge) across time is
    // meaningless.
    expect(harness.metrics.selects).toContain('SUM(metric.arrived)::int');
    expect(harness.metrics.groupBy).toBe('1, 2');
  });

  it('merges both stores into one series on a shared x-axis', async () => {
    const harness = makeService({
      oldest: new Date('2026-09-01T00:07:00.000Z'),
      liveRows: [{ at: new Date('2026-09-01T11:30:00.000Z'), event: 'note.created', count: 1 }],
      metricRows: [{ at: new Date('2026-08-31T18:00:00.000Z'), category: 'ingest', count: 3 }],
    });

    const result = await harness.service.categoryHistory(CTX, { windowHours: 24 });

    expect(result.points.map((point) => point.at)).toEqual([
      '2026-08-31T18:00:00.000Z',
      '2026-09-01T11:30:00.000Z',
    ]);
    // Zero-filled across every declared series, so a chart never has to decide
    // what a missing key means.
    expect(result.categories).toEqual(['ingest', 'search']);
    expect(result.points[0].counts).toEqual({ ingest: 3, search: 0 });
    expect(result.points[1].counts).toEqual({ ingest: 0, search: 1 });
  });
});

describe('JobQueryService.categoryHistory — the window', () => {
  it.each([
    [1, 5],
    [6, 5],
    [24, 30],
    [48, 30],
    [49, 180],
    [24 * 30, 180],
  ])('scales a %ih window to %i-minute buckets, matching history()', async (hours, expected) => {
    const harness = makeService({ oldest: null });

    const result = await harness.service.categoryHistory(CTX, { windowHours: hours });

    expect(result.bucketMinutes).toBe(expected);
    expect(result.windowHours).toBe(hours);
  });

  it('clamps the window to 1h..30d, the collector’s own retention', async () => {
    const tooSmall = await makeService({ oldest: null }).service.categoryHistory(CTX, {
      windowHours: 0,
    });
    const tooLarge = await makeService({ oldest: null }).service.categoryHistory(CTX, {
      windowHours: 10_000,
    });

    expect(tooSmall.windowHours).toBe(1);
    expect(tooLarge.windowHours).toBe(24 * 30);
  });

  it('refuses a request with no user context', async () => {
    const harness = makeService({ oldest: null });

    await expect(harness.service.categoryHistory({} as RequestContext, {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // Nothing was read on the way to the refusal.
    expect(harness.queries).toHaveLength(0);
  });
});

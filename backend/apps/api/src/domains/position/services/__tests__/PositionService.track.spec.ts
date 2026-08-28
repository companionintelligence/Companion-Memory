import type { Repository } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { DeviceService } from '@ci/domains/devices';
import type { EventService } from '@ci/domains/events';

import type { PositionEntity } from '../../entities/PositionEntity';
import { PositionService, type TrackOptions } from '../PositionService';
import { decodeTrackCursor, encodeTrackCursor } from '../positionTrack';

const ctx = { userId: '00000000-0000-0000-0000-0000000000aa' } as UserServiceContext;
const OTHER_USER = { userId: '00000000-0000-0000-0000-0000000000bb' } as UserServiceContext;

/** The live table's real extent, so the derived bucket is the one production sees. */
const FIRST_FIX = new Date('2013-05-28T21:02:08.000Z');
const LAST_FIX = new Date('2026-08-21T04:56:01.296Z');

type Executed = { sql: string; params: unknown[] };

interface Harness {
  service: PositionService;
  executed: Executed[];
  /** The page read — the one query that is either bucketed or raw. */
  page(): Executed;
  count(): Executed | undefined;
}

/**
 * A PositionService wired to a recording query runner.
 *
 * `manager.query` is dispatched by shape rather than by call order because
 * `findTrack` issues its span read, its page read and its count read on
 * different paths (a continuation skips two of the three), and a positional
 * mock would silently answer the wrong one.
 */
function makeService({ rows = [] as Record<string, unknown>[], total = 0 } = {}): Harness {
  const executed: Executed[] = [];

  const query = jest.fn(async (sql: string, params: unknown[]) => {
    executed.push({ sql, params });

    if (sql.includes('min(time)')) {
      return [{ from_time: FIRST_FIX, to_time: LAST_FIX }];
    }

    if (sql.includes('count(*) AS n')) {
      return [{ n: String(total) }];
    }

    return rows;
  });

  const repository = { manager: { query } } as unknown as Repository<PositionEntity>;
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as LoggerService;

  return {
    service: new PositionService(
      repository,
      {} as unknown as DeviceService,
      {} as unknown as EventService,
      logger,
    ),
    executed,
    page: () =>
      executed.find(
        (call) =>
          /FROM ci\.position p/.test(call.sql) &&
          !call.sql.includes('count(*) AS n') &&
          !call.sql.includes('min(time)'),
      )!,
    count: () => executed.find((call) => call.sql.includes('count(*) AS n')),
  };
}

/** One row as the bucketed query hands it back. */
function bucketRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    started_at: new Date('2016-04-07T00:38:54.000Z'),
    ended_at: new Date('2016-04-08T01:00:00.000Z'),
    fix_count: 7,
    latitude: '34.0579389',
    longitude: '-118.3049389',
    activity_type: 'in_vehicle',
    ...over,
  };
}

function run(harness: Harness, options: TrackOptions = {}, context = ctx) {
  return harness.service.findTrack(context, options);
}

describe('PositionService.findTrack — user scoping', () => {
  it('scopes every read to the caller, as the FIRST bound parameter', async () => {
    const harness = makeService({ rows: [bucketRow()], total: 63_044 });

    await run(harness, { bbox: [-122.6, 37.6, -122.2, 37.9] });

    // Span read, page read and count read: all three, no exceptions.
    expect(harness.executed).toHaveLength(3);

    for (const call of harness.executed) {
      expect(call.sql).toMatch(/user_id = \$1/);
      expect(call.params[0]).toBe(ctx.userId);
    }
  });

  it('never emits a filter-free read, whatever the caller passes', async () => {
    const harness = makeService({ rows: [] });

    await run(harness, { first: 5_000, maxPoints: 0, bbox: [-180, -90, 180, 90] });

    // maxPoints:0 is raw and the world bbox is dropped — the two widest inputs
    // available — and the user predicate still stands.
    expect(harness.page().sql).toContain('p.user_id = $1');
  });

  it('answers a different caller with a different scope', async () => {
    const harness = makeService({ rows: [bucketRow()] });

    await run(harness, {}, OTHER_USER);

    expect(harness.page().params[0]).toBe(OTHER_USER.userId);
    expect(harness.page().params).not.toContain(ctx.userId);
  });
});

describe('PositionService.findTrack — downsampling', () => {
  it("buckets a thirteen-year window to the caller's point budget", async () => {
    // total exceeds the budget, or the in-view count alone would pick raw
    // mode and the bucketed branch below would never run.
    const harness = makeService({ rows: [bucketRow()], total: 63_044 });

    const page = await run(harness, { maxPoints: 2_000 });

    const span = LAST_FIX.getTime() - FIRST_FIX.getTime();
    const expected = Math.ceil(span / 1000 / 2_000);

    expect(page.bucketSeconds).toBe(expected);
    expect(harness.page().sql).toContain('time_bucket(make_interval(secs =>');
    expect(harness.page().params).toContain(expected);
  });

  it('groups and orders by the bucket, which is what makes the time cursor valid', async () => {
    const harness = makeService({ rows: [bucketRow()], total: 63_044 });

    await run(harness, {});

    // Chronological group order is load-bearing: `time > cursor` can only
    // continue a page whose rows are in time order.
    expect(harness.page().sql).toContain('GROUP BY bucket_start');
    expect(harness.page().sql).toContain('ORDER BY bucket_start');
  });

  it("takes each bucket's first REAL fix, never an average of it", async () => {
    const harness = makeService({ rows: [bucketRow()], total: 63_044 });

    await run(harness, {});

    // A bucket spanning a flight averages to a point in the ocean. The map must
    // only ever draw somewhere the user actually was.
    expect(harness.page().sql).toContain('first(ST_Y(p.location::geometry), p.time)');
    expect(harness.page().sql).toContain('first(ST_X(p.location::geometry), p.time)');
    expect(harness.page().sql).not.toMatch(/avg\(/);
  });

  it('reports the bucket weight so a heat layer is honest about density', async () => {
    const harness = makeService({ rows: [bucketRow({ fix_count: 4_129 })], total: 63_044 });

    const page = await run(harness, {});

    expect(harness.page().sql).toContain('count(*)::int AS fix_count');
    expect(page.points[0].fixCount).toBe(4_129);
  });

  it('reads raw fixes when the caller switches downsampling off', async () => {
    const harness = makeService({ rows: [bucketRow({ fix_count: 1 })], total: 63_044 });

    const page = await run(harness, { maxPoints: 0 });

    expect(page.bucketSeconds).toBeNull();
    expect(harness.page().sql).not.toContain('time_bucket');
    expect(harness.page().sql).toContain('ORDER BY p.time');
    // Raw mode must not bind a bucket: Postgres rejects a bind supplying a
    // parameter the statement never mentions.
    expect(harness.page().sql).not.toContain('make_interval');
  });

  it('skips the span round trip entirely once maxPoints:0 already settles raw mode', async () => {
    const harness = makeService({ rows: [], total: 63_044 });

    await run(harness, { maxPoints: 0 });

    // The whole point of asking for raw fixes is to skip downsampling — the
    // min/max read exists only to size a bucket, so it must never fire here,
    // even though the in-view total (63,044) is far past the point budget.
    expect(harness.executed.some((call) => call.sql.includes('min(time)'))).toBe(false);
  });

  it('reads raw fixes for a window too narrow to be worth bucketing', async () => {
    // total still exceeds the budget so the bounded-window shortcut inside
    // resolveTrackSpanMs — not the in-view-count raw shortcut — is what this
    // test is actually exercising.
    const harness = makeService({ rows: [], total: 5_000 });

    const page = await run(harness, {
      startTime: new Date('2026-08-20T10:00:00Z'),
      endTime: new Date('2026-08-20T10:05:00Z'),
    });

    expect(page.bucketSeconds).toBeNull();
    // A bounded window is its own span — no min/max round trip needed.
    expect(harness.executed.some((call) => call.sql.includes('min(time)'))).toBe(false);
  });

  it('serves every fix once the viewport holds fewer of them than the point budget', async () => {
    // The whole reason this matters: a street-level viewport with only a few
    // hundred real fixes must show each one, not the same coarse sample the
    // world view gets — zooming in has to actually sharpen the trace.
    const harness = makeService({ rows: [bucketRow({ fix_count: 1 })], total: 340 });

    const page = await run(harness, {
      bbox: [-118.3, 34.05, -118.28, 34.07],
      maxPoints: 2_000,
    });

    expect(page.bucketSeconds).toBeNull();
    expect(harness.page().sql).not.toContain('time_bucket');
    // Bucketing exists only to shrink a read past the budget — 340 already
    // fits, so the span this method exists to size a bucket from must never
    // be read.
    expect(harness.executed.some((call) => call.sql.includes('min(time)'))).toBe(false);
  });

  it("sizes the bucket off the viewport's OWN span, not the whole table's", async () => {
    // A viewport packed with 21,997 fixes still needs bucketing (the budget
    // is 2,000), but the bucket must come from what's actually in the box —
    // otherwise every zoom level sees the same whole-history bucket width and
    // zooming in never sharpens anything.
    const harness = makeService({ rows: [bucketRow()], total: 21_997 });
    const bbox: [number, number, number, number] = [-118.9, 33.5, -117.6, 34.8];

    await run(harness, { bbox, maxPoints: 2_000 });

    const spanQuery = harness.executed.find((call) => call.sql.includes('min(time)'));

    expect(spanQuery).toBeDefined();
    // The span read must carry the SAME viewport predicate the page and the
    // count do — a bucket derived from an unfiltered min/max is exactly the
    // whole-history-span bug this scoping fixes.
    expect(spanQuery!.sql).toContain('ST_MakeEnvelope(');
    expect(spanQuery!.sql).toContain('p.user_id = $1');
    expect(spanQuery!.params).toEqual(expect.arrayContaining(bbox));
  });

  it('still narrows the span to the viewport when an explorer date filter is ALSO active', async () => {
    // Regression: the raw-span shortcut (`endTime - startTime`) fired on
    // startTime+endTime alone, before this bbox scoping existed to size a
    // bucket from what is actually in view. A caller with both a bbox AND a
    // date range set — exactly what the map does once the explorer's date
    // filter is on — must still get the IN-VIEWPORT span, not the raw width
    // of the filtered date range: a month-long date filter can hold only
    // three days of fixes inside a given viewport, and bucketing off the
    // wider month re-introduces "zooming doesn't sharpen the trace" for
    // every filtered session, just scoped to the filter instead of the
    // whole table.
    const harness = makeService({ rows: [bucketRow()], total: 21_997 });
    const bbox: [number, number, number, number] = [-118.9, 33.5, -117.6, 34.8];
    const startTime = new Date('2024-01-01T00:00:00Z');
    const endTime = new Date('2024-02-01T00:00:00Z'); // a month — much wider than the true in-view span

    await run(harness, { bbox, startTime, endTime, maxPoints: 2_000 });

    const spanQuery = harness.executed.find((call) => call.sql.includes('min(time)'));

    // The shortcut must NOT have fired: with a bbox present, only the
    // bbox-scoped min/max query can tell the truth about the in-view span.
    expect(spanQuery).toBeDefined();
    expect(spanQuery!.sql).toContain('ST_MakeEnvelope(');
    expect(spanQuery!.params).toEqual(expect.arrayContaining(bbox));
  });
});

describe('PositionService.findTrack — filters', () => {
  it('pushes the time range down to SQL as a half-open interval', async () => {
    const harness = makeService({ rows: [] });
    const startTime = new Date('2024-01-01T00:00:00Z');
    const endTime = new Date('2024-02-01T00:00:00Z');

    await run(harness, { startTime, endTime });

    expect(harness.page().sql).toMatch(/p\.time >= \$\d+/);
    expect(harness.page().sql).toMatch(/p\.time < \$\d+/);
    expect(harness.page().params).toContain(startTime);
    expect(harness.page().params).toContain(endTime);
  });

  it('pushes the viewport down as an indexed geography overlap', async () => {
    const harness = makeService({ rows: [] });

    await run(harness, { bbox: [-122.6, 37.6, -122.2, 37.9] });

    // `&&` on the geography is what position_location_idx answers; the explicit
    // IS NOT NULL matches that index's own partial predicate.
    expect(harness.page().sql).toContain('p.location && ST_MakeEnvelope(');
    expect(harness.page().sql).toContain('p.location IS NOT NULL');
    expect(harness.page().params).toEqual(expect.arrayContaining([-122.6, 37.6, -122.2, 37.9]));
  });

  it('ORs two envelopes for a viewport straddling the antimeridian', async () => {
    const harness = makeService({ rows: [] });

    await run(harness, { bbox: [170, -20, 190, 20] });

    expect(harness.page().sql).toMatch(/ST_MakeEnvelope\([^)]*\)::geography OR .*ST_MakeEnvelope/s);
    expect(harness.page().params).toEqual(expect.arrayContaining([170, 180, -180, -170]));
  });

  it('drops a viewport wider than a valid geodesic envelope rather than narrowing to its complement', async () => {
    const harness = makeService({ rows: [] });

    await run(harness, { bbox: [-180, -90, 180, 90] });

    expect(harness.page().sql).not.toContain('ST_MakeEnvelope');
  });

  it('counts against the same predicates the page was cut from', async () => {
    const harness = makeService({ rows: [bucketRow()], total: 41_964 });
    const bbox = [-119, 33, -117, 35];

    const page = await run(harness, { bbox, startTime: new Date('2024-01-01T00:00:00Z') });

    expect(page.totalCount).toBe(41_964);
    // A truncated trace and the total it is truncated against must describe the
    // same set of fixes, or the status line lies.
    expect(harness.count()!.sql).toContain('ST_MakeEnvelope');
    expect(harness.count()!.params).toEqual(expect.arrayContaining([...bbox, ctx.userId]));
  });
});

describe('PositionService.findTrack — keyset paging', () => {
  it('over-fetches by one so hasNextPage is a fact, not a guess', async () => {
    const rows = Array.from({ length: 4 }, (_unused, index) =>
      bucketRow({ ended_at: new Date(`2020-01-0${index + 1}T00:00:00.000Z`) }),
    );
    const harness = makeService({ rows });

    const page = await run(harness, { first: 3 });

    expect(harness.page().params).toContain(4);
    expect(page.points).toHaveLength(3);
    expect(page.hasNextPage).toBe(true);
  });

  it('reports the end of the walk when the over-fetch comes back short', async () => {
    const harness = makeService({ rows: [bucketRow(), bucketRow()] });

    const page = await run(harness, { first: 3 });

    expect(page.points).toHaveLength(2);
    expect(page.hasNextPage).toBe(false);
  });

  it('cuts the cursor at the LAST instant the point consumed', async () => {
    const endedAt = new Date('2016-04-08T01:00:00.000Z');
    const harness = makeService({ rows: [bucketRow({ ended_at: endedAt })], total: 63_044 });

    const page = await run(harness, { maxPoints: 2_000 });

    // A bucket's max(time) is strictly past every row the page consumed and
    // strictly before every row it did not — so `time > cursor` can neither
    // re-emit nor skip a fix.
    expect(decodeTrackCursor(page.endCursor)!.time).toEqual(endedAt);
    expect(page.endCursor).toBe(page.points[0].cursor);
  });

  it('continues with a keyset predicate, never an OFFSET', async () => {
    const after = encodeTrackCursor(new Date('2016-04-08T01:00:00.000Z'), 207_360);
    const harness = makeService({ rows: [bucketRow()] });

    await run(harness, { after });

    expect(harness.page().sql).toMatch(/p\.time > \$\d+/);
    expect(harness.page().sql).not.toMatch(/OFFSET/i);
    expect(harness.page().params).toContainEqual(new Date('2016-04-08T01:00:00.000Z'));
  });

  it('inherits the bucket from the cursor rather than re-deriving it mid-walk', async () => {
    const after = encodeTrackCursor(new Date('2016-04-08T01:00:00.000Z'), 3_600);
    const harness = makeService({ rows: [bucketRow()] });

    const page = await run(harness, { after, maxPoints: 2_000 });

    // maxPoints:2000 over the live span would derive ~207,360s. The cursor's
    // 3,600 wins, or the continuation would cut its groups on different
    // boundaries than the page before it.
    expect(page.bucketSeconds).toBe(3_600);
    expect(harness.page().params).toContain(3_600);
    expect(harness.executed.some((call) => call.sql.includes('min(time)'))).toBe(false);
  });

  it('counts once per walk, on the first page only', async () => {
    const first = makeService({ rows: [bucketRow()], total: 63_044 });
    const next = makeService({ rows: [bucketRow()], total: 63_044 });

    expect((await run(first, {})).totalCount).toBe(63_044);
    expect(first.count()).toBeDefined();

    const continuation = await run(next, {
      after: encodeTrackCursor(new Date('2020-01-01T00:00:00Z'), 207_360),
    });

    // A COUNT(*) is a second scan of the same rows and its answer cannot change
    // between pages of one walk.
    expect(continuation.totalCount).toBeNull();
    expect(next.count()).toBeUndefined();
  });

  it('has no cursor to hand back for an empty page', async () => {
    const harness = makeService({ rows: [] });

    const page = await run(harness, {});

    expect(page.points).toEqual([]);
    expect(page.endCursor).toBeNull();
    expect(page.hasNextPage).toBe(false);
  });
});

describe('PositionService.findTrack — projection', () => {
  it('projects a row to a drawable point', async () => {
    const harness = makeService({ rows: [bucketRow()] });

    const page = await run(harness, {});

    expect(page.points[0]).toEqual({
      startTime: new Date('2016-04-07T00:38:54.000Z'),
      endTime: new Date('2016-04-08T01:00:00.000Z'),
      latitude: 34.0579389,
      longitude: -118.3049389,
      fixCount: 7,
      activityType: 'in_vehicle',
      cursor: expect.any(String),
    });
  });

  it('coerces the numeric strings node-postgres hands back for ST_X/ST_Y', async () => {
    const harness = makeService({ rows: [bucketRow({ latitude: '34.0', longitude: '-118.3' })] });

    const page = await run(harness, {});

    expect(typeof page.points[0].latitude).toBe('number');
    expect(typeof page.points[0].longitude).toBe('number');
  });
});

describe('PositionService.getTrackExtent', () => {
  /**
   * A dedicated harness rather than reusing `makeService`: the extent query
   * asks for `count(*)` and `min/max(time)` in ONE statement, which the
   * shape-dispatch in `makeService` (built for `findTrack`'s three separate
   * queries) cannot distinguish from its own `min(time)` branch.
   */
  function makeExtentService({ count = 0, from = null as Date | null, to = null as Date | null } = {}) {
    const executed: Executed[] = [];
    const query = jest.fn(async (sql: string, params: unknown[]) => {
      executed.push({ sql, params });

      return [{ n: String(count), from_time: from, to_time: to }];
    });

    const repository = { manager: { query } } as unknown as Repository<PositionEntity>;
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as LoggerService;

    return {
      executed,
      service: new PositionService(
        repository,
        {} as unknown as DeviceService,
        {} as unknown as EventService,
        logger,
      ),
    };
  }

  it("answers the user's whole history in one query", async () => {
    const from = new Date('2013-05-28T21:02:08.000Z');
    const to = new Date('2026-08-21T04:56:01.296Z');
    const harness = makeExtentService({ count: 63_044, from, to });

    const extent = await harness.service.getTrackExtent(ctx);

    expect(extent).toEqual({ start: from, end: to, count: 63_044 });
    expect(harness.executed).toHaveLength(1);
    expect(harness.executed[0].sql).toContain('count(*) AS n');
    expect(harness.executed[0].sql).toContain('min(time)');
    expect(harness.executed[0].sql).toContain('max(time)');
  });

  it('scopes to the caller, as the first bound parameter', async () => {
    const harness = makeExtentService({ count: 1, from: new Date(), to: new Date() });

    await harness.service.getTrackExtent(ctx);

    expect(harness.executed[0].params[0]).toBe(ctx.userId);
  });

  it('returns null rather than a zeroed extent when the user has no track at all', async () => {
    const harness = makeExtentService({ count: 0, from: null, to: null });

    const extent = await harness.service.getTrackExtent(ctx);

    expect(extent).toBeNull();
  });

  it('narrows to a bbox when one is supplied, same as findTrack', async () => {
    const harness = makeExtentService({ count: 500, from: new Date(), to: new Date() });
    const bbox: [number, number, number, number] = [-118.9, 33.5, -117.6, 34.8];

    await harness.service.getTrackExtent(ctx, { bbox });

    expect(harness.executed[0].sql).toContain('ST_MakeEnvelope(');
    expect(harness.executed[0].params).toEqual(expect.arrayContaining(bbox));
  });
});

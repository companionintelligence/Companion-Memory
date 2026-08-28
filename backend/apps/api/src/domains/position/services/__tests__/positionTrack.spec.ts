import {
  DEFAULT_TRACK_MAX_POINTS,
  DEFAULT_TRACK_PAGE_SIZE,
  MAX_TRACK_MAX_POINTS,
  MAX_TRACK_PAGE_SIZE,
  clampMaxPoints,
  clampPageSize,
  decodeTrackCursor,
  encodeTrackCursor,
  normalizeBbox,
  resolveBucketSeconds,
} from '../positionTrack';

const DAY_MS = 86_400_000;

/**
 * The rules that decide how much of a 63,044-fix location history one map
 * request can ever ship. They are arithmetic, so they are provable without a
 * database — which is the whole reason they live outside the service.
 */
describe('positionTrack — page sizing', () => {
  it('defaults an unspecified page size rather than reading unbounded', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_TRACK_PAGE_SIZE);
    expect(clampPageSize(null)).toBe(DEFAULT_TRACK_PAGE_SIZE);
    expect(clampPageSize(NaN)).toBe(DEFAULT_TRACK_PAGE_SIZE);
  });

  it('caps a caller asking for the whole table in one page', () => {
    expect(clampPageSize(1_000_000)).toBe(MAX_TRACK_PAGE_SIZE);
  });

  it('never returns a page of zero, which would stall paging forever', () => {
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-10)).toBe(1);
  });

  it('honours a sensible request verbatim', () => {
    expect(clampPageSize(500)).toBe(500);
  });
});

describe('positionTrack — downsample budget', () => {
  it('defaults, and caps, the budget', () => {
    expect(clampMaxPoints(undefined)).toBe(DEFAULT_TRACK_MAX_POINTS);
    expect(clampMaxPoints(1_000_000)).toBe(MAX_TRACK_MAX_POINTS);
  });

  it('treats 0 (and below) as "give me raw fixes"', () => {
    expect(clampMaxPoints(0)).toBe(0);
    expect(clampMaxPoints(-1)).toBe(0);
  });
});

describe('resolveBucketSeconds', () => {
  it("collapses the live thirteen-year window to the caller's budget", () => {
    // 2013-05-28 → 2026-08-21 is the real span of ci.position on the appliance.
    const span = new Date('2026-08-21T04:56:01Z').getTime() - new Date('2013-05-28T21:02:08Z').getTime();

    const bucket = resolveBucketSeconds(span, 2_000);

    expect(bucket).not.toBeNull();
    // ~4,833 days over 2,000 points ≈ a 2.4-day bucket.
    expect(bucket! / 86_400).toBeCloseTo(2.4, 1);
    // The bound that matters: the window cannot yield more points than asked for.
    expect(Math.ceil(span / 1000 / bucket!)).toBeLessThanOrEqual(2_000);
  });

  it('scales the bucket with the budget, so a richer client gets a finer trace', () => {
    const span = 4_000 * DAY_MS;

    expect(resolveBucketSeconds(span, 500)!).toBeGreaterThan(resolveBucketSeconds(span, 5_000)!);
  });

  it('stays raw for a window narrow enough that bucketing would be a no-op', () => {
    // One day against a 2,000-point budget wants a 43-second bucket; at that
    // width nearly every bucket holds one fix, so bucketing costs an aggregate
    // and returns the same rows.
    expect(resolveBucketSeconds(DAY_MS, 2_000)).toBe(44);
    // A five-minute window, though, is below the point of bucketing entirely.
    expect(resolveBucketSeconds(5 * 60_000, 2_000)).toBeNull();
  });

  it('stays raw when the caller switched downsampling off', () => {
    expect(resolveBucketSeconds(4_000 * DAY_MS, 0)).toBeNull();
  });

  it('stays raw for a degenerate window', () => {
    expect(resolveBucketSeconds(0, 2_000)).toBeNull();
    expect(resolveBucketSeconds(-1, 2_000)).toBeNull();
    expect(resolveBucketSeconds(NaN, 2_000)).toBeNull();
  });
});

describe('track cursors', () => {
  it('round-trips the instant and the bucket it was cut with', () => {
    const time = new Date('2019-04-02T11:22:33.456Z');

    expect(decodeTrackCursor(encodeTrackCursor(time, 207_360))).toEqual({
      time,
      bucketSeconds: 207_360,
    });
  });

  it('round-trips a raw page', () => {
    const time = new Date('2019-04-02T11:22:33.456Z');

    expect(decodeTrackCursor(encodeTrackCursor(time, null))).toEqual({ time, bucketSeconds: null });
  });

  it('carries the bucket so a continuation cannot re-cut the window', () => {
    // The bucket is derived from the window's span on the first page. If a
    // later page re-derived it from a span that had since grown (one more fix
    // arrives, max(time) moves), its groups would fall on different boundaries
    // and duplicate or skip a slice of the trace. So it travels in the cursor.
    const encoded = encodeTrackCursor(new Date('2020-01-01T00:00:00.000Z'), 3_600);

    expect(decodeTrackCursor(encoded)!.bucketSeconds).toBe(3_600);
  });

  it('rejects junk instead of paging from a garbage instant', () => {
    expect(decodeTrackCursor(undefined)).toBeUndefined();
    expect(decodeTrackCursor('')).toBeUndefined();
    expect(decodeTrackCursor('not-base64-at-all')).toBeUndefined();
    expect(decodeTrackCursor(Buffer.from('nonsense::4').toString('base64'))).toBeUndefined();
    expect(decodeTrackCursor(Buffer.from('2020-01-01T00:00:00Z').toString('base64'))).toBeUndefined();
  });
});

describe('normalizeBbox', () => {
  it('passes an ordinary viewport straight through', () => {
    expect(normalizeBbox([-122.6, 37.6, -122.2, 37.9])).toEqual([[-122.6, 37.6, -122.2, 37.9]]);
  });

  it('ignores anything that is not four finite numbers', () => {
    expect(normalizeBbox(undefined)).toEqual([]);
    expect(normalizeBbox([])).toEqual([]);
    expect(normalizeBbox([1, 2, 3])).toEqual([]);
    expect(normalizeBbox([1, 2, 3, NaN])).toEqual([]);
    expect(normalizeBbox([1, 2, 3, Infinity])).toEqual([]);
  });

  it('drops a viewport too wide to be a valid geodesic envelope', () => {
    // Measured against the live table: a 240°-wide envelope matches 926 of
    // 63,044 rows because PostGIS reads the ring the other way round, and the
    // whole-world one raises "Antipodal (180 degrees long) edge detected!".
    // No filter is strictly safer than a filter that means its own complement.
    expect(normalizeBbox([-180, -90, 180, 90])).toEqual([]);
    expect(normalizeBbox([-100, 0, 100, 10])).toEqual([]);
    expect(normalizeBbox([-10, -40, 10, 40])).toEqual([]);
  });

  it('keeps a continent-sized viewport that is still inside the safe span', () => {
    expect(normalizeBbox([-130, 20, -60, 55])).toEqual([[-130, 20, -60, 55]]);
  });

  it('splits a viewport straddling the antimeridian into two boxes', () => {
    // Leaflet reports longitudes past 180 once the user pans into a world copy.
    // Coercing 190 back to -170 in one box would turn a 20°-wide Pacific
    // viewport into a 340°-wide box over the wrong half of the planet.
    expect(normalizeBbox([170, -20, 190, 20])).toEqual([
      [170, -20, 180, 20],
      [-180, -20, -170, 20],
    ]);
  });

  it('clamps an out-of-range latitude rather than handing PostGIS a bad point', () => {
    expect(normalizeBbox([-10, 95, 10, 60])).toEqual([[-10, 60, 10, 90]]);
  });

  it('tolerates a box whose corners arrive the wrong way round', () => {
    expect(normalizeBbox([10, 40, -10, 20])).toEqual([[-10, 20, 10, 40]]);
  });
});

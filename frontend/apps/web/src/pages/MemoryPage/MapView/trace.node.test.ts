import { describe, expect, it } from 'vitest';

import { TRACE_GAP_MS, describeTrace, traceRadius, traceSegments, type TracePoint } from './trace';

const HOUR_MS = 3_600_000;

function point(startIso: string, endIso: string, lat: number, lng: number, fixCount = 1): TracePoint {
  return { startTime: startIso, endTime: endIso, latitude: lat, longitude: lng, fixCount };
}

/** A point spanning one hour from `startIso`, for readable continuity cases. */
function hour(startIso: string, lat: number, lng: number, fixCount = 1): TracePoint {
  const start = Date.parse(startIso);

  return point(startIso, new Date(start + HOUR_MS).toISOString(), lat, lng, fixCount);
}

describe('traceSegments', () => {
  it('joins a continuous stretch into one polyline', () => {
    const points = [
      hour('2024-05-01T10:00:00.000Z', 34.0, -118.3),
      hour('2024-05-01T12:00:00.000Z', 34.1, -118.4),
      hour('2024-05-01T14:00:00.000Z', 34.2, -118.5),
    ];

    expect(traceSegments(points)).toEqual([
      [
        [34.0, -118.3],
        [34.1, -118.4],
        [34.2, -118.5],
      ],
    ]);
  });

  it('breaks the line across a gap instead of inventing a journey', () => {
    // The real history has a fix in Chicago in May 2013 and its next one in Los
    // Angeles in April 2016. Joining them draws a three-year trip that never
    // happened.
    const points = [
      hour('2013-05-28T21:02:08.000Z', 41.89314, -87.625685),
      hour('2016-04-07T00:38:54.000Z', 34.0579389, -118.3049389),
      hour('2016-04-07T04:00:00.000Z', 34.06, -118.31),
    ];

    const segments = traceSegments(points);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual([
      [34.0579389, -118.3049389],
      [34.06, -118.31],
    ]);
  });

  it('compares the END of one point against the START of the next', () => {
    // Two adjacent downsampled buckets are continuous even though their START
    // instants are a whole bucket apart. Comparing starts would shatter a
    // continuous trace into single points at any bucket wider than the gap.
    //
    // This bucket (2.4 days) is deliberately narrower than TRACE_GAP_MS
    // (3 days), which means it does NOT distinguish end-to-start from
    // start-to-start: `start(second) - start(first)` is one bucket-width, and
    // one bucket-width already fits under the 3-day gap either way. Kept as a
    // readable baseline case; the case below is the one that actually proves
    // which endpoint is compared.
    const bucketMs = 2.4 * 24 * HOUR_MS;
    const first = point(
      '2024-05-01T00:00:00.000Z',
      new Date(Date.parse('2024-05-01T00:00:00.000Z') + bucketMs).toISOString(),
      34.0,
      -118.3,
    );
    const second = point(
      new Date(Date.parse('2024-05-01T00:00:00.000Z') + bucketMs).toISOString(),
      new Date(Date.parse('2024-05-01T00:00:00.000Z') + 2 * bucketMs).toISOString(),
      34.1,
      -118.4,
    );

    expect(traceSegments([first, second])).toHaveLength(1);
  });

  it('stays continuous across a bucket WIDER than the gap threshold, which only an end-to-start comparison can tell', () => {
    // The case above cannot actually distinguish end-to-start from
    // start-to-start: at a 2.4-day bucket, `start(second) - start(first)`
    // (one bucket-width) is already under the 3-day TRACE_GAP_MS, so both a
    // correct and a buggy (start-vs-start) comparison call it continuous.
    //
    // Here the bucket is 4 days — WIDER than TRACE_GAP_MS. The two points are
    // still truly adjacent (second.startTime === first.endTime, zero real
    // gap), so the correct end-to-start comparison sees a 0ms gap and joins
    // them. A start-to-start comparison would instead see the full 4-day
    // bucket width, which exceeds the 3-day threshold, and shatter the trace
    // into two single-point (undrawn) stretches — producing zero segments
    // instead of one. That is exactly the difference this test pins.
    const bucketMs = 4 * 24 * HOUR_MS;
    const firstStart = '2024-05-01T00:00:00.000Z';
    const firstEnd = new Date(Date.parse(firstStart) + bucketMs).toISOString();
    const secondEnd = new Date(Date.parse(firstStart) + 2 * bucketMs).toISOString();

    const first = point(firstStart, firstEnd, 34.0, -118.3);
    const second = point(firstEnd, secondEnd, 34.1, -118.4);

    expect(traceSegments([first, second])).toHaveLength(1);
    expect(traceSegments([first, second])[0]).toEqual([
      [34.0, -118.3],
      [34.1, -118.4],
    ]);
  });

  it('drops stretches of one, which draw nothing as a line', () => {
    const points = [
      hour('2020-01-01T00:00:00.000Z', 1, 1),
      hour('2021-01-01T00:00:00.000Z', 2, 2),
      hour('2022-01-01T00:00:00.000Z', 3, 3),
    ];

    expect(traceSegments(points)).toEqual([]);
  });

  it('honours a caller-supplied gap', () => {
    const points = [hour('2024-05-01T00:00:00.000Z', 1, 1), hour('2024-05-01T06:00:00.000Z', 2, 2)];

    expect(traceSegments(points, TRACE_GAP_MS)).toHaveLength(1);
    expect(traceSegments(points, HOUR_MS)).toEqual([]);
  });

  it('skips undated points rather than placing them at the epoch', () => {
    const points = [
      hour('2024-05-01T10:00:00.000Z', 34.0, -118.3),
      point('not a date', 'not a date', 99, 99),
      hour('2024-05-01T12:00:00.000Z', 34.1, -118.4),
    ];

    expect(traceSegments(points)).toEqual([
      [
        [34.0, -118.3],
        [34.1, -118.4],
      ],
    ]);
  });

  it('has nothing to draw for an empty trace', () => {
    expect(traceSegments([])).toEqual([]);
  });
});

describe('traceRadius', () => {
  it('grows with weight but stays bounded', () => {
    expect(traceRadius(1)).toBeLessThan(traceRadius(100));
    expect(traceRadius(100)).toBeLessThan(traceRadius(9_264));
    expect(traceRadius(1_000_000)).toBeLessThanOrEqual(9);
  });

  it('keeps a single fix visible instead of a zero-radius dot', () => {
    expect(traceRadius(1)).toBeGreaterThan(0);
    expect(traceRadius(0)).toBeGreaterThan(0);
  });
});

describe('describeTrace', () => {
  it('says both numbers when the server downsampled', () => {
    // 316 points standing for 63,044 fixes — the live figures. Reporting only
    // the point count would present a sampled trace as the whole history.
    expect(describeTrace({ points: 316, totalFixes: 63_044, bucketSeconds: 207_360, hasMore: false })).toBe(
      '316 points from 63,044 fixes, sampled every 2.4 days',
    );
  });

  it('says so plainly when every fix is on screen', () => {
    expect(describeTrace({ points: 120, totalFixes: 120, bucketSeconds: null, hasMore: false })).toBe(
      '120 points (every fix)',
    );
  });

  it('admits when a raw walk has more pages to go', () => {
    expect(describeTrace({ points: 2_000, totalFixes: 63_044, bucketSeconds: null, hasMore: true })).toBe(
      '2,000 points of 63,044 fixes',
    );
  });

  it('reads naturally for one point and for sub-day buckets', () => {
    expect(describeTrace({ points: 1, totalFixes: 1, bucketSeconds: null, hasMore: false })).toBe(
      '1 point (every fix)',
    );
    expect(describeTrace({ points: 10, totalFixes: 40, bucketSeconds: 3_600, hasMore: false })).toBe(
      '10 points from 40 fixes, sampled every 1 hour',
    );
    expect(describeTrace({ points: 10, totalFixes: 40, bucketSeconds: 90, hasMore: false })).toBe(
      '10 points from 40 fixes, sampled every 1.5 minutes',
    );
  });

  it('does not pretend an empty area has history', () => {
    expect(describeTrace({ points: 0, totalFixes: 0, bucketSeconds: null, hasMore: false })).toBe(
      'No location history here',
    );
  });
});

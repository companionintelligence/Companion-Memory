import { describe, expect, it } from 'vitest';

import {
  MAX_INTERPOLATION_GAP_MS,
  interpolateAt,
  mergeStops,
  normalizeTrackRow,
  trailPoints,
  type TrackPoint,
} from './positionTrack';

const T0 = Date.UTC(2024, 0, 1);

function point(t: number, lat: number, lng: number): TrackPoint {
  return { t, lat, lng, name: null };
}

describe('normalizeTrackRow', () => {
  it('reads the compact shape this module uses', () => {
    expect(normalizeTrackRow({ t: T0, lat: 37.77, lng: -122.41 })).toEqual({
      t: T0,
      lat: 37.77,
      lng: -122.41,
      name: null,
    });
  });

  it('reads a flat server projection with an ISO time', () => {
    expect(normalizeTrackRow({ time: '2024-01-01T00:00:00.000Z', latitude: 1, longitude: 2 })).toEqual({
      t: T0,
      lat: 1,
      lng: 2,
      name: null,
    });
  });

  it('reads PostGIS GeoJSON without transposing lng/lat', () => {
    const row = { time: T0, location: { type: 'Point', coordinates: [-122.41, 37.77] } };

    expect(normalizeTrackRow(row)).toMatchObject({ lat: 37.77, lng: -122.41 });
  });

  it('carries a resolved place name when the row has one', () => {
    expect(normalizeTrackRow({ t: T0, lat: 1, lng: 2, name: 'Home' })?.name).toBe('Home');
    expect(normalizeTrackRow({ t: T0, lat: 1, lng: 2, city: 'Oakland' })?.name).toBe('Oakland');
  });

  it('drops rows that cannot be plotted rather than putting them at (0, 0)', () => {
    expect(normalizeTrackRow({ t: T0 })).toBeNull();
    expect(normalizeTrackRow({ t: T0, lat: 91, lng: 0 })).toBeNull();
    expect(normalizeTrackRow({ t: T0, lat: 0, lng: 181 })).toBeNull();
    expect(normalizeTrackRow({ lat: 1, lng: 2 })).toBeNull();
    expect(normalizeTrackRow({ time: 'not a date', lat: 1, lng: 2 })).toBeNull();
    expect(normalizeTrackRow(null)).toBeNull();
  });
});

describe('mergeStops', () => {
  it('interleaves two ascending lists', () => {
    expect(mergeStops([1, 5, 9], [2, 6])).toEqual([1, 2, 5, 6, 9]);
  });

  it('de-duplicates coincident moments', () => {
    expect(mergeStops([1, 2, 3], [2, 3, 4])).toEqual([1, 2, 3, 4]);
  });

  it('handles either side being empty', () => {
    expect(mergeStops([], [1, 2])).toEqual([1, 2]);
    expect(mergeStops([1, 2], [])).toEqual([1, 2]);
    expect(mergeStops([], [])).toEqual([]);
  });
});

describe('interpolateAt', () => {
  const points = [point(T0, 0, 0), point(T0 + 60_000, 10, 20)];

  it('returns nothing before the first fix', () => {
    expect(interpolateAt(points, 0, T0 - 1)).toBeNull();
    expect(interpolateAt([], 0, T0)).toBeNull();
  });

  it('sits exactly on a fix at that fix', () => {
    expect(interpolateAt(points, 1, T0)).toMatchObject({ lat: 0, lng: 0 });
  });

  it('interpolates the midpoint between consecutive fixes', () => {
    expect(interpolateAt(points, 1, T0 + 30_000)).toMatchObject({ lat: 5, lng: 10 });
  });

  it('holds at the last fix once the track runs out', () => {
    expect(interpolateAt(points, 2, T0 + 10 * 60_000)).toMatchObject({ lat: 10, lng: 20 });
  });

  it('refuses to glide across a gap wider than the cap', () => {
    const apart = [point(T0, 0, 0), point(T0 + MAX_INTERPOLATION_GAP_MS + 1, 50, 50)];

    // Halfway through a three-month gap the camera is still at the last real
    // fix, not somewhere over the Atlantic.
    expect(interpolateAt(apart, 1, T0 + MAX_INTERPOLATION_GAP_MS / 2)).toMatchObject({ lat: 0, lng: 0 });
  });
});

describe('trailPoints', () => {
  const points = [point(0, 0, 0), point(1, 1, 1), point(2, 2, 2), point(3, 3, 3)];

  it('returns the revealed prefix', () => {
    expect(trailPoints(points, 3, 10)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it('caps the tail to the most recent points', () => {
    expect(trailPoints(points, 4, 2)).toEqual([
      [2, 2],
      [3, 3],
    ]);
  });

  it('is empty before anything is revealed', () => {
    expect(trailPoints(points, 0, 10)).toEqual([]);
    expect(trailPoints(points, -5, 10)).toEqual([]);
  });

  it('never reads past the end of the track', () => {
    expect(trailPoints(points, 99, 10)).toHaveLength(4);
  });
});

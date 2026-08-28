import type { LatLngBounds } from 'leaflet';
import { describe, expect, it } from 'vitest';

import { boundsToBbox, bboxCenter, clampBboxSpan, formatBbox, parseBbox, type Bbox } from './bbox';

describe('parseBbox', () => {
  it('parses four finite numbers into a tuple', () => {
    expect(parseBbox('-118.5,33.7,-118.1,34.1')).toEqual([-118.5, 33.7, -118.1, 34.1]);
  });

  it('accepts an all-zero bbox (every value is finite)', () => {
    expect(parseBbox('0,0,0,0')).toEqual([0, 0, 0, 0]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])('returns undefined for %s', (_label, input) => {
    expect(parseBbox(input)).toBeUndefined();
  });

  it('returns undefined when there are too few parts', () => {
    expect(parseBbox('1,2,3')).toBeUndefined();
  });

  it('returns undefined when there are too many parts', () => {
    expect(parseBbox('1,2,3,4,5')).toBeUndefined();
  });

  it('returns undefined when a part is not a finite number', () => {
    expect(parseBbox('1,2,three,4')).toBeUndefined();
    expect(parseBbox('1,2,3,Infinity')).toBeUndefined();
  });
});

describe('formatBbox', () => {
  it('serialises with fixed 6-decimal precision, comma-joined', () => {
    expect(formatBbox([-118.123456789, 33.7, -118.1, 34])).toBe(
      '-118.123457,33.700000,-118.100000,34.000000',
    );
  });

  it('round-trips through parseBbox (within the formatted precision)', () => {
    const bbox: Bbox = [-118.18941, 33.76482, -118.1, 34.1];
    expect(parseBbox(formatBbox(bbox))).toEqual([-118.18941, 33.76482, -118.1, 34.1]);
  });
});

describe('boundsToBbox', () => {
  it('maps Leaflet bounds to [W, S, E, N]', () => {
    const bounds = {
      getWest: () => -118.5,
      getSouth: () => 33.7,
      getEast: () => -118.1,
      getNorth: () => 34.1,
    } as unknown as LatLngBounds;

    expect(boundsToBbox(bounds)).toEqual([-118.5, 33.7, -118.1, 34.1]);
  });
});

describe('bboxCenter', () => {
  it('returns the geographic centre as [lat, lng]', () => {
    // bbox = [minLon, minLat, maxLon, maxLat]
    expect(bboxCenter([0, 0, 10, 20])).toEqual([10, 5]);
  });

  it('handles negative coordinates', () => {
    expect(bboxCenter([-118.5, 33.7, -118.1, 34.1])).toEqual([(33.7 + 34.1) / 2, (-118.5 + -118.1) / 2]);
  });
});

describe('clampBboxSpan', () => {
  it('leaves a bbox already inside both limits untouched', () => {
    const bbox: Bbox = [-118.5, 33.7, -118.1, 34.1];

    expect(clampBboxSpan(bbox, 120, 60)).toEqual(bbox);
  });

  it('shrinks a too-tall bbox around its own centre, not its south-west corner', () => {
    // 80° of latitude — over a 60° cap — centred on the equator.
    const bbox: Bbox = [-10, -40, 10, 40];

    const clamped = clampBboxSpan(bbox, 120, 60);

    expect(clamped[3] - clamped[1]).toBeCloseTo(60);
    // Symmetric around the SAME centre — a corner-anchored shrink would move
    // the box, not just narrow it, and silently point the viewport read
    // somewhere the user isn't looking.
    expect(bboxCenter(clamped)).toEqual(bboxCenter(bbox));
    // Longitude, untouched by the lat cap, survives exactly.
    expect(clamped[0]).toBe(-10);
    expect(clamped[2]).toBe(10);
  });

  it('shrinks a too-wide bbox the same way', () => {
    const bbox: Bbox = [-100, -10, 100, 10];

    const clamped = clampBboxSpan(bbox, 120, 60);

    expect(clamped[2] - clamped[0]).toBeCloseTo(120);
    expect(bboxCenter(clamped)).toEqual(bboxCenter(bbox));
  });

  it('is exactly what a padded viewport needs: the case that motivated it', () => {
    // TraceLayer pads a raw viewport by 0.35 (35% on each edge) before
    // sending it — a raw 38° lat span (a plausible tall/portrait viewport,
    // not a contrived one) pads out past the server's 60° safe-envelope
    // ceiling, which would otherwise make the server drop the spatial filter
    // entirely rather than narrow it.
    const rawLatSpan = 38;
    const padded = rawLatSpan * 1.7; // pad(0.35) adds 0.35 to EACH edge.

    expect(padded).toBeGreaterThan(60);

    const bbox: Bbox = [-118, 20 - padded / 2, -118, 20 + padded / 2];
    const clamped = clampBboxSpan(bbox, 120, 60);

    expect(clamped[3] - clamped[1]).toBeLessThanOrEqual(60);
  });
});

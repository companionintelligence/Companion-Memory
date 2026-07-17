import type { LatLngBounds } from 'leaflet';
import { describe, expect, it } from 'vitest';

import { boundsToBbox, bboxCenter, formatBbox, parseBbox, type Bbox } from './bbox';

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

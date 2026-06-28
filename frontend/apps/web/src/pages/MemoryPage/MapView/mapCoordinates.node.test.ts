import { describe, expect, it } from 'vitest';

import { readCoordinates, readGeoJsonPoint } from './mapCoordinates';

describe('readGeoJsonPoint (PostGIS Point [lng, lat])', () => {
  it('reads a valid GeoJSON Point, honoring [lng, lat] axis order', () => {
    // Long Beach Convention Center, as a backend event.mapCoordinates would arrive.
    expect(readGeoJsonPoint({ type: 'Point', coordinates: [-118.1894, 33.7648] })).toEqual({
      lat: 33.7648,
      lng: -118.1894,
    });
  });

  it('accepts a legitimate zero on one axis (equator / prime meridian)', () => {
    expect(readGeoJsonPoint({ type: 'Point', coordinates: [0, 51.4769] })).toEqual({ lat: 51.4769, lng: 0 });
    expect(readGeoJsonPoint({ type: 'Point', coordinates: [-78.45, 0] })).toEqual({ lat: 0, lng: -78.45 });
  });

  it('rejects the (0,0) null-island sentinel', () => {
    expect(readGeoJsonPoint({ type: 'Point', coordinates: [0, 0] })).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a non-object', 42],
    ['no coordinates', { type: 'Point' }],
    ['coordinates not an array', { coordinates: 'nope' }],
    ['too few coordinates', { coordinates: [1] }],
    ['NaN', { coordinates: [Number.NaN, 5] }],
    ['non-number members', { coordinates: ['-118', '34'] }],
  ])('returns null for %s', (_label, input) => {
    expect(readGeoJsonPoint(input)).toBeNull();
  });
});

describe('readCoordinates ({ latitude, longitude })', () => {
  it('reads a valid latitude/longitude bag', () => {
    expect(readCoordinates({ latitude: 34.0522, longitude: -118.2437 })).toEqual({
      lat: 34.0522,
      lng: -118.2437,
    });
  });

  it('rejects the (0,0) null-island sentinel', () => {
    expect(readCoordinates({ latitude: 0, longitude: 0 })).toBeNull();
  });

  it.each([
    ['null', null],
    ['a non-object', 'x'],
    ['missing fields', {}],
    ['null fields', { latitude: null, longitude: null }],
    ['NaN', { latitude: Number.NaN, longitude: 12 }],
    ['string members', { latitude: '34', longitude: '-118' }],
  ])('returns null for %s', (_label, input) => {
    expect(readCoordinates(input)).toBeNull();
  });
});

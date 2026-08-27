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

// The properties bag is written as `{ lat, lng }` — PlaceService.upsert and the
// geocode path both use the short spelling. Reading only `latitude`/`longitude`
// meant every place resolved to null and rendered no pin, while its coordinate
// sat correct and full-precision in `location_point`. The original tests here
// only exercised the long spelling, so they agreed with the bug.
describe('readCoordinates ({ lat, lng }) — the shape writers actually produce', () => {
  it('reads a lat/lng bag', () => {
    expect(readCoordinates({ lat: 34.0522, lng: -118.2437 })).toEqual({ lat: 34.0522, lng: -118.2437 });
  });

  it('prefers the typed latitude/longitude when both spellings are present', () => {
    expect(readCoordinates({ latitude: 1, longitude: 2, lat: 9, lng: 9 })).toEqual({ lat: 1, lng: 2 });
  });

  it('still rejects null island in the short spelling', () => {
    expect(readCoordinates({ lat: 0, lng: 0 })).toBeNull();
  });

  it('still rejects a half-populated short pair', () => {
    expect(readCoordinates({ lat: 34.0522 })).toBeNull();
    expect(readCoordinates({ lng: -118.2437 })).toBeNull();
  });

  it('keeps a legitimate zero on one axis', () => {
    // Greenwich: longitude 0 is a real coordinate, only (0,0) is the sentinel.
    expect(readCoordinates({ lat: 51.4769, lng: 0 })).toEqual({ lat: 51.4769, lng: 0 });
  });
});

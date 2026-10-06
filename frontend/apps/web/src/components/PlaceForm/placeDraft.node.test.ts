import { describe, expect, it } from 'vitest';

import {
  PLACE_KINDS,
  PLACE_KIND_LABELS,
  applyCurrentLocation,
  emptyPlaceDraft,
  formatExactCoordinate,
  parseCoordinates,
  placeDraftToInput,
  validatePlaceDraft,
  type PlaceDraft,
} from './placeDraft';

function draft(overrides: Partial<PlaceDraft> = {}): PlaceDraft {
  return { ...emptyPlaceDraft(), name: 'Blue Bottle', ...overrides };
}

describe('PLACE_KINDS', () => {
  it('has a label for every kind the server accepts', () => {
    for (const kind of PLACE_KINDS) {
      expect(PLACE_KIND_LABELS[kind]).toBeTruthy();
    }
  });
});

describe('parseCoordinates', () => {
  it('parses a full pair', () => {
    expect(parseCoordinates('37.7823', '-122.4076')).toEqual({ latitude: 37.7823, longitude: -122.4076 });
  });

  it('is null unless both parts are given', () => {
    expect(parseCoordinates('37.7823', '')).toBeNull();
    expect(parseCoordinates('', '-122.4076')).toBeNull();
  });

  it('rejects out-of-range and non-numeric values', () => {
    expect(parseCoordinates('91', '0')).toBeNull();
    expect(parseCoordinates('0', '-181')).toBeNull();
    expect(parseCoordinates('somewhere', '0')).toBeNull();
  });
});

describe('validatePlaceDraft', () => {
  it('passes a named place', () => {
    expect(validatePlaceDraft(draft())).toBeNull();
  });

  it('requires a name', () => {
    expect(validatePlaceDraft(draft({ name: '  ' }))).toBe('name');
  });

  it('rejects half a coordinate pair rather than dropping it silently', () => {
    expect(validatePlaceDraft(draft({ latitude: '37.7823' }))).toBe('coordinates');
  });
});

describe('formatExactCoordinate', () => {
  it('keeps seven decimals so a GPS pin is not rounded away', () => {
    expect(formatExactCoordinate(37.78234567)).toBe('37.7823457');
    expect(formatExactCoordinate(-122.40761234)).toBe('-122.4076123');
  });
});

describe('applyCurrentLocation', () => {
  it('writes exact coordinates and keeps the street as the address, not the name or the kind', () => {
    expect(
      applyCurrentLocation(emptyPlaceDraft(), {
        latitude: 37.7823,
        longitude: -122.4076,
        address: '66 Mint St, San Francisco',
      }),
    ).toMatchObject({
      name: '',
      address: '66 Mint St, San Francisco',
      placeKind: '',
      latitude: '37.7823000',
      longitude: '-122.4076000',
    });
  });

  it('does not overwrite a name or kind the user already chose', () => {
    expect(
      applyCurrentLocation(draft({ name: 'Blue Bottle', placeKind: 'venue', address: 'hand typed' }), {
        latitude: 37.78,
        longitude: -122.4,
        address: '66 Mint St',
      }),
    ).toMatchObject({
      name: 'Blue Bottle',
      placeKind: 'venue',
      address: '66 Mint St',
    });
  });

  it('names an unnamed pin Current location when reverse geocode is empty', () => {
    expect(applyCurrentLocation(emptyPlaceDraft(), { latitude: 1, longitude: 2 }).name).toBe(
      'Current location',
    );
  });

  it('clears a Current location placeholder once an address arrives so the user can name it', () => {
    expect(
      applyCurrentLocation(draft({ name: 'Current location' }), {
        latitude: 1,
        longitude: 2,
        address: '66 Mint St',
      }),
    ).toMatchObject({ name: '', address: '66 Mint St', placeKind: '' });
  });
});

describe('placeDraftToInput', () => {
  it('omits blank optional fields instead of sending empty strings', () => {
    const input = placeDraftToInput(draft());

    expect(input).toEqual({
      name: 'Blue Bottle',
      description: undefined,
      placeKind: undefined,
      properties: undefined,
      latitude: undefined,
      longitude: undefined,
    });
  });

  it('never sends placeKind as an empty string — the resolver rejects unknown kinds', () => {
    expect(placeDraftToInput(draft({ placeKind: '' })).placeKind).toBeUndefined();
    expect(placeDraftToInput(draft({ placeKind: 'venue' })).placeKind).toBe('venue');
  });

  it('sends coordinates as typed top-level fields, not inside properties', () => {
    const input = placeDraftToInput(draft({ latitude: '37.7823', longitude: '-122.4076' }));

    expect(input.latitude).toBe(37.7823);
    expect(input.longitude).toBe(-122.4076);
    expect(input.properties).toBeUndefined();
  });

  it('puts the address on properties.address, where the detail drawer reads it', () => {
    expect(placeDraftToInput(draft({ address: '  66 Mint St  ' })).properties).toEqual({
      address: '66 Mint St',
    });
  });

  it('trims the name', () => {
    expect(placeDraftToInput(draft({ name: '  Blue Bottle  ' })).name).toBe('Blue Bottle');
  });

  it('throws rather than posting an unnamed place', () => {
    expect(() => placeDraftToInput(draft({ name: '' }))).toThrow(/needs a name/i);
  });
});

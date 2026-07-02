import { CreatePlaceInput } from '../../types/CreatePlaceInput';
import { buildPlaceProperties } from '../PlaceResolver';

function input(overrides: Partial<CreatePlaceInput> = {}): CreatePlaceInput {
  return Object.assign(new CreatePlaceInput(), { name: 'Pin', ...overrides });
}

describe('buildPlaceProperties', () => {
  it('promotes first-class latitude/longitude to top-level numeric properties (map-readable)', () => {
    // These are exactly the keys the memory-explorer Map view's readCoordinates
    // reads off a Place's properties bag, so a pin created this way renders.
    const props = buildPlaceProperties(input({ latitude: 37.7749, longitude: -122.4194 }));

    expect(props.latitude).toBe(37.7749);
    expect(props.longitude).toBe(-122.4194);
    expect(typeof props.latitude).toBe('number');
    expect(typeof props.longitude).toBe('number');
  });

  it('binds the rest of the Pin contract: capturedAt, memoryRef, source', () => {
    const memoryRef = { kind: 'file', id: 'file_123' };
    const props = buildPlaceProperties(
      input({ capturedAt: '2026-07-01T12:00:00.000Z', memoryRef, source: 'earth-2' }),
    );

    expect(props.capturedAt).toBe('2026-07-01T12:00:00.000Z');
    expect(props.memoryRef).toEqual(memoryRef);
    expect(props.source).toBe('earth-2');
  });

  it('drops NaN coordinates so a malformed pin never persists a bogus position', () => {
    const props = buildPlaceProperties(input({ latitude: Number.NaN, longitude: Number.NaN }));

    expect(props).not.toHaveProperty('latitude');
    expect(props).not.toHaveProperty('longitude');
  });

  it('keeps a valid coordinate even when it is 0 (equator / prime meridian)', () => {
    const props = buildPlaceProperties(input({ latitude: 0, longitude: 0 }));

    // The (0,0) null-island filtering is the Map view's concern; the input
    // normalizer must not silently drop a legitimately-zero coordinate.
    expect(props.latitude).toBe(0);
    expect(props.longitude).toBe(0);
  });

  it('still supports the legacy geolocation / type / boundary properties', () => {
    const props = buildPlaceProperties(
      input({
        type: 'home',
        geoFormat: 'wgs84',
        geolocation: { lat: 1, lng: 2 },
        locationBoundary: { type: 'Polygon' },
        estimated: true,
        tracked: true,
        uploaded: true,
      }),
    );

    expect(props.type).toBe('home');
    expect(props.geoFormat).toBe('wgs84');
    expect(props.geolocation).toEqual({ lat: 1, lng: 2 });
    expect(props.locationBoundary).toEqual({ type: 'Polygon' });
    expect(props.estimated).toBe(true);
    expect(props.tracked).toBe(true);
    expect(props.uploaded).toBe(true);
  });

  it('preserves caller-supplied properties and layers pin fields on top', () => {
    const props = buildPlaceProperties(
      input({ properties: { note: 'keep me' }, latitude: 10, longitude: 20 }),
    );

    expect(props.note).toBe('keep me');
    expect(props.latitude).toBe(10);
    expect(props.longitude).toBe(20);
  });
});

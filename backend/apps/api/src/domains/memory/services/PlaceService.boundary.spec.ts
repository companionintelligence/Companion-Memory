import type { UserServiceContext } from '@ci/common/context';

import { PlaceService } from './PlaceService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const EXISTING = '00000000-0000-0000-0000-0000000000b1';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

/** Mountain View's real Google bounds: a well-formed western-hemisphere box. */
const BOUNDS = { north: 37.4694, south: 37.32286, east: -122.0446, west: -122.1178 };

interface Harness {
  service: PlaceService;
  statements: Array<{ sql: string; params: unknown[] | undefined }>;
}

/**
 * Same shape as PlaceService.geocode.spec's harness, trimmed to what the
 * boundary path exercises: the place_id lookup, the main INSERT, the name+cell
 * read-back, and the enrich UPDATE.
 */
function makeHarness(
  options: { byPlaceIdRows?: Array<{ entity_id: string }>; wasNew?: boolean; rows?: unknown[] } = {},
): Harness {
  const statements: Array<{ sql: string; params: unknown[] | undefined }> = [];

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });

    if (options.rows && sql.includes('ST_Covers')) {
      return options.rows;
    }

    if (sql.includes(`properties->>'place_id' = $2`) && sql.trimStart().startsWith('SELECT')) {
      return options.byPlaceIdRows ?? [];
    }

    if (sql.includes('was_new')) {
      const insertedId = params?.[0] as string;

      return options.wasNew === false
        ? [{ entity_id: EXISTING, was_new: false }]
        : [{ entity_id: insertedId, was_new: true }];
    }

    return [];
  });

  const repository = {
    manager: { query },
    // findByIds path used by placesContaining
    find: jest.fn(async () => []),
  };

  const service = new PlaceService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send: jest.fn(async () => []) } as any,
    {
      entityCreated: jest.fn(async () => undefined),
      entityUpdated: jest.fn(async () => undefined),
      entityDeleted: jest.fn(async () => undefined),
      recordMany: jest.fn(async () => undefined),
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  );

  return { service, statements };
}

function statement(harness: Harness, fragment: string) {
  return harness.statements.find(({ sql }) => sql.includes(fragment));
}

describe('PlaceService boundary persistence (#2161)', () => {
  it('builds the envelope from a bounded result in (west, south, east, north) order', async () => {
    const harness = makeHarness({});

    await harness.service.findOrCreateForGeocode(CONTEXT, {
      name: 'Mountain View',
      lat: 37.386,
      lng: -122.083,
      bounds: BOUNDS,
    });

    const insert = statement(harness, 'INSERT INTO ci.entities');
    expect(insert?.sql).toContain('ST_MakeEnvelope');
    // $8 gates the envelope; $9..$12 are the corners. ST_MakeEnvelope takes
    // (xmin, ymin, xmax, ymax) = (west, south, east, north) — a swap here
    // silently produces an inverted or empty polygon.
    expect(insert?.params?.slice(7, 12)).toEqual([
      true,
      BOUNDS.west,
      BOUNDS.south,
      BOUNDS.east,
      BOUNDS.north,
    ]);
  });

  it('labels a bounded feature as an area, not an address', async () => {
    const harness = makeHarness({});

    await harness.service.findOrCreateForGeocode(CONTEXT, {
      name: 'Mountain View',
      lat: 37.386,
      lng: -122.083,
      bounds: BOUNDS,
    });

    expect(statement(harness, 'INSERT INTO ci.entities')?.params?.[6]).toBe('neighborhood');
  });

  // A bare point gets no kind (#3025): calling every geocode "address" filled the places
  // list with Address badges. The user picks the kind.
  it('writes no boundary and leaves the kind unset when the provider returned no box', async () => {
    const harness = makeHarness({});

    await harness.service.findOrCreateForGeocode(CONTEXT, {
      name: '1600 Amphitheatre Pkwy',
      lat: 37.4221,
      lng: -122.0841,
    });

    const insert = statement(harness, 'INSERT INTO ci.entities');
    expect(insert?.params?.[6]).toBeNull();
    expect(insert?.params?.[7]).toBe(false);
  });

  it.each([
    ['inverted latitudes', { north: 37.0, south: 37.5, east: -122.0, west: -122.2 }],
    ['antimeridian crossing', { north: -16.0, south: -18.3, east: -179.7, west: 177.0 }],
    ['zero area', { north: 37.4, south: 37.4, east: -122.0, west: -122.0 }],
    ['out of range', { north: 91, south: 37.3, east: -122.0, west: -122.2 }],
  ])('rejects a %s box instead of persisting a bad polygon', async (_label, bounds) => {
    const harness = makeHarness({});

    await harness.service.findOrCreateForGeocode(CONTEXT, {
      name: 'Suspicious',
      lat: 37.386,
      lng: -122.083,
      bounds,
    });

    const insert = statement(harness, 'INSERT INTO ci.entities');
    expect(insert?.params?.[7]).toBe(false);
    expect(insert?.params?.[6]).toBeNull();
  });

  it('backfills a boundary onto an existing place without overwriting one it already has', async () => {
    const harness = makeHarness({ byPlaceIdRows: [{ entity_id: EXISTING }] });

    await harness.service.findOrCreateForGeocode(CONTEXT, {
      name: 'Mountain View',
      lat: 37.386,
      lng: -122.083,
      placeId: 'place-mv',
      bounds: BOUNDS,
    });

    const enrich = statement(harness, 'COALESCE(location_point');
    // COALESCE(location_boundary, ...) is what makes this fill-only: a
    // hand-drawn or tighter existing polygon must survive re-resolution.
    expect(enrich?.sql).toContain('location_boundary = COALESCE(');
    expect(enrich?.params?.slice(4, 9)).toEqual([true, BOUNDS.west, BOUNDS.south, BOUNDS.east, BOUNDS.north]);
  });
});

describe('PlaceService.placesContaining (#2161)', () => {
  it('covers the point and returns the most specific container first', async () => {
    const harness = makeHarness({ rows: [{ entity_id: EXISTING }] });

    await harness.service.placesContaining(CONTEXT, { lat: 37.386, lng: -122.083 });

    const sql = statement(harness, 'ST_Covers')?.sql ?? '';
    // ST_Covers, not ST_Contains: a point exactly on a city limit belongs to
    // that city rather than to nowhere.
    expect(sql).toContain('ST_Covers(location_boundary');
    expect(sql).toContain('ORDER BY ST_Area(location_boundary) ASC');
    expect(sql).toContain('location_boundary IS NOT NULL');
    // GeoJSON/PostGIS argument order is (lng, lat) — swapping them silently
    // queries the wrong hemisphere.
    expect(statement(harness, 'ST_Covers')?.params?.slice(0, 3)).toEqual([USER, -122.083, 37.386]);
  });

  it('clamps the limit and short-circuits without a hydrate when nothing contains the point', async () => {
    const harness = makeHarness({ rows: [] });

    const result = await harness.service.placesContaining(CONTEXT, {
      lat: 37.386,
      lng: -122.083,
      limit: 5000,
    });

    expect(result).toEqual([]);
    expect(statement(harness, 'ST_Covers')?.params?.[3]).toBe(100);
  });
});

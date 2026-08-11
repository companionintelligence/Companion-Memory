import type { UserServiceContext } from '@ci/common/context';

import { PlaceService } from './PlaceService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const EXISTING = '00000000-0000-0000-0000-0000000000b1';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

const COMPONENTS = {
  address_components: [
    { long_name: '1600 Amphitheatre Pkwy', types: ['street_address'] },
    { long_name: 'Mountain View', types: ['locality', 'political'] },
    { long_name: 'California', types: ['administrative_area_level_1', 'political'] },
    { long_name: 'United States', types: ['country', 'political'] },
  ],
};

interface Harness {
  service: PlaceService;
  statements: Array<{ sql: string; params: unknown[] | undefined }>;
  send: jest.Mock;
}

/**
 * Routes the raw manager.query calls findOrCreateForGeocode issues:
 * - place_id lookup -> `byPlaceIdRows`
 * - main INSERT -> recorded
 * - name+cell read-back -> `wasNew` decides which id/flag comes back
 * - admin-node INSERT/SELECT pairs -> deterministic per-kind ids
 * - enrich/parent UPDATEs -> recorded
 */
function makeHarness(options: {
  byPlaceIdRows?: Array<{ entity_id: string }>;
  wasNew?: boolean;
  /** Simulate the read-back missing (INSERT swallowed by another unique index). */
  readBackMisses?: boolean;
  /** place_id rows served AFTER the read-back miss (the race winner). */
  raceWinnerRows?: Array<{ entity_id: string }>;
  /** Serve an existing unparented admin node for the adoption UPDATE. */
  adoptedAdminId?: string | null;
}): Harness {
  const statements: Array<{ sql: string; params: unknown[] | undefined }> = [];
  let placeIdLookups = 0;

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });

    if (sql.includes(`properties->>'place_id' = $2`) && sql.trimStart().startsWith('SELECT')) {
      placeIdLookups += 1;
      // The first lookup is step 1; a second one is the post-read-back-miss
      // resolution of the concurrent winner.
      if (placeIdLookups > 1 && options.raceWinnerRows) {
        return options.raceWinnerRows;
      }

      return options.byPlaceIdRows ?? [];
    }

    if (sql.includes('SET parent_place_id = $4') && sql.includes('parent_place_id IS NULL')) {
      return options.adoptedAdminId ? [{ entity_id: options.adoptedAdminId }] : [];
    }

    if (sql.includes('was_new')) {
      if (options.readBackMisses) {
        return [];
      }

      const insertedId = params?.[0] as string;

      return options.wasNew === false
        ? [{ entity_id: EXISTING, was_new: false }]
        : [{ entity_id: insertedId, was_new: true }];
    }

    if (sql.includes('AND place_kind = $2')) {
      // Admin-node read-back: echo a stable id per kind+name.
      const kind = params ? params[1] : 'unknown';
      const name = params ? (params[2] as string) : '';

      return [{ entity_id: `admin:${kind}:${name.toLowerCase()}` }];
    }

    return [];
  });

  const repository = { manager: { query } };
  const send = jest.fn(async () => []);

  const service = new PlaceService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { send } as any,
    {
      entityCreated: jest.fn(async () => undefined),
      entityUpdated: jest.fn(async () => undefined),
      entityDeleted: jest.fn(async () => undefined),
      recordMany: jest.fn(async () => undefined),
    } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  );

  return { service, statements, send };
}

function statementsMatching(harness: Harness, fragment: string) {
  return harness.statements.filter(({ sql }) => sql.includes(fragment));
}

describe('PlaceService.findOrCreateForGeocode (place_id + hierarchy)', () => {
  it('short-circuits on a place_id hit: no insert, enriches the row, builds hierarchy', async () => {
    const harness = makeHarness({ byPlaceIdRows: [{ entity_id: EXISTING }] });

    const result = await harness.service.findOrCreateForGeocode(CONTEXT, {
      name: 'Googleplex',
      lat: 37.4221234,
      lng: -122.0841234,
      placeId: 'ChIJj61dQgK6j4AR4GeTYWZsKWw',
      components: COMPONENTS,
    });

    expect(result).toEqual({ id: EXISTING, created: false });
    expect(
      statementsMatching(
        harness,
        `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties, location_point`,
      ),
    ).toHaveLength(0);
    // Enrich: point backfill runs with FULL precision coordinates.
    const enrich = statementsMatching(harness, 'COALESCE(location_point');
    expect(enrich).toHaveLength(1);
    expect(enrich[0].params).toEqual([EXISTING, USER, -122.0841234, 37.4221234]);
    // Hierarchy: city, region, country nodes created/resolved (the keyed
    // read-back SELECT runs once per level; COALESCE(parent_place_id is unique
    // to it, unlike the adoption UPDATE which also filters on place_kind).
    expect(statementsMatching(harness, 'COALESCE(parent_place_id,')).toHaveLength(3);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('creates a new place with full-precision point + place_id and emits PlaceCreatedEvent', async () => {
    const harness = makeHarness({ wasNew: true });

    const result = await harness.service.findOrCreateForGeocode(CONTEXT, {
      name: 'Googleplex',
      lat: 37.4221234,
      lng: -122.0841234,
      placeId: 'ChIJtest',
      components: COMPONENTS,
    });

    expect(result.created).toBe(true);

    const insert = statementsMatching(harness, 'ST_MakePoint($5, $6)');
    expect(insert).toHaveLength(1);
    // Full precision on the wire; 3dp only inside the stored dedupe properties.
    expect(insert[0].params?.[4]).toBe(-122.0841234);
    expect(insert[0].params?.[5]).toBe(37.4221234);
    const properties = JSON.parse(insert[0].params?.[3] as string) as Record<string, unknown>;
    expect(properties.place_id).toBe('ChIJtest');
    expect(properties.lat).toBe(37.422);
    expect(properties.lng).toBe(-122.084);

    // The venue is hung under the most specific admin node (the city).
    const parentLink = statementsMatching(harness, 'SET parent_place_id = $3');
    expect(parentLink).toHaveLength(1);
    expect(parentLink[0].params?.[2]).toBe('admin:city:mountain view');

    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('enriches a pre-existing name+cell row (no event) instead of duplicating it', async () => {
    const harness = makeHarness({ wasNew: false });

    const result = await harness.service.findOrCreateForGeocode(CONTEXT, {
      name: 'Googleplex',
      lat: 37.4221234,
      lng: -122.0841234,
      placeId: 'ChIJtest',
    });

    expect(result).toEqual({ id: EXISTING, created: false });
    // Point backfill + guarded place_id claim, no created event.
    expect(statementsMatching(harness, 'COALESCE(location_point')).toHaveLength(1);
    const claim = statementsMatching(harness, `jsonb_build_object('place_id'`);
    expect(claim).toHaveLength(1);
    expect(claim[0].params).toEqual([EXISTING, USER, 'ChIJtest']);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('walks the hierarchy top-down: country, then region under it, then city under that', async () => {
    const harness = makeHarness({ wasNew: true });

    await harness.service.findOrCreateForGeocode(CONTEXT, {
      name: 'Googleplex',
      lat: 37.4,
      lng: -122.1,
      components: COMPONENTS,
    });

    const adminSelects = statementsMatching(harness, 'COALESCE(parent_place_id,');
    expect(adminSelects.map((statement) => statement.params?.[1])).toEqual(['country', 'region', 'city']);
    // The region node is parented under the country node, the city under the region.
    expect(adminSelects[1].params?.[3]).toBe('admin:country:united states');
    expect(adminSelects[2].params?.[3]).toBe('admin:region:california');
  });

  it('resolves the concurrent winner when the INSERT conflicts on the place_id index', async () => {
    // Two callers resolve the same NEW place_id with different name-cells: the
    // loser's INSERT is swallowed by entities_place_provider_id_uniq, so the
    // name+cell read-back finds nothing. It must fall back to the place_id
    // lookup rather than throwing and losing the event's place link.
    const harness = makeHarness({
      readBackMisses: true,
      raceWinnerRows: [{ entity_id: EXISTING }],
    });

    const result = await harness.service.findOrCreateForGeocode(CONTEXT, {
      name: 'Blue Bottle Coffee, 66 Mint St',
      lat: 37.7822,
      lng: -122.4058,
      placeId: 'ChIJraced',
    });

    expect(result).toEqual({ id: EXISTING, created: false });
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('still throws when the read-back misses and there is no place_id to resolve', async () => {
    const harness = makeHarness({ readBackMisses: true });

    await expect(
      harness.service.findOrCreateForGeocode(CONTEXT, { name: 'Nowhere', lat: 1, lng: 2 }),
    ).rejects.toThrow(/failed to find or create place/);
  });

  it('adopts an existing unparented admin node instead of duplicating it', async () => {
    // A prior resolution created "Mountain View" with no parent (partial
    // address_components); this one knows the region, so the existing node must
    // be re-parented, not duplicated.
    const harness = makeHarness({ wasNew: true, adoptedAdminId: 'admin:city:mountain view' });

    await harness.service.findOrCreateForGeocode(CONTEXT, {
      name: 'Googleplex',
      lat: 37.4,
      lng: -122.1,
      components: COMPONENTS,
    });

    const adoptions = statementsMatching(harness, 'parent_place_id IS NULL');
    expect(adoptions.length).toBeGreaterThan(0);
    // The venue hangs under the adopted city node.
    const parentLink = statementsMatching(harness, 'SET parent_place_id = $3');
    expect(parentLink[0].params?.[2]).toBe('admin:city:mountain view');
  });

  it('skips hierarchy quietly when no components are available', async () => {
    const harness = makeHarness({ wasNew: true });

    await harness.service.findOrCreateForGeocode(CONTEXT, {
      name: 'Somewhere',
      lat: 1,
      lng: 2,
    });

    expect(statementsMatching(harness, 'COALESCE(parent_place_id,')).toHaveLength(0);
    expect(statementsMatching(harness, 'SET parent_place_id')).toHaveLength(0);
  });
});

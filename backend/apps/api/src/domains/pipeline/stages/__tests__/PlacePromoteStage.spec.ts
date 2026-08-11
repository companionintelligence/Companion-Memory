import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import { databaseAvailability, resolveConnection } from '../../__tests__/harness/pipelineHarness';
import { FORWARD_GEOCODE_PROVIDER_GENERATION } from '../enrich/GeocodeStage';
import {
  LOCATION_TYPE_RADIUS_METRES,
  PLACE_PROMOTION_RULE_GENERATION,
  PLACE_UNCERTAINTY_FLOOR_METRES,
  PROMOTE_PLACE_SOURCE,
  PROMOTE_PLACE_STAGE_ID,
  PROMOTE_PLACE_VERSION,
  PlacePromoteStage,
  placeGroupKey,
  promotePlaceStageVersion,
  radiusForLocationType,
} from '../promote/PlacePromoteStage';

/**
 * `promote.place` — resolved event locations become first-class places.
 *
 * This is the stage `GeocodeStage`'s own documentation asks for by name, and the
 * split it argues for is the first thing asserted here: a better place-dedupe
 * rule must be re-runnable without re-billing the geocoder, which means this
 * stage's version and `enrich.geocode`'s must move independently.
 *
 * Four properties, in the order they matter:
 *
 *  1. **Selection never reads the output.** `ci.events.location_entity_id` and
 *     `ci.entities.location_boundary` are what this stage writes. A predicate
 *     over either would be the one-way ratchet: the row leaves the candidate set
 *     the moment the link exists, so the unparented `address` nodes produced
 *     against a cold geocode cache could never be repaired.
 *  2. **Every id gets exactly one answer, and no non-`done` answer is
 *     anonymous.** `skipped: place_link_not_owned` is the one that earns its
 *     keep — `location_entity_id` has more than one writer.
 *  3. **It costs nothing metered.** The hierarchy comes out of
 *     `ci.geocode_cache` by primary key. A promoter that bills is a promoter
 *     nobody can re-run, which would make the rebuild plan's "re-promote freely"
 *     claim false.
 *  4. **It cannot destroy a human's work.** The footprint write skips any place
 *     whose boundary was not written by this stage, and the link write skips any
 *     event linked by another writer.
 *
 * The last block runs against real Postgres inside a transaction that is ALWAYS
 * rolled back, and SKIPS — never silently passes — when no database is
 * reachable. A fake agrees with whatever SQL it is handed; PostGIS does not.
 */

/* ===================================================================== *
 * Fixtures
 * ===================================================================== */

const USER = '00000000-0000-4000-8000-0000000000aa';

/** Googleplex, and a point ~140 m from it. */
const VENUE = { lat: 37.4224, lng: -122.0841 };
const VENUE_NEARBY = { lat: 37.4234, lng: -122.0851 };

const PLACE_ENTITY_ID = '00000000-0000-4000-8000-00000000cafe';

function eventId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

interface EventRow {
  id: string;
  location_name: string | null;
  lat: number | null;
  lng: number | null;
  location_entity_id: string | null;
  promoted_by: string | null;
  is_deleted: boolean | null;
}

function eventRow(n: number, overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: eventId(n),
    location_name: '1600 Amphitheatre Pkwy, Mountain View, CA',
    lat: VENUE.lat,
    lng: VENUE.lng,
    location_entity_id: null,
    promoted_by: null,
    is_deleted: false,
    ...overrides,
  };
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** One `ci.geocode_cache` row, in the shape the cache lookup selects. */
function cacheRow(queryHash: string, locationType: string | null, withComponents = true) {
  return {
    query_hash: queryHash,
    place_id: 'ChIJ_fixture',
    location_type: locationType,
    components: withComponents
      ? {
          address_components: [
            { long_name: 'Mountain View', types: ['locality'] },
            { long_name: 'California', types: ['administrative_area_level_1'] },
            { long_name: 'United States', types: ['country'] },
          ],
        }
      : null,
  };
}

interface FakeOptions {
  rows?: EventRow[];
  cache?: ReturnType<typeof cacheRow>[];
  /** Throw from the `UPDATE ci.events` link write. */
  failLinkWrite?: boolean;
  /** Throw from the footprint write. */
  failFootprintWrite?: boolean;
  /** Throw from the geocode cache read. */
  failCacheRead?: boolean;
}

/**
 * A `DataSource` that answers each of the stage's four statements by
 * recognising it, and records every call so the test can assert on the SHAPE of
 * the work (one cache lookup, one link write, one footprint write) rather than
 * on a SQL string.
 */
function fakeDataSource(options: FakeOptions = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];

  return {
    calls,
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });

      // Ordered most-specific first. The footprint statement selects
      // `FROM ci.events ev` inside its CTE, so a naive `FROM ci.events` test
      // would claim it for the loader and the write would silently never run.
      if (sql.includes('UPDATE ci.entities e')) {
        if (options.failFootprintWrite === true) {
          throw new Error('footprint write exploded');
        }

        return [];
      }

      if (sql.includes('UPDATE ci.events e')) {
        if (options.failLinkWrite === true) {
          throw new Error('link write exploded');
        }

        return [];
      }

      if (sql.includes('FROM ci.geocode_cache')) {
        if (options.failCacheRead === true) {
          throw new Error('geocode cache unavailable');
        }

        const hashes = params[0] as string[];

        return (options.cache ?? []).filter((row) => hashes.includes(row.query_hash));
      }

      if (sql.includes('FROM ci.events e\n')) {
        const ids = params[0] as string[];

        return (options.rows ?? []).filter((row) => ids.includes(row.id));
      }

      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    }),
  };
}

/** A `PlaceService` that resolves everything to one entity, and counts the calls. */
function fakePlaceService(behaviour?: (name: string) => Promise<{ id: string; created: boolean }>) {
  return {
    findOrCreateForGeocode: jest.fn(async (_ctx: unknown, input: { name: string }) =>
      behaviour != null ? await behaviour(input.name) : { id: PLACE_ENTITY_ID, created: true },
    ),
  };
}

function makeStage(options: FakeOptions = {}, placeService = fakePlaceService()) {
  const dataSource = fakeDataSource(options);
  const stage = new PlacePromoteStage(dataSource as never, placeService as never, makeLogger() as never);

  return { stage, dataSource, placeService };
}

/* ===================================================================== *
 * 1. Selection asks the LEDGER, never the columns this stage writes
 * ===================================================================== */

describe('PlacePromoteStage — the applicability predicate says what a row IS', () => {
  const predicate = PROMOTE_PLACE_SOURCE.predicate ?? '';

  it('never mentions location_entity_id — the column this stage writes', () => {
    // THE HEADLINE REGRESSION. `location_entity_id IS NULL` is the obvious
    // predicate, it works, and it is the ratchet: a place promoted against a
    // COLD geocode cache has no hierarchy at all (place_kind 'address',
    // parent_place_id NULL), and with that predicate warming the cache could
    // never repair a single one of them, because they all have a link.
    expect(predicate).not.toMatch(/location_entity_id/i);
  });

  it('never mentions location_boundary — the other column this stage writes', () => {
    expect(predicate).not.toMatch(/location_boundary/i);
  });

  it('never anti-joins ci.entities, which is the same ratchet wearing a hat', () => {
    expect(predicate).not.toMatch(/ci\.entities/i);
  });

  it('is a clause, not a statement, and does not reach into the ledger', () => {
    // The three checks `StageRegistry.assertApplicabilityPredicate` makes, which
    // fire at the first sweep. Asserting them here fails in the unit suite
    // instead, where the fix is obvious.
    expect(predicate.trim()).not.toMatch(/^and\b/i);
    expect(predicate).not.toContain(';');
    expect(predicate).not.toMatch(/pipeline_state|\bp\./i);
  });

  it('requires BOTH a coordinate and a name, because a place needs both', () => {
    // Narrower than "has coordinates" on purpose: 358 events on the appliance
    // carry a coordinate and 76 carry a name for it. Promoting the other 282 —
    // Uber GPS fixes, geotagged tweets — would mint 282 unnamed Locations that no
    // later stage could tell from a real venue. They arrive on their own the day
    // `enrich.position_reverse` names them, with no change here.
    expect(predicate).toMatch(/location_coordinates IS NOT NULL/i);
    expect(predicate).toMatch(/location_name IS NOT NULL/i);
    expect(predicate).toMatch(/is_deleted/i);
  });

  it('sweeps ci.events keyed by event_id and scoped by user_id', () => {
    expect(PROMOTE_PLACE_SOURCE).toMatchObject({
      schema: 'ci',
      table: 'events',
      idColumn: 'event_id',
      userColumn: 'user_id',
    });
  });
});

/* ===================================================================== *
 * 2. The version is DERIVED, so improving the geocoder re-promotes
 * ===================================================================== */

describe('PlacePromoteStage — the version tracks the geocode provider as well as its own rule', () => {
  it('derives from both generations rather than carrying a hand-chosen integer', () => {
    expect(PROMOTE_PLACE_VERSION).toBe(
      PLACE_PROMOTION_RULE_GENERATION + FORWARD_GEOCODE_PROVIDER_GENERATION - 1,
    );
  });

  it('is an integer >= 1, which versions.ts requires', () => {
    // 0 is reserved: `claim()` writes it and never advances it, so a row
    // abandoned by a SIGKILLed worker stays selectable. A stage at version 0
    // would strand those rows permanently.
    expect(Number.isInteger(PROMOTE_PLACE_VERSION)).toBe(true);
    expect(PROMOTE_PLACE_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('throws when STAGE_VERSIONS disagrees with the derivation', () => {
    expect(() => promotePlaceStageVersion({ [PROMOTE_PLACE_STAGE_ID]: PROMOTE_PLACE_VERSION + 7 })).toThrow(
      /declares .* but the stage derives/,
    );
  });

  it('accepts a missing entry, because this file lands before the wiring does', () => {
    expect(promotePlaceStageVersion({})).toBe(PROMOTE_PLACE_VERSION);
  });

  it('reports the derived version on the instance, never a literal', () => {
    const { stage } = makeStage();

    expect(stage.version).toBe(PROMOTE_PLACE_VERSION);
    expect(stage.id).toBe(PROMOTE_PLACE_STAGE_ID);
  });
});

/* ===================================================================== *
 * 3. run() — one answer per id, and every non-done answer names itself
 * ===================================================================== */

describe('PlacePromoteStage.run — every id gets exactly one answer', () => {
  it('promotes a named, located event and links it to the resolved place', async () => {
    const { stage, placeService } = makeStage({ rows: [eventRow(1)] });

    const results = await stage.run({ userId: USER }, [eventId(1)]);

    expect(results.size).toBe(1);
    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'done',
      detail: { placeEntityId: PLACE_ENTITY_ID },
    });
    expect(placeService.findOrCreateForGeocode).toHaveBeenCalledTimes(1);
  });

  it('answers for ids the load did not return, rather than leaving them silent', async () => {
    // `PipelineSliceListener` records a missing id as
    // `failed: stage_returned_no_result`, which is correct but uninformative and
    // charges an attempt. A row deleted between the sweep and the slice is a
    // skip: nothing to retry, nothing lost.
    const { stage } = makeStage({ rows: [eventRow(1)] });

    const results = await stage.run({ userId: USER }, [eventId(1), eventId(2)]);

    expect(results.size).toBe(2);
    expect(results.get(eventId(2))).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it.each([
    ['event_deleted', { is_deleted: true }],
    ['no_coordinates', { lat: null, lng: null }],
    ['no_location_name', { location_name: '   ' }],
  ])('skips with reason %s', async (reason, overrides) => {
    const { stage, placeService } = makeStage({ rows: [eventRow(1, overrides)] });

    const results = await stage.run({ userId: USER }, [eventId(1)]);

    expect(results.get(eventId(1))).toEqual({ outcome: 'skipped', reason });
    // Decided locally, before any place resolution: a row this stage may not
    // promote never costs a round trip.
    expect(placeService.findOrCreateForGeocode).not.toHaveBeenCalled();
  });

  it('refuses to re-point a link another writer owns', async () => {
    // OWNERSHIP, NOT NULLABILITY. `GeocodeBatchListener` fills
    // `location_entity_id` from the reverse-geocode path and importers can
    // arrive with one resolved. Re-pointing it would let a version bump silently
    // move an event to a place a better-informed writer had already chosen —
    // the failure `types.ts` warns about, where a worse answer destroys a
    // better one.
    const { stage, placeService } = makeStage({
      rows: [eventRow(1, { location_entity_id: '00000000-0000-4000-8000-0000000000ff' })],
    });

    const results = await stage.run({ userId: USER }, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'skipped',
      reason: 'place_link_not_owned',
    });
    expect(placeService.findOrCreateForGeocode).not.toHaveBeenCalled();
  });

  it('DOES re-promote a link it wrote itself, which is what a version bump is for', async () => {
    const { stage } = makeStage({
      rows: [
        eventRow(1, {
          location_entity_id: PLACE_ENTITY_ID,
          promoted_by: PROMOTE_PLACE_STAGE_ID,
        }),
      ],
    });

    const results = await stage.run({ userId: USER }, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'done' });
  });

  it('every non-done result carries a reason, which PipelineStateService enforces', async () => {
    const { stage } = makeStage({
      rows: [eventRow(1), eventRow(2, { is_deleted: true }), eventRow(3, { lat: null })],
    });

    const results = await stage.run({ userId: USER }, [eventId(1), eventId(2), eventId(3), eventId(4)]);

    for (const [id, result] of results) {
      if (result.outcome !== 'done') {
        expect({ id, reason: result.reason }).toMatchObject({ id, reason: expect.any(String) });
        expect(result.reason?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

/* ===================================================================== *
 * 4. Cost — a promoter that bills is a promoter nobody re-runs
 * ===================================================================== */

describe('PlacePromoteStage.run — it reads the geocode cache and never a provider', () => {
  it('takes no geocode service at all, so it structurally cannot bill', () => {
    // The constructor arity IS the assertion: DataSource, PlaceService, Logger.
    // Adding `GeocodeService` here would let a cache miss reach a metered
    // provider on every version bump, and the "re-promote freely" argument in
    // the rebuild plan (§8.4) would stop being true.
    expect(PlacePromoteStage.length).toBe(3);
  });

  it('resolves each DISTINCT place once, however many events share it', async () => {
    // 200 events at five venues are five resolutions. The key mirrors
    // PlaceService's own identity, so this is exact rather than a heuristic.
    const { stage, placeService } = makeStage({
      rows: [eventRow(1), eventRow(2), eventRow(3)],
    });

    await stage.run({ userId: USER }, [eventId(1), eventId(2), eventId(3)]);

    expect(placeService.findOrCreateForGeocode).toHaveBeenCalledTimes(1);
  });

  it('passes the cached place_id and components straight through to the hierarchy', async () => {
    const { stage, placeService, dataSource } = makeStage({
      rows: [eventRow(1)],
      cache: [],
    });

    // Discover the hash the stage looked up, then answer it — proving the key is
    // GeocodeService.hashQuery's and not a re-implementation.
    await stage.run({ userId: USER }, [eventId(1)]);

    const lookup = dataSource.calls.find((call) => call.sql.includes('FROM ci.geocode_cache'));

    expect(lookup).toBeDefined();

    const hash = (lookup!.params[0] as string[])[0];

    const warm = makeStage({ rows: [eventRow(1)], cache: [cacheRow(hash, 'ROOFTOP')] });

    await warm.stage.run({ userId: USER }, [eventId(1)]);

    expect(warm.placeService.findOrCreateForGeocode).toHaveBeenCalledWith(
      { userId: USER },
      expect.objectContaining({
        placeId: 'ChIJ_fixture',
        components: expect.objectContaining({ address_components: expect.any(Array) }),
      }),
    );

    expect(placeService.findOrCreateForGeocode).toHaveBeenCalledWith(
      { userId: USER },
      expect.objectContaining({ placeId: null, components: null }),
    );
  });

  it('promotes WITHOUT a hierarchy on a cold cache, and does not call it a failure', async () => {
    // The honest consequence of never billing: a cold cache means no address
    // components, so the place is an unparented `address` node. That is a `done`
    // at version N whose hierarchy arrives when enrich.geocode has run and
    // PLACE_PROMOTION_RULE_GENERATION is bumped past N.
    const { stage } = makeStage({ rows: [eventRow(1)], cache: [] });

    const results = await stage.run({ userId: USER }, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'done' });
  });

  it('survives an unavailable geocode cache rather than failing the slice', async () => {
    const { stage } = makeStage({ rows: [eventRow(1)], failCacheRead: true });

    const results = await stage.run({ userId: USER }, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'done' });
  });
});

/* ===================================================================== *
 * 5. Failure attribution
 * ===================================================================== */

describe('PlacePromoteStage.run — a failure is attributed, never spread', () => {
  it('fails only the events at the venue that could not be resolved', async () => {
    const stage = makeStage(
      { rows: [eventRow(1), eventRow(2, { location_name: 'Other Venue', lat: 1, lng: 2 })] },
      fakePlaceService(async (name) => {
        if (name === 'Other Venue') {
          throw new Error('unique violation');
        }

        return { id: PLACE_ENTITY_ID, created: false };
      }),
    ).stage;

    const results = await stage.run({ userId: USER }, [eventId(1), eventId(2)]);

    expect(results.get(eventId(1))).toMatchObject({ outcome: 'done' });
    expect(results.get(eventId(2))).toMatchObject({
      outcome: 'failed',
      reason: 'place_resolve_failed',
    });
  });

  it('fails the whole link write together, because one statement has one outcome', async () => {
    const { stage } = makeStage({ rows: [eventRow(1), eventRow(2)], failLinkWrite: true });

    const results = await stage.run({ userId: USER }, [eventId(1), eventId(2)]);

    for (const id of [eventId(1), eventId(2)]) {
      expect(results.get(id)).toMatchObject({
        outcome: 'failed',
        reason: 'place_link_write_failed',
      });
    }
  });

  it('still records done when only the FOOTPRINT write failed', async () => {
    // The link is the promotion; the boundary is enrichment on top of it. Failing
    // the event because a polygon could not be computed would lose a correct
    // place link and charge an attempt for it.
    const { stage } = makeStage({ rows: [eventRow(1)], failFootprintWrite: true });

    const results = await stage.run({ userId: USER }, [eventId(1)]);

    expect(results.get(eventId(1))).toMatchObject({
      outcome: 'done',
      detail: { footprintError: expect.any(String) },
    });
  });
});

/* ===================================================================== *
 * 6. The footprint rule — derived, never invented
 * ===================================================================== */

describe('PlacePromoteStage — the footprint radius', () => {
  it('floors at half a location-dedupe cell, which is a declared system constant', () => {
    // NOT a guess: entities_location_snap_dedup_uniq snaps location_point to a
    // 0.001-degree grid, so this system already treats two coordinates within
    // that cell as the same place. Half the cell in latitude is the greatest
    // distance a contributing coordinate can be from the cell it folded into.
    expect(PLACE_UNCERTAINTY_FLOOR_METRES).toBeCloseTo((0.001 * 111_320) / 2, 5);
  });

  it('contributes NOTHING for an unknown precision class, rather than a default', () => {
    // A middle-of-the-road default would be a number nobody measured outranking
    // the one thing that IS measured — the observations themselves.
    expect(radiusForLocationType(null)).toBe(0);
    expect(radiusForLocationType('SOMETHING_NEW')).toBe(0);
  });

  it('orders the precision classes the way GeocodeService orders its confidences', () => {
    // Rooftop is a building, APPROXIMATE is a city centroid. A footprint that did
    // not say so would render a promoted city centroid as a doorway.
    expect(radiusForLocationType('ROOFTOP')).toBeLessThan(radiusForLocationType('RANGE_INTERPOLATED'));
    expect(radiusForLocationType('RANGE_INTERPOLATED')).toBeLessThan(
      radiusForLocationType('GEOMETRIC_CENTER'),
    );
    expect(radiusForLocationType('GEOMETRIC_CENTER')).toBeLessThan(radiusForLocationType('APPROXIMATE'));
    expect(LOCATION_TYPE_RADIUS_METRES.APPROXIMATE).toBeGreaterThan(PLACE_UNCERTAINTY_FLOOR_METRES);
  });

  it('is case-insensitive, because the provider is not consistent about it', () => {
    expect(radiusForLocationType('rooftop')).toBe(radiusForLocationType('ROOFTOP'));
  });
});

describe('placeGroupKey — grouping is exact, not a heuristic', () => {
  it('collapses two events PlaceService would resolve to the same row', () => {
    // Same name, same 3dp cell — which is the grid the unique index snaps to.
    expect(placeGroupKey('The James Chicago', 41.89314, -87.625685)).toBe(
      placeGroupKey('  the james chicago  ', 41.893142, -87.625681),
    );
  });

  it('keeps two different venues in one cell apart', () => {
    expect(placeGroupKey('Cafe A', VENUE.lat, VENUE.lng)).not.toBe(
      placeGroupKey('Cafe B', VENUE.lat, VENUE.lng),
    );
  });

  it('keeps one name at two different cells apart', () => {
    expect(placeGroupKey('Home', VENUE.lat, VENUE.lng)).not.toBe(
      placeGroupKey('Home', VENUE_NEARBY.lat, VENUE_NEARBY.lng),
    );
  });
});

/* ===================================================================== *
 * 7. Against real Postgres — a fake agrees with whatever SQL it is handed
 * ===================================================================== */

const availability = databaseAvailability();
const describeIfDb = availability.available ? describe : describe.skip;

describeIfDb(`PlacePromoteStage — against real Postgres (${availability.reason})`, () => {
  let dataSource: DataSource;
  let runner: ReturnType<DataSource['createQueryRunner']>;
  let realUserId: string;

  /**
   * Fixture ids under a prefix that sorts ABOVE every real id: the appliance's
   * own ids are uuid v7 and begin `019…`, these begin `fff…`, so a fixture can
   * never be mistaken for real data and the transaction rollback is belt as well
   * as braces.
   */
  const FIXTURE_PREFIX = 'ffffffff-ffff-4fff-bfff-';
  const fixtureId = () => `${FIXTURE_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  /**
   * A fresh coordinate per test, well outside every other test's dedupe cell.
   *
   * `entities_location_snap_dedup_uniq` is UNIQUE on the 0.001-degree snap of
   * `location_point` per user, so two tests placing fixtures at the same venue
   * would collide on a real index — which is the index working, not a bug, and
   * exactly why each test gets its own patch of the South Atlantic.
   */
  let cell = 0;
  const nextPoint = () => {
    cell += 1;

    return { lat: -40 - cell * 0.05, lng: -30 - cell * 0.05 };
  };

  /** The stage, talking to the open transaction rather than the pool. */
  const transactionalDataSource = () => ({
    query: (sql: string, params?: unknown[]) => runner.query(sql, params),
  });

  /**
   * A `PlaceService` stand-in that performs the real INSERT inside the open
   * transaction and returns the id.
   *
   * The real one is covered by `PlaceService.geocode.spec.ts` and needs a
   * repository plus `EventService`; what this suite proves is what THIS stage
   * writes — the event link, the footprint polygon and the provenance — against
   * a real PostGIS, so the place row only has to exist. It is NOT `ON CONFLICT
   * DO NOTHING`: a collision here would mean the test fixtures overlap, and
   * swallowing it would silently turn the assertions into assertions about a
   * different row.
   */
  function insertingPlaceService(entityId: string) {
    return {
      findOrCreateForGeocode: jest.fn(
        async (_ctx: unknown, input: { name: string; lat: number; lng: number }) => {
          const existing = await runner.query(`SELECT entity_id FROM ci.entities WHERE entity_id = $1`, [
            entityId,
          ]);

          if (existing.length === 0) {
            await runner.query(
              `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties,
                                        location_point, place_kind)
               VALUES ($1, 'Location', $2, $3, '{}'::jsonb,
                       ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, 'address')`,
              [entityId, realUserId, input.name, input.lng, input.lat],
            );
          }

          return { id: entityId, created: existing.length === 0 };
        },
      ),
    };
  }

  /** Insert located, named events at `point`, and hand back their ids. */
  async function seedEvents(
    point: { lat: number; lng: number },
    offsets: Array<{ dLat: number; dLng: number }>,
  ): Promise<string[]> {
    const ids = offsets.map(() => fixtureId());

    // An event is a CTI aggregate: the base row in ci.entities owns the title
    // and the FK makes it mandatory. Seeded base-first.
    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties,
                                owner_user_id, linked_table, linked_id)
       SELECT u.id, 'Event', 'promote.place fixture', '{}'::jsonb, $1, 'events', u.id
         FROM unnest($2::uuid[]) AS u(id)`,
      [realUserId, ids],
    );
    await runner.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, source_system, is_deleted,
                              location_name, location_coordinates)
       SELECT u.id, $1, now(), 'spec', false, $2,
              ST_SetSRID(ST_MakePoint(u.lng, u.lat), 4326)::geography
         FROM unnest($3::uuid[], $4::float8[], $5::float8[]) AS u(id, lat, lng)`,
      [
        realUserId,
        `Fixture venue ${cell}`,
        ids,
        offsets.map((offset) => point.lat + offset.dLat),
        offsets.map((offset) => point.lng + offset.dLng),
      ],
    );

    return ids;
  }

  beforeAll(async () => {
    const connection = resolveConnection()!;

    dataSource = new DataSource({
      type: 'postgres',
      // Discrete fields rather than a URL, so a password containing URL
      // metacharacters (the dev one ends in `!`) never has to survive a round
      // trip through percent-encoding.
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      database: connection.database,
      entities: [],
      synchronize: false,
      logging: false,
    });

    await dataSource.initialize();
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    // `ci.events.user_id` FKs `ci.users`, so the fixture has to belong to a real
    // user. Nothing about the user is asserted.
    const users = await runner.query(`SELECT id FROM ci.users LIMIT 1`);
    realUserId = users[0].id;
  });

  afterAll(async () => {
    if (runner != null) {
      // ALWAYS rolled back. This is the user's real personal archive: 324,044
      // events, 170 content rows. Nothing this suite does may survive it.
      await runner.rollbackTransaction();
      await runner.release();
    }

    if (dataSource != null) {
      await dataSource.destroy();
    }
  });

  it('links the events and writes a real geography Polygon around what was observed', async () => {
    const point = nextPoint();
    // ~110 m apart in latitude, which is one dedupe cell.
    const [eventA, eventB] = await seedEvents(point, [
      { dLat: 0, dLng: 0 },
      { dLat: 0.001, dLng: 0 },
    ]);
    const placeEntityId = fixtureId();

    const stage = new PlacePromoteStage(
      transactionalDataSource() as never,
      insertingPlaceService(placeEntityId) as never,
      makeLogger() as never,
    );

    const results = await stage.run({ userId: realUserId }, [eventA, eventB]);

    expect(results.get(eventA)).toMatchObject({ outcome: 'done' });
    expect(results.get(eventB)).toMatchObject({ outcome: 'done' });

    const links = await runner.query(
      `SELECT event_id, location_entity_id, metadata->'promote'->>'stage' AS stage,
              (metadata->'promote'->>'version')::int AS version
         FROM ci.events WHERE event_id = ANY($1::uuid[])`,
      [[eventA, eventB]],
    );

    expect(links).toHaveLength(2);

    for (const link of links) {
      expect(link.location_entity_id).toBe(placeEntityId);
      // The reversibility record: a promoted link is withdrawable by predicate,
      // and the version says which rule produced it.
      expect(link.stage).toBe(PROMOTE_PLACE_STAGE_ID);
      expect(link.version).toBe(PROMOTE_PLACE_VERSION);
    }

    const [place] = await runner.query(
      `SELECT ST_GeometryType(location_boundary::geometry)                 AS gtype,
              ST_Covers(location_boundary,
                        ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) AS covers_observation,
              sqrt(ST_Area(location_boundary) / pi())                      AS effective_radius_m,
              properties->'promote'->>'stage'                              AS stage
         FROM ci.entities WHERE entity_id = $1`,
      [placeEntityId, point.lng, point.lat],
    );

    // `geography(Polygon,4326)` rejects a MultiPolygon outright, so this also
    // proves the buffer of a two-point hull stays a single ring.
    expect(place.gtype).toBe('ST_Polygon');
    expect(place.covers_observation).toBe(true);
    expect(place.stage).toBe(PROMOTE_PLACE_STAGE_ID);

    // Two observations ~110 m apart, buffered by >= 55.66 m, so the footprint is
    // materially larger than the floor a single observation would get — i.e. the
    // polygon is DERIVED from the observations rather than stamped from a
    // constant.
    expect(Number(place.effective_radius_m)).toBeGreaterThan(PLACE_UNCERTAINTY_FLOOR_METRES);
  });

  it('is idempotent: a second run writes the same link and the same footprint', async () => {
    const point = nextPoint();
    const [eventA] = await seedEvents(point, [{ dLat: 0, dLng: 0 }]);
    const placeEntityId = fixtureId();

    const stage = new PlacePromoteStage(
      transactionalDataSource() as never,
      insertingPlaceService(placeEntityId) as never,
      makeLogger() as never,
    );

    await stage.run({ userId: realUserId }, [eventA]);
    const [first] = await runner.query(
      `SELECT ST_AsBinary(location_boundary) AS wkb FROM ci.entities WHERE entity_id = $1`,
      [placeEntityId],
    );

    await stage.run({ userId: realUserId }, [eventA]);
    const [second] = await runner.query(
      `SELECT ST_AsBinary(location_boundary) AS wkb FROM ci.entities WHERE entity_id = $1`,
      [placeEntityId],
    );

    expect(first?.wkb).toBeDefined();
    // Recomputed from the CURRENT links rather than accumulated, so re-running is
    // a no-op instead of a slowly-growing polygon.
    expect(second.wkb).toEqual(first.wkb);
  });

  it('a single observation gets exactly the dedupe-cell floor, and no more', async () => {
    const point = nextPoint();
    const [eventA] = await seedEvents(point, [{ dLat: 0, dLng: 0 }]);
    const placeEntityId = fixtureId();

    const stage = new PlacePromoteStage(
      transactionalDataSource() as never,
      insertingPlaceService(placeEntityId) as never,
      makeLogger() as never,
    );

    await stage.run({ userId: realUserId }, [eventA]);

    const [place] = await runner.query(
      `SELECT sqrt(ST_Area(location_boundary) / pi()) AS effective_radius_m,
              (properties->'promote'->>'boundary_metres')::float8 AS recorded
         FROM ci.entities WHERE entity_id = $1`,
      [placeEntityId],
    );

    // The cold-cache case: no geocode cache row, so no precision class, so the
    // radius is the floor alone. `ST_Buffer` approximates a circle with 8
    // segments per quadrant, so the area is a couple of percent under a true
    // circle — hence the tolerance rather than an equality.
    expect(place.recorded).toBeCloseTo(PLACE_UNCERTAINTY_FLOOR_METRES, 2);
    expect(Number(place.effective_radius_m)).toBeGreaterThan(PLACE_UNCERTAINTY_FLOOR_METRES * 0.95);
    expect(Number(place.effective_radius_m)).toBeLessThan(PLACE_UNCERTAINTY_FLOOR_METRES * 1.05);
  });

  it('never replaces a boundary a human drew', async () => {
    // The read that protects a user, against real Postgres: a Location with a
    // boundary and NO `promote` provenance is somebody's own work, and no
    // version bump of this stage may replace it.
    const point = nextPoint();
    const [event] = await seedEvents(point, [{ dLat: 0, dLng: 0 }]);
    const handDrawnPlace = fixtureId();

    await runner.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties,
                                location_point, location_boundary, place_kind)
       VALUES ($1, 'Location', $2, 'Hand-drawn place', '{}'::jsonb,
               ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
               ST_Buffer(ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, 7)::geography,
               'venue')`,
      [handDrawnPlace, realUserId, point.lng, point.lat],
    );

    const stage = new PlacePromoteStage(
      transactionalDataSource() as never,
      insertingPlaceService(handDrawnPlace) as never,
      makeLogger() as never,
    );

    const results = await stage.run({ userId: realUserId }, [event]);

    // The EVENT is still promoted — the link is correct and useful. Only the
    // footprint is left alone.
    expect(results.get(event)).toMatchObject({ outcome: 'done' });

    const [row] = await runner.query(
      `SELECT sqrt(ST_Area(location_boundary) / pi()) AS effective_radius_m,
              properties ? 'promote'                  AS claimed
         FROM ci.entities WHERE entity_id = $1`,
      [handDrawnPlace],
    );

    expect(Number(row.effective_radius_m)).toBeLessThan(10);
    expect(row.claimed).toBe(false);
  });

  it('makes PlaceService.getVisitStats non-zero, which is the read path that matters', async () => {
    // `PlaceType.visitStats` returns zero for every place on the appliance
    // because 0 of 324,044 events carry a link. This is that query, verbatim from
    // `PlaceService.getVisitStats`, run against what the stage just wrote — the
    // Phase 8 gate as an assertion rather than a claim.
    const point = nextPoint();
    const [eventA, eventB] = await seedEvents(point, [
      { dLat: 0, dLng: 0 },
      { dLat: 0.0002, dLng: 0 },
    ]);
    const placeEntityId = fixtureId();

    const stage = new PlacePromoteStage(
      transactionalDataSource() as never,
      insertingPlaceService(placeEntityId) as never,
      makeLogger() as never,
    );

    await stage.run({ userId: realUserId }, [eventA, eventB]);

    const [stats] = await runner.query(
      `SELECT location_entity_id AS place_id, COUNT(*) AS n,
              MIN(start_time) AS first_at, MAX(start_time) AS last_at
         FROM ci.events
        WHERE user_id = $1 AND location_entity_id = ANY($2::uuid[])
        GROUP BY location_entity_id`,
      [realUserId, [placeEntityId]],
    );

    expect(Number(stats.n)).toBe(2);
    expect(stats.first_at).not.toBeNull();
  });

  it("promotes the appliance's REAL located events, and every id gets a verdict", async () => {
    // One page of the stage's OWN applicability predicate, straight off the
    // user's imported archive. 358 events on this appliance carry a coordinate
    // and 76 carry a name for it; those 76 are what a place list has ever been
    // able to be built from, and `ci.entities` holds 0 Locations today.
    //
    // The PlaceService stand-in dedupes on (name, 3dp cell) exactly as
    // `findOrCreateForGeocode` does, so the real corpus exercises the real
    // grouping instead of collapsing to one row.
    const candidates: Array<{ id: string }> = await runner.query(
      `SELECT s.event_id AS id
         FROM ci.events s
        WHERE s.user_id = $1::uuid
          AND (${PROMOTE_PLACE_SOURCE.predicate})
          AND s.title <> 'promote.place fixture'
        ORDER BY s.event_id
        LIMIT 200`,
      [realUserId],
    );

    if (candidates.length === 0) {
      console.warn('No located, named events in this database; real-corpus promotion not exercised.');

      return;
    }

    const minted = new Map<string, string>();
    const dedupingPlaceService = {
      findOrCreateForGeocode: async (_ctx: unknown, input: { name: string; lat: number; lng: number }) => {
        const key = placeGroupKey(input.name, input.lat, input.lng);
        const known = minted.get(key);

        if (known != null) {
          return { id: known, created: false };
        }

        const entityId = fixtureId();

        // INSERT ... ON CONFLICT DO NOTHING then SELECT BY CELL, which is what
        // the real `findOrCreateForGeocode` does — and it is load-bearing on real
        // data. `entities_location_snap_dedup_uniq` snaps to 0.001 degrees, and
        // the corpus genuinely holds two differently-NAMED locations inside one
        // cell (an Uber pickup and its Google Maps saved place). A stub that
        // assumed its INSERT won would hand the stage an entity id that does not
        // exist, and `events_location_entity_fk` would reject the link.
        await runner.query(
          `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, properties,
                                    location_point, place_kind)
           VALUES ($1, 'Location', $2, $3, '{}'::jsonb,
                   ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, 'address')
           ON CONFLICT DO NOTHING`,
          [entityId, realUserId, input.name, input.lng, input.lat],
        );

        const [canonical] = await runner.query(
          `SELECT entity_id FROM ci.entities
            WHERE entity_type = 'Location'
              AND owner_user_id = $1
              AND location_point IS NOT NULL
              AND ST_SnapToGrid(location_point::geometry, 0.001) =
                  ST_SnapToGrid(ST_SetSRID(ST_MakePoint($2, $3), 4326), 0.001)
            LIMIT 1`,
          [realUserId, input.lng, input.lat],
        );

        minted.set(key, canonical.entity_id);

        return { id: canonical.entity_id, created: canonical.entity_id === entityId };
      },
    };

    const ids = candidates.map((row) => row.id);
    const stage = new PlacePromoteStage(
      transactionalDataSource() as never,
      dedupingPlaceService as never,
      makeLogger() as never,
    );

    const results = await stage.run({ userId: realUserId }, ids);

    // THE CONTRACT: one answer per id, no silences.
    expect(results.size).toBe(ids.length);

    const tally = new Map<string, number>();

    for (const id of ids) {
      const result = results.get(id)!;
      const key = result.outcome === 'done' ? 'done' : `${result.outcome}:${result.reason}`;

      tally.set(key, (tally.get(key) ?? 0) + 1);

      if (result.outcome !== 'done') {
        expect(result.reason?.length ?? 0).toBeGreaterThan(0);
      }
    }

    console.log('promote.place over real data:', Object.fromEntries(tally), {
      distinctPlaces: minted.size,
    });

    const [linked] = await runner.query(
      `SELECT count(*)::int AS n FROM ci.events
        WHERE user_id = $1 AND event_id = ANY($2::uuid[]) AND location_entity_id IS NOT NULL`,
      [realUserId, ids],
    );

    expect(linked.n).toBe(tally.get('done') ?? 0);
    expect(linked.n).toBeGreaterThan(0);

    // Every place the run touched carries a real polygon, not a NULL that a read
    // path would have to special-case.
    const [places] = await runner.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE location_boundary IS NOT NULL)::int AS with_boundary
         FROM ci.entities
        WHERE owner_user_id = $1 AND entity_type = 'Location' AND entity_id = ANY($2::uuid[])`,
      [realUserId, [...minted.values()]],
    );

    expect(places.n).toBeGreaterThan(0);
    expect(places.with_boundary).toBe(places.n);
  });

  it('reads back through PlaceEntity’s own column mapping, boundary included', async () => {
    // `location_boundary` is mapped by `PlaceEntity` as `boundary` and returned
    // by `PlaceEntity.toEgressType`, which is what `PlaceService.findById` /
    // `findAll` / `findByIds` hand to `PlaceResolver` and `PlaceLoader`. This is
    // the SELECT list those go through, proving the promoted row is legible to
    // the read path rather than merely present in the table.
    const point = nextPoint();
    const [event] = await seedEvents(point, [{ dLat: 0, dLng: 0 }]);
    const placeEntityId = fixtureId();

    const stage = new PlacePromoteStage(
      transactionalDataSource() as never,
      insertingPlaceService(placeEntityId) as never,
      makeLogger() as never,
    );

    await stage.run({ userId: realUserId }, [event]);

    const [place] = await runner.query(
      `SELECT entity_id, entity_type, name, place_kind, parent_place_id,
              location_point IS NOT NULL    AS has_point,
              location_boundary IS NOT NULL AS has_boundary
         FROM ci.entities
        WHERE entity_type = 'Location' AND owner_user_id = $1 AND entity_id = $2`,
      [realUserId, placeEntityId],
    );

    expect(place).toMatchObject({
      entity_type: 'Location',
      place_kind: 'address',
      has_point: true,
      has_boundary: true,
    });
  });
});

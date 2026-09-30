import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PipelineStateService } from '../../services/PipelineStateService';
import {
  ENRICH_ESTIMATE_LOCATION_STAGE_ID,
  ESTIMATE_LOCATION_VERSION,
  EstimateLocationStage,
} from '../enrich/EstimateLocationStage';
import { GEOCODE_SOURCE } from '../enrich/GeocodeStage';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AN EVENT THAT NAMES ITS OWN LOCATION IS NEVER PINNED TO A NEIGHBOUR'S.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `enrich.estimate_location` v1 declined only a row with a REAL coordinate. A
 * calendar event whose own `location_name` had not been geocoded — geocoding not
 * configured on the reference appliance — has no coordinate, so it was filled
 * from the nearest GPS fix: 12 events, among them "Flight to Taipei" at
 * "Bangkok BKK", landed on the user's home, `promote.place` linked them to the
 * home Location, and Places → Known places labelled home "Taipei TPE".
 *
 * v2 records such a row as `skipped: has_location_name`. What only a real
 * database can show, and a stubbed `query` would agree with unconditionally:
 *
 *  1. the rule is a recorded per-row decision, not a sweep filter — the stage's
 *     applicability predicate still OFFERS named rows, against real `ci.events`;
 *  2. the named row stays unlocated while an unnamed twin beside it, with the
 *     same donor in the same window, IS estimated — so the name, and nothing
 *     else, is what changed the answer;
 *  3. the rows it declines are exactly the rows `GEOCODE_SOURCE.predicate`
 *     claims, evaluated by Postgres (`btrim`, not JS `trim`);
 *  4. a name written between the stage's load and its write still wins;
 *  5. the ledger records the skip at the current version, so the next sweep
 *     leaves it alone and a bump re-offers it.
 *
 * Opt-in like its neighbours: set `PIPELINE_TEST_DATABASE_URL` (or the
 * `DATABASE_*` variables) to a database with the migrations applied. Every
 * fixture belongs to a synthetic user and is deleted in `afterAll`; the donor
 * lookups are user-scoped, so nothing else in the database can lend a fixture a
 * coordinate.
 *
 *   PIPELINE_TEST_DATABASE_URL=postgres://… yarn workspace @ci/be-api jest EstimateLocationStage.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/EstimateLocationStage.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

/** The user's home, where the phone was that morning. */
const HOME = { lat: 34.0537, lng: -118.2428 };
/** Where a named event with a real coordinate actually was. */
const VENUE = { lat: 34.0094, lng: -118.4973 };

/** The GPS fix every fixture is within the 24-hour window of. */
const DONOR_AT = '2025-06-01T15:00:00Z';

const minutesAfterDonor = (minutes: number): string =>
  new Date(Date.parse(DONOR_AT) + minutes * 60_000).toISOString();

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describeWithDb(`enrich.estimate_location v2 against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;

  const ctx = { userId: uuidv7() } as UserServiceContext;

  const ids = {
    /** "Bangkok BKK", no coordinate: the v1 defect. */
    named: uuidv7(),
    /** The same moment, no name: the control that proves the donor was there. */
    unnamed: uuidv7(),
    /** A name of nothing but spaces is not a location (btrim → ''). */
    blankName: uuidv7(),
    /** Named, still carrying the estimate v1 wrote onto it. */
    namedWithV1Estimate: uuidv7(),
    /** Named AND a real coordinate: keeps its more fundamental reason. */
    namedWithRealCoordinate: uuidv7(),
    /** Unnamed when loaded, named by the time the write runs. */
    namedMidFlight: uuidv7(),
  };

  const stage = () => new EstimateLocationStage(dataSource, makeLogger() as never);

  async function seedEvent(
    eventId: string,
    args: {
      at: string;
      title: string;
      locationName: string | null;
      point?: { lat: number; lng: number };
      metadata?: Record<string, unknown>;
      sourceSystem?: string;
    },
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
      [eventId, args.title, ctx.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events
         (event_id, user_id, start_time, source_type, source_system, source_id, location_name,
          location_coordinates, metadata)
       VALUES ($1::uuid, $2, $3, 'ci.import', $4, $1::text, $5,
               CASE WHEN $6::float8 IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_MakePoint($7::float8, $6::float8), 4326)::geography END,
               $8::jsonb)`,
      [
        eventId,
        ctx.userId,
        args.at,
        args.sourceSystem ?? 'calendar',
        args.locationName,
        args.point?.lat ?? null,
        args.point?.lng ?? null,
        JSON.stringify(args.metadata ?? {}),
      ],
    );
  }

  async function eventRow(eventId: string): Promise<{
    lat: number | null;
    lng: number | null;
    location_source: string | null;
    is_inferred: boolean;
  }> {
    const [row] = await dataSource.query(
      `SELECT ST_Y(location_coordinates::geometry) AS lat,
              ST_X(location_coordinates::geometry) AS lng,
              metadata->>'location_source'       AS location_source,
              is_inferred
         FROM ci.events
        WHERE event_id = $1`,
      [eventId],
    );

    return row;
  }

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'pipeline/EstimateLocationStage.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, timezone) VALUES ($1, $2, $3, 'America/Los_Angeles')`,
      [ctx.userId, 'Estimate location spec fixture', `estimate.${ctx.userId}@example.invalid`],
    );

    // The only donor any fixture can reach: a GPS fix at home.
    await dataSource.query(
      `INSERT INTO ci.position (id, time, user_id, location, accuracy_meters, source)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, 12, 'gps')`,
      [uuidv7(), DONOR_AT, ctx.userId, HOME.lng, HOME.lat],
    );

    await seedEvent(ids.named, {
      at: minutesAfterDonor(10),
      title: 'Flight to Taipei',
      locationName: 'Bangkok BKK',
    });
    await seedEvent(ids.unnamed, { at: minutesAfterDonor(10), title: 'Gym', locationName: null });
    await seedEvent(ids.blankName, { at: minutesAfterDonor(20), title: 'Call', locationName: '   ' });
    await seedEvent(ids.namedWithV1Estimate, {
      at: minutesAfterDonor(30),
      title: 'Meeting',
      locationName: 'Conference Center, 100 Main St',
      point: HOME,
      metadata: { location_source: 'estimated' },
    });
    await seedEvent(ids.namedWithRealCoordinate, {
      at: minutesAfterDonor(40),
      title: 'Coffee',
      locationName: 'Blue Bottle Coffee',
      point: VENUE,
      sourceSystem: 'google_maps_places',
    });
    await seedEvent(ids.namedMidFlight, { at: minutesAfterDonor(50), title: 'Lunch', locationName: null });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.pipeline_state WHERE entity_id = ANY($1::uuid[])', [
        Object.values(ids),
      ]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.position WHERE user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('still OFFERS named events — the rule is a recorded decision, not a sweep filter', async () => {
    // Also the proof that the interpolated applicability predicate is valid SQL
    // over the real ci.events.
    const ledger = new PipelineStateService(dataSource, makeLogger() as never);

    const offered = await ledger.selectStale(stage(), ctx.userId, null, 500);

    expect([...offered].sort()).toEqual(Object.values(ids).sort());
  });

  it('leaves a named event unlocated where an unnamed one beside it is estimated', async () => {
    const results = await stage().run(ctx, [ids.named, ids.unnamed]);

    expect(results.get(ids.named)).toEqual({
      outcome: 'skipped',
      reason: 'has_location_name',
      detail: { locationSource: null },
    });
    expect(await eventRow(ids.named)).toEqual({
      lat: null,
      lng: null,
      location_source: null,
      is_inferred: false,
    });

    // Same instant, same donor, no name: v1's answer, still correct here. So the
    // name — and nothing else — is what kept "Bangkok BKK" off the user's home.
    expect(results.get(ids.unnamed)).toMatchObject({ outcome: 'done', detail: { donor: 'position' } });

    const unnamed = await eventRow(ids.unnamed);
    expect(unnamed.location_source).toBe('estimated');
    expect(Number(unnamed.lat)).toBeCloseTo(HOME.lat, 6);
    expect(Number(unnamed.lng)).toBeCloseTo(HOME.lng, 6);
  });

  it('estimates an event whose name is only whitespace — that is not a location', async () => {
    const results = await stage().run(ctx, [ids.blankName]);

    expect(results.get(ids.blankName)?.outcome).toBe('done');
    expect((await eventRow(ids.blankName)).location_source).toBe('estimated');
  });

  it('declines a named event that still carries a v1 estimate, and does not touch the estimate', async () => {
    const results = await stage().run(ctx, [ids.namedWithV1Estimate]);

    expect(results.get(ids.namedWithV1Estimate)).toEqual({
      outcome: 'skipped',
      reason: 'has_location_name',
      detail: { locationSource: 'estimated' },
    });

    // Withdrawing it is the migration's job, together with promote.place's link.
    const row = await eventRow(ids.namedWithV1Estimate);
    expect(row.location_source).toBe('estimated');
    expect(Number(row.lat)).toBeCloseTo(HOME.lat, 6);
  });

  it('keeps `has_own_location` for a named event with a real coordinate', async () => {
    const results = await stage().run(ctx, [ids.namedWithRealCoordinate]);

    expect(results.get(ids.namedWithRealCoordinate)).toMatchObject({
      outcome: 'skipped',
      reason: 'has_own_location',
    });
    expect(Number((await eventRow(ids.namedWithRealCoordinate)).lat)).toBeCloseTo(VENUE.lat, 6);
  });

  it('declines exactly the rows enrich.geocode claims, among those with no real coordinate', async () => {
    // One partition, two stages: every row the estimator hands to the geocoder
    // must be one the geocoder's sweep actually selects, or it is stranded
    // between them. Postgres decides both sides.
    const withoutRealCoordinate = [
      ids.named,
      ids.unnamed,
      ids.blankName,
      ids.namedWithV1Estimate,
      ids.namedMidFlight,
    ];

    const geocodable: Array<{ event_id: string }> = await dataSource.query(
      `SELECT s.event_id FROM ci.events s
        WHERE s.event_id = ANY($1::uuid[]) AND (${GEOCODE_SOURCE.predicate})`,
      [withoutRealCoordinate],
    );

    // The real stage over a view of the database whose write is a no-op, so
    // the other tests' fixtures stay as they are.
    const readOnly = {
      query: (sql: string, params?: unknown[]) =>
        /^\s*WITH estimated AS/i.test(sql) ? Promise.resolve([]) : dataSource.query(sql, params),
    };
    const results = await new EstimateLocationStage(readOnly as never, makeLogger() as never).run(
      ctx,
      withoutRealCoordinate,
    );

    const declined = withoutRealCoordinate.filter((id) => results.get(id)?.reason === 'has_location_name');

    expect([...declined].sort()).toEqual(geocodable.map((row) => row.event_id).sort());
    expect([...declined].sort()).toEqual([ids.named, ids.namedWithV1Estimate].sort());
  });

  it('lets a name written between the load and the write win', async () => {
    // The load saw no name; a writer names the event before the UPDATE runs.
    // The statement re-checks, so the estimate is not written. It is reported
    // as `no_donor_in_window` — the shared reason the stage documents for a row
    // its write guards excluded, rather than a second round trip to tell apart.
    const racing = {
      query: async (sql: string, params?: unknown[]) => {
        if (/^\s*WITH estimated AS/i.test(sql)) {
          await dataSource.query(`UPDATE ci.events SET location_name = 'Din Tai Fung' WHERE event_id = $1`, [
            ids.namedMidFlight,
          ]);
        }

        return dataSource.query(sql, params);
      },
    };

    const results = await new EstimateLocationStage(racing as never, makeLogger() as never).run(ctx, [
      ids.namedMidFlight,
    ]);

    expect(results.get(ids.namedMidFlight)).toEqual({ outcome: 'skipped', reason: 'no_donor_in_window' });
    expect(await eventRow(ids.namedMidFlight)).toMatchObject({ lat: null, location_source: null });
  });

  it('records the skip at the current version: the next sweep passes over it, a bump re-offers it', async () => {
    const real = stage();
    const ledger = new PipelineStateService(dataSource, makeLogger() as never);

    const claimed = await ledger.claim(real, 'event', [ids.named], ctx.userId);
    await ledger.complete(real, 'event', await real.run(ctx, claimed));

    const [row] = await dataSource.query(
      `SELECT status, reason, stage_version FROM ci.pipeline_state
        WHERE entity_type = 'event' AND entity_id = $1 AND stage = $2`,
      [ids.named, ENRICH_ESTIMATE_LOCATION_STAGE_ID],
    );
    expect(row).toEqual({
      status: 'skipped',
      reason: 'has_location_name',
      stage_version: ESTIMATE_LOCATION_VERSION,
    });
    // v2 is the generation that introduced the rule; a row decided under v1
    // (stage_version 1) is re-offered to it by THE ONE RULE.
    expect(ESTIMATE_LOCATION_VERSION).toBeGreaterThanOrEqual(2);

    expect(await ledger.selectStale(real, ctx.userId, null, 500)).not.toContain(ids.named);

    const bumped = { ...real, version: real.version + 1 } as unknown as EstimateLocationStage;
    expect(await ledger.selectStale(bumped, ctx.userId, null, 500)).toContain(ids.named);
  });
});

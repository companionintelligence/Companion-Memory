import type { ModuleRef } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { DEAD_EVENT_STATUSES } from '../CalendarEventService';
import { KnownPlacesService } from '../KnownPlacesService';
import type { PlaceService } from '../PlaceService';
import { SELF_ENTITY_PROVISIONER, type SelfEntityProvisioner } from '../selfEntityProvisioner';

/**
 * KnownPlacesService is all raw SQL — five statements over ci.events,
 * ci.entities, ci.users and ci.relationships — and until this file every spec
 * of it mocked `dataSource.query`. That is how #2777 shipped
 * `event.title` (ci.events has no title; it lives on ci.entities.name) with
 * the unit suite green: the Places page lost its Known places card to a
 * `QueryFailedError` that only a real database could raise. Writing this spec
 * against Postgres also found the second defect it pins: a user whose
 * `ci.users.entity_id` is NULL — every user after a from-scratch import, until
 * something self-anchored is ingested — could not confirm any known place.
 * The third is in the WHERE clause as well. A temporal location estimate is a
 * neighbour's coordinate, and it must not count as evidence of a place. The
 * `temporal location estimates` block below pins that. The fourth is its
 * sibling: an event that was deleted, predicted or cancelled, which the
 * `events that did not happen` block pins.
 *
 * Opt-in like the sibling integration specs: set MEMORY_TEST_DATABASE_URL.
 */
const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/KnownPlacesService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

// 2026-08-19 is a Wednesday; the owner is on Los Angeles time (UTC-7 in August).
const WED_2230_PDT = '2026-08-20T05:30:00Z';
const WED_2300_PDT = '2026-08-20T06:00:00Z';
const THU_0100_PDT = '2026-08-20T08:00:00Z';
const WED_1000_PDT = '2026-08-19T17:00:00Z';
const WED_1400_PDT = '2026-08-19T21:00:00Z';
const SAT_1030_PDT = '2026-08-22T17:30:00Z';

/**
 * The same wall-clock time `weeks` weeks later. Home and Work are tagged only
 * on a signal seen in three different weeks, so a fixture that should be
 * tagged spreads its events out this way. Every fixture stays in PDT.
 */
function weeksLater(iso: string, weeks: number): string {
  return new Date(Date.parse(iso) + weeks * 7 * 86_400_000).toISOString();
}

const HOME = { lat: 34.0522, lng: -118.2437 };
const OFFICE = { lat: 34.0195, lng: -118.4912 };
const ELSEWHERE = { lat: 40.7128, lng: -74.006 };

// The traveller's week. Friday night ends in a red-eye into LAX, the kind of
// night the estimator fills from a handful of airport GPS fixes.
const WED_2100_PDT = '2026-08-20T04:00:00Z';
const FRI_2340_PDT = '2026-08-22T06:40:00Z';
const SAT_0000_PDT = '2026-08-22T07:00:00Z';
const SAT_0352_PDT = '2026-08-22T10:52:00Z';
const SAT_0430_PDT = '2026-08-22T11:30:00Z';
const SAT_0504_PDT = '2026-08-22T12:04:00Z';
const SAT_1100_PDT = '2026-08-22T18:00:00Z';
const SAT_1400_PDT = '2026-08-22T21:00:00Z';
const SUN_1000_PDT = '2026-08-23T17:00:00Z';
const SUN_1200_PDT = '2026-08-23T19:00:00Z';
const SUN_1800_PDT = '2026-08-24T01:00:00Z';
const THU_0200_PDT = '2026-08-20T09:00:00Z';

const TRAVELLER_HOME = { lat: 34.1478, lng: -118.1445 };
const AIRPORT = { lat: 33.9416, lng: -118.4085 };
const LIBRARY = { lat: 34.0503, lng: -118.2551 };
const OVERLOOK = { lat: 34.0934, lng: -118.6015 };
const TRAILHEAD = { lat: 34.1184, lng: -118.3004 };

// The diarist's weeks: Wednesday evening classes, a weekend of photos, and
// the week after.
const THU_1000_PDT = '2026-08-20T17:00:00Z';
const THU_2200_PDT = '2026-08-21T05:00:00Z';
const FRI_1930_PDT = '2026-08-22T02:30:00Z';
const FRI_2200_PDT = '2026-08-22T05:00:00Z';
const SAT_0700_PDT = '2026-08-22T14:00:00Z';
const SAT_2200_PDT = '2026-08-23T05:00:00Z';
const SUN_2200_PDT = '2026-08-24T05:00:00Z';
const NEXT_WED_1000_PDT = '2026-08-26T17:00:00Z';
// The three Wednesdays after WED_2100_PDT, at the same 21:00.
const LATER_WEDS_2100_PDT = ['2026-08-27T04:00:00Z', '2026-09-03T04:00:00Z', '2026-09-10T04:00:00Z'];

const STUDIO = { lat: 34.0907, lng: -118.3266 };
const HOTEL = { lat: 34.0118, lng: -118.4172 };
const COWORKING = { lat: 33.9911, lng: -118.4658 };
const DENTIST = { lat: 34.0736, lng: -118.4004 };
const RESERVOIR = { lat: 34.1255, lng: -118.3159 };
const MARKET = { lat: 34.1561, lng: -118.1318 };
const PARK = { lat: 34.1366, lng: -118.2942 };
const TRATTORIA = { lat: 34.0839, lng: -118.3614 };
const NOODLE_BAR = { lat: 34.0617, lng: -118.3008 };

/**
 * The provenance columns (`metadata`, `inference_sources`, `is_inferred`,
 * `confidence_score`) as each writer leaves them. {@link MEASURED} is what the
 * column defaults give.
 */
interface Provenance {
  metadata: Record<string, unknown> | null;
  inferenceSources: Record<string, unknown> | null;
  isInferred: boolean;
  confidence: number;
}

const MEASURED: Provenance = { metadata: {}, inferenceSources: {}, isInferred: false, confidence: 1 };

/**
 * Whether the event still stands: the tombstone, the forecast flag and the
 * status. {@link HAPPENED} is what the column defaults give.
 */
interface Lifecycle {
  isDeleted: boolean;
  isPredicted: boolean | null;
  status: string;
}

const HAPPENED: Lifecycle = { isDeleted: false, isPredicted: false, status: 'confirmed' };

/** What `EstimateLocationStage.writeEstimates` writes: a donor GPS fix copied onto the event. */
function estimatedFromFix(deltaSeconds: number): Provenance {
  return {
    metadata: { location_source: 'estimated' },
    inferenceSources: {
      method: 'temporal_nn',
      donor: 'position',
      donor_id: uuidv7(),
      delta_seconds: deltaSeconds,
      accuracy_meters: 12,
      max_gap_hours: 24,
    },
    isInferred: true,
    confidence: 0.4,
  };
}

/**
 * That estimate after the legacy reverse-geocode leg (`GeocodeBatchListener`,
 * direction `reverse`) has named it. `tagLocationSource` replaces the
 * `location_source` key. `inference_sources` is left alone.
 */
function relabelledByLegacyReverseLeg(deltaSeconds: number): Provenance {
  const estimate = estimatedFromFix(deltaSeconds);

  return { ...estimate, metadata: { location_source: 'reverse_geocoded' } };
}

describeWithDb(`KnownPlacesService against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: KnownPlacesService;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  // Seeded by the `temporal location estimates` and `events that did not
  // happen` blocks; cleaned up here.
  const travellerId = uuidv7();
  const guessesOnlyId = uuidv7();
  const diaristId = uuidv7();
  const neverWentId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const stranger = { userId: strangerId } as UserServiceContext;
  const homeLocationId = uuidv7();

  const createKnownPlaceLocation = jest.fn();
  const provisioner: SelfEntityProvisioner = {
    // What GraphIngestService.ensureSelfEntityForOwner does, reduced to the
    // two writes this service depends on: a self node, and the pointer to it.
    ensureSelfEntityForOwner: jest.fn(async ({ userId }: UserServiceContext) => {
      const id = uuidv7();
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
         VALUES ($1, 'Person', 'Owner', '{"is_self": true}'::jsonb, $2)`,
        [id, userId],
      );
      await dataSource.query(`UPDATE ci.users SET entity_id = $2 WHERE id = $1 AND entity_id IS NULL`, [
        userId,
        id,
      ]);

      return { id, type: 'Person' };
    }),
  };

  async function seedEvent(args: {
    userId: string;
    title: string;
    at: string;
    point: { lat: number; lng: number };
    placeName: string | null;
    locationEntityId?: string;
    provenance?: Provenance;
    lifecycle?: Partial<Lifecycle>;
  }): Promise<void> {
    const eventId = uuidv7();
    const provenance = args.provenance ?? MEASURED;
    const lifecycle = { ...HAPPENED, ...args.lifecycle };
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
      [eventId, args.title, args.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events
         (event_id, user_id, start_time, category, source_type, source_system, source_id,
          location_coordinates, location_name, location_entity_id,
          metadata, inference_sources, is_inferred, confidence_score,
          is_deleted, is_predicted, status)
       VALUES ($1::uuid, $2, $3, 'capture', 'ci.import', 'known_places_spec', $1::text,
               ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $7,
               $8::jsonb, $9::jsonb, $10, $11,
               $12, $13, $14)`,
      [
        eventId,
        args.userId,
        args.at,
        args.point.lng,
        args.point.lat,
        args.placeName,
        args.locationEntityId ?? null,
        provenance.metadata === null ? null : JSON.stringify(provenance.metadata),
        provenance.inferenceSources === null ? null : JSON.stringify(provenance.inferenceSources),
        provenance.isInferred,
        provenance.confidence,
        lifecycle.isDeleted,
        lifecycle.isPredicted,
        lifecycle.status,
      ],
    );
  }

  async function activeLivesIn(
    userId: string,
  ): Promise<Array<{ relationship_id: string; to_entity_id: string }>> {
    return dataSource.query(
      `SELECT r.relationship_id, r.to_entity_id
         FROM ci.relationships r
         JOIN ci.users u ON u.entity_id = r.from_entity_id
        WHERE u.id = $1 AND r.relationship_type = 'LIVES_IN' AND r.is_active`,
      [userId],
    );
  }

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });

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
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/KnownPlacesService.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email, timezone) VALUES
         ($1, 'Owner known-places fixture', $2, 'America/Los_Angeles'),
         ($3, 'Stranger known-places fixture', $4, 'UTC')`,
      [ownerId, `owner.${ownerId}@example.invalid`, strangerId, `stranger.${strangerId}@example.invalid`],
    );
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, 'Location', 'Home base', '{}'::jsonb, $2)`,
      [homeLocationId, ownerId],
    );

    // One night in each of three weeks ("Movie night" runs past midnight),
    // and a weekend morning.
    for (const [title, at] of [
      ['Dinner at home', WED_2230_PDT],
      ['Late call', weeksLater(WED_2300_PDT, 1)],
      ['Movie night', weeksLater(THU_0100_PDT, 2)],
      ['Saturday brunch', SAT_1030_PDT],
    ]) {
      await seedEvent({
        userId: ownerId,
        title,
        at,
        point: HOME,
        placeName: 'Home base',
        locationEntityId: homeLocationId,
      });
    }

    // A weekday in each of three weeks.
    for (const [title, at] of [
      ['Standup', WED_1000_PDT],
      ['Design review', weeksLater(WED_1400_PDT, 1)],
      ['Planning', weeksLater(WED_1000_PDT, 2)],
    ]) {
      await seedEvent({ userId: ownerId, title, at, point: OFFICE, placeName: 'Office' });
    }

    await seedEvent({
      userId: strangerId,
      title: "Stranger's dinner",
      at: WED_2300_PDT,
      point: ELSEWHERE,
      placeName: 'Elsewhere',
    });

    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as LoggerService;
    const moduleRef = {
      get: jest.fn((token: unknown) => {
        if (token !== SELF_ENTITY_PROVISIONER) {
          throw new Error(`unexpected token ${String(token)}`);
        }

        return provisioner;
      }),
    } as unknown as ModuleRef;

    service = new KnownPlacesService(
      dataSource,
      logger,
      { createKnownPlaceLocation } as unknown as PlaceService,
      moduleRef,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      const users = [ownerId, strangerId, travellerId, guessesOnlyId, diaristId, neverWentId];
      await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it("builds Home and Work candidates from the owner's located events, titled from ci.entities", async () => {
    const candidates = await service.buildKnownPlaces(owner);

    expect(candidates.map((c) => [c.kind, c.label, c.eventCount, c.locationId])).toEqual([
      ['home', 'Home base', 4, homeLocationId],
      ['work', 'Office', 3, null],
    ]);
    // The title join #2777 broke: every sample reads its event's own name,
    // never the "Untitled event" fallback a NULL title would produce.
    expect(candidates[0].sampleEvents.map((e) => e.title).sort()).toEqual([
      'Dinner at home',
      'Late call',
      'Movie night',
      'Saturday brunch',
    ]);
    expect(candidates[1].sampleEvents.map((e) => e.title).sort()).toEqual([
      'Design review',
      'Planning',
      'Standup',
    ]);
  });

  describe('Home and Work on evidence that recurs over weeks', () => {
    // A user with a routine, and one with the reference corpus's shape: a
    // handful of rides, none of them recurring.
    const settledId = uuidv7();
    const drifterId = uuidv7();
    const settledHomeId = uuidv7();
    const settled = { userId: settledId } as UserServiceContext;
    const drifter = { userId: drifterId } as UserServiceContext;

    // Sunday 23:30 in Los Angeles is 06:30 Monday in UTC: not night at all on
    // a UTC clock, and a different day and week.
    const SUN_2330_PDT = '2026-08-24T06:30:00Z';
    const SAT_1300_PDT = '2026-08-22T20:00:00Z';
    const THU_2230_PDT = '2026-08-21T05:30:00Z';
    const PICKUP = { lat: 37.7749, lng: -122.4194 };
    const TERMINAL = { lat: 33.6762, lng: -117.8675 };
    const CONFERENCE_HOTEL = { lat: 42.3601, lng: -71.0942 };

    beforeAll(async () => {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, timezone) VALUES
           ($1, 'Settled known-places fixture', $2, 'America/Los_Angeles'),
           ($3, 'Drifter known-places fixture', $4, 'America/Los_Angeles')`,
        [
          settledId,
          `settled.${settledId}@example.invalid`,
          drifterId,
          `drifter.${drifterId}@example.invalid`,
        ],
      );
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
         VALUES ($1, 'Location', 'Home', '{}'::jsonb, $2)`,
        [settledHomeId, settledId],
      );

      // Home: a Sunday night in each of three weeks, and a Saturday lunch.
      // Three of its four events are at night, a share of 0.75.
      for (const [title, at] of [
        ['Sunday night in', SUN_2330_PDT],
        ['Sunday night in', weeksLater(SUN_2330_PDT, 1)],
        ['Sunday night in', weeksLater(SUN_2330_PDT, 2)],
        ['Saturday lunch', SAT_1300_PDT],
      ]) {
        await seedEvent({
          userId: settledId,
          title,
          at,
          point: HOME,
          placeName: 'Home',
          locationEntityId: settledHomeId,
        });
      }

      // One late pickup across town: a night share of 1.0, on one event.
      // The old rule made this Home.
      await seedEvent({
        userId: settledId,
        title: 'Late pickup',
        at: WED_2300_PDT,
        point: PICKUP,
        placeName: 'Pickup',
      });

      // The drifter's version of the same pickup, three weekday rides from an
      // airport on two trips, and two nights of a conference in a single week.
      await seedEvent({
        userId: drifterId,
        title: 'Late pickup',
        at: WED_2300_PDT,
        point: PICKUP,
        placeName: 'Pickup',
      });

      for (const at of [WED_1000_PDT, WED_1400_PDT, weeksLater(WED_1400_PDT, 1)]) {
        await seedEvent({
          userId: drifterId,
          title: 'Airport pickup',
          at,
          point: TERMINAL,
          placeName: 'Terminal',
        });
      }

      for (const at of [WED_2230_PDT, THU_2230_PDT]) {
        await seedEvent({
          userId: drifterId,
          title: 'Hotel',
          at,
          point: CONFERENCE_HOTEL,
          placeName: 'Conference hotel',
        });
      }
    });

    afterAll(async () => {
      const users = [settledId, drifterId];
      await dataSource.query('DELETE FROM ci.events WHERE user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);
    });

    it("tags the home whose nights recur on the owner's clock, not a single later night elsewhere", async () => {
      const candidates = await service.buildKnownPlaces(settled);

      expect(candidates.map((c) => [c.kind, c.label, c.eventCount, c.locationId])).toEqual([
        ['home', 'Home', 4, settledHomeId],
        ['other', 'Pickup', 1, null],
      ]);
    });

    it('tags no Home and no Work when nothing recurs across three weeks', async () => {
      const candidates = await service.buildKnownPlaces(drifter);

      expect(candidates.map((c) => [c.kind, c.label, c.eventCount])).toEqual([
        ['other', 'Terminal', 3],
        ['other', 'Conference hotel', 2],
        ['other', 'Pickup', 1],
      ]);
    });
  });

  it("never reads another user's events", async () => {
    const candidates = await service.buildKnownPlaces(stranger);

    expect(candidates.map((c) => c.label)).toEqual(['Elsewhere']);
  });

  it('confirms Home for a user with no self entity yet, provisioning one', async () => {
    const [{ entity_id: before }] = await dataSource.query(`SELECT entity_id FROM ci.users WHERE id = $1`, [
      ownerId,
    ]);
    expect(before).toBeNull();

    const place = await service.updateKnownPlace(owner, {
      label: 'Home',
      kind: 'home',
      locationId: homeLocationId,
      coordinates: HOME,
      confidence: 0.8,
      source: 'inferred',
    });

    expect(provisioner.ensureSelfEntityForOwner).toHaveBeenCalledTimes(1);
    expect(place).toMatchObject({
      kind: 'home',
      locationId: homeLocationId,
      label: 'Home base',
      coordinates: HOME,
      confidence: 0.8,
      source: 'inferred',
    });
    expect(await service.getKnownPlaces(owner, 'home')).toEqual([place]);
    expect(await service.getKnownPlaces(owner, 'work')).toEqual([]);
    expect(await activeLivesIn(ownerId)).toEqual([
      { relationship_id: place.id, to_entity_id: homeLocationId },
    ]);
  });

  it('re-confirming Home updates the same relationship instead of minting a second place', async () => {
    const [first] = await service.getKnownPlaces(owner, 'home');

    const place = await service.updateKnownPlace(owner, {
      label: 'My place',
      kind: 'home',
      coordinates: { lat: HOME.lat + 0.001, lng: HOME.lng },
      confidence: 0.95,
    });

    expect(place.id).toBe(first.id);
    expect(place.confidence).toBe(0.95);
    expect(createKnownPlaceLocation).not.toHaveBeenCalled();
    // The self entity now exists, so it is read, not provisioned again.
    expect(provisioner.ensureSelfEntityForOwner).toHaveBeenCalledTimes(1);
    expect(await activeLivesIn(ownerId)).toHaveLength(1);
  });

  it("does not show the owner's known places to anyone else", async () => {
    expect(await service.getKnownPlaces(stranger)).toEqual([]);
  });

  /**
   * `enrich.estimate_location` copies the nearest GPS fix or located event
   * within 24 h onto an event that has no location. On the reference corpus,
   * after a full sweep, those copies were 2,007 of 2,098 located events. They
   * made up most of every one of the top 15 candidates, and they gave Home to a
   * night of airport walking. The traveller below reproduces both effects in
   * miniature, and also covers each writer whose coordinate must still count.
   */
  describe('temporal location estimates', () => {
    const traveller = { userId: travellerId } as UserServiceContext;
    const guessesOnly = { userId: guessesOnlyId } as UserServiceContext;
    const travellerHomeId = uuidv7();
    const airportLocationId = uuidv7();

    beforeAll(async () => {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, timezone) VALUES
           ($1, 'Traveller known-places fixture', $2, 'America/Los_Angeles'),
           ($3, 'Guesses-only known-places fixture', $4, 'America/Los_Angeles')`,
        [
          travellerId,
          `traveller.${travellerId}@example.invalid`,
          guessesOnlyId,
          `guesses.${guessesOnlyId}@example.invalid`,
        ],
      );
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id) VALUES
           ($1, 'Location', 'Home', '{}'::jsonb, $3),
           ($2, 'Location', '1 World Way', '{}'::jsonb, $3)`,
        [travellerHomeId, airportLocationId, travellerId],
      );

      // Home, measured: a night in each of three weeks and a Sunday evening.
      // Only one of the four carries a name, as happens with photos.
      for (const [title, at, placeName] of [
        ['Dinner at home', WED_2230_PDT, 'Home'],
        ['Late call', weeksLater(WED_2300_PDT, 1), null],
        ['Movie night', weeksLater(THU_0100_PDT, 2), null],
        ['Sunday roast', SUN_1800_PDT, null],
      ] as const) {
        await seedEvent({
          userId: travellerId,
          title,
          at,
          point: TRAVELLER_HOME,
          placeName,
          locationEntityId: travellerHomeId,
        });
      }

      // What PR #2800 found: an event that named somewhere else was given the
      // home GPS fix by estimator v1, and `promote.place` then linked it to the
      // home Location. Two of them outvote the single measured name, which is
      // how home came to read "Taipei TPE".
      for (const at of [WED_2100_PDT, THU_0200_PDT]) {
        await seedEvent({
          userId: travellerId,
          title: 'Flight to Bangkok',
          at,
          point: TRAVELLER_HOME,
          placeName: 'Bangkok BKK',
          locationEntityId: travellerHomeId,
          provenance: estimatedFromFix(5_400),
        });
      }

      // The red-eye. Everything close enough in time to the airport fixes is
      // given the airport's coordinate, and all of it happens at night. That
      // includes the daily step summary, which is stamped at midnight.
      for (const [title, at, deltaSeconds] of [
        ['Amazon order — 1 item', FRI_2340_PDT, 15_120],
        ['Activity 2026-08-22 (3,782 steps)', SAT_0000_PDT, 13_920],
        ['Walking', SAT_0352_PDT, 70],
        ['Walking', SAT_0430_PDT, 40],
      ] as const) {
        await seedEvent({
          userId: travellerId,
          title,
          at,
          point: AIRPORT,
          placeName: null,
          provenance: estimatedFromFix(deltaSeconds),
        });
      }

      // One more airport estimate, which the legacy reverse leg has since
      // named, linked to a Location, and relabelled `reverse_geocoded`.
      await seedEvent({
        userId: travellerId,
        title: 'Walking',
        at: SAT_0504_PDT,
        point: AIRPORT,
        placeName: '1 World Way, Los Angeles, CA 90045',
        locationEntityId: airportLocationId,
        provenance: relabelledByLegacyReverseLeg(25),
      });

      // The traveller takes that red-eye week after week, so the airport's
      // nights recur: four of them, in four weeks, a night more than home's
      // three. A single red-eye could not take Home under the weeks rule even if
      // it were counted. A habit could, and that is what the estimate rule has
      // to stop.
      for (const week of [1, 2, 3]) {
        await seedEvent({
          userId: travellerId,
          title: 'Walking',
          at: weeksLater(SAT_0430_PDT, week),
          point: AIRPORT,
          placeName: null,
          provenance: estimatedFromFix(40),
        });
      }

      // Coordinates that ARE the event's own, one per writer, each on a
      // weekend daytime so that none of them carries a home or work signal.
      await seedEvent({
        userId: travellerId,
        title: 'Photo at the overlook',
        at: SAT_1100_PDT,
        point: OVERLOOK,
        placeName: 'Topanga overlook',
        // Photo EXIF, named by `EventReverseStage`: the same token as the
        // relabelled estimate, but no estimator stamp.
        provenance: { ...MEASURED, metadata: { location_source: 'reverse_geocoded' } },
      });
      await seedEvent({
        userId: travellerId,
        title: 'Book club',
        at: SAT_1400_PDT,
        point: LIBRARY,
        placeName: 'Central Library',
        // `GeocodeStage` geocoded the event's own name over an old estimate.
        // It sets the coordinate, the confidence and the token, and leaves
        // `is_inferred` and `inference_sources` as they were.
        provenance: {
          metadata: { location_source: 'geocoded' },
          inferenceSources: estimatedFromFix(3_600).inferenceSources,
          isInferred: true,
          confidence: 0.95,
        },
      });
      await seedEvent({
        userId: travellerId,
        title: 'Morning hike',
        at: SUN_1000_PDT,
        point: TRAILHEAD,
        placeName: 'Trailhead',
        // Both jsonb columns are nullable.
        provenance: { metadata: null, inferenceSources: null, isInferred: false, confidence: 1 },
      });
      await seedEvent({
        userId: travellerId,
        title: 'Lunch in Santa Monica',
        at: SUN_1200_PDT,
        point: OFFICE,
        placeName: 'Santa Monica',
        // A city centroid: as low-confidence as an estimate, but it is where
        // the event said it was.
        provenance: {
          metadata: { location_source: 'approximate' },
          inferenceSources: {},
          isInferred: false,
          confidence: 0.4,
        },
      });

      for (const at of [WED_2230_PDT, WED_2300_PDT, THU_0100_PDT]) {
        await seedEvent({
          userId: guessesOnlyId,
          title: 'Walking',
          at,
          point: AIRPORT,
          placeName: null,
          provenance: estimatedFromFix(600),
        });
      }
    });

    it("counts only the coordinates that are the event's own", async () => {
      // The estimates are really there as located rows. Leaving them out is
      // the rule's doing, not the fixture's.
      expect(
        await dataSource.query(
          `SELECT count(*)::int AS located,
                  count(*) FILTER (WHERE metadata->>'location_source' = 'estimated')::int AS estimated
             FROM ci.events
            WHERE user_id = $1 AND location_coordinates IS NOT NULL`,
          [travellerId],
        ),
      ).toEqual([{ located: 18, estimated: 9 }]);

      const [first, ...rest] = await service.buildKnownPlaces(traveller);
      const tuples = [first, ...rest.sort((a, b) => a.label.localeCompare(b.label))].map((c) => [
        c.kind,
        c.label,
        c.eventCount,
        c.locationId,
      ]);

      expect(tuples).toEqual([
        ['home', 'Home', 4, travellerHomeId],
        ['other', 'Central Library', 1, null],
        ['other', 'Santa Monica', 1, null],
        ['other', 'Topanga overlook', 1, null],
        ['other', 'Trailhead', 1, null],
      ]);
    });

    it('does not let a night of airport estimates take Home from the measured home', async () => {
      const candidates = await service.buildKnownPlaces(traveller);

      expect(candidates.filter((c) => c.kind === 'home').map((c) => c.locationId)).toEqual([travellerHomeId]);
      // Left out, not just outranked: neither the airport's grid cell nor the
      // Location the legacy reverse leg linked is a candidate.
      expect(
        candidates.filter(
          (c) =>
            c.locationId === airportLocationId ||
            (Math.abs(c.lat - AIRPORT.lat) < 0.01 && Math.abs(c.lng - AIRPORT.lng) < 0.01),
        ),
      ).toEqual([]);
    });

    it('does not let estimates linked to a real Location inflate it or rename it', async () => {
      const [home] = await service.buildKnownPlaces(traveller);

      expect(home).toMatchObject({ locationId: travellerHomeId, label: 'Home', eventCount: 4 });
      expect(home.sampleEvents.map((e) => e.title).sort()).toEqual([
        'Dinner at home',
        'Late call',
        'Movie night',
        'Sunday roast',
      ]);
    });

    it('offers no candidates to a user whose only located events are estimates', async () => {
      // So `HomeConfirmService` never asks "is this home?" about a guess.
      expect(await service.buildKnownPlaces(guessesOnly)).toEqual([]);
    });
  });

  /**
   * A deleted event, a predicted one, and one that was cancelled all keep a
   * coordinate that is their own, so the estimate rule lets them through.
   * None of them says the user was there. The reference corpus has none of
   * the three among its located events. It does have five cancelled Takeout
   * reservations, which say so only in `metadata` and have no coordinate yet
   * only because geocoding failed there. So the diarist below is the only
   * place any of this is measured. The deleted, predicted and cancelled
   * groups are each big enough to take Home or Work if they were counted. That
   * means the signal in three weeks, as the weeks rule requires, and a night or
   * an office day more than the real place has. A group any smaller would be
   * kept out by the weeks rule on its own, and the tests would stop saying
   * anything about the clauses that are meant to keep it out.
   */
  describe('events that did not happen', () => {
    const diarist = { userId: diaristId } as UserServiceContext;
    const neverWent = { userId: neverWentId } as UserServiceContext;
    const diaristHomeId = uuidv7();

    beforeAll(async () => {
      await dataSource.query(
        `INSERT INTO ci.users (id, name, email, timezone) VALUES
           ($1, 'Diarist known-places fixture', $2, 'America/Los_Angeles'),
           ($3, 'Never-went known-places fixture', $4, 'America/Los_Angeles')`,
        [
          diaristId,
          `diarist.${diaristId}@example.invalid`,
          neverWentId,
          `never-went.${neverWentId}@example.invalid`,
        ],
      );
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
         VALUES ($1, 'Location', 'Home', '{}'::jsonb, $2)`,
        [diaristHomeId, diaristId],
      );

      // What happened: a night at home in each of three weeks and a weekend
      // morning, and an office day in each of three weeks.
      for (const [title, at] of [
        ['Dinner at home', WED_2230_PDT],
        ['Late call', weeksLater(WED_2300_PDT, 1)],
        ['Movie night', weeksLater(THU_0100_PDT, 2)],
        ['Saturday brunch', SAT_1030_PDT],
      ]) {
        await seedEvent({
          userId: diaristId,
          title,
          at,
          point: HOME,
          placeName: 'Home',
          locationEntityId: diaristHomeId,
        });
      }

      for (const [title, at] of [
        ['Standup', WED_1000_PDT],
        ['Design review', weeksLater(WED_1400_PDT, 1)],
        ['Planning', weeksLater(WED_1000_PDT, 2)],
      ]) {
        await seedEvent({ userId: diaristId, title, at, point: OFFICE, placeName: 'Office' });
      }

      // Deleted: four nights of photos at a hotel, in three weeks, which the
      // user removed from their timeline. One more night than home.
      for (const [title, at] of [
        ['IMG_2041.HEIC', THU_2200_PDT],
        ['IMG_2042.HEIC', FRI_2200_PDT],
        ['IMG_2043.HEIC', weeksLater(SAT_2200_PDT, 1)],
        ['IMG_2044.HEIC', weeksLater(SUN_2200_PDT, 2)],
      ]) {
        await seedEvent({
          userId: diaristId,
          title,
          at,
          point: HOTEL,
          placeName: 'Hotel',
          lifecycle: { isDeleted: true },
        });
      }

      // Predicted: the next four weeks of office hours, forecast at a coworking
      // space. One more office day than the office. No writer produces these
      // today except an account import, which restores rows verbatim, but
      // the flag says what the row is.
      for (const week of [0, 1, 2, 3]) {
        await seedEvent({
          userId: diaristId,
          title: 'Focus time',
          at: weeksLater(NEXT_WED_1000_PDT, week),
          point: COWORKING,
          placeName: 'Coworking space',
          lifecycle: { isPredicted: true },
        });
      }

      // `is_predicted` is nullable. NULL is not a prediction: the column
      // default is false, and every other reader COALESCEs NULL to false.
      await seedEvent({
        userId: diaristId,
        title: 'Farmers market',
        at: SAT_1100_PDT,
        point: MARKET,
        placeName: 'Farmers market',
        lifecycle: { isPredicted: null },
      });

      // Cancelled: an evening class that took place, and the three that
      // followed it, which the studio called off. Google Calendar sync keeps a
      // cancelled event as a row with status 'cancelled' and geocodes its
      // venue like any other. Counted, they would make the studio the user's
      // most-visited night spot.
      const geocoded: Provenance = { ...MEASURED, metadata: { location_source: 'geocoded' } };
      await seedEvent({
        userId: diaristId,
        title: 'Pottery class',
        at: WED_2100_PDT,
        point: STUDIO,
        placeName: 'Pottery studio',
        provenance: geocoded,
      });
      for (const at of LATER_WEDS_2100_PDT) {
        await seedEvent({
          userId: diaristId,
          title: 'Pottery class',
          at,
          point: STUDIO,
          placeName: 'Pottery studio',
          provenance: geocoded,
          lifecycle: { status: 'cancelled' },
        });
      }

      // Cancelled, where `status` cannot say so: Friday dinner, booked at a
      // trattoria, cancelled, and rebooked at a noodle bar. The Google Takeout
      // importer leaves both reservations 'confirmed' and records the
      // cancellation only as `metadata.Canceled`. Each address is geocoded
      // like any other.
      for (const [placeName, point, canceled] of [
        ['Trattoria', TRATTORIA, true],
        ['Noodle bar', NOODLE_BAR, false],
      ] as const) {
        await seedEvent({
          userId: diaristId,
          title: `Reservation — ${placeName}`,
          at: FRI_1930_PDT,
          point,
          placeName,
          provenance: {
            ...MEASURED,
            metadata: { Kind: 'reservation', Canceled: canceled, location_source: 'geocoded' },
          },
        });
      }

      // The rest of the calendar's "did not happen": an appointment the user
      // did not show up to, and a planned run they skipped.
      await seedEvent({
        userId: diaristId,
        title: 'Dentist',
        at: THU_1000_PDT,
        point: DENTIST,
        placeName: 'Dentist',
        lifecycle: { status: 'no_show' },
      });
      await seedEvent({
        userId: diaristId,
        title: 'Run',
        at: SAT_0700_PDT,
        point: RESERVOIR,
        placeName: 'Reservoir loop',
        lifecycle: { status: 'skipped' },
      });

      // An invitation the user has not answered. The calendar still draws a
      // tentative event, so it counts.
      await seedEvent({
        userId: diaristId,
        title: 'Picnic',
        at: SUN_1200_PDT,
        point: PARK,
        placeName: 'Griffith Park',
        lifecycle: { status: 'tentative' },
      });

      // One night of each kind at the same hotel, and nothing that happened.
      for (const lifecycle of [{ isDeleted: true }, { isPredicted: true }, { status: 'cancelled' }]) {
        await seedEvent({
          userId: neverWentId,
          title: 'Night out',
          at: WED_2300_PDT,
          point: HOTEL,
          placeName: 'Hotel',
          lifecycle,
        });
      }

      await seedEvent({
        userId: neverWentId,
        title: 'Reservation — Hotel',
        at: WED_2300_PDT,
        point: HOTEL,
        placeName: 'Hotel',
        provenance: { ...MEASURED, metadata: { Kind: 'reservation', Canceled: true } },
      });
    });

    it('counts only the events that happened', async () => {
      // They are all really there as located rows. Leaving them out is the
      // rule's doing, not the fixture's.
      expect(
        await dataSource.query(
          `SELECT count(*)::int AS located,
                  count(*) FILTER (WHERE is_deleted)::int AS deleted,
                  count(*) FILTER (WHERE is_predicted)::int AS predicted,
                  count(*) FILTER (WHERE status = ANY($2))::int AS did_not_happen,
                  count(*) FILTER (WHERE metadata @> '{"Canceled": true}')::int AS canceled_reservations
             FROM ci.events
            WHERE user_id = $1 AND location_coordinates IS NOT NULL`,
          [diaristId, [...DEAD_EVENT_STATUSES]],
        ),
      ).toEqual([{ located: 25, deleted: 4, predicted: 4, did_not_happen: 5, canceled_reservations: 1 }]);

      const [first, ...rest] = await service.buildKnownPlaces(diarist);
      const tuples = [first, ...rest.sort((a, b) => a.label.localeCompare(b.label))].map((c) => [
        c.kind,
        c.label,
        c.eventCount,
        c.locationId,
      ]);

      expect(tuples).toEqual([
        ['home', 'Home', 4, diaristHomeId],
        ['other', 'Farmers market', 1, null],
        ['other', 'Griffith Park', 1, null],
        ['other', 'Noodle bar', 1, null],
        ['work', 'Office', 3, null],
        ['other', 'Pottery studio', 1, null],
      ]);
    });

    // The test above checks who wins Home and Work. Each test below looks only
    // at its own group's place, so a failure names the clause that broke.

    it('does not count photos the user deleted, or return their titles', async () => {
      const candidates = await service.buildKnownPlaces(diarist);

      expect(candidates.filter((c) => c.label === 'Hotel')).toEqual([]);
      // A tombstoned row is never returned to a client, and `sampleEvents`
      // goes to the Places page.
      expect(
        candidates.flatMap((c) => c.sampleEvents.map((e) => e.title)).filter((t) => t.startsWith('IMG_')),
      ).toEqual([]);
    });

    it('does not count predicted events, but counts one whose is_predicted is NULL', async () => {
      const candidates = await service.buildKnownPlaces(diarist);

      expect(candidates.filter((c) => c.label === 'Coworking space')).toEqual([]);
      expect(candidates.filter((c) => c.label === 'Farmers market').map((c) => c.eventCount)).toEqual([1]);
    });

    it('counts the class that took place, not the three that were called off', async () => {
      const candidates = await service.buildKnownPlaces(diarist);

      expect(candidates.filter((c) => c.label === 'Pottery studio')).toMatchObject([
        { kind: 'other', eventCount: 1 },
      ]);
    });

    it('does not count a reservation whose cancellation only its metadata records', async () => {
      const labels = (await service.buildKnownPlaces(diarist)).map((c) => c.label);

      expect(labels).not.toContain('Trattoria');
      // The key's value decides, not its presence: `Canceled: false` counts.
      expect(labels).toContain('Noodle bar');
    });

    it('treats a no-show and a skipped block as the calendar does, and still counts a tentative event', async () => {
      const labels = (await service.buildKnownPlaces(diarist)).map((c) => c.label);

      expect(labels).not.toContain('Dentist');
      expect(labels).not.toContain('Reservoir loop');
      expect(labels).toContain('Griffith Park');
    });

    it('offers no candidates to a user whose only located events did not happen', async () => {
      // So `HomeConfirmService` never asks "is this home?" about somewhere the
      // user never went.
      expect(await service.buildKnownPlaces(neverWent)).toEqual([]);
    });
  });
});

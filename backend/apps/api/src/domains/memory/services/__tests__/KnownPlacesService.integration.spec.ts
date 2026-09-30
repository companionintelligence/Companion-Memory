import type { ModuleRef } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
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
 * `temporal location estimates` block below pins that.
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
  // Seeded by the `temporal location estimates` block; cleaned up here.
  const travellerId = uuidv7();
  const guessesOnlyId = uuidv7();
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
  }): Promise<void> {
    const eventId = uuidv7();
    const provenance = args.provenance ?? MEASURED;
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
      [eventId, args.title, args.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events
         (event_id, user_id, start_time, category, source_type, source_system, source_id,
          location_coordinates, location_name, location_entity_id,
          metadata, inference_sources, is_inferred, confidence_score)
       VALUES ($1::uuid, $2, $3, 'capture', 'ci.import', 'known_places_spec', $1::text,
               ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $7,
               $8::jsonb, $9::jsonb, $10, $11)`,
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

    for (const [title, at] of [
      ['Dinner at home', WED_2230_PDT],
      ['Late call', WED_2300_PDT],
      ['Movie night', THU_0100_PDT],
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

    for (const [title, at] of [
      ['Standup', WED_1000_PDT],
      ['Design review', WED_1400_PDT],
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
      const users = [ownerId, strangerId, travellerId, guessesOnlyId];
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
      ['home', 'Home base', 3, homeLocationId],
      ['work', 'Office', 2, null],
    ]);
    // The title join #2777 broke: every sample reads its event's own name,
    // never the "Untitled event" fallback a NULL title would produce.
    expect(candidates[0].sampleEvents.map((e) => e.title).sort()).toEqual([
      'Dinner at home',
      'Late call',
      'Movie night',
    ]);
    expect(candidates[1].sampleEvents.map((e) => e.title).sort()).toEqual(['Design review', 'Standup']);
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

      // Home, measured: three nights and a Sunday evening. Only one of the
      // four carries a name, as happens with photos.
      for (const [title, at, placeName] of [
        ['Dinner at home', WED_2230_PDT, 'Home'],
        ['Late call', WED_2300_PDT, null],
        ['Movie night', THU_0100_PDT, null],
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
      ).toEqual([{ located: 15, estimated: 6 }]);

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
});

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

describeWithDb(`KnownPlacesService against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: KnownPlacesService;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
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
    placeName: string;
    locationEntityId?: string;
  }): Promise<void> {
    const eventId = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Event', $2, '{}'::jsonb, $3, 'events', $1)`,
      [eventId, args.title, args.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events
         (event_id, user_id, start_time, category, source_type, source_system, source_id,
          location_coordinates, location_name, location_entity_id)
       VALUES ($1::uuid, $2, $3, 'capture', 'ci.import', 'known_places_spec', $1::text,
               ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $7)`,
      [
        eventId,
        args.userId,
        args.at,
        args.point.lng,
        args.point.lat,
        args.placeName,
        args.locationEntityId ?? null,
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
      const users = [ownerId, strangerId];
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
});

import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { PlaceService } from '../PlaceService';

/**
 * `PlaceService.photosAtNamedPlace` in Postgres: the SQL behind media.findPhotos'
 * "photos from <place>". The unit tests stub it, so only here do the PostGIS
 * tests, the label read and the FileId cast meet a real schema.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a database with
 * the migrations applied; with nothing reachable this suite SKIPS legibly.
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/PlaceService.photosAtNamedPlace.integration] SKIPPED - ${availability.reason}`);
}

jest.setTimeout(60_000);

/** Blue Bottle Coffee, Mint Plaza. */
const CAFE = { lat: 37.7825, lng: -122.4075 };
/** About 20 m north of it. */
const NEAR = { lat: 37.78268, lng: -122.4075 };
/** About 1 km north of it. */
const FAR = { lat: 37.7915, lng: -122.4075 };

describeWithDb(`PlaceService.photosAtNamedPlace, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: PlaceService;
  const owners: string[] = [];

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as LoggerService;

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

    schemaLock = await acquireSchemaWriteLock(
      dataSource,
      'memory/PlaceService.photosAtNamedPlace.integration',
    );

    service = new PlaceService(
      { manager: dataSource.manager } as never,
      { send: async () => [] } as never,
      new GraphDeltaWriter(dataSource, noopLogger),
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.files WHERE user_id = ANY($1::uuid[])', [owners]);
      await dataSource.query('DELETE FROM ci.events WHERE user_id = ANY($1::uuid[])', [owners]);
      await dataSource.query('DELETE FROM ci.relationships WHERE owner_user_id = ANY($1::uuid[])', [owners]);
      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [owners]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [owners]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [owners]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  /** A fresh owner per case, with a self Person so a known-place relationship has a source. */
  const newOwner = async (): Promise<UserServiceContext & { selfId: string }> => {
    const userId = uuidv7();
    const selfId = uuidv7();
    owners.push(userId);

    await dataSource.query(`INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3)`, [
      userId,
      'Photos at a place fixture',
      `photos-at-place.${userId}@example.invalid`,
    ]);
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name) VALUES ($1, 'Person', $2, 'Me')`,
      [selfId, userId],
    );
    await dataSource.query('UPDATE ci.users SET entity_id = $2 WHERE id = $1', [userId, selfId]);

    return { userId, selfId } as UserServiceContext & { selfId: string };
  };

  const place = async (owner: UserServiceContext, name: string, at = CAFE): Promise<string> => {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, location_point)
       VALUES ($1, 'Location', $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography)`,
      [id, owner.userId, name, at.lng, at.lat],
    );

    return id;
  };

  /** An event row and the graph Event entity every event carries (`events_event_id_entities_fk`). */
  const insertEvent = async (
    owner: UserServiceContext,
    at: { lat: number; lng: number },
    takenAt: string,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    const eventId = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, owner_user_id, name, linked_table, linked_id)
       VALUES ($1, 'Event', $2, 'photo', 'events', $1)`,
      [eventId, owner.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.events (event_id, user_id, start_time, category, location_coordinates, metadata)
       VALUES ($1, $2, $3, 'photo', ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6::jsonb)`,
      [eventId, owner.userId, takenAt, at.lng, at.lat, JSON.stringify(metadata)],
    );
  };

  /** An imported photo: an event with a coordinate whose metadata names its file. */
  const photo = async (
    owner: UserServiceContext,
    at: { lat: number; lng: number },
    takenAt: string,
    metadata: Record<string, unknown> = {},
  ): Promise<string> => {
    const fileId = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.files (id, filename, content_type, user_id) VALUES ($1, $2, 'image/jpeg', $3)`,
      [fileId, `${takenAt}.jpg`, owner.userId],
    );
    await insertEvent(owner, at, takenAt, { FileId: fileId, ...metadata });

    return fileId;
  };

  it('returns the photos taken near the named place, newest first, and not the ones far away', async () => {
    const owner = await newOwner();
    await place(owner, 'Blue Bottle Coffee');
    const older = await photo(owner, NEAR, '2026-10-20T09:46:00Z');
    const newer = await photo(owner, CAFE, '2026-10-20T15:54:00Z');
    await photo(owner, FAR, '2026-10-20T12:00:00Z');

    const found = await service.photosAtNamedPlace(owner, 'photos from Blue Bottle Coffee', 25);

    expect(found.places.map((p) => p.name)).toEqual(['Blue Bottle Coffee']);
    expect(found).toMatchObject({ fileIds: [newer, older], total: 2 });
  });

  it('stops at the limit and still counts them all', async () => {
    const owner = await newOwner();
    await place(owner, 'Blue Bottle Coffee');
    const newest = await photo(owner, NEAR, '2026-10-20T12:00:00Z');
    await photo(owner, NEAR, '2026-10-20T11:00:00Z');
    await photo(owner, NEAR, '2026-10-20T10:00:00Z');

    const found = await service.photosAtNamedPlace(owner, 'Blue Bottle Coffee', 1);

    expect(found).toMatchObject({ fileIds: [newest], total: 3 });
  });

  it('finds a place by the label the user gave it on the Places page', async () => {
    const owner = await newOwner();
    const address = await place(owner, '1 Ferry Plaza');
    await dataSource.query(
      `INSERT INTO ci.relationships (relationship_id, owner_user_id, from_entity_id, to_entity_id, relationship_type, properties)
       VALUES ($1, $2, $3, $4, 'VISITED', $5::jsonb)`,
      [uuidv7(), owner.userId, owner.selfId, address, JSON.stringify({ label: 'Blue Bottle Coffee' })],
    );
    const shot = await photo(owner, NEAR, '2026-10-20T10:00:00Z');

    const found = await service.photosAtNamedPlace(owner, 'photos from blue bottle coffee', 25);

    expect(found).toMatchObject({ places: [{ id: address, name: 'Blue Bottle Coffee' }], fileIds: [shot] });
  });

  it('leaves out a photo whose coordinate was only estimated, and survives a FileId that is no uuid', async () => {
    const owner = await newOwner();
    await place(owner, 'Blue Bottle Coffee');
    const measured = await photo(owner, NEAR, '2026-10-20T10:00:00Z');
    await photo(owner, NEAR, '2026-10-20T11:00:00Z', { location_source: 'estimated' });
    await insertEvent(owner, NEAR, '2026-10-20T12:00:00Z', { FileId: 'IMG_0042.HEIC' });

    const found = await service.photosAtNamedPlace(owner, 'Blue Bottle Coffee', 25);

    expect(found).toMatchObject({ fileIds: [measured], total: 1 });
  });

  it("never returns another owner's photo taken at the same spot", async () => {
    const owner = await newOwner();
    const stranger = await newOwner();
    await place(owner, 'Blue Bottle Coffee');
    await photo(stranger, CAFE, '2026-10-20T10:00:00Z');

    const found = await service.photosAtNamedPlace(owner, 'Blue Bottle Coffee', 25);

    expect(found).toMatchObject({ fileIds: [], total: 0 });
  });

  it('names the longer place when one name is part of another', async () => {
    const owner = await newOwner();
    await place(owner, 'Blue Bottle Coffee');
    await place(owner, 'Coffee', FAR);
    const atCafe = await photo(owner, NEAR, '2026-10-20T10:00:00Z');
    await photo(owner, FAR, '2026-10-20T11:00:00Z');

    const found = await service.photosAtNamedPlace(owner, 'Blue Bottle Coffee', 25);

    expect(found.places.map((p) => p.name)).toEqual(['Blue Bottle Coffee']);
    expect(found.fileIds).toEqual([atCafe]);
  });
});

import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { UserEntity } from '@ci/domains/user';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { PlaceEntity } from '../../entities/PlaceEntity';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { PlaceMergeService } from '../PlaceMergeService';
import { PlaceService } from '../PlaceService';

/**
 * A place added by hand next to another, against the real
 * `entities_location_snap_dedup_uniq` index: which place the conflict names,
 * and that a place merged into another stops being offered anywhere.
 *
 * A merged-away place keeps its point, so it still holds its 0.001-degree cell
 * after Places stops listing it. The conflict must name the place it was merged
 * into, not say "another place" with nothing to find. A collision on a
 * different unique index is about the name, not the spot, and says so.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a database with
 * the migrations applied; with nothing reachable this suite SKIPS legibly.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest PlaceService.nearbyConflict.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/PlaceService.nearbyConflict.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

/** [lng, lat] in one 0.001-degree cell, about 35 m apart. */
const SPOT_A = [-122.46045, 37.81045];
const SPOT_B = [-122.4602, 37.8102];
/** Two points 13 m apart on either side of a cell edge (lng -122.4605). */
const CAFE_EAST = [-122.46045, 37.81045];
const CAFE_WEST = [-122.4606, 37.81045];

const point = ([lng, lat]: number[]) => ({ type: 'Point' as const, coordinates: [lng, lat] });

describeWithDb(`PlaceService — a place next to another, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: PlaceService;
  let merger: PlaceMergeService;
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
      entities: [PlaceEntity, UserEntity],
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/PlaceService.nearbyConflict.integration');

    const graphDeltaWriter = new GraphDeltaWriter(dataSource, noopLogger);
    service = new PlaceService(
      dataSource.getRepository(PlaceEntity),
      { send: async () => [] } as never,
      graphDeltaWriter,
    );
    merger = new PlaceMergeService(
      {
        manager: dataSource.manager,
        // The payload's read-back joins the user graph, which is not under test.
        findOne: async () => Object.assign(new PlaceEntity(), { id: uuidv7(), properties: {} }),
      } as never,
      noopLogger,
      { send: async () => [] } as never,
      graphDeltaWriter,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.entity_merges WHERE owner_user_id = ANY($1::uuid[])', [owners]);
      await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [owners]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [owners]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [owners]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  /** A fresh owner per case, so no case finds another's places. */
  const newOwner = async (): Promise<UserServiceContext> => {
    const userId = uuidv7();
    owners.push(userId);

    await dataSource.query(`INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3)`, [
      userId,
      'Place conflict fixture',
      `place-conflict.${userId}@example.invalid`,
    ]);

    return { userId } as UserServiceContext;
  };

  const conflictOf = async (attempt: Promise<unknown>): Promise<unknown> =>
    attempt.then(
      () => null,
      (err) => err,
    );

  it('names the place already in the cell', async () => {
    const owner = await newOwner();
    await service.create(owner, { name: 'Spot A', locationPoint: point(SPOT_A) });

    const err = await conflictOf(service.create(owner, { name: 'Spot B', locationPoint: point(SPOT_B) }));

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/^"Spot A" is already saved at this spot\./);
  });

  it('points at the place a merged-away place was merged into, and offers the merged one nowhere', async () => {
    const owner = await newOwner();
    const [kept] = await service.create(owner, { name: 'Cafe', locationPoint: point(CAFE_EAST) });
    const [merged] = await service.create(owner, { name: 'Cafe (old)', locationPoint: point(CAFE_WEST) });
    await merger.mergePlaces(owner, [merged.id], kept.id);

    const err = await conflictOf(
      service.create(owner, { name: 'Bakery', locationPoint: point([CAFE_WEST[0] - 0.0001, CAFE_WEST[1]]) }),
    );

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/^This spot is held by a place you merged into "Cafe"\./);

    expect((await service.findAll(owner)).map((place) => place.id)).toEqual([kept.id]);
    expect(
      (await service.placesNear(owner, { lat: CAFE_WEST[1], lng: CAFE_WEST[0], radiusMeters: 500 })).map(
        (place) => place.id,
      ),
    ).toEqual([kept.id]);
  });

  it('names the place in the cell when an edit moves another place into it', async () => {
    const owner = await newOwner();
    await service.create(owner, { name: 'Spot A', locationPoint: point(SPOT_A) });
    const [elsewhere] = await service.create(owner, { name: 'Elsewhere', locationPoint: point(CAFE_WEST) });

    const err = await conflictOf(
      service.update(owner, elsewhere.id, { properties: {}, latitude: SPOT_B[1], longitude: SPOT_B[0] }),
    );

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/^"Spot A" is already saved at this spot\./);
  });

  it('says "another place" when the place holding the cell was archived', async () => {
    const owner = await newOwner();
    const [archived] = await service.create(owner, { name: 'Gone', locationPoint: point(SPOT_A) });
    await dataSource.query('UPDATE ci.entities SET is_active = FALSE WHERE entity_id = $1', [archived.id]);

    const err = await conflictOf(service.create(owner, { name: 'Spot B', locationPoint: point(SPOT_B) }));

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/^Another place is already saved at this spot\./);
  });

  it('answers a collision on another index with the name conflict, not the spot one', async () => {
    const owner = await newOwner();
    await service.create(owner, { name: 'Springfield', placeKind: 'city', locationPoint: point(SPOT_A) });

    const err = await conflictOf(
      service.create(owner, { name: 'Springfield', placeKind: 'city', locationPoint: point(CAFE_WEST) }),
    );

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/^A place with that name already exists\./);
  });
});

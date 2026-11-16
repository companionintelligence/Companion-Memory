import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { BaseEntity } from '../../entities/BaseEntity';
import { PlaceEntity } from '../../entities/PlaceEntity';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { PlaceService } from '../PlaceService';

/**
 * `PlaceService.update` and `remove` (the `updatePlace` and `deletePlace` mutations) touch places
 * and nothing else, in Postgres.
 *
 * `PlaceEntity` maps all of `ci.entities`, so an id was the only thing the update matched on. The
 * owner's own Person holds their settings under `properties.planner`, the autonomy dial among them,
 * and `updatePlace` merges free-form `properties`, so an id of that Person let any write-capable
 * caller of the GraphQL plane switch tool approvals off.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`) to a migrated database; with nothing
 * reachable this suite SKIPS legibly.
 */

const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/PlaceService.update.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = (): LoggerService =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

describeWithDb(`PlaceService.update against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let places: PlaceService;

  const ownerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const signalling = { send: jest.fn(async () => []) } as unknown as EventService;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, UserEntity, PlaceEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/PlaceService.update');

    await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'PlaceUpdate', ownerId);

    places = new PlaceService(
      dataSource.getRepository(PlaceEntity),
      signalling,
      new GraphDeltaWriter(dataSource, logger()),
    );
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ownerId]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ownerId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ownerId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  async function insert(
    entityType: string,
    name: string,
    properties: Record<string, unknown>,
  ): Promise<string> {
    const id = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [id, entityType, name, JSON.stringify(properties), ownerId],
    );

    return id;
  }

  async function row(id: string): Promise<{ name: string; properties: Record<string, unknown> }> {
    const [found] = await dataSource.query('SELECT name, properties FROM ci.entities WHERE entity_id = $1', [
      id,
    ]);

    return found;
  }

  it("leaves the owner's own Person alone, settings included, when asked to update it as a place", async () => {
    const self = await insert('Person', 'Robin Vale', { is_self: true, planner: { trust_mode: 'cautious' } });

    const updated = await places.update(owner, self, {
      name: 'Renamed',
      properties: { planner: { trust_mode: 'hands_off' } },
    });

    expect(updated).toBeNull();
    expect(await row(self)).toEqual({
      name: 'Robin Vale',
      properties: { is_self: true, planner: { trust_mode: 'cautious' } },
    });
  });

  it('still updates a place under either spelling the graph holds one in', async () => {
    const geocoded = await insert('Location', 'Chez Panisse', { source: 'geocoder' });
    const remembered = await insert('Place', 'Zuni Café', {});

    expect(
      await places.update(owner, geocoded, { name: 'Chez Panisse Café', properties: { tracked: true } }),
    ).not.toBeNull();
    expect(await places.update(owner, remembered, { properties: { note: 'corner table' } })).not.toBeNull();

    expect(await row(geocoded)).toEqual({
      name: 'Chez Panisse Café',
      properties: { source: 'geocoder', tracked: true },
    });
    expect((await row(remembered)).properties).toEqual({ note: 'corner table' });
  });

  it('removes a place, and leaves a Person alone when asked to remove it as one', async () => {
    const dana = await insert('Person', 'Dana', {});
    const cafe = await insert('Location', 'Chez Panisse', {});

    expect(await places.remove(owner, dana)).toBe(false);
    expect(await row(dana)).toEqual({ name: 'Dana', properties: {} });

    expect(await places.remove(owner, cafe)).toBe(true);
    expect(await row(cafe)).toBeUndefined();
  });

  it('removes a city that same-named cities were merged into, and those duplicates with it', async () => {
    // What two merges leave: the kept city took a region, and each city merged
    // into it is left without one. A live, unparented city of that name came
    // later. The kept city's delete would set the duplicates' merged_into_entity_id
    // to NULL, and each would then share its key with the others and the newer city.
    const region = uuidv7();
    const kept = uuidv7();
    const newer = uuidv7();
    const duplicates = [uuidv7(), uuidv7()];

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, place_kind, parent_place_id)
       VALUES ($1, 'Location', 'Remove Test Region', '{}'::jsonb, $3, 'region', NULL),
              ($2, 'Location', 'Brockway', '{}'::jsonb, $3, 'city', $1),
              ($4, 'Location', 'Brockway', '{}'::jsonb, $3, 'city', NULL)`,
      [region, kept, ownerId, newer],
    );
    for (const duplicate of duplicates) {
      await dataSource.query(
        `INSERT INTO ci.entities
                (entity_id, entity_type, name, properties, owner_user_id, place_kind, merged_into_entity_id, is_active)
         VALUES ($1, 'Location', 'Brockway', '{}'::jsonb, $2, 'city', $3, FALSE)`,
        [duplicate, ownerId, kept],
      );
    }

    expect(await places.remove(owner, kept)).toBe(true);

    expect(await row(kept)).toBeUndefined();
    for (const duplicate of duplicates) {
      expect(await row(duplicate)).toBeUndefined();
    }

    expect(await row(newer)).toEqual({ name: 'Brockway', properties: {} });
  });

  it('removes a city with a legacy chain of merged-away cities, every link of it', async () => {
    // A chain from before merges kept it one hop deep: the second duplicate
    // points at the first, not at the kept city. Deleting only the first
    // would set the second's merged_into_entity_id to NULL, and it would then
    // share its key with the newer unparented city.
    const region = uuidv7();
    const kept = uuidv7();
    const newer = uuidv7();
    const [first, second] = [uuidv7(), uuidv7()];

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, place_kind, parent_place_id)
       VALUES ($1, 'Location', 'Remove Chain Region', '{}'::jsonb, $3, 'region', NULL),
              ($2, 'Location', 'Ashby', '{}'::jsonb, $3, 'city', $1),
              ($4, 'Location', 'Ashby', '{}'::jsonb, $3, 'city', NULL)`,
      [region, kept, ownerId, newer],
    );
    for (const [duplicate, into] of [
      [first, kept],
      [second, first],
    ]) {
      await dataSource.query(
        `INSERT INTO ci.entities
                (entity_id, entity_type, name, properties, owner_user_id, place_kind, merged_into_entity_id, is_active)
         VALUES ($1, 'Location', 'Ashby', '{}'::jsonb, $2, 'city', $3, FALSE)`,
        [duplicate, ownerId, into],
      );
    }

    expect(await places.remove(owner, kept)).toBe(true);

    for (const id of [kept, first, second]) {
      expect(await row(id)).toBeUndefined();
    }

    expect(await row(newer)).toEqual({ name: 'Ashby', properties: {} });
  });

  it('keeps a place an older version hung under a merged-away region, moving it up to the next region', async () => {
    // Before merged-away places left the region key, a geocode could resolve a
    // region to one and hang a city under it. Deleting the kept region takes
    // the merged-away one with it, and the city moves up to the country as it
    // would from the kept region, instead of losing its parent.
    const country = uuidv7();
    const kept = uuidv7();
    const mergedAway = uuidv7();
    const city = uuidv7();

    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, place_kind, parent_place_id)
       VALUES ($1, 'Location', 'Remove Graft Country', '{}'::jsonb, $3, 'country', NULL),
              ($2, 'Location', 'Remove Graft Region', '{}'::jsonb, $3, 'region', $1)`,
      [country, kept, ownerId],
    );
    await dataSource.query(
      `INSERT INTO ci.entities
              (entity_id, entity_type, name, properties, owner_user_id, place_kind, merged_into_entity_id, is_active)
       VALUES ($1, 'Location', 'Remove Graft Region', '{}'::jsonb, $2, 'region', $3, FALSE)`,
      [mergedAway, ownerId, kept],
    );
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, place_kind, parent_place_id)
       VALUES ($1, 'Location', 'Remove Graft City', '{}'::jsonb, $2, 'city', $3)`,
      [city, ownerId, mergedAway],
    );

    expect(await places.remove(owner, kept)).toBe(true);

    expect(await row(kept)).toBeUndefined();
    expect(await row(mergedAway)).toBeUndefined();
    const [moved]: Array<{ parent_place_id: string | null }> = await dataSource.query(
      'SELECT parent_place_id FROM ci.entities WHERE entity_id = $1',
      [city],
    );
    expect(moved.parent_place_id).toBe(country);
  });
});

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
});

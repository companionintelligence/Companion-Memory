import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { UserEntity } from '@ci/domains/user';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, dataSourceConnection } from '../../../__tests__/support/databaseConnection';
import { BaseEntity } from '../../entities/BaseEntity';
import { ItemBaseEntity } from '../../entities/ItemBaseEntity';
import { ItemEntity } from '../../entities/ItemEntity';
import { GraphDeltaWriter } from '../GraphDeltaWriter';
import { ItemService } from '../ItemService';

/**
 * `findOwnedUnitOfModel` is what lets a scan of a model code (an Amazon ASIN,
 * a GTIN) open the thing you own of that model. An Amazon import claims the
 * ASIN for the catalog MODEL and leaves the unit's `product_id` empty, with the
 * ASIN only in the unit's `identifier_codes`, so both places are searched.
 */
const DATABASE_ENV = { urlEnvVar: 'MEMORY_TEST_DATABASE_URL' };
const availability = databaseAvailability(DATABASE_ENV);
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ItemService.ownedUnitOfModel.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const logger = () =>
  ({
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }) as unknown as LoggerService;

const ASIN = 'B09M95S7ZN';

describeWithDb(`ItemService.findOwnedUnitOfModel against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let items: ItemService;

  const ownerId = uuidv7();
  const strangerId = uuidv7();
  const owner = { userId: ownerId } as UserServiceContext;
  const stranger = { userId: strangerId } as UserServiceContext;
  const users = [ownerId, strangerId];

  const insertProduct = async (title: string): Promise<string> => {
    const productId = uuidv7();

    await dataSource.query(`INSERT INTO ci.product_models (product_id, user_id, title) VALUES ($1, $2, $3)`, [
      productId,
      ownerId,
      title,
    ]);

    return productId;
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      ...dataSourceConnection(DATABASE_ENV),
      entities: [BaseEntity, UserEntity, ItemBaseEntity, ItemEntity],
      synchronize: false,
      extra: { options: '-c search_path=ci,public' },
    });
    await dataSource.initialize();

    for (const userId of users) {
      await createSyntheticTestUser((sql, params) => dataSource.query(sql, params), 'ItemOwnedUnit', userId);
    }

    items = new ItemService(
      dataSource.getRepository(ItemEntity),
      dataSource.getRepository(ItemBaseEntity),
      logger(),
      { send: jest.fn(async () => []) } as unknown as EventService,
      new GraphDeltaWriter(dataSource, logger()),
    );
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM ci.graph_deltas WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.objects WHERE user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
    await dataSource.query('DELETE FROM ci.product_models WHERE user_id = ANY($1::uuid[])', [users]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('UPDATE ci.users SET entity_id = NULL WHERE id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1::uuid[])', [users]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1::uuid[])', [users]);
      await dataSource.destroy();
    }
  });

  it('finds an imported unit by the code in its identifier_codes, with no product link', async () => {
    const oil = await insertProduct('Motor oil');
    const unit = await items.create(owner, { name: 'Motor oil', identifierCodes: { asin: ASIN } });
    await items.create(owner, { name: 'Fan', identifierCodes: { asin: 'B07C5VG64V' } });

    const found = await items.findOwnedUnitOfModel(owner, oil, { namespace: 'asin', value: ASIN });

    expect(found?.id).toBe(unit.id);
  });

  it('finds a unit linked to the product, whatever its codes', async () => {
    const mug = await insertProduct('Blue mug');
    const unit = await items.create(owner, { name: 'Blue mug', productId: mug });

    const found = await items.findOwnedUnitOfModel(owner, mug, { namespace: 'gtin', value: '00012345678905' });

    expect(found?.id).toBe(unit.id);
  });

  it('prefers a unit you still have, then the newest', async () => {
    const oil = await insertProduct('Motor oil');
    await items.create(owner, {
      name: 'Motor oil (used up)',
      identifierCodes: { asin: ASIN },
      lifecycleState: 'consumed',
      acquiredAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    await items.create(owner, {
      name: 'Motor oil (older)',
      identifierCodes: { asin: ASIN },
      acquiredAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    const newest = await items.create(owner, {
      name: 'Motor oil (newer)',
      identifierCodes: { asin: ASIN },
      acquiredAt: new Date('2026-05-17T00:00:00.000Z'),
    });

    const found = await items.findOwnedUnitOfModel(owner, oil, { namespace: 'asin', value: ASIN });

    expect(found?.id).toBe(newest.id);
  });

  it("is null when you own none, and never returns another account's unit", async () => {
    const oil = await insertProduct('Motor oil');
    await items.create(stranger, { name: 'Their motor oil', identifierCodes: { asin: ASIN } });

    expect(await items.findOwnedUnitOfModel(owner, oil, { namespace: 'asin', value: ASIN })).toBeNull();
  });
});

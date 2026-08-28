import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { ProductModelEntity } from '../../entities/ProductModelEntity';
import { ProductModelService } from '../ProductModelService';

/**
 * The two things about this service that are decided by an INDEX, not by code,
 * executed against Postgres.
 *
 *  1. `ON CONFLICT (owner_user_id, lower(btrim(brand)), lower(btrim(model_number)))
 *     WHERE …` INFERS `product_models_brand_model_uniq` only when both the
 *     expression list and the predicate match what the index was created with.
 *     A mismatch is not a compile error and not a wrong answer — it is
 *     "there is no unique or exclusion constraint matching the ON CONFLICT
 *     specification" at runtime, i.e. a 500 on the path whose entire job is to
 *     be safe under concurrency. `ProductModelService.spec.ts` stubs `query`,
 *     so it asserts the conflict-target STRING and can never find out whether
 *     Postgres accepts it.
 *  2. The 23505 that `update()` now translates into a 409. A mock cannot raise
 *     a real unique violation, so the handler is only exercised here.
 *
 * Opt-in: set `MEMORY_TEST_DATABASE_URL` (or `DATABASE_URL`); this suite SKIPS
 * legibly when nothing is reachable.
 *
 *   MEMORY_TEST_DATABASE_URL=postgres://companion:pw@localhost:5432/companion \
 *     yarn workspace @ci/be-api jest ProductModelService.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'MEMORY_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[memory/ProductModelService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`ProductModelService — index-decided behaviour, in Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let service: ProductModelService;

  const owner = { userId: uuidv7() } as UserServiceContext;

  const noopLogger = {
    setContext: () => undefined,
    log: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
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
      entities: [ProductModelEntity],
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'memory/ProductModelService.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [owner.userId, 'Product spec fixture', `product.${owner.userId}@example.invalid`],
    );

    service = new ProductModelService(
      dataSource.getRepository(ProductModelEntity),
      { resolve: async () => null } as never,
      { send: async () => [] } as never,
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.product_models WHERE user_id = $1', [owner.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [owner.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('findOrCreateByBrandModel INFERS the partial index — the ON CONFLICT target is one Postgres accepts', async () => {
    // If the expression list or the predicate drifted from the index, this call
    // raises 42P10 rather than returning a row.
    const created = await service.findOrCreateByBrandModel(owner, {
      brand: 'Sony',
      modelNumber: `WH-${owner.userId.slice(0, 8)}`,
    });

    expect(created).not.toBeNull();
    expect(created).toMatchObject({ brand: 'Sony' });
  });

  it('findOrCreateByBrandModel is idempotent, and normalises the way the index does', async () => {
    const modelNumber = `BKE-${owner.userId.slice(0, 8)}`;

    const first = await service.findOrCreateByBrandModel(owner, {
      brand: 'Breville',
      modelNumber,
    });
    // Different case and surrounding whitespace: lower(btrim(…)) on both sides
    // of the index means this is the SAME key, and the DO NOTHING branch has to
    // resolve to the row that won.
    const second = await service.findOrCreateByBrandModel(owner, {
      brand: '  BREVILLE ',
      modelNumber: ` ${modelNumber.toLowerCase()} `,
    });

    expect(second?.id).toBe(first?.id);

    const [{ count }] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ci.product_models
        WHERE owner_user_id = $1 AND lower(btrim(brand)) = 'breville'`,
      [owner.userId],
    );
    expect(count).toBe(1);
  });

  it('findOrCreateByBrandModel does NOT resolve to a tombstoned model', async () => {
    const modelNumber = `TOMB-${owner.userId.slice(0, 8)}`;

    const original = await service.findOrCreateByBrandModel(owner, {
      brand: 'Anker',
      modelNumber,
    });

    // Merge it away. The partial index excludes tombstones, so the key is free
    // again — and the read-back must not hand back the losing row, which
    // nothing points at any more.
    const survivor = uuidv7();
    await dataSource.query(
      `INSERT INTO ci.product_models (product_id, user_id, owner_user_id, title) VALUES ($1, $2, $2, 'Survivor')`,
      [survivor, owner.userId],
    );
    await dataSource.query(`UPDATE ci.product_models SET merged_into_product_id = $2 WHERE product_id = $1`, [
      original?.id,
      survivor,
    ]);

    const reminted = await service.findOrCreateByBrandModel(owner, { brand: 'Anker', modelNumber });

    expect(reminted).not.toBeNull();
    expect(reminted?.id).not.toBe(original?.id);
  });

  it('returns null rather than minting an unfindable model when brand or model number is missing', async () => {
    // The index does not cover these rows, so there is no key to find-or-create
    // ON and every call would mint another one.
    await expect(
      service.findOrCreateByBrandModel(owner, { brand: 'Sony', modelNumber: null }),
    ).resolves.toBeNull();
    await expect(
      service.findOrCreateByBrandModel(owner, { brand: '  ', modelNumber: 'X' }),
    ).resolves.toBeNull();
  });

  it('update() reports a brand/model collision as a 409, not a 500', async () => {
    const suffix = owner.userId.slice(0, 8);

    const taken = await service.create(owner, {
      title: 'Kettle',
      brand: 'Smeg',
      modelNumber: `KLF03-${suffix}`,
    });
    const other = await service.create(owner, {
      title: 'Other kettle',
      brand: 'Smeg',
      modelNumber: `KLF04-${suffix}`,
    });

    await expect(service.update(owner, other.id, { modelNumber: `KLF03-${suffix}` })).rejects.toBeInstanceOf(
      ConflictException,
    );

    // The row is unchanged — a rejected write, not a partial one.
    const after = await service.findById(owner, other.id);
    expect(after?.modelNumber).toBe(`KLF04-${suffix}`);
    expect(taken.modelNumber).toBe(`KLF03-${suffix}`);
  });

  it('update() still succeeds when the pair is free', async () => {
    const suffix = owner.userId.slice(0, 8);

    const model = await service.create(owner, {
      title: 'Toaster',
      brand: 'Dualit',
      modelNumber: `2-SLICE-${suffix}`,
    });

    const updated = await service.update(owner, model.id, { modelNumber: `4-SLICE-${suffix}` });

    expect(updated?.modelNumber).toBe(`4-SLICE-${suffix}`);
  });
});

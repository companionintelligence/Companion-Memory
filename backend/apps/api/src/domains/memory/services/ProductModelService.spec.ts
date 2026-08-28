import { BadRequestException } from '@nestjs/common';
import { IsNull } from 'typeorm';

import type { ServiceContext, UserServiceContext } from '@ci/common/context';
import { ProductUpdatedEvent } from '@ci/domains/memory/events';

import { FIND_OR_CREATE_IDENTITY_CONFIDENCE, ProductModelService } from './ProductModelService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const PRODUCT = '00000000-0000-0000-0000-0000000000b1';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

interface Harness {
  service: ProductModelService;
  statements: Array<{ sql: string; params: unknown[] }>;
  findOne: jest.Mock;
  resolve: jest.Mock;
  send: jest.Mock;
  update: jest.Mock;
}

function makeHarness(options: { existingProductId?: string | null } = {}): Harness {
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });

    if (sql.includes('SELECT product_id')) {
      const id = options.existingProductId === undefined ? PRODUCT : options.existingProductId;

      return id == null ? [] : [{ product_id: id }];
    }

    // ON CONFLICT DO NOTHING lost the race: RETURNING is empty.
    return [];
  });

  const findOne = jest.fn(async () => ({ id: PRODUCT, title: 'Sony WH-1000XM5' }));
  const update = jest.fn(async () => undefined);

  const repository = {
    manager: { query },
    findOne,
    update,
    create: (row: unknown) => row,
    save: jest.fn(async (row: unknown) => row),
    metadata: { columns: { length: 24 } },
  };

  const resolve = jest.fn(async () => null);
  const send = jest.fn(async () => []);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ProductModelService(
    repository as never,
    { resolve } as never,
    { send } as never,
    logger as never,
  );

  return { service, statements, findOne, resolve, send, update };
}

describe('ProductModelService.findOrCreateByBrandModel', () => {
  it('repeats the partial index predicate VERBATIM in the conflict target', async () => {
    const harness = makeHarness();

    await harness.service.findOrCreateByBrandModel(CONTEXT, { brand: 'Sony', modelNumber: 'WH-1000XM5' });

    const insert = harness.statements.find(({ sql }) => sql.includes('INSERT INTO ci.product_models'));

    // Postgres infers a PARTIAL unique index only when BOTH the expression list
    // and the predicate match; a near-miss is a runtime 500, not a type error.
    expect(insert?.sql).toContain(
      'ON CONFLICT (owner_user_id, lower(btrim(brand)), lower(btrim(model_number))) ' +
        'WHERE brand IS NOT NULL AND model_number IS NOT NULL AND merged_into_product_id IS NULL',
    );
    expect(insert?.sql).toContain('DO NOTHING');
  });

  it('reads the winner back through the same normalization the index uses', async () => {
    const harness = makeHarness();

    await harness.service.findOrCreateByBrandModel(CONTEXT, { brand: ' sony ', modelNumber: 'wh-1000xm5' });

    const select = harness.statements.find(({ sql }) => sql.startsWith('SELECT product_id'));
    expect(select?.sql).toContain('lower(btrim(brand)) = lower(btrim($2))');
    expect(select?.sql).toContain('lower(btrim(model_number)) = lower(btrim($3))');
    // The read-back must exclude tombstones or it can resolve to a merged-away row.
    expect(select?.sql).toContain('merged_into_product_id IS NULL');
    expect(select?.params).toEqual([USER, 'sony', 'wh-1000xm5']);
  });

  it('writes the derived-identity confidence, not the 1.0 ground-truth default', async () => {
    const harness = makeHarness();

    await harness.service.findOrCreateByBrandModel(CONTEXT, { brand: 'Sony', modelNumber: 'WH-1000XM5' });

    const insert = harness.statements.find(({ sql }) => sql.includes('INSERT INTO ci.product_models'));
    expect(insert?.params[7]).toBe(FIND_OR_CREATE_IDENTITY_CONFIDENCE);
    expect(FIND_OR_CREATE_IDENTITY_CONFIDENCE).toBeLessThan(1);
  });

  it('derives a title when the caller has none, rather than writing NULL into a NOT NULL column', async () => {
    const harness = makeHarness();

    await harness.service.findOrCreateByBrandModel(CONTEXT, { brand: 'Sony', modelNumber: 'WH-1000XM5' });

    const insert = harness.statements.find(({ sql }) => sql.includes('INSERT INTO ci.product_models'));
    expect(insert?.params[2]).toBe('Sony WH-1000XM5');
  });

  it('declines without inserting when either half of the key is missing', async () => {
    const harness = makeHarness();

    expect(
      await harness.service.findOrCreateByBrandModel(CONTEXT, { brand: 'Sony', modelNumber: null }),
    ).toBeNull();
    expect(
      await harness.service.findOrCreateByBrandModel(CONTEXT, { brand: '  ', modelNumber: 'X' }),
    ).toBeNull();

    // The index does not cover those rows, so there is no key to converge on —
    // inserting anyway mints unfindable models forever.
    expect(harness.statements).toHaveLength(0);
  });

  it('returns null rather than throwing when the row is merged away mid-call', async () => {
    const harness = makeHarness({ existingProductId: null });

    expect(
      await harness.service.findOrCreateByBrandModel(CONTEXT, { brand: 'Sony', modelNumber: 'WH-1000XM5' }),
    ).toBeNull();
  });
});

describe('ProductModelService reads', () => {
  it('filters tombstones on every by-id read', async () => {
    const harness = makeHarness();

    await harness.service.findById(CONTEXT, PRODUCT);

    expect(harness.findOne).toHaveBeenCalledWith({
      where: { id: PRODUCT, userId: USER, mergedIntoProductId: IsNull() },
    });
  });

  it('drops the user filter for the system context but keeps the tombstone filter', async () => {
    const harness = makeHarness();
    const system = { userId: Symbol.for('SYSTEM_USER') } as unknown as ServiceContext;

    await harness.service.findById(system, PRODUCT);

    const [{ where }] = harness.findOne.mock.calls[0] as [{ where: Record<string, unknown> }];
    expect(where.mergedIntoProductId).toEqual(IsNull());
  });

  it('rejects an identity confidence the CHECK constraint would refuse', async () => {
    const harness = makeHarness();

    await expect(harness.service.create(CONTEXT, { title: 'x', identityConfidence: 0 })).rejects.toThrow(
      BadRequestException,
    );
    await expect(harness.service.create(CONTEXT, { title: 'x', identityConfidence: 1.5 })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('ProductModelService.update', () => {
  it('emits ProductUpdatedEvent after a genuine field mutation, so search re-indexes it', async () => {
    const harness = makeHarness();

    await harness.service.update(CONTEXT, PRODUCT, { title: 'Sony WH-1000XM6' });

    expect(harness.update).toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith(ProductUpdatedEvent, { productId: PRODUCT });
  });

  it('does not emit when the patch is empty — nothing changed, nothing to re-index', async () => {
    const harness = makeHarness();

    await harness.service.update(CONTEXT, PRODUCT, {});

    expect(harness.update).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });
});

describe('ProductModelService.resolveByIdentifier', () => {
  it('ignores a claim held by an object INSTANCE — a serial is not a product', async () => {
    const harness = makeHarness();
    harness.resolve.mockResolvedValue({ subjectType: 'object_instance', subjectId: 'x' });

    expect(await harness.service.resolveByIdentifier(CONTEXT, 'serial', 'SN-1')).toBeNull();
    expect(harness.findOne).not.toHaveBeenCalled();
  });

  it('resolves a product claim through the tombstone-filtered read', async () => {
    const harness = makeHarness();
    harness.resolve.mockResolvedValue({ subjectType: 'product_model', subjectId: PRODUCT });

    await harness.service.resolveByIdentifier(CONTEXT, 'gtin', '012345678905');

    // The raw value is handed to the shared normalizer, never pre-normalized here.
    expect(harness.resolve).toHaveBeenCalledWith(USER, 'gtin', '012345678905', {}, undefined);
    expect(harness.findOne).toHaveBeenCalledWith({
      where: { id: PRODUCT, userId: USER, mergedIntoProductId: IsNull() },
    });
  });
});

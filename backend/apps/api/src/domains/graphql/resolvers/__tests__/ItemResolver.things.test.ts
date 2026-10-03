import { type RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
import { ItemSortOrder } from '../../types/ItemFilters';
import { decodeItemCursor } from '../../utils/itemCursor';
import { ItemResolver } from '../ItemResolver';

const context = { userId: 'user-1' } as unknown as RequestContext;

const ITEM_A = '550e8400-e29b-41d4-a716-446655440001';
const ITEM_B = '550e8400-e29b-41d4-a716-446655440002';
const PRODUCT_A = '550e8400-e29b-41d4-a716-4466554400aa';

const CREATED_AT = new Date('2026-01-02T03:04:05.000Z');
/** The same instant as Postgres formats it: the microseconds the `Date` above has lost. */
const CREATED_AT_EXACT = '2026-01-02T03:04:05.000789Z';

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_A,
    name: 'Blue mug',
    description: null,
    category: 'kitchen',
    subcategory: null,
    brand: 'Acme',
    model: null,
    currentValue: 10,
    purchasePrice: 10,
    currency: 'USD',
    condition: 'good',
    quantity: 1,
    metadata: {},
    acquiredAt: null,
    identifierCodes: {},
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    massG: null,
    volumeMl: null,
    unitSystem: null,
    colors: null,
    colorHex: null,
    materials: null,
    composition: {},
    acquisitionMethod: null,
    acquiredFrom: null,
    manufacturedAt: null,
    expiresAt: null,
    isDigital: false,
    lifecycleState: 'active',
    identityConfidence: 1,
    lastSeenAt: null,
    productId: null,
    acquisitionLineItemId: null,
    sourceType: null,
    sourceSystem: null,
    sourceId: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  } as never;
}

/** Only the collaborators a given test actually reaches are real mocks. */
function build(overrides: Partial<Record<string, unknown>> = {}) {
  const itemService = {
    findPage: jest.fn(),
    findAll: jest.fn(),
    findById: jest.fn(),
    update: jest.fn(),
    ...(overrides.itemService as object),
  };

  const objectIdentifierService = {
    listForSubjects: jest.fn(async () => new Map()),
    resolve: jest.fn(),
    ...(overrides.objectIdentifierService as object),
  };

  const productModelService = {
    findById: jest.fn(),
    ...(overrides.productModelService as object),
  };

  const entityMergeBlockService = {
    blockAllPairs: jest.fn(async () => 1),
    ...(overrides.entityMergeBlockService as object),
  };

  const resolver = new ItemResolver(
    undefined as never,
    itemService as never,
    undefined as never,
    { clear: jest.fn() } as never,
    { clear: jest.fn() } as never,
    undefined as never,
    undefined as never,
    objectIdentifierService as never,
    undefined as never,
    undefined as never,
    productModelService as never,
    entityMergeBlockService as never,
  );

  return { resolver, itemService, objectIdentifierService, productModelService, entityMergeBlockService };
}

describe('ItemResolver.items', () => {
  it('pages in SQL and never falls back to the unbounded findAll', async () => {
    const item = makeItem();
    const { resolver, itemService } = build({
      itemService: {
        findPage: jest.fn(async () => ({
          items: [item],
          positions: [{ createdAt: CREATED_AT_EXACT, id: ITEM_A }],
          hasMore: true,
          nextCursor: null,
        })),
      },
    });

    const connection = await resolver.items(context, { first: 1 });

    expect(itemService.findAll).not.toHaveBeenCalled();
    expect(itemService.findPage).toHaveBeenCalledTimes(1);
    expect(itemService.findPage).toHaveBeenCalledWith(
      { userId: 'user-1' },
      {},
      { limit: 1, afterCreatedAt: null, afterId: null },
    );
    expect(connection.pageInfo.hasNextPage).toBe(true);
  });

  it('mints a cursor carrying BOTH halves of the keyset, and seeks on both', async () => {
    const item = makeItem();
    const { resolver, itemService } = build({
      itemService: {
        findPage: jest.fn(async () => ({
          items: [item],
          positions: [{ createdAt: CREATED_AT_EXACT, id: ITEM_A }],
          hasMore: false,
          nextCursor: null,
        })),
      },
    });

    const first = await resolver.items(context, { first: 1 });
    const cursor = first.edges[0].cursor;

    // The row's exact position, from the service: NOT `item.createdAt`, whose Date has lost the microseconds.
    expect(decodeItemCursor(cursor)).toEqual({ createdAt: CREATED_AT_EXACT, id: ITEM_A });

    await resolver.items(context, { first: 1, after: cursor });

    expect(itemService.findPage).toHaveBeenLastCalledWith(
      { userId: 'user-1' },
      {},
      { limit: 1, afterCreatedAt: CREATED_AT_EXACT, afterId: ITEM_A },
    );
  });

  it("gives every edge its own row's position, not just the last", async () => {
    const mug = makeItem({ id: ITEM_A });
    const kettle = makeItem({ id: ITEM_B, name: 'Kettle' });
    const { resolver } = build({
      itemService: {
        findPage: jest.fn(async () => ({
          items: [mug, kettle],
          positions: [
            { createdAt: '2026-01-02T03:04:05.000789Z', id: ITEM_A },
            { createdAt: '2026-01-02T03:04:05.000123Z', id: ITEM_B },
          ],
          hasMore: false,
          nextCursor: null,
        })),
      },
    });

    const connection = await resolver.items(context, { first: 2 });

    expect(connection.edges.map((edge) => decodeItemCursor(edge.cursor))).toEqual([
      { createdAt: '2026-01-02T03:04:05.000789Z', id: ITEM_A },
      { createdAt: '2026-01-02T03:04:05.000123Z', id: ITEM_B },
    ]);
    expect(connection.pageInfo.startCursor).toBe(connection.edges[0].cursor);
    expect(connection.pageInfo.endCursor).toBe(connection.edges[1].cursor);
  });

  it('resumes from a cursor an earlier release minted, which holds milliseconds', async () => {
    const { resolver, itemService } = build({
      itemService: {
        findPage: jest.fn(async () => ({ items: [], positions: [], hasMore: false, nextCursor: null })),
      },
    });
    const legacy = Buffer.from(`${CREATED_AT.toISOString()}|${ITEM_A}`).toString('base64');

    await resolver.items(context, { first: 1, after: legacy });

    expect(itemService.findPage).toHaveBeenLastCalledWith(
      { userId: 'user-1' },
      {},
      { limit: 1, afterCreatedAt: '2026-01-02T03:04:05.000Z', afterId: ITEM_A },
    );
  });

  it('pushes category, brand and lifecycleState into SQL rather than filtering after the fact', async () => {
    const { resolver, itemService } = build({
      itemService: {
        findPage: jest.fn(async () => ({ items: [], positions: [], hasMore: false, nextCursor: null })),
      },
    });

    await resolver.items(context, {}, undefined, 'kitchen', 'Acme', undefined, 'stored');

    expect(itemService.findPage).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { category: 'kitchen', brand: 'Acme', lifecycleState: 'stored' },
      expect.anything(),
    );
  });

  it('rejects backwards pagination instead of quietly returning the first page', async () => {
    const { resolver } = build();

    await expect(resolver.items(context, { last: 5 })).rejects.toThrow(/forward-only/);
    await expect(resolver.items(context, { before: 'x' })).rejects.toThrow(/forward-only/);
  });

  it('applies the query refinement to a drained window', async () => {
    const mug = makeItem({ id: ITEM_A });
    const kettle = makeItem({ id: ITEM_B, name: 'Kettle' });

    const { resolver } = build({
      itemService: {
        findPage: jest.fn(async () => ({ items: [mug, kettle], hasMore: false, nextCursor: null })),
      },
    });

    const connection = await resolver.items(context, { first: 10 }, 'kett');

    expect(connection.edges).toHaveLength(1);
    expect(connection.edges[0].node.id).toBe(GlobalUID.encode('item', ITEM_B));
  });

  it('keeps hasNextPage true when the refinement walk stopped early', async () => {
    // Always reports more, so the drain hits its scan ceiling.
    const { resolver } = build({
      itemService: {
        findPage: jest.fn(async () => ({
          items: [makeItem()],
          hasMore: true,
          nextCursor: { createdAt: CREATED_AT_EXACT, id: ITEM_A },
        })),
      },
    });

    const connection = await resolver.items(
      context,
      { first: 1 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ItemSortOrder.NAME_ASC,
    );

    expect(connection.pageInfo.hasNextPage).toBe(true);
  });

  it("hands each chunk's exact position to the next, so the drain cannot skip the rest of an instant", async () => {
    const mug = makeItem({ id: ITEM_A });
    const kettle = makeItem({ id: ITEM_B, name: 'Kettle' });
    const findPage = jest
      .fn()
      .mockResolvedValueOnce({
        items: [mug],
        positions: [{ createdAt: CREATED_AT_EXACT, id: ITEM_A }],
        hasMore: true,
        nextCursor: { createdAt: CREATED_AT_EXACT, id: ITEM_A },
      })
      .mockResolvedValueOnce({ items: [kettle], positions: [], hasMore: false, nextCursor: null });
    const { resolver } = build({ itemService: { findPage } });

    const connection = await resolver.items(
      context,
      { first: 10 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ItemSortOrder.NAME_ASC,
    );

    expect(connection.edges).toHaveLength(2);
    expect(findPage).toHaveBeenCalledTimes(2);
    expect(findPage.mock.calls[0][2]).toEqual({ limit: 200, afterCreatedAt: null, afterId: null });
    // The text the service reported, microseconds and all: not a Date, which would be `.000`.
    expect(findPage.mock.calls[1][2]).toEqual({
      limit: 200,
      afterCreatedAt: CREATED_AT_EXACT,
      afterId: ITEM_A,
    });
  });
});

describe('ItemResolver.objectByIdentifier', () => {
  it('answers a GTIN with the catalog MODEL, not an owned unit', async () => {
    const { resolver, objectIdentifierService, productModelService } = build({
      objectIdentifierService: {
        resolve: jest.fn(async () => ({
          subjectType: 'product_model',
          subjectId: PRODUCT_A,
          namespace: 'gtin',
          valueNormalized: '00012345678905',
          qualifier: '',
          confidence: 1,
        })),
      },
      productModelService: {
        findById: jest.fn(async () => ({
          id: PRODUCT_A,
          title: 'Blue mug',
          brand: 'Acme',
          manufacturer: null,
          modelNumber: null,
          category: null,
          subcategory: null,
          productType: null,
          description: null,
          variantAttributes: {},
          spec: {},
          msrpMinor: null,
          currency: null,
          imageContentId: null,
          manualContentIds: null,
          isDigital: false,
          identityConfidence: 1,
          productEntityId: null,
          metadata: {},
          sourceType: null,
          sourceSystem: null,
          sourceId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      },
    });

    const payload = await resolver.objectByIdentifier(context, 'gtin', '012345678905');

    expect(payload.matched).toBe(true);
    expect(payload.subjectType).toBe('product_model');
    expect(payload.product?.id).toBe(GlobalUID.encode('product', PRODUCT_A));
    expect(payload.item ?? null).toBeNull();
    expect(objectIdentifierService.resolve).toHaveBeenCalled();
    expect(productModelService.findById).toHaveBeenCalledWith({ userId: 'user-1' }, PRODUCT_A);
  });

  it('reports an unreadable code as unmatched rather than raising', async () => {
    const { resolver, objectIdentifierService } = build();

    // Fails the GTIN check digit, so it never normalizes into something matchable.
    const payload = await resolver.objectByIdentifier(context, 'gtin', '012345678900');

    expect(payload.matched).toBe(false);
    expect(payload.value ?? null).toBeNull();
    expect(objectIdentifierService.resolve).not.toHaveBeenCalled();
  });
});

describe('object-identity global ids', () => {
  it.each([
    ['product', PRODUCT_A],
    ['receipt', ITEM_B],
    ['observation', ITEM_A],
  ] as const)('round-trips a %s id', (type, raw) => {
    expect(GlobalUID.parse(type, GlobalUID.encode(type, raw))).toBe(raw);
  });

  it('refuses an id minted for a different resource type', () => {
    expect(() => GlobalUID.parse('product', GlobalUID.encode('item', ITEM_A))).toThrow(
      /Unexpected global id type/,
    );
  });
});

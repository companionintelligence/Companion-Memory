import { FindOperator } from 'typeorm';

import { SYSTEM_USER } from '@ci/common/context';
import config from '@ci/configuration';
import { ProductModelService } from '@ci/domains/memory';

import { ProductSearchIndexListener } from '../ProductSearchIndexListener';

/**
 * A repository that answers `findOne` by applying the REAL `where` — the
 * `IsNull()` operator included — to an in-memory row set.
 *
 * The listener is wired to the REAL {@link ProductModelService} through it,
 * because a stubbed `findById` can hand the listener rows the live-scoped read
 * cannot produce. That is how a `mergedIntoProductId != null` branch came to
 * look tested while being unreachable: `liveScope` filters tombstones for the
 * system context too, so a merged-away model always reads as absent.
 */
function fakeRepository(rows: Array<Record<string, unknown>>) {
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([column, expected]) => {
      if (expected instanceof FindOperator) {
        if (expected.type !== 'isNull') {
          throw new Error(`fake repository does not implement the "${expected.type}" operator`);
        }

        return (row[column] ?? null) === null;
      }

      return row[column] === expected;
    });

  return {
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((row) => matches(row, where)) ?? null,
    ),
  };
}

function makeListener(
  product: Record<string, unknown> | null = null,
  identifiers: Array<{ valueNormalized: string; valueRaw: string | null }> | null = null,
) {
  const serviceLogger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const productModelService = new ProductModelService(
    fakeRepository(product == null ? [] : [product]) as never,
    { resolve: jest.fn() } as never,
    { send: jest.fn() } as never,
    serviceLogger as never,
  );
  const objectIdentifierService = {
    listForSubjects: jest
      .fn()
      .mockImplementation(async (_owner: string, _type: string, ids: string[]) =>
        identifiers ? new Map([[ids[0], identifiers]]) : new Map(),
      ),
  };
  const embeddingGenerationService = { generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]) };
  const embeddingService = {
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
  };
  const indexSkipService = {
    recordSkip: jest.fn().mockResolvedValue(undefined),
    clearSkip: jest.fn().mockResolvedValue(true),
  };
  const vectorService = {
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const listener = new ProductSearchIndexListener(
    productModelService as never,
    objectIdentifierService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    indexSkipService as never,
    vectorService as never,
    logger as never,
  );

  return {
    listener,
    productModelService,
    objectIdentifierService,
    embeddingGenerationService,
    embeddingService,
    indexSkipService,
    vectorService,
    logger,
  };
}

describe('ProductSearchIndexListener.unindexProduct', () => {
  it('removes the embedding and the vector for (product, id), under the system context', async () => {
    const { listener, embeddingService, vectorService } = makeListener();

    await listener.unindexProduct({ productId: 'product-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'product', entityId: 'product-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'product', entityId: 'product-1' },
    );
  });
});

describe('ProductSearchIndexListener.indexProduct / updateProduct', () => {
  it('is a no-op when the model cannot be found', async () => {
    const { listener, embeddingService, vectorService, logger } = makeListener(null);

    await listener.indexProduct({ productId: 'ghost' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('embeds and vectorizes a model scoped to its user, as entity_type "product"', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'product-1',
      userId: 'user-1',
      ownerUserId: 'user-1',
      title: 'Bose QuietComfort 45',
      brand: 'Bose',
      modelNumber: 'QC45',
    });

    await listener.updateProduct({ productId: 'product-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'product', entityId: 'product-1', embedding: [0.1, 0.2] },
    );

    const upserted = vectorService.upsert.mock.calls[0][1];
    expect(upserted.entityType).toBe('product');
    expect(upserted.searchableText).toContainEqual({ text: 'Bose QuietComfort 45', weight: 10 });
  });

  it('indexes both forms of a GTIN claim at weight 8', async () => {
    const { listener, objectIdentifierService, embeddingGenerationService, vectorService } = makeListener(
      { id: 'product-1', userId: 'user-1', ownerUserId: 'owner-1', title: 'Bose QuietComfort 45' },
      [{ valueNormalized: '0017817770231', valueRaw: '0 17817 77023 1' }],
    );

    await listener.indexProduct({ productId: 'product-1' } as never);

    expect(objectIdentifierService.listForSubjects).toHaveBeenCalledWith('owner-1', 'product_model', [
      'product-1',
    ]);
    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith(
      'Bose QuietComfort 45 0017817770231 0 17817 77023 1',
    );
    expect(vectorService.upsert.mock.calls[0][1].searchableText).toContainEqual({
      text: '0017817770231 0 17817 77023 1',
      weight: 8,
    });
  });

  it('indexes variant axes by VALUE, never by key, and keeps spec out of the document', async () => {
    const { listener, embeddingGenerationService, vectorService } = makeListener({
      id: 'product-1',
      userId: 'user-1',
      title: 'iPhone 15 Pro',
      variantAttributes: { color: 'Blue Titanium', capacity: '256GB' },
      spec: { weight_g: 187 },
    });

    await listener.indexProduct({ productId: 'product-1' } as never);

    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith(
      'iPhone 15 Pro Blue Titanium 256GB',
    );

    const texts = vectorService.upsert.mock.calls[0][1].searchableText;
    expect(texts).toContainEqual({ text: 'Blue Titanium 256GB', weight: 3 });
    expect(texts).toContainEqual({ text: '187', weight: 1 });
  });

  it('records an index skip for a model with no searchable text, so the backfill sweep converges', async () => {
    const { listener, embeddingService, indexSkipService } = makeListener({
      id: 'product-2',
      userId: 'user-1',
      title: null,
      brand: null,
      manufacturer: null,
      modelNumber: null,
      category: null,
      subcategory: null,
      productType: null,
      description: null,
    });

    await listener.indexProduct({ productId: 'product-2' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(indexSkipService.recordSkip).toHaveBeenCalledWith({
      entityType: 'product',
      entityId: 'product-2',
      reason: 'empty',
    });
  });

  it('clears a previous skip once the model gains a title', async () => {
    const { listener, indexSkipService } = makeListener({
      id: 'product-2',
      userId: 'user-1',
      title: 'Bose QuietComfort 45',
    });

    await listener.updateProduct({ productId: 'product-2' } as never);

    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
      entityType: 'product',
      entityId: 'product-2',
    });
  });
});

describe('ProductSearchIndexListener CI_EMBED_TYPES allowlist', () => {
  const originalTypes = config.embedding.types;

  afterEach(() => {
    config.embedding.types = originalTypes;
  });

  it('skips embedding (but still vectorizes) a product when "product" is excluded from the allowlist', async () => {
    config.embedding.types = ['event'];

    const { listener, embeddingService, vectorService } = makeListener({
      id: 'product-1',
      userId: 'user-1',
      title: 'Bose QuietComfort 45',
      brand: 'Bose',
      modelNumber: 'QC45',
    });

    await listener.indexProduct({ productId: 'product-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).toHaveBeenCalled();
  });
});

describe('ProductSearchIndexListener — merge tombstones', () => {
  it('cannot see a merged-away model at all, so it neither indexes nor unindexes one', async () => {
    const { listener, embeddingService, vectorService, embeddingGenerationService } = makeListener({
      id: 'loser',
      userId: 'user-1',
      title: 'Bose QuietComfort 45',
      mergedIntoProductId: 'winner',
    });

    await listener.updateProduct({ productId: 'loser' } as never);

    expect(embeddingGenerationService.generateEmbedding).not.toHaveBeenCalled();
    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    // Deleting the tombstone's rows belongs to the transaction that made it
    // one — ObjectMergeService.mergeProductModels. A branch here would be
    // unreachable code standing in for that.
    expect(embeddingService.remove).not.toHaveBeenCalled();
    expect(vectorService.remove).not.toHaveBeenCalled();
  });
});

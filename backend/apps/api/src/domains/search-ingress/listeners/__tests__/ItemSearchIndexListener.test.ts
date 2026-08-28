import { SYSTEM_USER } from '@ci/common/context';

import { ItemSearchIndexListener } from '../ItemSearchIndexListener';

function makeListener(
  item: Record<string, unknown> | null = null,
  place: Record<string, unknown> | null = null,
  extras: {
    product?: Record<string, unknown> | null;
    identifiers?: Array<{ valueNormalized: string; valueRaw: string | null }>;
  } = {},
) {
  const itemService = { findById: jest.fn().mockResolvedValue(item) };
  const placeService = { findById: jest.fn().mockResolvedValue(place) };
  const productModelService = { findById: jest.fn().mockResolvedValue(extras.product ?? null) };
  const objectIdentifierService = {
    listForSubjects: jest
      .fn()
      .mockImplementation(async (_owner: string, _type: string, ids: string[]) =>
        extras.identifiers ? new Map([[ids[0], extras.identifiers]]) : new Map(),
      ),
  };
  const embeddingGenerationService = { generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]) };
  const embeddingService = {
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
  };
  const vectorService = {
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const listener = new ItemSearchIndexListener(
    itemService as never,
    placeService as never,
    productModelService as never,
    objectIdentifierService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    vectorService as never,
    logger as never,
  );

  return {
    listener,
    itemService,
    placeService,
    productModelService,
    objectIdentifierService,
    embeddingGenerationService,
    embeddingService,
    vectorService,
    logger,
  };
}

describe('ItemSearchIndexListener.unindexItem', () => {
  it('removes the embedding and the vector for (item, id), under the system context', async () => {
    const { listener, embeddingService, vectorService } = makeListener();

    await listener.unindexItem({ itemId: 'item-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'item', entityId: 'item-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'item', entityId: 'item-1' },
    );
  });
});

describe('ItemSearchIndexListener — resolving the last-seen place name', () => {
  it("looks up the item's lastSeenPlaceEntityId under the SYSTEM context and folds the name into the document", async () => {
    const { listener, placeService, embeddingGenerationService } = makeListener(
      { id: 'item-1', userId: 'user-1', name: 'Cordless drill', lastSeenPlaceEntityId: 'place-1' },
      { id: 'place-1', name: 'Garage' },
    );

    await listener.indexItem({ itemId: 'item-1' } as never);

    expect(placeService.findById).toHaveBeenCalledWith({ userId: SYSTEM_USER }, 'place-1');
    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith('Cordless drill Garage');
  });

  it('skips the place lookup entirely when the item has no lastSeenPlaceEntityId', async () => {
    const { listener, placeService } = makeListener({
      id: 'item-1',
      userId: 'user-1',
      name: 'Cordless drill',
      lastSeenPlaceEntityId: null,
    });

    await listener.indexItem({ itemId: 'item-1' } as never);

    expect(placeService.findById).not.toHaveBeenCalled();
  });

  it('treats a place with a blank/whitespace-only name as having no name', async () => {
    const { listener, embeddingGenerationService } = makeListener(
      { id: 'item-1', userId: 'user-1', name: 'Cordless drill', lastSeenPlaceEntityId: 'place-1' },
      { id: 'place-1', name: '   ' },
    );

    await listener.indexItem({ itemId: 'item-1' } as never);

    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith('Cordless drill');
  });

  it('tolerates the place having been deleted (findById resolves null) — indexes without the place name', async () => {
    const { listener, embeddingService } = makeListener(
      { id: 'item-1', userId: 'user-1', name: 'Cordless drill', lastSeenPlaceEntityId: 'gone' },
      null,
    );

    await listener.indexItem({ itemId: 'item-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'item', entityId: 'item-1' }),
    );
  });
});

describe('ItemSearchIndexListener — identifiers and the catalog model', () => {
  it('folds BOTH forms of every identifier claim into the document and the tsvector', async () => {
    const { listener, objectIdentifierService, embeddingGenerationService, vectorService } = makeListener(
      { id: 'item-1', userId: 'user-1', ownerUserId: 'owner-1', name: 'Headphones' },
      null,
      {
        identifiers: [{ valueNormalized: 'SN12345678', valueRaw: 'SN 1234-5678' }],
      },
    );

    await listener.indexItem({ itemId: 'item-1' } as never);

    expect(objectIdentifierService.listForSubjects).toHaveBeenCalledWith('owner-1', 'object_instance', [
      'item-1',
    ]);
    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith(
      'Headphones SN12345678 SN 1234-5678',
    );
    // Weight 8 — the 'A' band, above every descriptive field.
    expect(vectorService.upsert.mock.calls[0][1].searchableText).toContainEqual({
      text: 'SN12345678 SN 1234-5678',
      weight: 8,
    });
  });

  it('falls back to user_id when the unit carries no owner_user_id', async () => {
    const { listener, objectIdentifierService } = makeListener({
      id: 'item-1',
      userId: 'user-1',
      ownerUserId: null,
      name: 'Headphones',
    });

    await listener.indexItem({ itemId: 'item-1' } as never);

    expect(objectIdentifierService.listForSubjects).toHaveBeenCalledWith('user-1', 'object_instance', [
      'item-1',
    ]);
  });

  it("indexes the catalog model's text so a query for the brand finds the owned unit", async () => {
    const { listener, productModelService, embeddingGenerationService, vectorService } = makeListener(
      { id: 'item-1', userId: 'user-1', name: 'Headphones', productId: 'product-1' },
      null,
      {
        product: {
          id: 'product-1',
          title: 'Bose QuietComfort 45',
          brand: 'Bose',
          modelNumber: 'QC45',
          category: 'Audio',
          subcategory: 'Headphones',
        },
      },
    );

    await listener.indexItem({ itemId: 'item-1' } as never);

    expect(productModelService.findById).toHaveBeenCalledWith({ userId: SYSTEM_USER }, 'product-1');
    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith(
      'Headphones Bose QuietComfort 45 Bose QC45 Audio',
    );

    const texts = vectorService.upsert.mock.calls[0][1].searchableText;
    expect(texts).toContainEqual({ text: 'Bose QuietComfort 45', weight: 5 });
    expect(texts).toContainEqual({ text: 'QC45', weight: 5 });
    expect(texts).toContainEqual({ text: 'Audio', weight: 3 });
  });

  it('skips the product lookup entirely when the unit is not linked to a model', async () => {
    const { listener, productModelService } = makeListener({
      id: 'item-1',
      userId: 'user-1',
      name: 'Headphones',
      productId: null,
    });

    await listener.indexItem({ itemId: 'item-1' } as never);

    expect(productModelService.findById).not.toHaveBeenCalled();
  });

  it('still indexes the unit when its product_id dangles', async () => {
    const { listener, embeddingGenerationService } = makeListener(
      { id: 'item-1', userId: 'user-1', name: 'Headphones', productId: 'gone' },
      null,
      { product: null },
    );

    await listener.indexItem({ itemId: 'item-1' } as never);

    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith('Headphones');
  });
});

describe('ItemSearchIndexListener — merge tombstones', () => {
  it('removes a tombstoned unit from BOTH stores instead of re-indexing it', async () => {
    const { listener, embeddingService, vectorService, embeddingGenerationService } = makeListener({
      id: 'loser',
      userId: 'user-1',
      name: 'Cordless drill',
      mergedIntoObjectId: 'winner',
    });

    await listener.updateItem({ itemId: 'loser' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'item', entityId: 'loser' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'item', entityId: 'loser' },
    );
    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(embeddingGenerationService.generateEmbedding).not.toHaveBeenCalled();
  });
});

describe('ItemSearchIndexListener.indexItem / updateItem', () => {
  it('is a no-op when the item cannot be found', async () => {
    const { listener, embeddingService, logger } = makeListener(null);

    await listener.indexItem({ itemId: 'ghost' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is a no-op when the item has no associated user', async () => {
    const { listener, embeddingService, placeService } = makeListener({
      id: 'item-1',
      userId: null,
      name: 'Cordless drill',
    });

    await listener.indexItem({ itemId: 'item-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    // No point resolving a place name for an item we are about to refuse to index.
    expect(placeService.findById).not.toHaveBeenCalled();
  });

  it('embeds and vectorizes an item scoped to its user', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'item-1',
      userId: 'user-1',
      name: 'Cordless drill',
      brand: 'DeWalt',
      lastSeenPlaceEntityId: null,
    });

    await listener.updateItem({ itemId: 'item-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'item', entityId: 'item-1', embedding: [0.1, 0.2] },
    );
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'item', entityId: 'item-1' }),
    );
  });

  it('skips both embedding and vectorization for an item with no searchable fields', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'item-2',
      userId: 'user-1',
      name: null,
      description: null,
      category: null,
      subcategory: null,
      brand: null,
      model: null,
      lastSeenPlaceEntityId: null,
      colors: null,
      materials: null,
    });

    await listener.indexItem({ itemId: 'item-2' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
  });
});

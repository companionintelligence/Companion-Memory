import { SYSTEM_USER } from '@ci/common/context';
import config from '@ci/configuration';

import { ReceiptSearchIndexListener } from '../ReceiptSearchIndexListener';

function makeListener(
  receipt: Record<string, unknown> | null = null,
  lines: Array<Record<string, unknown>> = [],
) {
  const receiptService = {
    findByIdWithLines: jest.fn().mockResolvedValue(receipt == null ? null : { receipt, lines }),
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

  const listener = new ReceiptSearchIndexListener(
    receiptService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    indexSkipService as never,
    vectorService as never,
    logger as never,
  );

  return {
    listener,
    receiptService,
    embeddingGenerationService,
    embeddingService,
    indexSkipService,
    vectorService,
    logger,
  };
}

describe('ReceiptSearchIndexListener.unindexReceipt', () => {
  it('removes the embedding and the vector for (receipt, id), under the system context', async () => {
    const { listener, embeddingService, vectorService } = makeListener();

    await listener.unindexReceipt({ receiptId: 'receipt-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'receipt', entityId: 'receipt-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'receipt', entityId: 'receipt-1' },
    );
  });
});

describe('ReceiptSearchIndexListener.indexReceipt / updateReceipt', () => {
  it('is a no-op when the receipt cannot be found', async () => {
    const { listener, embeddingService, vectorService, logger } = makeListener(null);

    await listener.indexReceipt({ receiptId: 'ghost' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('loads the lines with the header and folds their descriptions into the index text', async () => {
    const { listener, receiptService, embeddingGenerationService, vectorService } = makeListener(
      {
        id: 'receipt-1',
        userId: 'user-1',
        merchantName: 'Home Depot',
        orderNumber: 'WO-4417',
        purchasedAt: '2026-03-14T00:00:00.000Z',
        rawText: null,
      },
      [
        { description: 'Bosch dishwasher', brand: 'Bosch', modelNumber: 'SHX78' },
        { description: 'Delivery', brand: null, modelNumber: null },
      ],
    );

    await listener.indexReceipt({ receiptId: 'receipt-1' } as never);

    expect(receiptService.findByIdWithLines).toHaveBeenCalledWith({ userId: SYSTEM_USER }, 'receipt-1');
    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith(
      'Home Depot Bosch dishwasher Delivery Bosch SHX78 WO-4417 March 2026 spring 2026',
    );

    const texts = vectorService.upsert.mock.calls[0][1].searchableText;
    expect(vectorService.upsert.mock.calls[0][1].entityType).toBe('receipt');
    expect(texts).toContainEqual({ text: 'Home Depot', weight: 10 });
    expect(texts).toContainEqual({ text: 'WO-4417', weight: 8 });
    expect(texts).toContainEqual({ text: 'Bosch dishwasher Delivery', weight: 5 });
    expect(texts).toContainEqual({ text: 'Bosch SHX78', weight: 5 });
    expect(texts).toContainEqual({ text: 'March 2026 spring 2026', weight: 3 });
  });

  it('scopes the embedding to the receipt owner', async () => {
    const { listener, embeddingService } = makeListener({
      id: 'receipt-1',
      userId: 'user-1',
      merchantName: 'Home Depot',
    });

    await listener.updateReceipt({ receiptId: 'receipt-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'receipt', entityId: 'receipt-1', embedding: [0.1, 0.2] },
    );
  });

  it('records an index skip for a still-unextracted receipt, so the backfill sweep converges', async () => {
    const { listener, embeddingService, vectorService, indexSkipService } = makeListener({
      id: 'receipt-2',
      userId: 'user-1',
      merchantName: null,
      orderNumber: null,
      purchasedAt: null,
      rawText: null,
      channel: null,
      paymentMethod: null,
      paymentLast4: null,
      extractionState: 'pending',
    });

    await listener.indexReceipt({ receiptId: 'receipt-2' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(indexSkipService.recordSkip).toHaveBeenCalledWith({
      entityType: 'receipt',
      entityId: 'receipt-2',
      reason: 'empty',
    });
  });

  it('clears the skip once extraction fills the receipt in', async () => {
    const { listener, indexSkipService } = makeListener(
      { id: 'receipt-2', userId: 'user-1', merchantName: 'Home Depot', extractionState: 'extracted' },
      [{ description: 'Bosch dishwasher', brand: null, modelNumber: null }],
    );

    await listener.updateReceipt({ receiptId: 'receipt-2' } as never);

    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
      entityType: 'receipt',
      entityId: 'receipt-2',
    });
  });

  it('refuses to index a receipt with no associated user', async () => {
    const { listener, embeddingService, vectorService, logger } = makeListener({
      id: 'receipt-3',
      userId: null,
      merchantName: 'Home Depot',
    });

    await listener.indexReceipt({ receiptId: 'receipt-3' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('ReceiptSearchIndexListener CI_EMBED_TYPES allowlist', () => {
  const originalTypes = config.embedding.types;

  afterEach(() => {
    config.embedding.types = originalTypes;
  });

  it('skips embedding (but still vectorizes) a receipt when "receipt" is excluded from the allowlist', async () => {
    config.embedding.types = ['event'];

    const { listener, embeddingService, vectorService } = makeListener({
      id: 'receipt-1',
      userId: 'user-1',
      merchantName: 'Home Depot',
    });

    await listener.indexReceipt({ receiptId: 'receipt-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).toHaveBeenCalled();
  });
});

import { SYSTEM_USER } from '@ci/common/context';

import { BrowserActivitySearchIndexListener } from '../BrowserActivitySearchIndexListener';

function makeListener(activity: Record<string, unknown> | null = null) {
  const browserActivityService = { findById: jest.fn().mockResolvedValue(activity) };
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

  const listener = new BrowserActivitySearchIndexListener(
    browserActivityService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    indexSkipService as never,
    vectorService as never,
    logger as never,
  );

  return { listener, browserActivityService, embeddingService, indexSkipService, vectorService, logger };
}

describe('BrowserActivitySearchIndexListener.unindexBrowserActivity', () => {
  it('removes the embedding, the vector, and any skip marker for (browser-activity, id), under the system context', async () => {
    const { listener, embeddingService, vectorService, indexSkipService } = makeListener();

    await listener.unindexBrowserActivity({ browserActivityId: 'ba-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'browser-activity', entityId: 'ba-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'browser-activity', entityId: 'ba-1' },
    );
    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
      entityType: 'browser-activity',
      entityId: 'ba-1',
    });
  });
});

describe('BrowserActivitySearchIndexListener.indexBrowserActivity / updateBrowserActivity', () => {
  it('is a no-op when the row cannot be found', async () => {
    const { listener, embeddingService, logger } = makeListener(null);

    await listener.indexBrowserActivity({ browserActivityId: 'ghost' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is a no-op when the activity has no eager-loaded user relation', async () => {
    const { listener, embeddingService } = makeListener({
      id: 'ba-1',
      user: null,
      title: 'Some page',
      url: 'https://example.com',
    });

    await listener.indexBrowserActivity({ browserActivityId: 'ba-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
  });

  it('embeds and vectorizes a substantive page visit, scoped to its user, and clears any stale skip marker', async () => {
    const { listener, embeddingService, vectorService, indexSkipService } = makeListener({
      id: 'ba-1',
      user: { id: 'user-1' },
      title: 'How to bake sourdough bread at home',
      url: 'https://example.com/sourdough',
      properties: { description: 'A long-form baking guide' },
    });

    await listener.updateBrowserActivity({ browserActivityId: 'ba-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'browser-activity', entityId: 'ba-1', embedding: [0.1, 0.2] },
    );
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'browser-activity', entityId: 'ba-1' }),
    );
    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
      entityType: 'browser-activity',
      entityId: 'ba-1',
    });
  });

  // Skip-marker convergence: a bare, trivial, or too-short page title/url must
  // not burn an embedding call, and must leave a ci_search.index_skips row
  // behind — the same IndexSkipService gate CommunicationSearchIndexListener
  // uses — or the backfill sweep (LEFT JOIN on ci_search.embeddings) re-finds
  // this row on every run.
  it('skips embedding a trivial/too-short title and records a skip marker', async () => {
    const { listener, embeddingService, indexSkipService } = makeListener({
      id: 'ba-2',
      user: { id: 'user-1' },
      title: 'ok',
      url: null,
      properties: null,
    });

    await listener.indexBrowserActivity({ browserActivityId: 'ba-2' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).not.toHaveBeenCalled();
    expect(indexSkipService.recordSkip).toHaveBeenCalledTimes(1);
    expect(indexSkipService.recordSkip).toHaveBeenCalledWith({
      entityType: 'browser-activity',
      entityId: 'ba-2',
      reason: expect.any(String),
    });
  });

  it('skips both embedding and vectorization when there is no title, url, or description, recording an "empty" skip marker', async () => {
    const { listener, embeddingService, vectorService, indexSkipService } = makeListener({
      id: 'ba-3',
      user: { id: 'user-1' },
      title: null,
      url: null,
      properties: null,
    });

    await listener.indexBrowserActivity({ browserActivityId: 'ba-3' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(indexSkipService.recordSkip).toHaveBeenCalledWith({
      entityType: 'browser-activity',
      entityId: 'ba-3',
      reason: 'empty',
    });
  });
});

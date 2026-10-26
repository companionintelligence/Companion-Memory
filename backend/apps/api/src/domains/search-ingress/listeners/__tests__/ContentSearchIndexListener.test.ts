import { SYSTEM_USER } from '@ci/common/context';

import { ContentSearchIndexListener } from '../ContentSearchIndexListener';

function makeListener(content: Record<string, unknown> | null = null, embeddedIds: string[] = []) {
  const contentService = { findById: jest.fn().mockResolvedValue(content) };
  const embeddingGenerationService = { generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]) };
  const embeddingService = {
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
    existingEntityIds: jest.fn().mockResolvedValue(new Set<string>(embeddedIds)),
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

  const listener = new ContentSearchIndexListener(
    contentService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    indexSkipService as never,
    vectorService as never,
    logger as never,
  );

  return {
    listener,
    contentService,
    embeddingGenerationService,
    embeddingService,
    indexSkipService,
    vectorService,
    logger,
  };
}

const SUBSTANTIVE = {
  id: 'content-1',
  type: 'article',
  title: 'A real title',
  text: 'A substantive body of text about something searchable.',
  url: 'https://example.com/a',
  mimetype: 'text/html',
};

describe('ContentSearchIndexListener.indexRemove', () => {
  it('removes the embedding, the vector, and any skip marker for (content, id), under the system context', async () => {
    const { listener, embeddingService, vectorService, indexSkipService } = makeListener();

    await listener.unindexContent({ contentId: 'content-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'content', entityId: 'content-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'content', entityId: 'content-1' },
    );
    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
      entityType: 'content',
      entityId: 'content-1',
    });
  });
});

// Skip-marker convergence: a content row the listener examines but
// intentionally does NOT embed must leave a ci_search.index_skips row behind,
// or the backfill sweep (LEFT JOIN on ci_search.embeddings) re-finds it on
// every run. Ported from CommunicationSearchIndexListener, the reference
// implementation for this pattern.
describe('ContentSearchIndexListener.indexContent skip markers', () => {
  it('records a skip marker (and no embedding) for low-value content', async () => {
    // 'ok' is an exact trivial phrase AND below the min length — either way, a
    // skip reason, not an embedding.
    const { listener, embeddingService, indexSkipService } = makeListener({
      id: 'content-1',
      userId: 'user-1',
      type: null,
      title: null,
      text: 'ok',
      url: null,
      mimetype: null,
    });

    await listener.indexContent({ contentId: 'content-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).not.toHaveBeenCalled();
    expect(indexSkipService.recordSkip).toHaveBeenCalledTimes(1);
    expect(indexSkipService.recordSkip).toHaveBeenCalledWith({
      entityType: 'content',
      entityId: 'content-1',
      reason: expect.any(String),
    });
  });

  it('records an "empty" skip marker when there is no search document at all', async () => {
    const { listener, embeddingService, vectorService, indexSkipService } = makeListener({
      id: 'content-2',
      userId: 'user-1',
      type: null,
      title: null,
      text: null,
      url: null,
      mimetype: null,
    });

    await listener.indexContent({ contentId: 'content-2' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(indexSkipService.recordSkip).toHaveBeenCalledWith({
      entityType: 'content',
      entityId: 'content-2',
      reason: 'empty',
    });
  });

  it('clears any stale skip marker after a successful embed upsert', async () => {
    const { listener, embeddingService, indexSkipService } = makeListener({
      ...SUBSTANTIVE,
      userId: 'user-1',
    });

    await listener.indexContent({ contentId: 'content-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledTimes(1);
    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'content', entityId: 'content-1' }),
    );
    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
      entityType: 'content',
      entityId: 'content-1',
    });
  });

  it('entity-not-found is a warn, NOT a skip marker (transient — the row may land later)', async () => {
    const { listener, indexSkipService, logger } = makeListener(null);

    await listener.indexContent({ contentId: 'content-ghost' } as never);

    expect(logger.warn).toHaveBeenCalled();
    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).not.toHaveBeenCalled();
  });
});

describe('ContentSearchIndexListener owner-id resolution', () => {
  // This is the historical bug's exact regression surface: ci.content.user_id
  // used to persist NULL (see typeorm-relation-fk-insert-false), so the listener
  // was written to fall back to the eager-loaded `user.id` relation. Both inputs
  // must keep working.
  it('indexes using the scalar userId when present', async () => {
    const { listener, embeddingService } = makeListener({ ...SUBSTANTIVE, userId: 'user-scalar' });

    await listener.indexContent({ contentId: 'content-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-scalar' },
      expect.objectContaining({ entityType: 'content', entityId: 'content-1' }),
    );
  });

  it('falls back to the eager-loaded user relation when the scalar userId is null', async () => {
    const { listener, embeddingService } = makeListener({
      ...SUBSTANTIVE,
      userId: null,
      user: { id: 'user-relation' },
    });

    await listener.indexContent({ contentId: 'content-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-relation' },
      expect.objectContaining({ entityType: 'content' }),
    );
  });

  it('skips indexing entirely when NEITHER the scalar userId nor the relation is set', async () => {
    const { listener, embeddingService, vectorService, logger } = makeListener({
      ...SUBSTANTIVE,
      userId: null,
      user: null,
    });

    await listener.indexContent({ contentId: 'content-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no associated user'));
  });
});

describe('ContentSearchIndexListener.indexContent / updateContent', () => {
  it('is a no-op when the content row cannot be found (transient — not an error)', async () => {
    const { listener, embeddingService, vectorService, logger } = makeListener(null);

    await listener.indexContent({ contentId: 'ghost' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('embeds and vectorizes substantive content, scoped to its owner', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      ...SUBSTANTIVE,
      userId: 'user-1',
    });

    await listener.updateContent({ contentId: 'content-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'content', entityId: 'content-1', embedding: [0.1, 0.2] },
    );
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'content', entityId: 'content-1' }),
    );
  });

  // Same sweep-vs-pipeline re-drive race as the event listener: keep a vector
  // that already exists on a created content row, re-embed on an update.
  it('keeps an existing embedding on a created content row, but still refreshes the tsvector', async () => {
    const { listener, embeddingGenerationService, embeddingService, vectorService } = makeListener(
      { ...SUBSTANTIVE, userId: 'user-1' },
      ['content-1'],
    );

    await listener.indexContent({ contentId: 'content-1' } as never);

    expect(embeddingService.existingEntityIds).toHaveBeenCalledWith({ userId: 'user-1' }, 'content', [
      'content-1',
    ]);
    expect(embeddingGenerationService.generateEmbedding).not.toHaveBeenCalled();
    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'content', entityId: 'content-1' }),
    );
  });

  it('re-embeds UPDATED content even when an embedding exists (its text changed)', async () => {
    const { listener, embeddingGenerationService, embeddingService } = makeListener(
      { ...SUBSTANTIVE, userId: 'user-1' },
      ['content-1'],
    );

    await listener.updateContent({ contentId: 'content-1' } as never);

    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledTimes(1);
    expect(embeddingService.upsert).toHaveBeenCalledTimes(1);
  });

  it('skips both embedding and vectorization when there is no searchable content at all', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'content-2',
      userId: 'user-1',
      type: null,
      title: null,
      text: null,
      url: null,
      mimetype: null,
    });

    await listener.indexContent({ contentId: 'content-2' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
  });
});

import { SYSTEM_USER } from '@ci/common/context';

import { CommunicationSearchIndexListener } from '../CommunicationSearchIndexListener';

function makeListener(communication: Record<string, unknown> | null = null) {
  const communicationService = { findById: jest.fn().mockResolvedValue(communication) };
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

  const listener = new CommunicationSearchIndexListener(
    communicationService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    indexSkipService as never,
    vectorService as never,
    logger as never,
  );

  return {
    listener,
    communicationService,
    embeddingGenerationService,
    embeddingService,
    indexSkipService,
    vectorService,
    logger,
  };
}

// The removal handler is the cascade-delete that stops new orphans from row
// deletes (#1). It must delete BOTH the embedding and the vector for the
// (entity_type, entity_id) pair, under the system context, regardless of which
// user originally owned the row — plus any skip marker, so a re-created row
// with the same id is re-examined.
describe('CommunicationSearchIndexListener.indexRemove', () => {
  it('removes the embedding, the vector, and any skip marker keyed by (communication, id)', async () => {
    const { listener, embeddingService, vectorService, indexSkipService } = makeListener();

    await listener.indexRemove({ communicationId: 'comm-123' } as never);

    expect(embeddingService.remove).toHaveBeenCalledTimes(1);
    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'communication', entityId: 'comm-123' },
    );

    expect(vectorService.remove).toHaveBeenCalledTimes(1);
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'communication', entityId: 'comm-123' },
    );

    expect(indexSkipService.clearSkip).toHaveBeenCalledTimes(1);
    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
      entityType: 'communication',
      entityId: 'comm-123',
    });
  });
});

// Skip-marker convergence: a comm the listener examines but intentionally does
// NOT embed must leave a ci_search.index_skips row behind, or the backfill
// sweep (LEFT JOIN on ci_search.embeddings) re-finds it on every run.
describe('CommunicationSearchIndexListener.indexCreate skip markers', () => {
  it('records a skip marker (and no embedding) for a low-value communication', async () => {
    // 'ok' is an exact trivial phrase AND below the min length — either way, a
    // skip reason, not an embedding.
    const { listener, embeddingService, indexSkipService } = makeListener({
      id: 'comm-1',
      userId: 'user-1',
      subject: null,
      preview: null,
      content: 'ok',
    });

    await listener.indexCreate({ communicationId: 'comm-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).not.toHaveBeenCalled();
    expect(indexSkipService.recordSkip).toHaveBeenCalledTimes(1);
    expect(indexSkipService.recordSkip).toHaveBeenCalledWith({
      entityType: 'communication',
      entityId: 'comm-1',
      reason: expect.any(String),
    });
  });

  it('records an "empty" skip marker when there is no search content at all', async () => {
    const { listener, embeddingService, vectorService, indexSkipService } = makeListener({
      id: 'comm-2',
      userId: 'user-1',
      subject: null,
      preview: null,
      content: null,
    });

    await listener.indexCreate({ communicationId: 'comm-2' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(indexSkipService.recordSkip).toHaveBeenCalledWith({
      entityType: 'communication',
      entityId: 'comm-2',
      reason: 'empty',
    });
  });

  it('clears any stale skip marker after a successful embed upsert', async () => {
    const { listener, embeddingService, indexSkipService } = makeListener({
      id: 'comm-3',
      userId: 'user-1',
      subject: 'Quarterly planning',
      preview: null,
      content: 'Substantive message about the quarterly project plans.',
    });

    await listener.indexCreate({ communicationId: 'comm-3' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledTimes(1);
    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'communication', entityId: 'comm-3' }),
    );
    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
      entityType: 'communication',
      entityId: 'comm-3',
    });
  });

  it('entity-not-found is a warn, NOT a skip marker (transient — the row may land later)', async () => {
    const { listener, indexSkipService, logger } = makeListener(null);

    await listener.indexCreate({ communicationId: 'comm-4' } as never);

    expect(logger.warn).toHaveBeenCalled();
    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).not.toHaveBeenCalled();
  });
});

import { SYSTEM_USER } from '@ci/common/context';
import { embedSkipReason } from '@ci/common/embeddings';

import { ConceptSearchIndexListener } from '../ConceptSearchIndexListener';

function makeListener(concept: Record<string, unknown> | null = null) {
  const conceptService = { findById: jest.fn().mockResolvedValue(concept) };
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

  const listener = new ConceptSearchIndexListener(
    conceptService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    indexSkipService as never,
    vectorService as never,
    logger as never,
  );

  return {
    listener,
    conceptService,
    embeddingGenerationService,
    embeddingService,
    indexSkipService,
    vectorService,
    logger,
  };
}

describe('ConceptSearchIndexListener.unindexConcept', () => {
  it('removes the embedding, the vector, and any skip marker for (concept, id), under the system context', async () => {
    const { listener, embeddingService, vectorService, indexSkipService } = makeListener();

    await listener.unindexConcept({ conceptId: 'concept-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'concept', entityId: 'concept-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'concept', entityId: 'concept-1' },
    );
    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
      entityType: 'concept',
      entityId: 'concept-1',
    });
  });
});

describe('ConceptSearchIndexListener.indexConcept / updateConcept', () => {
  it('is a no-op when the concept cannot be found (warn, not a skip marker — the row may land later)', async () => {
    const { listener, embeddingService, vectorService, indexSkipService, logger } = makeListener(null);

    await listener.indexConcept({ conceptId: 'ghost' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).not.toHaveBeenCalled();
  });

  it('is a no-op when the concept has no associated user', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'concept-1',
      userId: null,
      name: 'Photography',
      description: 'A hobby',
    });

    await listener.indexConcept({ conceptId: 'concept-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
  });

  it('removes a concept the user asked Memory to forget instead of indexing it again on a later write', async () => {
    const { listener, embeddingGenerationService, embeddingService, vectorService, indexSkipService } =
      makeListener({
        id: 'concept-9',
        userId: 'user-1',
        name: 'Quillfeather Project',
        description: 'A side project',
        isActive: false,
      });

    await listener.updateConcept({ conceptId: 'concept-9' } as never);

    expect(embeddingGenerationService.generateEmbedding).not.toHaveBeenCalled();
    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'concept', entityId: 'concept-9' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'concept', entityId: 'concept-9' },
    );
    // Absent by the user's choice, not for want of text: no skip marker either way.
    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).not.toHaveBeenCalled();
  });

  it('embeds and vectorizes a concept scoped to its user, passing the generated embedding through', async () => {
    const { listener, embeddingGenerationService, embeddingService, vectorService, indexSkipService } =
      makeListener({
        id: 'concept-1',
        userId: 'user-1',
        name: 'Photography',
        description: 'A creative hobby',
      });

    await listener.updateConcept({ conceptId: 'concept-1' } as never);

    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith('Photography A creative hobby');
    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'concept', entityId: 'concept-1', embedding: [0.1, 0.2] },
    );
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      {
        entityType: 'concept',
        entityId: 'concept-1',
        searchableText: [
          { text: 'Photography', weight: 10 },
          { text: 'A creative hobby', weight: 5 },
        ],
      },
    );
    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
      entityType: 'concept',
      entityId: 'concept-1',
    });
  });

  it('records an "empty" skip marker (and skips both embedding and vectorization) for a concept with no name or description', async () => {
    const { listener, embeddingService, vectorService, indexSkipService } = makeListener({
      id: 'concept-2',
      userId: 'user-1',
      name: null,
      description: null,
    });

    await listener.indexConcept({ conceptId: 'concept-2' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(indexSkipService.recordSkip).toHaveBeenCalledWith({
      entityType: 'concept',
      entityId: 'concept-2',
      reason: 'empty',
    });
  });

  it('removes the stale embedding and tsvector when a concept loses its name and description', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'concept-2',
      userId: 'user-1',
      name: null,
      description: null,
    });

    await listener.updateConcept({ conceptId: 'concept-2' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'concept', entityId: 'concept-2' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'concept', entityId: 'concept-2' },
    );
  });

  // getSearchDocument dedupes via a Set — an identical name and description
  // must not double up in the embedded document.
  it('dedupes the embedded document when name and description are identical', async () => {
    const { listener, embeddingGenerationService } = makeListener({
      id: 'concept-3',
      userId: 'user-1',
      name: 'Same text',
      description: 'Same text',
    });

    await listener.indexConcept({ conceptId: 'concept-3' } as never);

    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith('Same text');
  });

  // Concept names that the message-tuned embedSkipReason heuristics reject.
  // Gating concepts on those heuristics is destructive: concept isn't in
  // PIPELINE_COVERED_STAGES (so the backfill sweep anti-joins skip-marked rows
  // out of every future run) and the bulk graph upsert path emits no per-row
  // event, so the marker can never be cleared and the concept disappears from
  // semantic search for good. These are real names — 'Concept' is the default
  // entity type for un-typed imported entities, which never carry a description.
  const NAMES_THE_SHARED_HEURISTIC_REJECTS = [
    'Node.js',
    'React.js',
    'socket.io',
    'github.com',
    'invoice.pdf',
    'AI',
    'ML',
    '3D',
  ];

  it.each(NAMES_THE_SHARED_HEURISTIC_REJECTS)('embeds the concept named %s, unmarked', async (name) => {
    // Pin the premise with the real shared helper rather than a mock: each of
    // these IS 'url-only'/'too-short' to embedSkipReason, which is exactly why
    // the listener must not delegate its skip decision to it.
    expect(embedSkipReason(name)).not.toBeNull();

    const { listener, embeddingGenerationService, embeddingService, indexSkipService } = makeListener({
      id: 'concept-4',
      userId: 'user-1',
      name,
      description: null,
    });

    await listener.indexConcept({ conceptId: 'concept-4' } as never);

    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith(name);
    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'concept', entityId: 'concept-4', embedding: [0.1, 0.2] },
    );
    expect(indexSkipService.recordSkip).not.toHaveBeenCalled();
    expect(indexSkipService.clearSkip).toHaveBeenCalledWith({
      entityType: 'concept',
      entityId: 'concept-4',
    });
  });
});

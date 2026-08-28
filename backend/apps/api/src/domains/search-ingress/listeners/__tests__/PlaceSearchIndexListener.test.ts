import { SYSTEM_USER } from '@ci/common/context';
import config from '@ci/configuration';

import { PlaceSearchIndexListener } from '../PlaceSearchIndexListener';

function makeListener(place: Record<string, unknown> | null = null) {
  const placeService = { findById: jest.fn().mockResolvedValue(place) };
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

  const listener = new PlaceSearchIndexListener(
    placeService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    vectorService as never,
    logger as never,
  );

  return { listener, placeService, embeddingService, vectorService, logger };
}

describe('PlaceSearchIndexListener.unindexPlace', () => {
  it('removes the embedding and the vector for (place, id), under the system context', async () => {
    const { listener, embeddingService, vectorService } = makeListener();

    await listener.unindexPlace({ placeId: 'place-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'place', entityId: 'place-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'place', entityId: 'place-1' },
    );
  });
});

describe('PlaceSearchIndexListener.indexPlace / updatePlace', () => {
  it('is a no-op when the place cannot be found', async () => {
    const { listener, embeddingService, logger } = makeListener(null);

    await listener.indexPlace({ placeId: 'ghost' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is a no-op when the place has no eager-loaded user relation', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'place-1',
      user: null,
      name: 'Coffee shop',
    });

    await listener.indexPlace({ placeId: 'place-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
  });

  it('embeds and vectorizes a place scoped to its user, folding in the properties.type field', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'place-1',
      user: { id: 'user-1' },
      name: 'Blue Bottle',
      description: 'Our usual coffee spot',
      properties: { type: 'cafe' },
    });

    await listener.updatePlace({ placeId: 'place-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'place', entityId: 'place-1', embedding: [0.1, 0.2] },
    );
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      {
        entityType: 'place',
        entityId: 'place-1',
        searchableText: [
          { text: 'Blue Bottle', weight: 10 },
          { text: 'Our usual coffee spot', weight: 5 },
          { text: 'cafe', weight: 3 },
        ],
      },
    );
  });

  it('ignores a non-string properties.type rather than crashing', async () => {
    const { listener, embeddingService } = makeListener({
      id: 'place-2',
      user: { id: 'user-1' },
      name: 'Somewhere',
      properties: { type: 42 },
    });

    await listener.indexPlace({ placeId: 'place-2' } as never);

    expect(embeddingService.upsert).toHaveBeenCalled(); // name alone is enough
  });

  it('skips both embedding and vectorization for a place with no searchable fields', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'place-3',
      user: { id: 'user-1' },
      name: null,
      description: null,
      properties: null,
    });

    await listener.indexPlace({ placeId: 'place-3' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
  });

  describe('CI_EMBED_TYPES allowlist', () => {
    const originalTypes = config.embedding.types;

    afterEach(() => {
      config.embedding.types = originalTypes;
    });

    it('skips embedding (but still vectorizes) a place when "place" is excluded from the allowlist', async () => {
      config.embedding.types = ['event'];

      const { listener, embeddingService, vectorService } = makeListener({
        id: 'place-4',
        user: { id: 'user-1' },
        name: 'Blue Bottle',
        description: 'Our usual coffee spot',
      });

      await listener.indexPlace({ placeId: 'place-4' } as never);

      expect(embeddingService.upsert).not.toHaveBeenCalled();
      expect(vectorService.upsert).toHaveBeenCalled();
    });
  });
});

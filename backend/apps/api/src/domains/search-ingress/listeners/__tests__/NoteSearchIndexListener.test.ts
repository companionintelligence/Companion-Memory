import { SYSTEM_USER } from '@ci/common/context';
import config from '@ci/configuration';

import { NoteSearchIndexListener } from '../NoteSearchIndexListener';

function makeListener(note: Record<string, unknown> | null = null) {
  const notesService = { findById: jest.fn().mockResolvedValue(note) };
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

  const listener = new NoteSearchIndexListener(
    notesService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    vectorService as never,
    logger as never,
  );

  return { listener, notesService, embeddingService, vectorService, logger };
}

describe('NoteSearchIndexListener.unindexNote', () => {
  it('removes the embedding and the vector for (note, id), under the system context', async () => {
    const { listener, embeddingService, vectorService } = makeListener();

    await listener.unindexNote({ noteId: 'note-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'note', entityId: 'note-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'note', entityId: 'note-1' },
    );
  });
});

describe('NoteSearchIndexListener.indexNote / updateNote', () => {
  it('is a no-op when the note cannot be found', async () => {
    const { listener, embeddingService, logger } = makeListener(null);

    await listener.indexNote({ noteId: 'ghost' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('embeds and vectorizes a note scoped to its user, title weighted above content', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'note-1',
      userId: 'user-1',
      title: 'Grocery list',
      content: 'Milk, eggs, bread',
    });

    await listener.indexNote({ noteId: 'note-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'note', entityId: 'note-1', embedding: [0.1, 0.2] },
    );
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      {
        entityType: 'note',
        entityId: 'note-1',
        searchableText: [
          { text: 'Grocery list', weight: 10 },
          { text: 'Milk, eggs, bread', weight: 5 },
        ],
      },
    );
  });

  it('updateNote re-indexes an existing note the same way', async () => {
    const { listener, embeddingService } = makeListener({
      id: 'note-1',
      userId: 'user-1',
      title: 'Updated title',
      content: 'Updated body',
    });

    await listener.updateNote({ noteId: 'note-1' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'note', entityId: 'note-1' }),
    );
  });

  it('skips both embedding and vectorization for a note with no title and no content', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'note-2',
      userId: 'user-1',
      title: null,
      content: null,
    });

    await listener.indexNote({ noteId: 'note-2' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
  });

  it('indexes on title alone when there is no content', async () => {
    const { listener, embeddingService } = makeListener({
      id: 'note-3',
      userId: 'user-1',
      title: 'Just a title',
      content: null,
    });

    await listener.indexNote({ noteId: 'note-3' } as never);

    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'note' }),
    );
  });

  describe('CI_EMBED_TYPES allowlist', () => {
    const originalTypes = config.embedding.types;

    afterEach(() => {
      config.embedding.types = originalTypes;
    });

    it('skips embedding (but still vectorizes) a note when "note" is excluded from the allowlist', async () => {
      config.embedding.types = ['event'];

      const { listener, embeddingService, vectorService } = makeListener({
        id: 'note-4',
        userId: 'user-1',
        title: 'Grocery list',
        content: 'Milk, eggs, bread',
      });

      await listener.indexNote({ noteId: 'note-4' } as never);

      expect(embeddingService.upsert).not.toHaveBeenCalled();
      expect(vectorService.upsert).toHaveBeenCalled();
    });
  });
});

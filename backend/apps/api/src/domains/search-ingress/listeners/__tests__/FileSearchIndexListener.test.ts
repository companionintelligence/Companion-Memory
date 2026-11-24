import { SYSTEM_USER } from '@ci/common/context';

import { FileSearchIndexListener } from '../FileSearchIndexListener';

function makeListener(file: Record<string, unknown> | null = null) {
  const fileService = { findById: jest.fn().mockResolvedValue(file) };
  const embeddingGenerationService = { generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]) };
  const embeddingService = {
    upsertDocument: jest.fn(
      async (_ctx: unknown, data: { text: string }, generate: (text: string) => Promise<number[]>) => {
        await generate(data.text);

        return 'embedded';
      },
    ),
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
  };
  const vectorService = {
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const listener = new FileSearchIndexListener(
    fileService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    vectorService as never,
    logger as never,
  );

  return { listener, fileService, embeddingService, vectorService, logger };
}

const SUBSTANTIVE_FILE = {
  id: 'file-1',
  userId: 'user-1',
  title: 'Vacation photo',
  description: 'Beach trip 2026',
  filename: 'beach.jpg',
  contentType: 'image/jpeg',
};

describe('FileSearchIndexListener.unindexFile', () => {
  it('removes the embedding and the vector for (file, id), under the system context', async () => {
    const { listener, embeddingService, vectorService } = makeListener();

    await listener.unindexFile({ fileId: 'file-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'file', entityId: 'file-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'file', entityId: 'file-1' },
    );
  });
});

// Three distinct events converge on the same upsert (indexFile / indexUploadedFile
// / updateFile) — a regression that disconnects any ONE of them from `upsertFile`
// would silently stop indexing files created that way. Each is exercised
// separately rather than assumed identical.
describe('FileSearchIndexListener — every creation-path event indexes the file', () => {
  it('indexFile (FileCreatedEvent) embeds and vectorizes, scoped to the owner', async () => {
    const { listener, embeddingService, vectorService } = makeListener(SUBSTANTIVE_FILE);

    await listener.indexFile({ fileId: 'file-1' } as never);

    expect(embeddingService.upsertDocument).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'file', entityId: 'file-1', text: expect.any(String) },
      expect.any(Function),
    );
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'file', entityId: 'file-1' }),
    );
  });

  it('indexUploadedFile (FileUploadedEvent) also indexes the file', async () => {
    const { listener, embeddingService } = makeListener(SUBSTANTIVE_FILE);

    await listener.indexUploadedFile({ fileId: 'file-1' } as never);

    expect(embeddingService.upsertDocument).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'file', entityId: 'file-1' }),
      expect.any(Function),
    );
  });

  it('updateFile (FileUpdatedEvent) re-indexes the file', async () => {
    const { listener, embeddingService } = makeListener(SUBSTANTIVE_FILE);

    await listener.updateFile({ fileId: 'file-1' } as never);

    expect(embeddingService.upsertDocument).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'file', entityId: 'file-1' }),
      expect.any(Function),
    );
  });
});

describe('FileSearchIndexListener upsert guards', () => {
  it('is a no-op when the file cannot be found', async () => {
    const { listener, embeddingService, logger } = makeListener(null);

    await listener.indexFile({ fileId: 'ghost' } as never);

    expect(embeddingService.upsertDocument).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is a no-op when the file has no associated user', async () => {
    const { listener, embeddingService } = makeListener({ ...SUBSTANTIVE_FILE, userId: null });

    await listener.indexFile({ fileId: 'file-1' } as never);

    expect(embeddingService.upsertDocument).not.toHaveBeenCalled();
  });

  it('skips both embedding and vectorization for a file with no searchable metadata', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'file-2',
      userId: 'user-1',
      title: null,
      description: null,
      filename: null,
      contentType: null,
    });

    await listener.indexFile({ fileId: 'file-2' } as never);

    expect(embeddingService.upsertDocument).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
  });
});

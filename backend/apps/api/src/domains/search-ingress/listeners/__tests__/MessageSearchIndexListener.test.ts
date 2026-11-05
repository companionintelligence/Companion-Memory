import { SYSTEM_USER } from '@ci/common/context';

import { MessageSearchIndexListener } from '../MessageSearchIndexListener';

// The handlers depend only on their injected services, so we instantiate the
// listener with targeted stubs and call them directly (mirrors the no-op-deps
// style of EventSearchIndexListener.test.ts). This locks in the create/remove
// symmetry for the recall 'message' channel: a created fragment is embedded,
// and a removed fragment's embedding is reaped so it can't orphan in
// ci_search.embeddings.

// The constructor calls logger.setContext; the handlers call logger.log.
const logger = { setContext: () => undefined, log: () => undefined } as never;

describe('MessageSearchIndexListener.removeMessage', () => {
  it("reaps the fragment's 'message' embedding under the system user", async () => {
    const embeddingService = {
      upsertDocument: jest.fn(
        async (_ctx: unknown, data: { text: string }, generate: (text: string) => Promise<number[]>) => {
          await generate(data.text);

          return 'embedded';
        },
      ),
      remove: jest.fn().mockResolvedValue(true),
    };
    const listener = new MessageSearchIndexListener(null as never, embeddingService as never, logger);

    await listener.removeMessage({ memoryId: 'mem-1', userId: 'user-1' });

    // entityId is the fragment's memoryId; 'message' has no vector/tsvector
    // row, so only the embedding is removed (no vectorService is injected).
    expect(embeddingService.remove).toHaveBeenCalledTimes(1);
    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'message', entityId: 'mem-1' },
    );
  });
});

describe('MessageSearchIndexListener.indexMessage', () => {
  it('embeds the raw fragment content under entity_type message', async () => {
    const embeddingGenerationService = { generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]) };
    const embeddingService = {
      upsertDocument: jest.fn(
        async (_ctx: unknown, data: { text: string }, generate: (text: string) => Promise<number[]>) => {
          await generate(data.text);

          return 'embedded';
        },
      ),
      upsert: jest.fn().mockResolvedValue(null),
    };
    const listener = new MessageSearchIndexListener(
      embeddingGenerationService as never,
      embeddingService as never,
      logger,
    );

    await listener.indexMessage({ memoryId: 'mem-2', userId: 'user-2', content: 'hello world' });

    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith('hello world');
    expect(embeddingService.upsertDocument).toHaveBeenCalledWith(
      { userId: 'user-2' },
      { entityType: 'message', entityId: 'mem-2', text: expect.any(String) },
      expect.any(Function),
    );
  });

  it('skips empty/whitespace-only fragments without embedding', async () => {
    const embeddingGenerationService = { generateEmbedding: jest.fn() };
    const embeddingService = {
      upsertDocument: jest.fn(
        async (_ctx: unknown, data: { text: string }, generate: (text: string) => Promise<number[]>) => {
          await generate(data.text);

          return 'embedded';
        },
      ),
      upsert: jest.fn(),
    };
    const listener = new MessageSearchIndexListener(
      embeddingGenerationService as never,
      embeddingService as never,
      logger,
    );

    await listener.indexMessage({ memoryId: 'mem-3', userId: 'user-3', content: '   ' });

    expect(embeddingGenerationService.generateEmbedding).not.toHaveBeenCalled();
    expect(embeddingService.upsertDocument).not.toHaveBeenCalled();
  });
});

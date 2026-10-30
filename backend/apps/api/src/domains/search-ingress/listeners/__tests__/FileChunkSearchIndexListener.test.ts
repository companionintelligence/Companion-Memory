import type { Acknowledgement } from '@ci/domains/events';
import type { DocumentParsedPayload } from '@ci/domains/parsing';

import { FileChunkSearchIndexListener } from '../FileChunkSearchIndexListener';

function makeAck(): Acknowledgement {
  return { jobId: 'test-job', done: jest.fn(), fail: jest.fn(), defer: jest.fn() };
}

function makeListener(chunks: Record<string, unknown>[], alreadyEmbeddedIds: string[] = []) {
  const chunkService = { findByIds: jest.fn().mockResolvedValue(chunks) };
  const embeddingGenerationService = {
    generateEmbeddings: jest
      .fn()
      .mockImplementation(async (inputs: string[]) => inputs.map(() => [0.1, 0.2])),
  };
  const embeddingService = {
    upsert: jest.fn().mockResolvedValue(null),
    existingEntityIds: jest.fn().mockResolvedValue(new Set(alreadyEmbeddedIds)),
  };
  const vectorService = { upsert: jest.fn().mockResolvedValue(null) };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const listener = new FileChunkSearchIndexListener(
    chunkService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    vectorService as never,
    logger as never,
  );

  // @OnEvent wraps the descriptor at class-definition time in an
  // autoAcknowledge try/catch (see OnEvent.ts): it calls ack.done() when the
  // wrapped promise resolves and ack.fail() when it rejects, and never lets
  // the rejection reach the caller. Calling through this same wrapper — the
  // same path pg-boss's worker drives — is what makes the throw-vs-swallow
  // fix observable.
  const call = (payload: DocumentParsedPayload, ack: Acknowledgement) =>
    (
      listener as unknown as {
        indexChunks: (p: DocumentParsedPayload, a: Acknowledgement) => Promise<void>;
      }
    ).indexChunks(payload, ack);

  return { call, chunkService, embeddingGenerationService, embeddingService, vectorService, logger };
}

function chunk(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chunk-1',
    userId: 'user-1',
    fileId: 'file-1',
    sectionTitle: null,
    content: 'Some chunk text.',
    ...overrides,
  };
}

describe('FileChunkSearchIndexListener.indexChunks', () => {
  it('looks up every chunk id from the payload and indexes each one, scoped to its own user', async () => {
    const { call, chunkService, embeddingGenerationService, embeddingService, vectorService } = makeListener([
      chunk({ id: 'c1', userId: 'user-1', content: 'First chunk of text.' }),
      chunk({ id: 'c2', userId: 'user-2', content: 'Second chunk of text.' }),
    ]);
    const ack = makeAck();

    await call({ fileId: 'file-1', userId: 'user-1', chunkIds: ['c1', 'c2'] } as never, ack);

    // Read as the document's owner the event names, never across every user's chunks.
    expect(chunkService.findByIds).toHaveBeenCalledWith({ userId: 'user-1' }, ['c1', 'c2']);
    // One batched call over both chunks' content, not one call per chunk.
    expect(embeddingGenerationService.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(embeddingGenerationService.generateEmbeddings).toHaveBeenCalledWith([
      'First chunk of text.',
      'Second chunk of text.',
    ]);
    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ entityType: 'file-chunk', entityId: 'c1' }),
    );
    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-2' },
      expect.objectContaining({ entityType: 'file-chunk', entityId: 'c2' }),
    );
    expect(vectorService.upsert).toHaveBeenCalledTimes(2);
    expect(ack.done).toHaveBeenCalledTimes(1);
    expect(ack.fail).not.toHaveBeenCalled();
  });

  it('weights an available sectionTitle above the chunk content', async () => {
    const { call, vectorService } = makeListener([
      chunk({ sectionTitle: 'Introduction', content: 'The chunk body.' }),
    ]);

    await call({ fileId: 'file-1', chunkIds: ['chunk-1'] } as never, makeAck());

    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        searchableText: [
          { text: 'Introduction', weight: 8 },
          { text: 'The chunk body.', weight: 3 },
        ],
      }),
    );
  });

  it('omits the sectionTitle entry when the chunk has none', async () => {
    const { call, vectorService } = makeListener([chunk({ sectionTitle: null, content: 'Body only.' })]);

    await call({ fileId: 'file-1', chunkIds: ['chunk-1'] } as never, makeAck());

    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ searchableText: [{ text: 'Body only.', weight: 3 }] }),
    );
  });

  /**
   * The bug: every chunk failing to embed was swallowed by a per-chunk
   * try/catch that only logged a warning, so indexChunks still returned
   * normally and OnEvent's autoAcknowledge wrapper called ack.done() — pg-boss
   * marked the job "done" even though nothing was indexed. Because file-chunk
   * has no backfill sweep or pipeline stage, a transient Ollama outage during
   * parsing permanently and silently dropped that document's searchability.
   * Throwing routes it to ack.fail() instead, so pg-boss can retry/dead-letter it.
   */
  it('fails the job (ack.fail) when every chunk fails to embed, instead of silently ack.done()-ing it', async () => {
    const { call, embeddingGenerationService, embeddingService, vectorService, logger } = makeListener([
      chunk({ id: 'c1', content: 'First chunk.' }),
      chunk({ id: 'c2', content: 'Second chunk.' }),
    ]);
    const ack = makeAck();
    const embedError = new Error('ollama unreachable');
    embeddingGenerationService.generateEmbeddings.mockRejectedValue(embedError);

    await expect(call({ fileId: 'file-1', chunkIds: ['c1', 'c2'] } as never, ack)).resolves.toBeUndefined();

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(ack.done).not.toHaveBeenCalled();
    expect(ack.fail).toHaveBeenCalledTimes(1);
    expect(ack.fail).toHaveBeenCalledWith(embedError);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Embedding call failed for 2 chunks'),
      expect.any(Error),
    );
  });

  /**
   * The embedding call is batched (one Ollama round trip for the whole
   * document), so a single chunk can no longer fail it independently — but a
   * per-row write failure must still be isolated to that chunk (the others
   * still get written), while the job as a whole still fails since there is
   * no sweep to catch a partially-indexed document later.
   */
  it('still writes the chunks that succeed when one fails to persist, but fails the job overall', async () => {
    const { call, embeddingService, vectorService, logger } = makeListener([
      chunk({ id: 'c1', content: 'Good chunk one.' }),
      chunk({ id: 'c2', content: 'Bad chunk.' }),
      chunk({ id: 'c3', content: 'Good chunk three.' }),
    ]);
    const ack = makeAck();
    const writeError = new Error('db write failed');
    embeddingService.upsert.mockImplementation(async (_ctx: unknown, dto: { entityId: string }) => {
      if (dto.entityId === 'c2') {
        throw writeError;
      }

      return null;
    });

    await expect(
      call({ fileId: 'file-1', chunkIds: ['c1', 'c2', 'c3'] } as never, ack),
    ).resolves.toBeUndefined();

    expect(embeddingService.upsert).toHaveBeenCalledTimes(3);
    // The failed chunk's vector write is skipped — it throws before reaching it.
    expect(vectorService.upsert).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to index chunk, continuing',
      expect.objectContaining({ chunkId: 'c2', error: 'db write failed' }),
    );
    expect(ack.done).not.toHaveBeenCalled();
    expect(ack.fail).toHaveBeenCalledTimes(1);
    expect(ack.fail).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('c2') }),
    );
  });

  /**
   * The maintenance sweep re-drives this listener for chunks that already have
   * an embedding but no device document, so the listener must not pay for the
   * model again — it only has to write the index statement.
   */
  it('re-embeds nothing when every chunk already has an embedding, but still indexes and acks', async () => {
    const { call, embeddingGenerationService, embeddingService, vectorService } = makeListener(
      [chunk({ id: 'c1', content: 'First chunk.' }), chunk({ id: 'c2', content: 'Second chunk.' })],
      ['c1', 'c2'],
    );
    const ack = makeAck();

    await call({ fileId: 'file-1', userId: 'user-1', chunkIds: ['c1', 'c2'] } as never, ack);

    expect(embeddingService.existingEntityIds).toHaveBeenCalledWith({ userId: 'user-1' }, 'file-chunk', [
      'c1',
      'c2',
    ]);
    expect(embeddingGenerationService.generateEmbeddings).not.toHaveBeenCalled();
    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).toHaveBeenCalledTimes(2);
    expect(ack.done).toHaveBeenCalledTimes(1);
    expect(ack.fail).not.toHaveBeenCalled();
  });

  it('embeds only the chunks that have no embedding yet, and indexes all of them', async () => {
    const { call, embeddingGenerationService, embeddingService, vectorService } = makeListener(
      [
        chunk({ id: 'c1', content: 'Already embedded.' }),
        chunk({ id: 'c2', content: 'Missing embedding.' }),
        chunk({ id: 'c3', content: 'Also missing.' }),
      ],
      ['c1'],
    );
    const ack = makeAck();

    await call({ fileId: 'file-1', userId: 'user-1', chunkIds: ['c1', 'c2', 'c3'] } as never, ack);

    expect(embeddingGenerationService.generateEmbeddings).toHaveBeenCalledTimes(1);
    expect(embeddingGenerationService.generateEmbeddings).toHaveBeenCalledWith([
      'Missing embedding.',
      'Also missing.',
    ]);
    expect(embeddingService.upsert).toHaveBeenCalledTimes(2);
    expect(embeddingService.upsert).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityId: 'c1' }),
    );
    expect(vectorService.upsert).toHaveBeenCalledTimes(3);
    expect(ack.done).toHaveBeenCalledTimes(1);
    expect(ack.fail).not.toHaveBeenCalled();
  });

  it('is a no-op with no chunks found for the payload ids', async () => {
    const { call, embeddingGenerationService, embeddingService, vectorService } = makeListener([]);
    const ack = makeAck();

    await call({ fileId: 'file-1', chunkIds: ['missing'] } as never, ack);

    expect(embeddingGenerationService.generateEmbeddings).not.toHaveBeenCalled();
    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
    expect(ack.done).toHaveBeenCalledTimes(1);
    expect(ack.fail).not.toHaveBeenCalled();
  });
});

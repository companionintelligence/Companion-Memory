import { SYSTEM_USER } from '@ci/common/context';

import { AnswerSearchIndexListener } from '../AnswerSearchIndexListener';

function makeListener(answer: Record<string, unknown> | null = null) {
  const answerService = { findById: jest.fn().mockResolvedValue(answer) };
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

  const listener = new AnswerSearchIndexListener(
    answerService as never,
    embeddingGenerationService as never,
    embeddingService as never,
    vectorService as never,
    logger as never,
  );

  return { listener, answerService, embeddingService, vectorService, logger };
}

describe('AnswerSearchIndexListener.unindexAnswer', () => {
  it('removes the embedding and the vector for (answer, id), under the system context', async () => {
    const { listener, embeddingService, vectorService } = makeListener();

    await listener.unindexAnswer({ answerId: 'answer-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'answer', entityId: 'answer-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'answer', entityId: 'answer-1' },
    );
  });
});

describe('AnswerSearchIndexListener.indexAnswer / updateAnswer', () => {
  it('is a no-op when the answer cannot be found', async () => {
    const { listener, embeddingService, logger } = makeListener(null);

    await listener.indexAnswer({ answerId: 'ghost' } as never);

    expect(embeddingService.upsertDocument).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is a no-op when the answer has no eager-loaded user relation', async () => {
    const { listener, embeddingService } = makeListener({
      id: 'answer-1',
      user: null,
      answer: 'Yes, twice last year.',
    });

    await listener.indexAnswer({ answerId: 'answer-1' } as never);

    expect(embeddingService.upsertDocument).not.toHaveBeenCalled();
  });

  it("embeds and vectorizes an answer's text alongside its question, scoped to its user", async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'answer-1',
      user: { id: 'user-1' },
      answer: 'Yes, twice last year.',
      question: { text: 'Have you been to Japan?' },
    });

    await listener.updateAnswer({ answerId: 'answer-1' } as never);

    expect(embeddingService.upsertDocument).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'answer', entityId: 'answer-1', text: expect.any(String) },
      expect.any(Function),
    );
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      {
        entityType: 'answer',
        entityId: 'answer-1',
        searchableText: [
          { text: 'Yes, twice last year.', weight: 10 },
          { text: 'Have you been to Japan?', weight: 5 },
        ],
      },
    );
  });

  it('still indexes on the answer text alone when the question has no text', async () => {
    const { listener, embeddingService } = makeListener({
      id: 'answer-2',
      user: { id: 'user-1' },
      answer: 'No.',
      question: null,
    });

    await listener.indexAnswer({ answerId: 'answer-2' } as never);

    expect(embeddingService.upsertDocument).toHaveBeenCalled();
  });

  it('skips both embedding and vectorization when there is no answer text and no question text', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      id: 'answer-3',
      user: { id: 'user-1' },
      answer: null,
      question: null,
    });

    await listener.indexAnswer({ answerId: 'answer-3' } as never);

    expect(embeddingService.upsertDocument).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
  });
});

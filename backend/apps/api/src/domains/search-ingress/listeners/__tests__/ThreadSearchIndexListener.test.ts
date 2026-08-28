import { SYSTEM_USER } from '@ci/common/context';

import { ThreadSearchIndexListener } from '../ThreadSearchIndexListener';

function makeListener(
  options: {
    thread?: Record<string, unknown> | null;
    messages?: Record<string, unknown>[];
    message?: Record<string, unknown> | null;
  } = {},
) {
  const embeddingGenerationService = { generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2]) };
  const embeddingService = {
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
  };
  const messageService = {
    findById: jest.fn().mockResolvedValue(options.message ?? null),
    findByThreadId: jest.fn().mockResolvedValue(options.messages ?? []),
  };
  const threadService = { findById: jest.fn().mockResolvedValue(options.thread ?? null) };
  const vectorService = {
    upsert: jest.fn().mockResolvedValue(null),
    remove: jest.fn().mockResolvedValue(true),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const listener = new ThreadSearchIndexListener(
    embeddingGenerationService as never,
    embeddingService as never,
    messageService as never,
    threadService as never,
    vectorService as never,
    logger as never,
  );

  return {
    listener,
    embeddingGenerationService,
    embeddingService,
    messageService,
    threadService,
    vectorService,
    logger,
  };
}

const SUBSTANTIVE_THREAD = {
  id: 'thread-1',
  user: { id: 'user-1' },
  name: 'Trip planning',
  description: null,
};

describe('ThreadSearchIndexListener.unindexThread', () => {
  it('removes the embedding and the vector for (thread, id), under the system context', async () => {
    const { listener, embeddingService, vectorService } = makeListener();

    await listener.unindexThread({ threadId: 'thread-1' } as never);

    expect(embeddingService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'thread', entityId: 'thread-1' },
    );
    expect(vectorService.remove).toHaveBeenCalledWith(
      { userId: SYSTEM_USER },
      { entityType: 'thread', entityId: 'thread-1' },
    );
  });
});

describe('ThreadSearchIndexListener.indexThread / updateThread', () => {
  it('is a no-op when the thread cannot be found', async () => {
    const { listener, embeddingService, logger } = makeListener({ thread: null });

    await listener.indexThread({ threadId: 'ghost' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('is a no-op when the thread has no eager-loaded user relation', async () => {
    const { listener, embeddingService } = makeListener({ thread: { id: 'thread-1', user: null } });

    await listener.indexThread({ threadId: 'thread-1' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
  });

  it('embeds and vectorizes the thread name/description PLUS every message in it', async () => {
    const { listener, embeddingGenerationService, embeddingService, vectorService, messageService } =
      makeListener({
        thread: SUBSTANTIVE_THREAD,
        messages: [{ content: 'When are we leaving?' }, { content: 'Friday morning works for me.' }],
      });

    await listener.updateThread({ threadId: 'thread-1' } as never);

    expect(messageService.findByThreadId).toHaveBeenCalledWith({ userId: SYSTEM_USER }, 'thread-1');
    expect(embeddingGenerationService.generateEmbedding).toHaveBeenCalledWith(
      'Trip planning When are we leaving? Friday morning works for me.',
    );
    expect(embeddingService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { entityType: 'thread', entityId: 'thread-1', embedding: [0.1, 0.2] },
    );
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      {
        entityType: 'thread',
        entityId: 'thread-1',
        searchableText: [
          { text: 'Trip planning', weight: 10 },
          { text: 'When are we leaving?', weight: 3 },
          { text: 'Friday morning works for me.', weight: 3 },
        ],
      },
    );
  });

  it('skips both embedding and vectorization for a thread with no name/description and no messages', async () => {
    const { listener, embeddingService, vectorService } = makeListener({
      thread: { id: 'thread-2', user: { id: 'user-1' }, name: null, description: null },
      messages: [],
    });

    await listener.indexThread({ threadId: 'thread-2' } as never);

    expect(embeddingService.upsert).not.toHaveBeenCalled();
    expect(vectorService.upsert).not.toHaveBeenCalled();
  });
});

describe('ThreadSearchIndexListener.updateThreadOnMessageCreated', () => {
  it("re-derives the thread from the new message's threadId", async () => {
    const { listener, threadService, messageService } = makeListener({
      thread: SUBSTANTIVE_THREAD,
      message: { id: 'msg-1', threadId: 'thread-1' },
      messages: [],
    });

    await listener.updateThreadOnMessageCreated({ messageId: 'msg-1' } as never);

    expect(messageService.findById).toHaveBeenCalledWith({ userId: SYSTEM_USER }, 'msg-1');
    expect(threadService.findById).toHaveBeenCalledWith({ userId: SYSTEM_USER }, 'thread-1');
  });

  it('is a no-op when the message has no associated thread', async () => {
    const { listener, threadService } = makeListener({ message: { id: 'msg-1', threadId: null } });

    await listener.updateThreadOnMessageCreated({ messageId: 'msg-1' } as never);

    expect(threadService.findById).not.toHaveBeenCalled();
  });
});

// The documented historical bug: MessageUpdatedEvent / MessageDeletedEvent were
// declared and sent, but nothing consumed them — an edited message kept the
// thread's stale indexed text forever, and a deleted one stayed searchable
// indefinitely. These two handlers are the fix; this is their regression test.
describe('ThreadSearchIndexListener — re-indexing on message edit / delete', () => {
  it('re-indexes the thread when a message is EDITED, picking up the new content', async () => {
    const { listener, threadService, vectorService } = makeListener({
      thread: SUBSTANTIVE_THREAD,
      message: { id: 'msg-1', threadId: 'thread-1' },
      messages: [{ content: 'The corrected message text.' }],
    });

    await listener.updateThreadOnMessageUpdated({ messageId: 'msg-1' } as never);

    expect(threadService.findById).toHaveBeenCalledWith({ userId: SYSTEM_USER }, 'thread-1');
    expect(vectorService.upsert).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        searchableText: expect.arrayContaining([{ text: 'The corrected message text.', weight: 3 }]),
      }),
    );
  });

  it('re-indexes the thread when a message is DELETED, rebuilding from what survives', async () => {
    // MessageService.findById filters canceled: false, so it returns null for
    // a deleted message in a real system — the mock leaves it null here too,
    // matching that behavior, to prove the delete path does NOT depend on it
    // resolving. Only the surviving thread messages are what matters here: the
    // stale content from the deleted message must NOT still appear.
    const { listener, threadService, messageService, vectorService } = makeListener({
      thread: SUBSTANTIVE_THREAD,
      message: null,
      messages: [{ content: 'Only the surviving message remains.' }],
    });

    await listener.updateThreadOnMessageDeleted({ messageId: 'msg-1', threadId: 'thread-1' } as never);

    expect(messageService.findById).not.toHaveBeenCalled();
    expect(threadService.findById).toHaveBeenCalledWith({ userId: SYSTEM_USER }, 'thread-1');
    const [, dto] = vectorService.upsert.mock.calls[0];
    const texts = (dto.searchableText as { text: string }[]).map((t) => t.text);
    expect(texts).toContain('Only the surviving message remains.');
    expect(texts.join(' ')).not.toContain('deleted');
  });

  it('a message deleted with no associated thread is a no-op, not an error', async () => {
    const { listener, threadService, logger } = makeListener();

    await expect(
      listener.updateThreadOnMessageDeleted({ messageId: 'msg-gone', threadId: null } as never),
    ).resolves.toBeUndefined();

    expect(threadService.findById).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('skipping re-index'),
      expect.objectContaining({ messageId: 'msg-gone' }),
    );
  });

  it('a message resolving with no threadId is also a no-op', async () => {
    const { listener, threadService } = makeListener({ message: { id: 'msg-1', threadId: null } });

    await listener.updateThreadOnMessageUpdated({ messageId: 'msg-1' } as never);

    expect(threadService.findById).not.toHaveBeenCalled();
  });
});

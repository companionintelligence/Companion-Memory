import { DEFAULT_JOB_PRIORITY, INTERACTIVE_JOB_PRIORITY } from '@ci/domains/events';

import { LLM_QUEUE_OPTIONS } from '../../constants';
import { ChatTurnService } from '../ChatTurnService';

function buildService(overrides: {
  threadService?: unknown;
  messageService?: unknown;
  ollamaService?: unknown;
}) {
  return new ChatTurnService(
    {} as never,
    {} as never,
    (overrides.messageService ?? {}) as never,
    (overrides.ollamaService ?? {}) as never,
    (overrides.threadService ?? {}) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    {} as never,
  );
}

describe('ChatTurnService.summarizeThread', () => {
  it('names the thread with the served chat model rather than a hardcoded summarizer', async () => {
    const threadService = {
      findById: jest.fn(async () => ({ id: 'thread-1', name: null })),
      update: jest.fn(async () => undefined),
    };
    const messageService = {
      findByThreadId: jest.fn(async () => [
        { role: 'user', content: 'Plan dinner', model: 'Qwen3.8-27B-Uncensored' },
        { role: 'assistant', content: 'Here is a menu.', model: 'Qwen3.8-27B-Uncensored' },
      ]),
    };
    const ollamaService = {
      resolveModel: jest.fn(async (_ctx: unknown, opts: { requestedModel?: string }) => ({
        model: opts.requestedModel ?? 'fallback',
        enableThinking: false,
        enableTools: false,
      })),
      chat: jest.fn(async () => ({ message: { content: 'Dinner plans' } })),
    };

    const service = buildService({ threadService, messageService, ollamaService });

    await service.summarizeThread({ ownerId: 'user-1', threadId: 'thread-1' });

    expect(ollamaService.resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({
        requestedModel: 'Qwen3.8-27B-Uncensored',
        enableThinking: false,
        enableTools: false,
      }),
    );
    expect(ollamaService.chat).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: 'Qwen3.8-27B-Uncensored' }),
    );
    expect(threadService.update).toHaveBeenCalledWith(
      expect.anything(),
      'thread-1',
      expect.objectContaining({ name: 'Dinner Plans' }),
    );
  });

  it('still names the thread when history has no stored model id', async () => {
    const threadService = {
      findById: jest.fn(async () => ({ id: 'thread-1', name: null })),
      update: jest.fn(async () => undefined),
    };
    const messageService = {
      findByThreadId: jest.fn(async () => [{ role: 'user', content: 'Plan dinner' }]),
    };
    const ollamaService = {
      resolveModel: jest.fn(async () => ({
        model: 'Qwen3.8-27B-Uncensored',
        enableThinking: false,
        enableTools: false,
      })),
      chat: jest.fn(async () => ({ message: { content: 'Dinner plans' } })),
    };

    const service = buildService({ threadService, messageService, ollamaService });

    await service.summarizeThread({ ownerId: 'user-1', threadId: 'thread-1' });

    expect(ollamaService.resolveModel).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ enableThinking: false, enableTools: false }),
    );
    expect(ollamaService.chat).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: 'Qwen3.8-27B-Uncensored' }),
    );
  });

  /**
   * The title job used to COMPLETE over a reply it could not use — an empty one, or one with nothing left once
   * quotes and symbols were stripped — so the queue saw success, never retried, and the thread stayed untitled
   * (5 of 8 jobs on the iOS QA re-test, each done in about 0.15 s). An unusable reply is a failure: the queue retries
   * it within its bounded policy.
   */
  describe.each([
    ['an empty reply', ''],
    ['whitespace', '  \n '],
    ['nothing but punctuation', '"..." !!!'],
    ['only a thinking trace', '<think>the user wants a plan</think>'],
  ])('when the model sends %s', (_label, reply) => {
    it('fails the job and writes no title, so it is retried', async () => {
      const threadService = {
        findById: jest.fn(async () => ({ id: 'thread-1', name: null })),
        update: jest.fn(async () => undefined),
      };
      const messageService = {
        findByThreadId: jest.fn(async () => [{ role: 'user', content: 'Plan dinner' }]),
      };
      const ollamaService = {
        resolveModel: jest.fn(async () => ({ model: 'm', enableThinking: false, enableTools: false })),
        chat: jest.fn(async () => ({ message: { content: reply } })),
      };
      const service = buildService({ threadService, messageService, ollamaService });

      await expect(service.summarizeThread({ ownerId: 'user-1', threadId: 'thread-1' })).rejects.toThrow(
        /no usable/i,
      );
      expect(threadService.update).not.toHaveBeenCalled();
    });
  });

  /**
   * What the listener falls back to once the retries are spent: the person's own first words, written only if the
   * thread is STILL unnamed (the conditional write is the service's: a real title that landed meanwhile wins).
   */
  describe('nameThreadFromFirstMessage', () => {
    const build = (messages: unknown[], written = true) => {
      const threadService = { nameIfUnnamed: jest.fn(async () => written) };
      const messageService = { findByThreadId: jest.fn(async () => messages) };

      return { threadService, service: buildService({ threadService, messageService }) };
    };

    it('titles the thread with the first user message, cut at a word boundary', async () => {
      const { service, threadService } = build([
        { role: 'assistant', content: 'Hello! How can I help?' },
        {
          role: 'user',
          content: 'Please summarise everything my family said about the move to Lisbon last spring',
        },
        { role: 'user', content: 'and also the visa' },
      ]);

      await expect(
        service.nameThreadFromFirstMessage({ ownerId: 'user-1', threadId: 'thread-1' }),
      ).resolves.toBe(true);
      expect(threadService.nameIfUnnamed).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
        'thread-1',
        'Please summarise everything my family said about the move to',
      );
    });

    it('does nothing when there is no user text to use', async () => {
      const { service, threadService } = build([
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: '  ' },
      ]);

      await expect(
        service.nameThreadFromFirstMessage({ ownerId: 'user-1', threadId: 'thread-1' }),
      ).resolves.toBe(false);
      expect(threadService.nameIfUnnamed).not.toHaveBeenCalled();
    });

    it('reports false when a real title got there first', async () => {
      const { service } = build([{ role: 'user', content: 'Plan dinner' }], false);

      await expect(
        service.nameThreadFromFirstMessage({ ownerId: 'user-1', threadId: 'thread-1' }),
      ).resolves.toBe(false);
    });
  });

  it('keeps chat jobs ahead of default-priority inference and titles', () => {
    expect(INTERACTIVE_JOB_PRIORITY).toBeGreaterThan(DEFAULT_JOB_PRIORITY);
    expect(LLM_QUEUE_OPTIONS.localConcurrency).toBe(1);
    expect(LLM_QUEUE_OPTIONS.retryLimit).toBe(3);
  });
});

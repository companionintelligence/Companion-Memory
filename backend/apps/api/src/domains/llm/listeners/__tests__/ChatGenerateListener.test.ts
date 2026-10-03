import type { Acknowledgement } from '@ci/domains/events';

import { ChatGenerateListener } from '../ChatGenerateListener';

const titlePayload = { ownerId: 'user-1', threadId: 'thread-1' } as never;

function makeListener(
  opts: {
    summarizeThread?: jest.Mock;
    nameThreadFromFirstMessage?: jest.Mock;
    getJob?: jest.Mock;
  } = {},
) {
  const chatTurnService = {
    execute: jest.fn(async () => undefined),
    summarizeThread: opts.summarizeThread ?? jest.fn(async () => undefined),
    nameThreadFromFirstMessage: opts.nameThreadFromFirstMessage ?? jest.fn(async () => true),
  };
  const eventService = { getJob: opts.getJob ?? jest.fn(async () => ({ retryCount: 0, retryLimit: 3 })) };
  const logger = { setContext: jest.fn(), error: jest.fn(), warn: jest.fn() };
  const listener = new ChatGenerateListener(chatTurnService as never, logger as never, eventService as never);

  return { listener, chatTurnService, eventService, logger };
}

function makeAck(): Acknowledgement {
  return { jobId: 'job-1', done: jest.fn(), fail: jest.fn(), defer: jest.fn() };
}

const failing = (message = 'model down') =>
  jest.fn(async () => {
    throw new Error(message);
  });

describe('ChatGenerateListener', () => {
  it('runs the chat turn', async () => {
    const { listener, chatTurnService } = makeListener();

    await listener.handleGenerate({
      ownerId: 'user-1',
      threadId: 'thread-1',
      promptMessageId: 'm1',
      assistantMessageId: 'm2',
      model: 'Qwen3.8-27B-Uncensored',
      enableTools: false,
      enableThinking: false,
      capability: 'full',
    });

    expect(chatTurnService.execute).toHaveBeenCalledTimes(1);
  });

  /**
   * A title that fails — the model busy, Ollama down, or a reply with nothing usable — fails the job so the queue
   * retries it a bounded number of times (3 retries, backed off, see LLM_BACKGROUND_QUEUE_OPTIONS). Only on the
   * LAST attempt does the thread settle for the person's own first words instead of staying untitled for good.
   */
  describe('the title job', () => {
    it('names the thread from the payload it was given, and completes', async () => {
      const { listener, chatTurnService } = makeListener();
      const ack = makeAck();

      await listener.handleSummarization(titlePayload, ack);

      expect(chatTurnService.summarizeThread).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'user-1', threadId: 'thread-1' }),
      );
      expect(ack.done).toHaveBeenCalledTimes(1);
      expect(ack.fail).not.toHaveBeenCalled();
      expect(chatTurnService.nameThreadFromFirstMessage).not.toHaveBeenCalled();
    });

    it('fails the job on an attempt the queue will retry, with no stand-in title yet', async () => {
      const { listener, chatTurnService, eventService } = makeListener({
        summarizeThread: failing(),
        getJob: jest.fn(async () => ({ retryCount: 1, retryLimit: 3 })),
      });
      const ack = makeAck();

      await listener.handleSummarization(titlePayload, ack);

      expect(eventService.getJob).toHaveBeenCalledWith('llm-background', 'job-1');
      expect(ack.fail).toHaveBeenCalledWith(expect.objectContaining({ message: 'model down' }));
      expect(ack.done).not.toHaveBeenCalled();
      expect(chatTurnService.nameThreadFromFirstMessage).not.toHaveBeenCalled();
    });

    it('falls back to the first message on the last attempt, and completes rather than dead-lettering', async () => {
      const { listener, chatTurnService } = makeListener({
        summarizeThread: failing(),
        getJob: jest.fn(async () => ({ retryCount: 3, retryLimit: 3 })),
      });
      const ack = makeAck();

      await listener.handleSummarization(titlePayload, ack);

      expect(chatTurnService.nameThreadFromFirstMessage).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'user-1', threadId: 'thread-1' }),
      );
      expect(ack.done).toHaveBeenCalledTimes(1);
      expect(ack.fail).not.toHaveBeenCalled();
    });

    it('falls back at once when there is no queue row to retry (nothing will retry it)', async () => {
      const { listener, chatTurnService } = makeListener({
        summarizeThread: failing(),
        getJob: jest.fn(async () => null),
      });
      const ack = makeAck();

      await listener.handleSummarization(titlePayload, ack);

      expect(chatTurnService.nameThreadFromFirstMessage).toHaveBeenCalledTimes(1);
      expect(ack.done).toHaveBeenCalledTimes(1);
    });

    it('lets the queue retry when it cannot tell whether this is the last attempt', async () => {
      const { listener, chatTurnService } = makeListener({
        summarizeThread: failing(),
        getJob: failing('db blip'),
      });
      const ack = makeAck();

      await listener.handleSummarization(titlePayload, ack);

      expect(ack.fail).toHaveBeenCalledWith(expect.objectContaining({ message: 'model down' }));
      expect(chatTurnService.nameThreadFromFirstMessage).not.toHaveBeenCalled();
    });

    it('fails the job when even the fallback cannot be written', async () => {
      const { listener } = makeListener({
        summarizeThread: failing(),
        nameThreadFromFirstMessage: failing('db down'),
        getJob: jest.fn(async () => ({ retryCount: 3, retryLimit: 3 })),
      });
      const ack = makeAck();

      await listener.handleSummarization(titlePayload, ack);

      expect(ack.fail).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));
      expect(ack.done).not.toHaveBeenCalled();
    });
  });
});

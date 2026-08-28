import { Events } from '@ci/domains/events';

import { ChatGenerationBroker } from '../ChatGenerationBroker';
import { ChatTurnService } from '../ChatTurnService';

const payload = {
  ownerId: 'user-1',
  threadId: 'thread-1',
  promptMessageId: 'user-msg',
  assistantMessageId: 'assistant-msg',
  model: 'Qwen3.8-27B-Uncensored',
  enableTools: false,
  enableThinking: false,
  capability: 'full' as const,
};

function streamFrom(chunks: Array<{ message: { content?: string } }>) {
  const generator = (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();

  Object.defineProperty(generator, 'messages', {
    get: () => [{ role: 'assistant', content: 'hi there' }],
  });

  return generator;
}

/**
 * LLM_QUEUE_OPTIONS now declares `policy: 'short'`, which pg-boss enforces
 * queue-wide over `COALESCE(singleton_key,'')` — a keyless CHAT_SUMMARIZATION
 * send would collapse every thread's title job into one slot. This runs the
 * real `execute()` and checks the singletonKey actually handed to
 * `eventService.send`, not a mocked no-op.
 */
describe('ChatTurnService.execute chat-summarization singletonKey', () => {
  it('carries a per-thread singletonKey so two threads cannot collapse under the "short" policy', async () => {
    const eventService = { send: jest.fn(async () => ['job-id']) };
    const threadService = {
      findById: jest.fn(async () => ({ id: 'thread-1', name: null, generationStatus: 'queued' })),
      update: jest.fn(async () => undefined),
    };
    const messageService = {
      findByThreadId: jest.fn(async () => [
        { id: 'user-msg', role: 'user', content: 'hi', files: [] },
        { id: 'assistant-msg', role: 'assistant', content: '', files: [] },
      ]),
      update: jest.fn(async () => ({})),
    };
    const ollamaService = {
      resolveModel: jest.fn(async () => ({
        model: payload.model,
        enableThinking: false,
        enableTools: false,
      })),
      chatStream: jest.fn(async () => streamFrom([{ message: { content: 'hi there' } }])),
    };
    const broker = new ChatGenerationBroker();

    const service = new ChatTurnService(
      eventService as never,
      { findByThreadId: jest.fn(async () => null) } as never,
      messageService as never,
      ollamaService as never,
      threadService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      broker,
      { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      { isFeatureEnabled: jest.fn(async () => false) } as never,
    );

    await service.execute(payload);

    expect(eventService.send).toHaveBeenCalledWith(
      Events.CHAT_SUMMARIZATION,
      expect.objectContaining({ ownerId: 'user-1', threadId: 'thread-1' }),
      expect.objectContaining({ singletonKey: 'chat-summarize:thread-1' }),
    );
  });
});

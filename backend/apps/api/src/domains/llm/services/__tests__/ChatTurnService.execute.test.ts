import { Channel } from '@ci/common/rpc';

import { ChatGenerationBroker } from '../ChatGenerationBroker';
import { ChatTurnService, EMPTY_TURN_FALLBACK_TEXT, persistedAssistantContent } from '../ChatTurnService';

const payload = {
  ownerId: 'user-1',
  threadId: 'thread-1',
  promptMessageId: 'user-msg',
  assistantMessageId: 'assistant-msg',
  model: 'Qwen3.8-27B-Uncensored',
  enableTools: false,
  enableThinking: true,
  capability: 'full' as const,
};

function streamFrom(
  chunks: Array<{ message: { content?: string; thinking?: string } }>,
  accumulated: Array<{ role: string; content: string }>,
) {
  const generator = (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();

  Object.defineProperty(generator, 'messages', {
    get: () => accumulated,
  });

  return generator;
}

function buildService(
  chatStream: jest.Mock,
  messageService = { findByThreadId: jest.fn(), update: jest.fn() },
) {
  const broker = new ChatGenerationBroker();
  const threadService = {
    findById: jest.fn(async () => ({ id: 'thread-1', name: null, generationStatus: 'queued' })),
    update: jest.fn(async () => undefined),
  };
  messageService.findByThreadId.mockResolvedValue([
    { id: 'user-msg', role: 'user', content: 'hi', files: [] },
    { id: 'assistant-msg', role: 'assistant', content: '', files: [] },
  ]);
  messageService.update.mockResolvedValue({});

  const ollamaService = {
    resolveModel: jest.fn(async () => ({
      model: payload.model,
      enableThinking: true,
      enableTools: false,
    })),
    chatStream,
  };

  const service = new ChatTurnService(
    { send: jest.fn(async () => ['title-job']) } as never,
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

  return { service, broker, messageService, ollamaService };
}

describe('persistedAssistantContent', () => {
  it('wraps thinking the same way a reloaded ChatMessage parses it', () => {
    expect(persistedAssistantContent('hmm', 'Hi')).toBe('<think>hmm</think>Hi');
    expect(persistedAssistantContent('', 'Hi')).toBe('Hi');
  });
});

describe('ChatTurnService.execute providers', () => {
  it('fans vLLM-style separate thinking and content deltas into the broker and the assistant row', async () => {
    const accumulated = [{ role: 'assistant', content: '<think>hmm</think>Hello' }];
    const chatStream = jest.fn(async () =>
      streamFrom(
        [{ message: { thinking: 'hmm' } }, { message: { content: 'Hello' } }, { message: { content: '' } }],
        accumulated,
      ),
    );
    const { service, broker, messageService, ollamaService } = buildService(chatStream);
    const published: Array<{ channel: Channel; text: string }> = [];
    const original = broker.publish.bind(broker);
    broker.publish = (threadId, chunk) => {
      published.push(chunk);
      original(threadId, chunk);
    };

    await service.execute(payload);

    expect(ollamaService.chatStream).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.any(Array),
      expect.objectContaining({ signal: expect.any(AbortSignal), model: payload.model }),
    );
    expect(published).toEqual(
      expect.arrayContaining([
        { channel: Channel.THINK, text: 'hmm' },
        { channel: Channel.TEXT, text: 'Hello' },
      ]),
    );
    expect(messageService.update).toHaveBeenCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ content: '<think>hmm</think>Hello', canceled: false }),
    );
  });

  it('fans a native-Ollama chunk that carries thinking and content together', async () => {
    const accumulated = [{ role: 'assistant', content: '<think>hmm</think>Hello' }];
    const chatStream = jest.fn(async () =>
      streamFrom([{ message: { thinking: 'hmm', content: 'Hello' } }], accumulated),
    );
    const { service, broker } = buildService(chatStream);
    const published: Array<{ channel: Channel; text: string }> = [];
    const original = broker.publish.bind(broker);
    broker.publish = (threadId, chunk) => {
      published.push(chunk);
      original(threadId, chunk);
    };

    await service.execute(payload);

    expect(published).toEqual([
      { channel: Channel.TEXT, text: 'Hello' },
      { channel: Channel.THINK, text: 'hmm' },
    ]);
  });

  it('still writes streamed thinking+text when the provider yields no accumulated messages', async () => {
    const chatStream = jest.fn(async () =>
      streamFrom([{ message: { thinking: 'a' } }, { message: { content: 'b' } }], []),
    );
    const { service, messageService } = buildService(chatStream);

    await service.execute(payload);

    expect(messageService.update).toHaveBeenCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ content: '<think>a</think>b' }),
    );
  });

  // The measured incident: two tool rounds, both returning [], then the stream
  // ended — all thinking and tool traffic, not one visible character. The
  // viewer's stream closed on a blank bubble, indistinguishable from a hang.
  it('publishes and persists the fallback reply when a turn ends with no visible text', async () => {
    const accumulated = [
      { role: 'assistant', content: '<think>searching</think>' },
      { role: 'tool', content: '[]' },
      { role: 'assistant', content: '<think>retrying</think>' },
      { role: 'tool', content: '[]' },
    ];
    const chatStream = jest.fn(async () =>
      streamFrom([{ message: { thinking: 'searching' } }, { message: { thinking: 'retrying' } }], accumulated),
    );
    const messageService = {
      findByThreadId: jest.fn(),
      update: jest.fn(),
      create: jest.fn(async () => ({})),
    };
    const { service, broker } = buildService(chatStream, messageService);
    const published: Array<{ channel: Channel; text: string }> = [];
    const original = broker.publish.bind(broker);
    broker.publish = (threadId, chunk) => {
      published.push(chunk);
      original(threadId, chunk);
    };

    await service.execute(payload);

    expect(published).toContainEqual({ channel: Channel.TEXT, text: EMPTY_TURN_FALLBACK_TEXT });
    expect(messageService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'assistant', content: EMPTY_TURN_FALLBACK_TEXT }),
    );
  });

  it('does not substitute the fallback when the model streamed real text', async () => {
    const accumulated = [{ role: 'assistant', content: 'Hello' }];
    const chatStream = jest.fn(async () => streamFrom([{ message: { content: 'Hello' } }], accumulated));
    const { service, broker } = buildService(chatStream);
    const published: Array<{ channel: Channel; text: string }> = [];
    const original = broker.publish.bind(broker);
    broker.publish = (threadId, chunk) => {
      published.push(chunk);
      original(threadId, chunk);
    };

    await service.execute(payload);

    expect(published).not.toContainEqual({ channel: Channel.TEXT, text: EMPTY_TURN_FALLBACK_TEXT });
  });
});

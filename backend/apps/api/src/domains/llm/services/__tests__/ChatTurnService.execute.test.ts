import { Channel } from '@ci/common/rpc';

import { LlmFirstResponseTimeoutError } from '../../firstResponseDeadline';
import { ChatGenerationBroker } from '../ChatGenerationBroker';
import {
  ChatTurnService,
  EMPTY_TURN_FALLBACK_TEXT,
  MAX_FIRST_RESPONSE_ATTEMPTS,
  persistedAssistantContent,
} from '../ChatTurnService';

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
  error?: Error,
) {
  const generator = (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();

  Object.defineProperty(generator, 'messages', {
    get: () => accumulated,
  });

  // Mirrors OllamaService.chatStream: a swallowed backend failure is exposed
  // additively on the stream, never thrown at the consumer.
  Object.defineProperty(generator, 'error', {
    get: () => error,
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
      streamFrom(
        [{ message: { thinking: 'searching' } }, { message: { thinking: 'retrying' } }],
        accumulated,
      ),
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

  it('asks again when the backend never started answering, then fails the job rather than faking a reply', async () => {
    // The measured failure: the request sat in Ollama's scheduler with no
    // response until a timeout tore it down, and the turn ended in fallback
    // prose that read as if the model had answered. A no-response is now a
    // bounded retry and then a FAILED job — pg-boss's retry/backoff applies,
    // and the thread reads `failed`.
    const noResponse = new LlmFirstResponseTimeoutError('gemma4:e4b', 90_000);
    const chatStream = jest.fn(async () => streamFrom([], [], noResponse));
    const messageService = {
      findByThreadId: jest.fn(),
      update: jest.fn(),
      create: jest.fn(async () => ({})),
    };
    const { service, broker, ollamaService } = buildService(chatStream, messageService);
    const published: Array<{ channel: Channel; text: string }> = [];
    const original = broker.publish.bind(broker);
    broker.publish = (threadId, chunk) => {
      published.push(chunk);
      original(threadId, chunk);
    };

    const threadUpdates: unknown[] = [];
    const threadService = (service as unknown as { threadService: { update: jest.Mock } }).threadService;
    threadService.update.mockImplementation(async (_ctx: unknown, _id: string, data: unknown) => {
      threadUpdates.push(data);
    });

    await expect(service.execute(payload)).rejects.toBe(noResponse);

    expect(ollamaService.chatStream).toHaveBeenCalledTimes(MAX_FIRST_RESPONSE_ATTEMPTS);
    expect(published).not.toContainEqual({ channel: Channel.TEXT, text: EMPTY_TURN_FALLBACK_TEXT });
    expect(messageService.create).not.toHaveBeenCalled();
    expect(threadUpdates).toContainEqual({ generationStatus: 'failed' });
    expect(threadUpdates).not.toContainEqual({ generationStatus: 'idle' });
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

/**
 * Stop keeps what streamed. `canceled` is stored in `is_deleted`, which every read leaves out, so a stopped reply
 * marked canceled vanished on reload while the database still held its text.
 */
describe('ChatTurnService.execute — a reply stopped part way', () => {
  /** A stream that yields `chunks`, then has the person press Stop before it ends. */
  function stoppedStream(
    broker: ChatGenerationBroker,
    chunks: Array<{ message: { content?: string; thinking?: string } }>,
    accumulated: Array<{ role: string; content: string; tool_calls?: unknown[] }>,
  ) {
    const generator = (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }

      broker.abort(payload.threadId);
    })();

    Object.defineProperty(generator, 'messages', { get: () => accumulated });
    Object.defineProperty(generator, 'error', { get: () => undefined });

    return generator;
  }

  function build(
    stream: (broker: ChatGenerationBroker) => ReturnType<typeof stoppedStream>,
  ): ReturnType<typeof buildService> & { messageService: { create: jest.Mock } } {
    const messageService = {
      findByThreadId: jest.fn(),
      update: jest.fn(),
      create: jest.fn(async () => ({})),
    };
    const chatStream = jest.fn();
    const built = buildService(chatStream, messageService);

    chatStream.mockImplementation(async () => stream(built.broker));

    return { ...built, messageService };
  }

  it('keeps the part that streamed when the stream accumulated no message', async () => {
    const { service, messageService } = build((broker) =>
      stoppedStream(
        broker,
        [{ message: { thinking: 'hmm' } }, { message: { content: 'The first half' } }],
        [],
      ),
    );

    await service.execute(payload);

    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ content: '<think>hmm</think>The first half', canceled: false }),
    );
  });

  it('keeps the cut-off reply when the stream accumulated it', async () => {
    const { service, messageService } = build((broker) =>
      stoppedStream(
        broker,
        [{ message: { content: 'The first half' } }],
        [{ role: 'assistant', content: 'The first half' }],
      ),
    );

    await service.execute(payload);

    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ content: 'The first half', canceled: false }),
    );
  });

  it('keeps the last row of a stopped tool turn that has text', async () => {
    const { service, messageService } = build((broker) =>
      stoppedStream(
        broker,
        [{ message: { content: 'Found it, here' } }],
        [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'memory.search', arguments: {} } }],
          },
          { role: 'tool', content: '[]' },
          { role: 'assistant', content: 'Found it, here' },
        ],
      ),
    );

    await service.execute(payload);

    expect(messageService.create).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'assistant', content: 'Found it, here', canceled: false }),
    );
  });

  it('still hides a stopped reply that has nothing in it', async () => {
    const { service, messageService } = build((broker) => stoppedStream(broker, [], []));

    await service.execute(payload);

    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ content: '', canceled: true }),
    );
  });

  it('still hides an empty last row of a stopped tool turn', async () => {
    const { service, messageService } = build((broker) =>
      stoppedStream(
        broker,
        [{ message: { content: 'Let me look' } }],
        [
          {
            role: 'assistant',
            content: 'Let me look',
            tool_calls: [{ function: { name: 'memory.search', arguments: {} } }],
          },
          { role: 'tool', content: '[]' },
          { role: 'assistant', content: '' },
        ],
      ),
    );

    await service.execute(payload);

    expect(messageService.update).toHaveBeenCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ content: 'Let me look', canceled: false }),
    );
    expect(messageService.create).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'assistant', content: '', canceled: true }),
    );
  });
});

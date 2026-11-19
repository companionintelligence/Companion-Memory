import { Channel } from '@ci/common/rpc';
import { LiveChangesService } from '@ci/domains/live-changes';

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
  liveChanges?: LiveChangesService,
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

  const eventService = { send: jest.fn(async () => ['title-job']) };
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
    undefined,
    undefined,
    liveChanges,
  );

  return { service, broker, messageService, ollamaService, threadService, eventService };
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
describe('ChatTurnService.execute with a reply stopped part way', () => {
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
    // The tool-call row keeps its own (empty) text. Given the streamed text too, the reply showed twice on reload.
    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({
        content: '',
        canceled: false,
        toolCalls: [{ function: { name: 'memory.search', arguments: {} } }],
      }),
    );
  });

  it('keeps the thinking of a reply stopped before its tool call ran, without the call', async () => {
    const { service, messageService } = build((broker) =>
      stoppedStream(
        broker,
        [{ message: { thinking: 'I should search' } }],
        [
          {
            role: 'assistant',
            content: '<think>I should search</think>',
            tool_calls: [{ function: { name: 'memory.search', arguments: {} } }],
          },
        ],
      ),
    );

    await service.execute(payload);

    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({
        content: '<think>I should search</think>',
        canceled: false,
        toolCalls: null,
      }),
    );
  });

  it('drops the unrun call of the last row of a stopped tool turn', async () => {
    const { service, messageService } = build((broker) =>
      stoppedStream(
        broker,
        [{ message: { thinking: 'one more' } }],
        [
          {
            role: 'assistant',
            content: '<think>first</think>',
            tool_calls: [{ function: { name: 'memory.search', arguments: {} } }],
          },
          { role: 'tool', content: '[]' },
          {
            role: 'assistant',
            content: '<think>one more</think>',
            tool_calls: [{ function: { name: 'memory.search', arguments: { q: 'x' } } }],
          },
        ],
      ),
    );

    await service.execute(payload);

    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ toolCalls: [{ function: { name: 'memory.search', arguments: {} } }] }),
    );
    expect(messageService.create).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'assistant', content: '<think>one more</think>', canceled: false }),
    );
    expect(messageService.create).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.not.objectContaining({ toolCalls: expect.anything() }),
    );
  });

  it('hides a stopped reply whose thinking is only whitespace', async () => {
    const { service, messageService } = build((broker) =>
      stoppedStream(broker, [{ message: { thinking: '\n\n' } }], []),
    );

    await service.execute(payload);

    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ content: '<think>\n\n</think>', canceled: true }),
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

/**
 * Stop can land before the worker runs the job: the thread is already idle, so the turn is closed without a model
 * call. The placeholder row is normally empty and hidden, but a job retried after an API restart may already have
 * streamed into it.
 */
describe('ChatTurnService.execute on a turn stopped before it ran', () => {
  function build(rowContent: string) {
    const messageService = {
      findByThreadId: jest.fn(),
      findById: jest.fn(async () => ({ id: 'assistant-msg', role: 'assistant', content: rowContent })),
      update: jest.fn(),
    };
    const chatStream = jest.fn();
    const built = buildService(chatStream, messageService);

    built.threadService.findById.mockResolvedValue({ id: 'thread-1', name: null, generationStatus: 'idle' });

    return { ...built, chatStream, messageService };
  }

  it('hides the empty placeholder row', async () => {
    const { service, messageService, chatStream } = build('');

    await service.execute(payload);

    expect(chatStream).not.toHaveBeenCalled();
    expect(messageService.update).toHaveBeenCalledWith(expect.anything(), 'assistant-msg', {
      canceled: true,
    });
  });

  it('keeps a row an earlier run already streamed into', async () => {
    const { service, messageService, chatStream } = build('<think>hmm</think>The first half');

    await service.execute(payload);

    expect(chatStream).not.toHaveBeenCalled();
    expect(messageService.update).not.toHaveBeenCalledWith(expect.anything(), 'assistant-msg', {
      canceled: true,
    });
  });
});

describe('ChatTurnService.execute on a finished tool turn', () => {
  it('stores the answer once when the first round was only a tool call', async () => {
    const messageService = {
      findByThreadId: jest.fn(),
      update: jest.fn(),
      create: jest.fn(async () => ({})),
    };
    const chatStream = jest.fn(async () =>
      streamFrom([{ message: { content: 'Nothing about coffee.' } }], [
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'knowledge', arguments: {} } }] },
        { role: 'tool', content: '[]' },
        { role: 'assistant', content: 'Nothing about coffee.' },
      ] as Array<{ role: string; content: string }>),
    );
    const { service } = buildService(chatStream, messageService);

    await service.execute(payload);

    // The tool-call row used to take every round's streamed text, so the answer showed twice after a reload.
    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ content: '', canceled: false }),
    );
    expect(messageService.create).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'assistant', content: 'Nothing about coffee.', canceled: false }),
    );
  });
});

/**
 * A reply streaming when the key or session that asked for it is revoked (deleted, Sign out, Sign out everywhere, a
 * password change) used to run to its end. It now stops the way Stop stops it.
 */
describe('ChatTurnService.execute when the key or session that asked for it is revoked', () => {
  const asked = { ...payload, credential: { kind: 'session', sessionId: 'sess-1' } as const };
  const signedIn = [{ '?column?': 1 }];

  /**
   * A real LiveChangesService on a fake database, whose lookups answer `rows`. `revoke()` empties them and sends
   * the notice, then waits for the lookup it starts.
   */
  function build(makeStream: (revoke: () => Promise<void>) => jest.Mock, rows: unknown[] = signedIn) {
    const dataSource = { query: jest.fn(async () => rows) };
    const liveChanges = new LiveChangesService(
      dataSource as never,
      { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() } as never,
    );
    const revoke = async () => {
      dataSource.query.mockResolvedValue([]);
      liveChanges.dispatch(JSON.stringify({ userId: asked.ownerId, revoked: true }));
      await new Promise(setImmediate);
    };

    const chatStream = makeStream(revoke);
    const messageService = {
      findByThreadId: jest.fn(),
      findById: jest.fn(async () => ({ id: 'assistant-msg', role: 'assistant', content: '' })),
      update: jest.fn(),
      create: jest.fn(async () => ({})),
    };

    return { ...buildService(chatStream, messageService, liveChanges), chatStream, dataSource, liveChanges };
  }

  /** Streams `first`, has the session signed out, then streams `rest` unless its signal was aborted by then. */
  function revokedPartWay(revoke: () => Promise<void>, first: string, rest: string) {
    return jest.fn(async (_context: unknown, _messages: unknown, { signal }: { signal: AbortSignal }) => {
      const generator = (async function* () {
        yield { message: { content: first } };
        await revoke();

        // OllamaService.chatStream ends once its signal aborts.
        if (!signal.aborted) {
          yield { message: { content: rest } };
        }
      })();

      Object.defineProperty(generator, 'messages', { get: () => [] });
      Object.defineProperty(generator, 'error', { get: () => undefined });

      return generator;
    });
  }

  const finished = () =>
    jest.fn(async () =>
      streamFrom([{ message: { content: 'All of it' } }], [{ role: 'assistant', content: 'All of it' }]),
    );

  it('aborts the model call, ends the reply for whoever watches it and keeps what streamed, like Stop', async () => {
    const { service, broker, chatStream, messageService, threadService, eventService } = build((revoke) =>
      revokedPartWay(revoke, 'The first half', ' and the rest'),
    );
    const viewer = {
      writeHead: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
    };
    broker.pipeToResponse(viewer as never, payload.threadId);

    await service.execute(asked);

    const [, , options] = chatStream.mock.calls[0] as unknown as [unknown, unknown, { signal: AbortSignal }];

    expect(options.signal.aborted).toBe(true);
    expect(viewer.end).toHaveBeenCalled();
    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ content: 'The first half', canceled: false }),
    );
    expect(threadService.update).toHaveBeenLastCalledWith(expect.anything(), 'thread-1', {
      generationStatus: 'idle',
    });
    // No title for a first turn cut off part way, as for one the person stopped.
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('stops a turn whose session was signed out just after the queue check, with no notice heard', async () => {
    const { service, chatStream, dataSource } = build(() =>
      jest.fn(async (_context: unknown, _messages: unknown, { signal }: { signal: AbortSignal }) => {
        const generator = (async function* () {
          yield { message: { content: 'The first half' } };
          await new Promise(setImmediate);

          if (!signal.aborted) {
            yield { message: { content: ' and the rest' } };
          }
        })();

        Object.defineProperty(generator, 'messages', { get: () => [] });
        Object.defineProperty(generator, 'error', { get: () => undefined });

        return generator;
      }),
    );
    // The queue check reads the session as signed in; the sign-out lands right after it, its notice unheard.
    dataSource.query.mockResolvedValueOnce(signedIn).mockResolvedValue([]);

    await service.execute(asked);

    const [, , options] = chatStream.mock.calls[0] as unknown as [unknown, unknown, { signal: AbortSignal }];

    expect(options.signal.aborted).toBe(true);
  });

  it('does not run a turn whose key was deleted while it waited in the queue', async () => {
    const { service, chatStream, messageService, threadService } = build(() => jest.fn(), []);

    await service.execute({ ...payload, credential: { kind: 'apiKey', keyId: 'key-1' } });

    expect(chatStream).not.toHaveBeenCalled();
    expect(messageService.update).toHaveBeenCalledWith(expect.anything(), 'assistant-msg', {
      canceled: true,
    });
    expect(threadService.update).toHaveBeenLastCalledWith(expect.anything(), 'thread-1', {
      generationStatus: 'idle',
    });
  });

  it('runs to the end while the session stays signed in, then stops listening', async () => {
    const { service, messageService, dataSource, liveChanges } = build(finished);

    await service.execute(asked);

    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ content: 'All of it', canceled: false }),
    );

    const lookups = dataSource.query.mock.calls.length;
    liveChanges.dispatch(JSON.stringify({ userId: asked.ownerId, revoked: true }));
    await new Promise(setImmediate);

    expect(dataSource.query).toHaveBeenCalledTimes(lookups);
  });

  it('runs the turn when the lookup fails', async () => {
    const { service, chatStream, messageService, dataSource } = build(finished);
    dataSource.query.mockRejectedValue(new Error('connection reset'));

    await service.execute(asked);

    expect(chatStream).toHaveBeenCalled();
    expect(messageService.update).toHaveBeenLastCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ content: 'All of it', canceled: false }),
    );
  });

  it('leaves a job queued before the credential was recorded alone', async () => {
    const { service, chatStream, dataSource } = build(finished, []);

    await service.execute(payload);

    expect(chatStream).toHaveBeenCalled();
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});

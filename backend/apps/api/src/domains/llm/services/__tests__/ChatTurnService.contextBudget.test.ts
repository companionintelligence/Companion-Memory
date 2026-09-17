import { NUM_CTX_ENV_VAR } from '../../contextBudget';
import { ChatGenerationBroker } from '../ChatGenerationBroker';
import { ChatTurnService } from '../ChatTurnService';

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

interface StreamRow {
  role: string;
  content: string;
}

function streamFrom(accumulated: StreamRow[], error?: Error) {
  const generator = (async function* () {
    // Nothing streamed: a prefill rejection ends the stream before any token.
    if (!error) {
      yield { message: { content: accumulated[0]?.content ?? '' } };
    }
  })();

  Object.defineProperty(generator, 'messages', { get: () => accumulated });
  Object.defineProperty(generator, 'error', { get: () => error });

  return generator;
}

function buildService(options: {
  rows: Array<Record<string, unknown>>;
  chatStream: jest.Mock;
  getFileContent?: jest.Mock;
  /** Absent: the facade has no planner, the shape older tests build. */
  resolveChatContextTokens?: jest.Mock;
}) {
  const broker = new ChatGenerationBroker();
  const threadService = {
    findById: jest.fn(async () => ({ id: 'thread-1', name: 'named', generationStatus: 'queued' })),
    update: jest.fn(async () => undefined),
  };
  const messageService = {
    findByThreadId: jest.fn(async () => options.rows),
    update: jest.fn(async () => ({})),
    create: jest.fn(async () => ({})),
  };
  const ollamaService = {
    resolveModel: jest.fn(async () => ({
      model: payload.model,
      enableThinking: true,
      enableTools: false,
    })),
    chatStream: options.chatStream,
    ...(options.resolveChatContextTokens && { resolveChatContextTokens: options.resolveChatContextTokens }),
  };
  const fileService = {
    getFileContent: options.getFileContent ?? jest.fn(async () => new Uint8Array([1, 2, 3])),
  };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ChatTurnService(
    { send: jest.fn(async () => ['job']) } as never,
    { findByThreadId: jest.fn(async () => null) } as never,
    messageService as never,
    ollamaService as never,
    threadService as never,
    fileService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    broker,
    logger as never,
    { isFeatureEnabled: jest.fn(async () => false) } as never,
  );

  return { service, ollamaService, fileService, logger, messageService };
}

interface SentMessage {
  role: string;
  content: string;
  images?: Uint8Array[];
}

/** The `messages` argument of the nth `chatStream` call. */
function sentMessages(chatStream: jest.Mock, call = 0): SentMessage[] {
  return (chatStream.mock.calls as unknown as unknown[][])[call][1] as SentMessage[];
}

function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return { toolCalls: null, files: [], ...overrides };
}

describe('ChatTurnService context budget', () => {
  const originalNumCtx = process.env[NUM_CTX_ENV_VAR];

  beforeEach(() => {
    // 4096 → 1024 output reserve + 1024 system reserve → 2048 prompt bytes.
    process.env[NUM_CTX_ENV_VAR] = '4096';
  });

  afterEach(() => {
    if (originalNumCtx === undefined) {
      delete process.env[NUM_CTX_ENV_VAR];
    } else {
      process.env[NUM_CTX_ENV_VAR] = originalNumCtx;
    }
  });

  it('asks the backend for the window CI-Hub computed, and caps the answer', async () => {
    const chatStream = jest.fn(async () => streamFrom([{ role: 'assistant', content: 'hi' }]));
    const { service, ollamaService } = buildService({
      rows: [row({ id: 'user-msg', role: 'user', content: 'hello' })],
      chatStream,
    });

    await service.execute(payload);

    expect(ollamaService.chatStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({ numCtx: 4096, maxOutputTokens: 1024 }),
    );
  });

  it('drops the oldest history that does not fit and keeps the newest user turn', async () => {
    const filler = 'x'.repeat(2100);
    const chatStream = jest.fn(async () => streamFrom([{ role: 'assistant', content: 'hi' }]));
    const { service } = buildService({
      rows: [
        row({ id: 'm1', role: 'user', content: filler }),
        row({ id: 'm2', role: 'assistant', content: filler }),
        row({ id: 'm3', role: 'user', content: 'what did I just ask?' }),
        row({ id: 'assistant-msg', role: 'assistant', content: '' }),
      ],
      chatStream,
    });

    await service.execute(payload);

    const sent = sentMessages(chatStream);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toStrictEqual({ role: 'user', content: 'what did I just ask?' });
  });

  it('does not fetch attachment bytes for a message the budget dropped', async () => {
    const filler = 'y'.repeat(1500);
    const getFileContent = jest.fn(async () => new Uint8Array([1]));
    const chatStream = jest.fn(async () => streamFrom([{ role: 'assistant', content: 'hi' }]));
    const { service } = buildService({
      rows: [
        row({
          id: 'm1',
          role: 'user',
          content: filler,
          files: [{ key: 'dropped-photo', size: 1000 }],
        }),
        row({ id: 'm2', role: 'assistant', content: filler }),
        row({ id: 'm3', role: 'user', content: 'hello again' }),
      ],
      chatStream,
      getFileContent,
    });

    await service.execute(payload);

    expect(getFileContent).not.toHaveBeenCalled();
  });

  it('re-inlines images only for the newest attachment-bearing messages, stubbing the rest', async () => {
    const getFileContent = jest.fn(async () => new Uint8Array([1]));
    const chatStream = jest.fn(async () => streamFrom([{ role: 'assistant', content: 'hi' }]));
    const { service } = buildService({
      rows: [
        row({ id: 'm1', role: 'user', content: 'photo 1', files: [{ key: 'a', size: 10 }] }),
        row({ id: 'm2', role: 'assistant', content: 'nice' }),
        row({ id: 'm3', role: 'user', content: 'photo 2', files: [{ key: 'b', size: 10 }] }),
        row({ id: 'm4', role: 'assistant', content: 'also nice' }),
        row({ id: 'm5', role: 'user', content: 'photo 3', files: [{ key: 'c', size: 10 }] }),
      ],
      chatStream,
      getFileContent,
    });

    await service.execute(payload);

    // Three photos in the thread; only the two newest are re-uploaded.
    expect(getFileContent).toHaveBeenCalledTimes(2);
    expect((getFileContent.mock.calls as unknown as unknown[][]).map((call) => call[1])).toStrictEqual([
      'b',
      'c',
    ]);

    const sent = sentMessages(chatStream);

    expect(sent[0].images).toBeUndefined();
    expect(sent[0].content).toContain('1 attachment');
    expect(sent[2].images).toHaveLength(1);
    expect(sent[4].images).toHaveLength(1);
  });

  it('skips an oversized image without reading it out of object storage', async () => {
    const getFileContent = jest.fn(async () => new Uint8Array([1]));
    const chatStream = jest.fn(async () => streamFrom([{ role: 'assistant', content: 'hi' }]));
    const { service } = buildService({
      rows: [
        row({
          id: 'm1',
          role: 'user',
          content: 'huge',
          files: [{ key: 'huge', size: 8 * 1024 * 1024 }],
        }),
      ],
      chatStream,
      getFileContent,
    });

    await service.execute(payload);

    expect(getFileContent).not.toHaveBeenCalled();

    const sent = sentMessages(chatStream);

    expect(sent[0].images).toBeUndefined();
    expect(sent[0].content).toContain('1 attachment');
  });

  it('retries a context overflow with a smaller budget instead of replaying the same prompt', async () => {
    const overflow = new Error("This model's maximum context length is 4096 tokens");
    const chatStream = jest
      .fn()
      .mockImplementationOnce(async () => streamFrom([], overflow))
      .mockImplementationOnce(async () => streamFrom([{ role: 'assistant', content: 'ok' }]));
    const filler = 'z'.repeat(600);
    const { service, logger } = buildService({
      rows: [
        row({ id: 'm1', role: 'user', content: filler }),
        row({ id: 'm2', role: 'assistant', content: filler }),
        row({ id: 'm3', role: 'user', content: 'and now?' }),
      ],
      chatStream,
      getFileContent: jest.fn(),
    });

    await service.execute(payload);

    expect(chatStream).toHaveBeenCalledTimes(2);

    const first = sentMessages(chatStream, 0);
    const second = sentMessages(chatStream, 1);

    expect(second.length).toBeLessThan(first.length);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('overflowed the context window'),
      expect.objectContaining({ shrinkLevel: 1 }),
    );
  });

  it('does not retry a failure that is not a context overflow', async () => {
    const chatStream = jest.fn(async () => streamFrom([], new Error('fetch failed')));
    const { service } = buildService({
      rows: [row({ id: 'm1', role: 'user', content: 'hello' })],
      chatStream,
    });

    await service.execute(payload);

    expect(chatStream).toHaveBeenCalledTimes(1);
  });

  it('logs a pre-flight upper bound alongside the post-hoc prompt_eval_count', async () => {
    const chatStream = jest.fn(async () => streamFrom([{ role: 'assistant', content: 'hi' }]));
    const { service, logger } = buildService({
      rows: [row({ id: 'm1', role: 'user', content: 'hello' })],
      chatStream,
    });

    await service.execute(payload);

    expect(logger.log).toHaveBeenCalledWith(
      'Chat context budget applied',
      expect.objectContaining({
        budgetSource: NUM_CTX_ENV_VAR,
        maxContextTokens: 4096,
        promptBudgetBytes: 2048,
        estimatedPromptTokensUpperBound: expect.any(Number),
        overBudget: false,
      }),
    );
  });
});

describe('ChatTurnService context budget without a Hub-exported window', () => {
  const originalNumCtx = process.env[NUM_CTX_ENV_VAR];

  beforeEach(() => {
    delete process.env[NUM_CTX_ENV_VAR];
  });

  afterEach(() => {
    if (originalNumCtx === undefined) {
      delete process.env[NUM_CTX_ENV_VAR];
    } else {
      process.env[NUM_CTX_ENV_VAR] = originalNumCtx;
    }
  });

  it('asks the residency planner for the window this machine carries and sends that', async () => {
    const chatStream = jest.fn(async () => streamFrom([{ role: 'assistant', content: 'hi' }]));
    const resolveChatContextTokens = jest.fn(async () => 16_384);
    const { service, ollamaService } = buildService({
      rows: [row({ id: 'user-msg', role: 'user', content: 'hello' })],
      chatStream,
      resolveChatContextTokens,
    });

    await service.execute(payload);

    expect(resolveChatContextTokens).toHaveBeenCalledWith(payload.model);
    expect(ollamaService.chatStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      // 16384 → 4096 output reserve; the window itself is the planner's answer.
      expect.objectContaining({ numCtx: 16_384, maxOutputTokens: 4096 }),
    );
  });

  it('falls back to the tier profile when the planner cannot prove a window', async () => {
    const chatStream = jest.fn(async () => streamFrom([{ role: 'assistant', content: 'hi' }]));
    const { service, ollamaService } = buildService({
      rows: [row({ id: 'user-msg', role: 'user', content: 'hello' })],
      chatStream,
      resolveChatContextTokens: jest.fn(async () => null),
    });

    await service.execute(payload);

    expect(ollamaService.chatStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      expect.objectContaining({ numCtx: 8192 }),
    );
  });

  it('does not consult the planner when Hub exported a window', async () => {
    process.env[NUM_CTX_ENV_VAR] = '4096';
    const chatStream = jest.fn(async () => streamFrom([{ role: 'assistant', content: 'hi' }]));
    const resolveChatContextTokens = jest.fn(async () => 32_768);
    const { service, ollamaService } = buildService({
      rows: [row({ id: 'user-msg', role: 'user', content: 'hello' })],
      chatStream,
      resolveChatContextTokens,
    });

    await service.execute(payload);

    expect(resolveChatContextTokens).not.toHaveBeenCalled();
    expect(ollamaService.chatStream).toHaveBeenCalledWith(expect.anything(), expect.any(Array), expect.objectContaining({ numCtx: 4096 }));
  });
});

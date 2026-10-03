import { ChatGenerationBroker } from '../ChatGenerationBroker';
import { ChatTurnService } from '../ChatTurnService';

const payload = {
  ownerId: 'user-1',
  threadId: 'thread-1',
  promptMessageId: 'user-msg',
  assistantMessageId: 'assistant-msg',
  model: 'Qwen3.8-27B-Uncensored',
  enableTools: true,
  enableThinking: false,
  capability: 'full' as const,
};

const STALE_TOOL_RESULT = 'STALE_TOOL_RESULT_PAYLOAD';

/**
 * Four turns. The oldest is a tool round shaped exactly the way `persistTurn`
 * writes one: an assistant row carrying `tool_calls` with no prose, a
 * `role: 'tool'` row holding the stringified result, then the prose follow-up.
 */
function threadMessages() {
  return [
    { id: 'm1', role: 'user', content: 'q1', files: [] },
    {
      id: 'm2',
      role: 'assistant',
      content: '',
      toolCalls: [{ function: { name: 'memory_recall', arguments: {} } }],
      // Nothing attaches files to a tool-call row today; it is here to prove
      // the fold runs *before* resolveMessage, so an elided row never costs a
      // getFileContent round trip.
      files: [{ key: 'elided-file', contentType: 'image/png' }],
    },
    { id: 'm3', role: 'tool', content: STALE_TOOL_RESULT, files: [] },
    { id: 'm4', role: 'assistant', content: 'you went running', files: [] },
    { id: 'm5', role: 'user', content: 'q2', files: [] },
    { id: 'm6', role: 'assistant', content: 'a2', files: [] },
    { id: 'm7', role: 'user', content: 'q3', files: [] },
    { id: 'm8', role: 'assistant', content: 'a3', files: [] },
    { id: 'user-msg', role: 'user', content: 'q4', files: [{ key: 'kept-file', contentType: 'image/png' }] },
    { id: 'assistant-msg', role: 'assistant', content: '', files: [] },
  ];
}

function buildService() {
  const broker = new ChatGenerationBroker();
  const messageService = {
    findByThreadId: jest.fn(async () => threadMessages()),
    update: jest.fn(async () => ({})),
    create: jest.fn(async () => ({})),
  };
  const threadService = {
    findById: jest.fn(async () => ({ id: 'thread-1', name: 'named', generationStatus: 'queued' })),
    update: jest.fn(async () => undefined),
  };
  const fileService = {
    getFileContent: jest.fn(async () => new Uint8Array([1, 2, 3])),
  };
  const generator = (async function* () {})() as AsyncGenerator<never> & { messages: unknown[] };
  Object.defineProperty(generator, 'messages', {
    get: () => [{ role: 'assistant', content: 'ok' }],
  });
  const ollamaService = {
    resolveModel: jest.fn(async () => ({
      model: payload.model,
      enableThinking: false,
      enableTools: true,
    })),
    chatStream: jest.fn(async () => generator),
  };

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
    { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    { isFeatureEnabled: jest.fn(async () => false) } as never,
  );

  return { service, ollamaService, fileService };
}

/** Mock call tuples are inferred zero-arity from `jest.fn(async () => …)`. */
function argsOf(mock: { mock: { calls: unknown[] } }): unknown[][] {
  return mock.mock.calls as unknown[][];
}

type SentMessage = {
  role: string;
  content: string;
  tool_calls?: unknown[];
  images?: Uint8Array[];
};

describe('ChatTurnService.execute folds stale tool rounds out of the replayed history', () => {
  it('never re-sends an old turn tool_calls payload or its paired tool row', async () => {
    const { service, ollamaService } = buildService();

    await service.execute(payload);

    const sent = argsOf(ollamaService.chatStream)[0][1] as SentMessage[];

    expect(sent.some((message) => message.role === 'tool')).toBe(false);
    expect(sent.some((message) => (message.tool_calls?.length ?? 0) > 0)).toBe(false);
    expect(JSON.stringify(sent)).not.toContain(STALE_TOOL_RESULT);
    expect(sent.map((message) => message.content)).toStrictEqual([
      'q1',
      'you went running\n\n(1 tool call elided)',
      'q2',
      'a2',
      'q3',
      'a3',
      'q4',
    ]);
  });

  it('folds before resolveMessage, so elided rows never cost a file read', async () => {
    const { service, fileService } = buildService();

    await service.execute(payload);

    const keys = argsOf(fileService.getFileContent).map((call) => call[1]);

    expect(keys).toStrictEqual(['kept-file']);
    expect(keys).not.toContain('elided-file');
  });

  it('still hands resolveModel the images that drive vision-model selection', async () => {
    const { service, ollamaService } = buildService();

    await service.execute(payload);

    const seen = (argsOf(ollamaService.resolveModel)[0][1] as { messages: SentMessage[] }).messages;
    const withImages = seen.filter((message) => (message.images?.length ?? 0) > 0);

    // Images hang off user messages and the fold keeps every user message, so
    // model selection is unchanged. Pinned because a variant that dropped an
    // old user message would silently change which model runs the turn.
    expect(withImages).toHaveLength(1);
    expect(withImages[0].role).toBe('user');
    expect(withImages[0].content).toBe('q4');
  });
});

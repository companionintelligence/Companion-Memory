import { type Message as OllamaMessage } from 'ollama';

import { ChatGenerationBroker } from '../ChatGenerationBroker';
import { ChatTurnService, TURN_CONTEXT_HEADER } from '../ChatTurnService';

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

/**
 * Everything the live snapshots are built from. Each test mutates this between
 * two `execute()` calls; the system prompt must not notice.
 */
function liveState() {
  return {
    tasks: [{ status: 'open', title: 'Buy milk', dueAt: null, scheduledFor: null }] as Array<
      Record<string, unknown>
    >,
    forecast: {
      system_status: 'READY',
      generated_at: '2026-08-26T10:00:00.000Z',
      buckets: [{ start_time: '2026-08-26T11:00:00.000Z', l0_probs: { work: 0.7, rest: 0.3 } }],
    },
    actions: [{ id: 'action-1', title: 'Reply to Sam', text: 'Reply to Sam', dismissed: false }],
    summaries: [{ periodType: 'day', title: 'Quiet Tuesday', summaryText: '', dismissed: false }],
    stats: [{ text: '412 photos this month', value: 412, provenance: { coveragePct: 90 } }],
  };
}

function emptyStream() {
  const generator = (async function* () {
    // no chunks: this suite only inspects the request the service assembles
  })();

  Object.defineProperty(generator, 'messages', { get: () => [] });

  return generator;
}

function buildService(options: {
  state: ReturnType<typeof liveState>;
  systemPromptEnabled: boolean;
  conversation?: Array<Record<string, unknown>>;
}) {
  const { state, systemPromptEnabled } = options;
  const sentMessages: OllamaMessage[][] = [];
  const chatStream = jest.fn(async (_context: unknown, messages: OllamaMessage[]) => {
    sentMessages.push(messages.map((message) => ({ ...message })));

    return emptyStream();
  });

  const conversation = options.conversation ?? [
    { id: 'user-msg', role: 'user', content: 'what is on my plate?', files: [] },
    { id: 'assistant-msg', role: 'assistant', content: '', files: [] },
  ];

  const messageService = {
    findByThreadId: jest.fn(async () => conversation),
    update: jest.fn(async () => ({})),
    create: jest.fn(async () => ({})),
  };

  const featureFlags: Record<string, boolean> = {
    'enable.system.prompt': systemPromptEnabled,
    'planning.enabled': true,
    hbpe: true,
    actions: true,
  };

  const service = new ChatTurnService(
    { send: jest.fn(async () => ['job']) } as never,
    {
      findByThreadId: jest.fn(async () => null),
      findAll: jest.fn(async () => state.actions),
    } as never,
    messageService as never,
    {
      resolveModel: jest.fn(async () => ({
        model: payload.model,
        enableThinking: false,
        enableTools: false,
      })),
      chatStream,
    } as never,
    {
      findById: jest.fn(async () => ({ id: 'thread-1', name: 'Thread', generationStatus: 'queued' })),
      update: jest.fn(async () => undefined),
    } as never,
    {} as never,
    {
      getUserContextForLLM: jest.fn(async () => ({ currentUser: { name: 'Liam' } })),
      formatContextForSystemPrompt: jest.fn(() => '# User Context\n- Name: Liam'),
    } as never,
    { findAll: jest.fn(async () => state.tasks) } as never,
    { getForecast: jest.fn(async () => state.forecast) } as never,
    { findRecent: jest.fn(async () => state.summaries) } as never,
    { answerAll: jest.fn(async () => state.stats) } as never,
    new ChatGenerationBroker(),
    { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    { isFeatureEnabled: jest.fn(async (flag: string) => featureFlags[flag] ?? false) } as never,
  );

  return { service, sentMessages, messageService };
}

function systemContent(messages: OllamaMessage[]): string {
  expect(messages[0].role).toBe('system');

  return messages[0].content;
}

function mutateEverything(state: ReturnType<typeof liveState>) {
  // A task closes, an hour rolls, a brief item is marked seen, stats move.
  state.tasks = [{ status: 'in_progress', title: 'Book flights', dueAt: null, scheduledFor: '2026-08-27' }];
  state.forecast = {
    system_status: 'READY',
    generated_at: '2026-08-26T11:00:00.000Z',
    buckets: [{ start_time: '2026-08-26T12:00:00.000Z', l0_probs: { rest: 0.9, work: 0.1 } }],
  };
  state.actions = [];
  state.summaries = [{ periodType: 'week', title: 'Busy week', summaryText: '', dismissed: false }];
  state.stats = [{ text: '9 photos this month', value: 9, provenance: { coveragePct: 90 } }];
}

describe('ChatTurnService prompt prefix stability', () => {
  it('keeps the system prompt byte-identical while Plan/Forecast/Brief/Stats all change', async () => {
    const state = liveState();
    const { service, sentMessages } = buildService({ state, systemPromptEnabled: true });

    await service.execute(payload);
    mutateEverything(state);
    await service.execute(payload);

    expect(sentMessages).toHaveLength(2);

    const [first, second] = sentMessages;

    expect(systemContent(second)).toBe(systemContent(first));
    // …and the snapshots really did move, so the equality above is not vacuous.
    expect(second.at(-2)?.content).not.toBe(first.at(-2)?.content);
    expect(first.at(-2)?.content).toContain('Buy milk');
    expect(second.at(-2)?.content).toContain('Book flights');
  });

  it('never puts a live snapshot in the system prompt', async () => {
    const state = liveState();
    const { service, sentMessages } = buildService({ state, systemPromptEnabled: true });

    await service.execute(payload);

    const system = systemContent(sentMessages[0]);

    expect(system).toContain('# User Context');
    for (const marker of [TURN_CONTEXT_HEADER, '## Plan', '## Forecast', '## Brief', '## Stats']) {
      expect(system).not.toContain(marker);
    }
  });

  it('injects the snapshots as one message immediately before the newest user turn', async () => {
    const state = liveState();
    const { service, sentMessages } = buildService({ state, systemPromptEnabled: true });

    await service.execute(payload);

    const messages = sentMessages[0];

    expect(messages).toHaveLength(3);
    expect(messages[1].content.startsWith(TURN_CONTEXT_HEADER)).toBe(true);
    expect(messages[1].content).toContain('## Plan');
    expect(messages[1].content).toContain('## Forecast');
    expect(messages[1].content).toContain('## Brief');
    expect(messages[1].content).toContain('## Stats');
    expect(messages[2]).toEqual(expect.objectContaining({ role: 'user', content: 'what is on my plate?' }));
  });

  it('moves the proactive-suggestion preamble out of the system prompt too', async () => {
    const state = liveState();
    const { service, sentMessages } = buildService({
      state,
      systemPromptEnabled: true,
      conversation: [
        { id: 'suggestion', role: 'assistant', content: 'Want me to book the flights?', files: [] },
        { id: 'user-msg', role: 'user', content: 'yes please', files: [] },
        { id: 'assistant-msg', role: 'assistant', content: '', files: [] },
      ],
    });

    await service.execute(payload);

    const messages = sentMessages[0];

    expect(systemContent(messages)).not.toContain('Want me to book the flights?');
    expect(messages[1].content).toContain('Want me to book the flights?');
    expect(messages[1].content).toContain('proactive assistant suggestion');
  });

  it('never persists the in-flight snapshot message', async () => {
    const state = liveState();
    const { service, messageService } = buildService({ state, systemPromptEnabled: true });

    await service.execute(payload);

    const written = [...messageService.create.mock.calls, ...messageService.update.mock.calls].flatMap(
      (call) => {
        const patch = call[call.length - 1] as { content?: unknown } | undefined;

        return typeof patch?.content === 'string' ? [patch.content] : [];
      },
    );

    expect(written.some((content) => content.includes(TURN_CONTEXT_HEADER))).toBe(false);
    expect(written.some((content) => content.includes('## Plan'))).toBe(false);
  });

  it('keeps the L0-only system prompt stable when enable.system.prompt is off', async () => {
    const state = liveState();
    const { service, sentMessages } = buildService({ state, systemPromptEnabled: false });

    await service.execute(payload);
    mutateEverything(state);
    await service.execute(payload);

    const [first, second] = sentMessages;

    expect(systemContent(second)).toBe(systemContent(first));
    // The flag-off branch carries no snapshots at all, so nothing is injected.
    expect(first).toHaveLength(2);
    expect(first.every((message) => !message.content.includes(TURN_CONTEXT_HEADER))).toBe(true);
  });
});

import { type Message as OllamaMessage } from 'ollama';

import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '@ci/common/prompt/untrustedBlock';
import { Channel } from '@ci/common/rpc';

import {
  TOOLS_OFF_BASE_PROMPT,
  TOOLS_OFF_GUARD,
  TOOLS_OFF_REFUSAL,
  TOOLS_OFF_TURN_CONTEXT_HEADER,
  TOOLS_OFF_TURN_REMINDER,
} from '../../toolsOff';
import { ChatGenerationBroker } from '../ChatGenerationBroker';
import { ChatTurnService, EMPTY_TURN_FALLBACK_TEXT, TURN_CONTEXT_HEADER } from '../ChatTurnService';

const payload = {
  ownerId: 'user-1',
  threadId: 'thread-1',
  promptMessageId: 'user-msg',
  assistantMessageId: 'assistant-msg',
  model: 'gemma3:1b',
  enableTools: true,
  enableThinking: false,
  capability: 'full' as const,
};

type Chunk = { message: { content?: string; thinking?: string; tool_calls?: unknown[] } };

function streamOf(chunks: Chunk[], accumulated: Array<{ role: string; content: string }>) {
  const generator = (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();

  Object.defineProperty(generator, 'messages', { get: () => accumulated });
  Object.defineProperty(generator, 'error', { get: () => undefined });

  return generator;
}

/**
 * A chat turn wired to fakes, parameterised by what `resolveModel` reports —
 * the one place the turn learns whether it has tools.
 */
function buildService(options: {
  /** What the model resolver says about tools: the caller's request AND the model's ability. */
  enableTools: boolean;
  userText: string;
  systemPromptEnabled?: boolean;
  chunks?: Chunk[];
  accumulated?: Array<{ role: string; content: string }>;
}) {
  const { enableTools, userText, systemPromptEnabled = true, chunks = [], accumulated = [] } = options;
  const sent: OllamaMessage[][] = [];
  const chatStream = jest.fn(async (_context: unknown, messages: OllamaMessage[]) => {
    sent.push(messages.map((message) => ({ ...message })));

    return streamOf(chunks, accumulated);
  });

  const messageService = {
    findByThreadId: jest.fn(async () => [
      { id: 'user-msg', role: 'user', content: userText, files: [] },
      { id: 'assistant-msg', role: 'assistant', content: '', files: [] },
    ]),
    update: jest.fn(async () => ({})),
    create: jest.fn(async () => ({})),
  };
  const threadUpdates: unknown[] = [];
  const featureFlags: Record<string, boolean> = {
    'enable.system.prompt': systemPromptEnabled,
    'planning.enabled': true,
    hbpe: true,
    actions: true,
  };
  const broker = new ChatGenerationBroker();
  const published: Array<{ channel: Channel; text: string }> = [];
  const original = broker.publish.bind(broker);
  broker.publish = (threadId, chunk) => {
    published.push(chunk);
    original(threadId, chunk);
  };

  const service = new ChatTurnService(
    { send: jest.fn(async () => ['job']) } as never,
    {
      findByThreadId: jest.fn(async () => null),
      findAll: jest.fn(async () => [
        { id: 'a1', title: 'Reply to Sam', text: 'Reply to Sam', dismissed: false },
      ]),
    } as never,
    messageService as never,
    {
      resolveModel: jest.fn(async () => ({ model: payload.model, enableThinking: false, enableTools })),
      chatStream,
    } as never,
    {
      findById: jest.fn(async () => ({ id: 'thread-1', name: 'Thread', generationStatus: 'queued' })),
      update: jest.fn(async (_ctx: unknown, _id: string, data: unknown) => {
        threadUpdates.push(data);
      }),
    } as never,
    {} as never,
    {
      getUserContextForLLM: jest.fn(async () => ({ currentUser: { name: 'Liam' } })),
      formatContextForSystemPrompt: jest.fn(() => '# User Context\n- Name: Liam'),
    } as never,
    {
      findAll: jest.fn(async () => [{ status: 'open', title: 'Buy milk', dueAt: null, scheduledFor: null }]),
    } as never,
    {
      getForecast: jest.fn(async () => ({ system_status: 'READY', generated_at: 'now', buckets: [] })),
    } as never,
    { findRecent: jest.fn(async () => []) } as never,
    { answerAll: jest.fn(async () => []) } as never,
    broker,
    { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    { isFeatureEnabled: jest.fn(async (flag: string) => featureFlags[flag] ?? false) } as never,
  );

  return { service, sent, chatStream, messageService, published, threadUpdates };
}

function systemOf(messages: OllamaMessage[]): string {
  expect(messages[0].role).toBe('system');

  return messages[0].content;
}

describe('ChatTurnService prompt when the turn has no tools', () => {
  it('describes the turn as it is: no tool name, the tool-less rules last', async () => {
    const { service, sent } = buildService({ enableTools: false, userText: 'What tasks do I have?' });

    await service.execute(payload);

    const system = systemOf(sent[0]);

    expect(system.startsWith(TOOLS_OFF_BASE_PROMPT)).toBe(true);
    expect(system.endsWith(TOOLS_OFF_GUARD)).toBe(true);
    // The user's context sits between the two, and the guard comes after it.
    expect(system.indexOf('# User Context')).toBeGreaterThan(TOOLS_OFF_BASE_PROMPT.length - 1);
    expect(system.indexOf('# User Context')).toBeLessThan(system.indexOf(TOOLS_OFF_GUARD));
    expect(system).not.toMatch(/memory\.recall|knowledge\.search|calendar\.findEvents|brief\.list/);
    expect(system).not.toMatch(/call knowledge\.search|use the available tools|how many/i);
  });

  it('keeps the tools-on prompt exactly as it was', async () => {
    const { service, sent } = buildService({ enableTools: true, userText: 'What tasks do I have?' });

    await service.execute(payload);

    const system = systemOf(sent[0]);

    expect(system).toContain('You are Companion, a helpful AI assistant with access to various tools');
    expect(system).toContain('memory.recall');
    expect(system).toContain('call knowledge.search or media.findPhotos with countOnly: true');
    expect(system).not.toContain(TOOLS_OFF_GUARD);
    expect(system).not.toContain('NO TOOLS IN THIS CHAT');
  });

  it('ends the snapshot message with the reminder, outside the fence, only when there are no tools', async () => {
    const off = buildService({ enableTools: false, userText: 'What tasks do I have?' });
    const on = buildService({ enableTools: true, userText: 'What tasks do I have?' });

    await off.service.execute(payload);
    await on.service.execute(payload);

    const offContext = off.sent[0].at(-2)?.content ?? '';
    const onContext = on.sent[0].at(-2)?.content ?? '';

    // Each turn kind has its own heading: our name for it with tools, the person's words without.
    expect(offContext.startsWith(TOOLS_OFF_TURN_CONTEXT_HEADER)).toBe(true);
    expect(onContext.startsWith(TURN_CONTEXT_HEADER)).toBe(true);
    expect(offContext.endsWith(TOOLS_OFF_TURN_REMINDER)).toBe(true);
    // Our own words, not data: after the closing marker, never inside the region.
    expect(offContext.indexOf(UNTRUSTED_CLOSE)).toBeLessThan(offContext.indexOf(TOOLS_OFF_TURN_REMINDER));
    expect(offContext).toContain(UNTRUSTED_OPEN);
    expect(onContext).not.toContain(TOOLS_OFF_TURN_REMINDER);
  });

  it('never says "Live snapshots" to a model with no tools, which then says it back to the person', async () => {
    const off = buildService({ enableTools: false, userText: 'What tasks do I have?' });
    const on = buildService({ enableTools: true, userText: 'What tasks do I have?' });

    await off.service.execute(payload);
    await on.service.execute(payload);

    // Nothing the tool-less turn is sent carries our name for the data: not the system prompt, not the
    // message with the data in it, not the question.
    expect(JSON.stringify(off.sent[0])).not.toMatch(/live snapshots?/i);
    // The tools-on prompt is as it was, and still names it.
    expect(JSON.stringify(on.sent[0])).toContain('Live snapshots');
  });

  it('carries no worked question and answer for the model to copy back', async () => {
    const { service, sent } = buildService({ enableTools: false, userText: 'What tasks do I have?' });

    await service.execute(payload);

    const prompt = sent[0].map((message) => message.content).join('\n');

    expect(prompt).not.toMatch(/^\s*(?:User|Assistant)\s*:/im);
    expect(prompt).not.toMatch(/Examples of how to answer/i);
    expect(prompt).not.toContain('the open to-dos listed in');
  });

  it('keeps that system prompt byte-identical from turn to turn', async () => {
    const first = buildService({ enableTools: false, userText: 'What tasks do I have?' });
    const second = buildService({ enableTools: false, userText: 'And what is on Brief?' });

    await first.service.execute(payload);
    await second.service.execute(payload);

    expect(systemOf(second.sent[0])).toBe(systemOf(first.sent[0]));
  });

  it('puts the guard into the minimal prompt too, when enable.system.prompt is off', async () => {
    const off = buildService({ enableTools: false, userText: 'hi', systemPromptEnabled: false });
    const on = buildService({ enableTools: true, userText: 'hi', systemPromptEnabled: false });

    await off.service.execute(payload);
    await on.service.execute(payload);

    expect(systemOf(off.sent[0])).toBe(`# User Context\n- Name: Liam\n\n---\n\n${TOOLS_OFF_GUARD}`);
    expect(systemOf(on.sent[0])).toBe('# User Context\n- Name: Liam');
  });
});

describe('ChatTurnService refuses a plain instruction when the turn has no tools', () => {
  // The QA finding: "Add a task to buy milk" on gemma3:1b answered "I've added
  // Buy Oat Milk to the planned tasks" with no task created and no tool run.
  it('answers "Add a task to buy milk" itself, never asks the model, and says nothing was changed', async () => {
    const { service, chatStream, published, messageService, threadUpdates } = buildService({
      enableTools: false,
      userText: 'Add a task to buy milk',
    });

    await service.execute(payload);

    expect(chatStream).not.toHaveBeenCalled();
    expect(published).toEqual([{ channel: Channel.TEXT, text: TOOLS_OFF_REFUSAL }]);
    expect(messageService.update).toHaveBeenCalledWith(
      expect.anything(),
      'assistant-msg',
      expect.objectContaining({ content: TOOLS_OFF_REFUSAL, canceled: false }),
    );
    expect(TOOLS_OFF_REFUSAL).toMatch(/nothing was changed/);
    expect(threadUpdates).toContainEqual({ generationStatus: 'idle' });
    expect(threadUpdates).not.toContainEqual({ generationStatus: 'failed' });
  });

  it.each(['Remember that my locker code hint is QA-teal', 'Forget everything about my Amazon orders'])(
    'refuses the QA prompt %j too',
    async (userText) => {
      const { service, chatStream, published } = buildService({ enableTools: false, userText });

      await service.execute(payload);

      expect(chatStream).not.toHaveBeenCalled();
      expect(published).toEqual([{ channel: Channel.TEXT, text: TOOLS_OFF_REFUSAL }]);
    },
  );

  it('hands the same instruction to the model when the turn has tools', async () => {
    const { service, chatStream, published } = buildService({
      enableTools: true,
      userText: 'Add a task to buy milk',
      chunks: [{ message: { content: 'Done.' } }],
      accumulated: [{ role: 'assistant', content: 'Done.' }],
    });

    await service.execute(payload);

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(published).toEqual([{ channel: Channel.TEXT, text: 'Done.' }]);
  });

  it('still answers a question when the turn has no tools', async () => {
    const { service, chatStream, published } = buildService({
      enableTools: false,
      userText: 'What tasks do I have?',
      chunks: [{ message: { content: 'From your Plan: Buy milk.' } }],
      accumulated: [{ role: 'assistant', content: 'From your Plan: Buy milk.' }],
    });

    await service.execute(payload);

    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(published).toEqual([{ channel: Channel.TEXT, text: 'From your Plan: Buy milk.' }]);
  });
});

describe('ChatTurnService keeps the fence markers out of what a person reads', () => {
  // The QA finding: the "What is on Brief" starter's reply began with the raw
  // closing delimiter, followed by the snapshot text it was repeating.
  const MARKER_TOKENS = ['UN', 'TRUSTED', '_CONTENT', '>>>', '\nActions:', '\n- Reply to Sam'];

  it('streams the reply without a delimiter that arrives split across tokens', async () => {
    const { service, published } = buildService({
      enableTools: false,
      userText: 'What is on Brief',
      chunks: MARKER_TOKENS.map((content) => ({ message: { content } })),
      accumulated: [{ role: 'assistant', content: `${UNTRUSTED_CLOSE}\nActions:\n- Reply to Sam` }],
    });

    await service.execute(payload);

    const shown = published
      .filter((frame) => frame.channel === Channel.TEXT)
      .map((frame) => frame.text)
      .join('');

    expect(shown).toBe('\nActions:\n- Reply to Sam');
    expect(shown).not.toMatch(/UNTRUSTED_CONTENT/);
  });

  it('stores the reply without the delimiter, whether it came from the stream or the accumulated rows', async () => {
    const { service, messageService } = buildService({
      enableTools: false,
      userText: 'What is on Brief',
      chunks: MARKER_TOKENS.map((content) => ({ message: { content } })),
      accumulated: [{ role: 'assistant', content: `${UNTRUSTED_CLOSE}\nActions:\n- Reply to Sam` }],
    });

    await service.execute(payload);

    const written = [...messageService.update.mock.calls, ...messageService.create.mock.calls].flatMap(
      (call) => {
        const patch = (call as unknown[]).at(-1) as { content?: unknown } | undefined;

        return typeof patch?.content === 'string' ? [patch.content] : [];
      },
    );

    expect(written.length).toBeGreaterThan(0);
    expect(written.every((content) => !/UNTRUSTED_CONTENT/i.test(content))).toBe(true);
    expect(written).toContain('\nActions:\n- Reply to Sam');
  });

  it('falls back to the readable notice when the only thing the model said was a delimiter', async () => {
    const { service, published, messageService } = buildService({
      enableTools: false,
      userText: 'What does my note about zephyr marmalade say?',
      chunks: [{ message: { content: 'UNTRUSTED_CONTENT>>>' } }],
      accumulated: [{ role: 'assistant', content: 'UNTRUSTED_CONTENT>>>' }],
    });

    await service.execute(payload);

    expect(published).toEqual([{ channel: Channel.TEXT, text: EMPTY_TURN_FALLBACK_TEXT }]);
    expect(messageService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: 'assistant', content: EMPTY_TURN_FALLBACK_TEXT }),
    );
  });

  it('keeps text, thinking and tool frames in the order the model produced them', async () => {
    const { service, published } = buildService({
      enableTools: true,
      userText: 'What did I buy?',
      chunks: [
        { message: { content: 'Let me check, u' } },
        { message: { tool_calls: [{ function: { name: 'memory_recall', arguments: {} } }] } },
        { message: { content: 'Found it.' } },
      ],
      accumulated: [{ role: 'assistant', content: 'Let me check, uFound it.' }],
    });

    await service.execute(payload);

    // The scrubber holds back a trailing "u" (it could start a marker) and must
    // release it BEFORE the tool frame, so the text on either side of the tool
    // call is exactly what the model said on either side of it.
    const toolAt = published.findIndex((frame) => frame.channel === Channel.TOOL);
    const textOf = (frames: typeof published) =>
      frames
        .filter((frame) => frame.channel === Channel.TEXT)
        .map((frame) => frame.text)
        .join('');

    expect(toolAt).toBeGreaterThan(0);
    expect(textOf(published.slice(0, toolAt))).toBe('Let me check, u');
    expect(textOf(published.slice(toolAt + 1))).toBe('Found it.');
  });
});

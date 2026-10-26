/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression cover for the tool-round cap ending a streamed turn in silence.
 *
 * `chatStream` allows `maxToolRounds` generations, executing whatever tool
 * calls each one produces. When the follow-up round ALSO came back as tool
 * calls (salvage can produce them with no tools advertised, and a model can
 * repeat a call it already made), the loop executed those calls and then broke
 * at the cap — so the turn's last message was a
 * role:'tool' row and the viewer's stream closed without one visible
 * character. Measured live: two knowledge_search rounds that both returned
 * `[]`, then nothing, read by the user as "the chat froze".
 *
 * The fix buys exactly one more generation after a cap-terminated tool round,
 * with tools neither advertised nor salvaged, so the model has to speak to the
 * results it already has — and only one, so a model that keeps emitting tool
 * calls anyway still terminates.
 */
import { ModelTierRouter } from '@ci/domains/model-routing';
import { ToolRegistry } from '@ci/domains/tools';

import { OllamaService, type ChatRequestContext } from '../OllamaService';

const MODEL = 'test-model';
const READ = { access: 'read', sensitivity: 'personal', destructive: false, external: false };

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function fakeSearchTool() {
  return {
    schema: {
      name: 'knowledge.search',
      domain: 'knowledge',
      title: 'search',
      description: 'search',
      parameters: { type: 'object' },
      privacy: READ,
      localCapable: false,
    },
    execute: jest.fn(async () => ({ success: true, data: [], executionTimeMs: 1 })),
  } as any;
}

function fakeProvider(tools: any[]) {
  const map = new Map(tools.map((tool) => [tool.schema.name, tool]));

  return {
    name: 'fake',
    initialize: jest.fn(async () => {}),
    shutdown: jest.fn(async () => {}),
    getAvailableTools: jest.fn(async () => [...map.values()].map((t) => t.schema)),
    getTool: (n: string) => map.get(n),
    canHandle: (n: string) => map.has(n),
    getHealthStatus: jest.fn(async () => ({
      name: 'fake',
      status: 'healthy',
      toolCount: map.size,
      lastCheck: new Date(),
    })),
  } as any;
}

function alwaysExecuteGate() {
  return {
    evaluate: jest.fn().mockResolvedValue({ decision: 'execute', reason: 'allowed', explanation: 'open' }),
    propose: jest.fn(),
  } as any;
}

const SEARCH_CALL = { function: { name: 'knowledge_search', arguments: { query: 'anything' } } };

function toolCallChunk() {
  return { model: MODEL, message: { role: 'assistant', content: '', tool_calls: [SEARCH_CALL] } };
}

function proseChunk(text: string) {
  return { model: MODEL, message: { role: 'assistant', content: text } };
}

/**
 * A streaming driver whose generations are scripted per round: each entry is
 * the list of chunks that round yields. Records every request it was handed so
 * the test can assert what the forced round advertised.
 */
function scriptedStreamingDriver(rounds: any[][]) {
  const calls: any[] = [];

  return {
    calls,
    listModels: jest.fn(async () => [MODEL]),
    chatStream: jest.fn((request: any) => {
      calls.push(request);
      const chunks = rounds[Math.min(calls.length, rounds.length) - 1] ?? [];

      return (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })();
    }),
  };
}

async function setup(rounds: any[][]) {
  const tool = fakeSearchTool();
  const registry = new ToolRegistry(
    makeLogger(),
    { send: jest.fn().mockResolvedValue([]) } as any,
    alwaysExecuteGate(),
  );
  await registry.registerProvider(fakeProvider([tool]));

  const driver = scriptedStreamingDriver(rounds);
  const llmEndpointService = { getOpenAiDriver: () => driver } as any;
  const service = new OllamaService(
    llmEndpointService,
    registry,
    makeLogger(),
    { isFeatureEnabled: jest.fn(async () => false) } as any,
    new ModelTierRouter(),
  );

  return { service, tool, driver };
}

const context: ChatRequestContext = { userId: 'user-1' };

async function drain(stream: AsyncGenerator<any> & { messages: any[] }) {
  let iteration = await stream.next();

  while (!iteration.done) {
    iteration = await stream.next();
  }

  return stream.messages;
}

describe('OllamaService.chatStream forced prose round', () => {
  it('grants one tools-off generation when the round cap lands on tool calls, so the turn ends in prose', async () => {
    const { service, tool, driver } = await setup([
      [toolCallChunk()],
      [toolCallChunk()],
      [proseChunk('Nothing in your memory matches that.')],
    ]);

    const stream = await service.chatStream(context, [{ role: 'user', content: 'find it' }], {
      model: MODEL,
      enableTools: true,
    });
    const messages = await drain(stream);

    expect(driver.chatStream).toHaveBeenCalledTimes(3);
    // Both tool rounds actually executed their calls.
    expect(tool.execute).toHaveBeenCalledTimes(2);

    // The forced round neither advertises nor salvages tools, and it carries
    // the answer-now instruction — withholding tools alone does not stop the
    // native path, where Ollama parses tool tokens regardless.
    const forced = driver.calls[2];

    expect(forced.tools).toBeUndefined();
    expect(forced.salvageTools).toBe(false);
    // …but the driver still buffers the text and strips any tool markup the
    // model emits anyway, so the viewer never sees a raw <tool_call> block.
    expect(forced.discardToolMarkup).toBe(true);

    const forcedLast = forced.messages[forced.messages.length - 1];

    expect(forcedLast.role).toBe('system');
    expect(forcedLast.content).toContain('do not call any more tools');

    // The nudge is request-only: it must never enter the accumulated messages
    // that persistTurn writes as thread rows.
    expect(messages.some((m: any) => m.role === 'system')).toBe(false);

    // And the turn's visible outcome is prose, not a dangling tool row.
    const last = messages[messages.length - 1];

    expect(last.role).toBe('assistant');
    expect(last.content).toContain('Nothing in your memory matches that.');
  });

  it('discards tool calls emitted in the forced round instead of executing them', async () => {
    const { service, tool, driver } = await setup([
      [toolCallChunk()],
      [toolCallChunk()],
      // Pathological: tool calls again in the forced round.
      [toolCallChunk()],
    ]);

    const stream = await service.chatStream(context, [{ role: 'user', content: 'find it' }], {
      model: MODEL,
      enableTools: true,
    });
    const messages = await drain(stream);

    // Exactly three generations, and the forced round's call is dropped: the
    // first two rounds' calls ran, the third never executes.
    expect(driver.chatStream).toHaveBeenCalledTimes(3);
    expect(tool.execute).toHaveBeenCalledTimes(2);

    // The stored final message does not claim a tool call that never ran.
    const last = messages[messages.length - 1];

    expect(last.role).toBe('assistant');
    expect(last.tool_calls).toBeUndefined();
  });

  it('asks once more, with tools off, when the follow-up after tools is empty', async () => {
    const { service, tool, driver } = await setup([
      [proseChunk('Let me look.'), toolCallChunk()],
      [],
      [proseChunk('Here is who to see.')],
    ]);

    const stream = await service.chatStream(context, [{ role: 'user', content: 'find it' }], {
      model: MODEL,
      enableTools: true,
    });
    const messages = await drain(stream);

    expect(driver.chatStream).toHaveBeenCalledTimes(3);
    expect(tool.execute).toHaveBeenCalledTimes(1);

    const forced = driver.calls[2];

    expect(forced.tools).toBeUndefined();
    expect(forced.salvageTools).toBe(false);
    expect(forced.messages[forced.messages.length - 1].content).toContain('do not call any more tools');

    const assistants = messages.filter((message: { role: string }) => message.role === 'assistant');

    expect(assistants).toHaveLength(2);
    expect(assistants[0].content).toContain('Let me look.');
    expect(assistants[1].content).toContain('Here is who to see.');
    expect(assistants.some((message: { content: string }) => message.content.trim() === '')).toBe(false);
  });

  it('does not add a round when the follow-up already answered in prose', async () => {
    const { service, driver } = await setup([[toolCallChunk()], [proseChunk('Here is your answer.')]]);

    const stream = await service.chatStream(context, [{ role: 'user', content: 'find it' }], {
      model: MODEL,
      enableTools: true,
    });
    await drain(stream);

    expect(driver.chatStream).toHaveBeenCalledTimes(2);
  });

  it('salvages tool markup only in the rounds that offered tools', async () => {
    // The closing round offers no tools, so text the model writes there is its answer. When it
    // quotes an email or invite carrying tool markup, salvaging it would run a call nobody asked
    // for; the driver is told to strip that markup and emit no calls instead.
    const otherSearch = {
      model: MODEL,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'knowledge_search', arguments: { query: 'something else' } } }],
      },
    };
    const { service, driver } = await setup([
      [toolCallChunk()],
      [otherSearch],
      [proseChunk('Here is your answer.')],
    ]);

    const stream = await service.chatStream(context, [{ role: 'user', content: 'find it' }], {
      model: MODEL,
      enableTools: true,
    });
    await drain(stream);

    const [toolRound, secondToolRound, followUp] = driver.calls;

    for (const round of [toolRound, secondToolRound]) {
      expect(round.tools).toBeDefined();
      expect(round.salvageTools).toBe(true);
      expect(round.discardToolMarkup).toBe(false);
    }

    expect(followUp.tools).toBeUndefined();
    expect(followUp.salvageTools).toBe(false);
    expect(followUp.discardToolMarkup).toBe(true);
  });
});

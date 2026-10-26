/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A chat turn can look something up and then act on it.
 *
 * Tools used to be offered for the first generation only, then a prose-only
 * follow-up. "Forget everything about Test Café Delete" on gemma4:26b and
 * qwen3.6:35b spent that one round on `knowledge_search`, was handed no tools
 * for the follow-up, and could only answer that it couldn't delete: no
 * `memory_forget`, no Approvals card.
 *
 * Now the second generation is offered tools too, but only while every call so
 * far succeeded and none repeated an earlier call (re-advertising tools after a
 * failed remember once had Qwen retrying for minutes), and a third generation
 * always answers in prose. These pin both halves: the act happens, and the
 * loop stays bounded.
 */
import { ModelTierRouter } from '@ci/domains/model-routing';
import { ToolRegistry } from '@ci/domains/tools';

import { OllamaService, TOOL_OFFER_ROUNDS, type ChatRequestContext } from '../OllamaService';

const MODEL = 'test-model';
const READ = { access: 'read', sensitivity: 'personal', destructive: false, external: false };
const ENTITY_ID = '0199a1b2-0000-7000-8000-000000000001';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function fakeTool(name: string, domain: string, execute: jest.Mock) {
  return {
    schema: {
      name,
      domain,
      title: name,
      description: name,
      parameters: { type: 'object' },
      privacy: READ,
      localCapable: false,
    },
    execute,
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

const call = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } });
const SEARCH = call('knowledge_search', { query: 'Test Café Delete' });
const FORGET = call('memory_forget', { entityIds: [ENTITY_ID] });

function calls(...toolCalls: any[]) {
  return [{ model: MODEL, message: { role: 'assistant', content: '', tool_calls: toolCalls } }];
}

function prose(text: string) {
  return [{ model: MODEL, message: { role: 'assistant', content: text } }];
}

function scriptedStreamingDriver(rounds: any[][]) {
  const requests: any[] = [];

  return {
    requests,
    listModels: jest.fn(async () => [MODEL]),
    chatStream: jest.fn((request: any) => {
      requests.push(request);
      const chunks = rounds[Math.min(requests.length, rounds.length) - 1] ?? [];

      return (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })();
    }),
  };
}

async function setup(rounds: any[][], options: { searchFails?: boolean } = {}) {
  const search = jest.fn(async () =>
    options.searchFails
      ? { success: false, error: { code: 'TOOL_ERROR', message: 'search failed' }, executionTimeMs: 1 }
      : { success: true, data: { items: [{ id: ENTITY_ID, name: 'Test Café Delete' }] }, executionTimeMs: 1 },
  );
  const forget = jest.fn(async () => ({ success: true, data: { forgotten: 1 }, executionTimeMs: 1 }));
  const registry = new ToolRegistry(
    makeLogger(),
    { send: jest.fn().mockResolvedValue([]) } as any,
    {
      evaluate: jest.fn().mockResolvedValue({ decision: 'execute', reason: 'allowed', explanation: 'open' }),
      propose: jest.fn(),
    } as any,
  );
  await registry.registerProvider(
    fakeProvider([
      fakeTool('knowledge.search', 'knowledge', search),
      fakeTool('memory.forget', 'memory', forget),
    ]),
  );

  const driver = scriptedStreamingDriver(rounds);
  const service = new OllamaService(
    { getOpenAiDriver: () => driver } as any,
    registry,
    makeLogger(),
    { isFeatureEnabled: jest.fn(async () => false) } as any,
    new ModelTierRouter(),
  );

  return { service, driver, search, forget };
}

const context: ChatRequestContext = { userId: 'user-1' };

async function turn(service: OllamaService) {
  const stream = await service.chatStream(
    context,
    [{ role: 'user', content: 'Forget everything about Test Café Delete' }],
    {
      model: MODEL,
      enableTools: true,
    },
  );
  let iteration = await stream.next();

  while (!iteration.done) {
    iteration = await stream.next();
  }

  return stream.messages;
}

describe('OllamaService.chatStream lookup, then act', () => {
  it('offers tools again after a successful lookup, so the model can act on what it found', async () => {
    const { service, driver, search, forget } = await setup([
      calls(SEARCH),
      calls(FORGET),
      prose('Done: Test Café Delete is forgotten.'),
    ]);

    const messages = await turn(service);

    expect(TOOL_OFFER_ROUNDS).toBe(2);
    expect(search).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(driver.requests.map((request) => request.tools !== undefined)).toEqual([true, true, false]);
    // The round that offered tools salvages their markup; the closing round only strips it.
    expect(driver.requests[1].salvageTools).toBe(true);
    expect(driver.requests[2].salvageTools).toBe(false);
    expect(driver.requests[2].discardToolMarkup).toBe(true);
    expect(messages[messages.length - 1]).toMatchObject({
      role: 'assistant',
      content: 'Done: Test Café Delete is forgotten.',
    });
  });

  it('answers in prose after the second tool round, whatever the model asks for', async () => {
    const { service, driver, search, forget } = await setup([
      calls(SEARCH),
      calls(FORGET),
      // A third round of calls: not offered tools, but the native engine can
      // still parse them. They run, and the forced prose round follows.
      calls(call('knowledge_search', { query: 'something else' })),
      prose('All done.'),
    ]);

    const messages = await turn(service);

    expect(driver.chatStream).toHaveBeenCalledTimes(4);
    expect(driver.requests.map((request) => request.tools !== undefined)).toEqual([true, true, false, false]);
    expect(search).toHaveBeenCalledTimes(2);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(driver.requests[3].messages[driver.requests[3].messages.length - 1].content).toContain(
      'do not call any more tools',
    );
    expect(messages[messages.length - 1]).toMatchObject({ role: 'assistant', content: 'All done.' });
  });

  it('does not offer tools again after a call failed', async () => {
    const { service, driver, search } = await setup([calls(SEARCH), prose('The search failed, sorry.')], {
      searchFails: true,
    });

    await turn(service);

    expect(search).toHaveBeenCalledTimes(1);
    expect(driver.requests.map((request) => request.tools !== undefined)).toEqual([true, false]);
    expect(driver.requests[1].salvageTools).toBe(false);
  });

  it('does not offer tools again after the model repeated a call', async () => {
    const { service, driver, search } = await setup([
      calls(SEARCH),
      calls(SEARCH),
      prose('Nothing more found.'),
    ]);

    await turn(service);

    expect(search).toHaveBeenCalledTimes(2);
    expect(driver.requests.map((request) => request.tools !== undefined)).toEqual([true, true, false]);
    // A repeat means the model is looping, so the closing round is the forced one.
    expect(driver.requests[2].salvageTools).toBe(false);
    expect(driver.requests[2].messages[driver.requests[2].messages.length - 1].content).toContain(
      'do not call any more tools',
    );
  });

  it('runs one generation when the model answers without tools', async () => {
    const { service, driver } = await setup([prose('Nothing to look up.')]);

    await turn(service);

    expect(driver.chatStream).toHaveBeenCalledTimes(1);
  });
});

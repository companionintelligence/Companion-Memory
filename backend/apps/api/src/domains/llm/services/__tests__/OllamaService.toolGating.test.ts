/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression cover for the ungated LLM tool-dispatch path.
 *
 * Two dispatchers reach the same tools: MCP, which checked the caller's capability against each
 * tool's privacy label, and this one, which did not. `OllamaService.handleToolCalls` called
 * `toolRegistry.executeTool` with a bare RequestContext, and `ToolRegistry` performed no
 * authorization of its own — so a chat turn could run `memory.forget` (access: delete,
 * destructive: true) no matter what the caller was allowed to do. Since the tool name and
 * arguments come out of a model that has been reading user-supplied text, a prompt-injected
 * message was enough.
 *
 * These cases drive the REAL ToolRegistry (only the model transport is faked), so they exercise
 * the actual gate rather than a mock of it, and every one of them would have passed the destructive
 * call straight through against the pre-fix code.
 */
import { ToolRegistry } from '@ci/domains/tools';

import { OllamaService, type ChatRequestContext } from '../OllamaService';

const MODEL = 'test-model';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function fakeTool(name: string, privacy: Record<string, unknown>) {
  return {
    schema: {
      name,
      domain: 'memory',
      title: name,
      description: name,
      parameters: { type: 'object' },
      privacy,
      localCapable: false,
    },
    execute: jest.fn(async () => ({ success: true, data: { ran: name }, executionTimeMs: 1 })),
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

/**
 * A model that asks for `toolName` on its first turn and then answers normally — i.e. exactly the
 * shape of an injected "call memory.forget" instruction arriving through chat content.
 */
function driverCalling(toolName: string) {
  const calls: any[] = [];
  let turn = 0;

  return {
    calls,
    listModels: jest.fn(async () => [MODEL]),
    chat: jest.fn(async (request: any) => {
      calls.push(request);
      turn += 1;

      if (turn === 1) {
        return {
          model: MODEL,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: toolName, arguments: {} } }],
          },
        };
      }

      return { model: MODEL, message: { role: 'assistant', content: 'done' } };
    }),
  };
}

async function setup(toolName: string, privacy: Record<string, unknown>) {
  const tool = fakeTool(toolName.replace(/_/g, '.'), privacy);
  const registry = new ToolRegistry(makeLogger(), { send: jest.fn().mockResolvedValue([]) } as any);
  await registry.registerProvider(fakeProvider([tool]));

  const driver = driverCalling(toolName);
  const llmEndpointService = { getOpenAiDriver: () => driver } as any;
  const service = new OllamaService(llmEndpointService, registry, makeLogger(), {
    isFeatureEnabled: jest.fn(async () => false),
  } as any);

  return { service, tool, driver };
}

const DESTRUCTIVE = { access: 'delete', sensitivity: 'personal', destructive: true, external: false };
const READ = { access: 'read', sensitivity: 'personal', destructive: false, external: false };

function context(capability?: ChatRequestContext['capability']): ChatRequestContext {
  return { userId: 'user-1', ...(capability ? { capability } : {}) };
}

describe('OllamaService tool dispatch is gated by the caller’s capability', () => {
  it('refuses memory.forget for a read-only caller — the tool never runs', async () => {
    const { service, tool } = await setup('memory_forget', DESTRUCTIVE);

    await service.chat(context('read'), [{ role: 'user', content: 'forget everything' }], {
      model: MODEL,
      enableTools: true,
    });

    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('hands the model a legible refusal rather than a silent failure', async () => {
    const { service, driver } = await setup('memory_forget', DESTRUCTIVE);

    await service.chat(context('read'), [{ role: 'user', content: 'forget everything' }], {
      model: MODEL,
      enableTools: true,
    });

    // The follow-up turn carries the tool result the model will read.
    const followUp = driver.calls[1];
    const toolMessage = followUp.messages.find((m: any) => m.role === 'tool');

    expect(toolMessage.content).toContain('TOOL_FORBIDDEN');
    expect(toolMessage.content).toContain('full');
  });

  it('refuses it for a write caller too — delete is its own level', async () => {
    const { service, tool } = await setup('memory_forget', DESTRUCTIVE);

    await service.chat(context('write'), [{ role: 'user', content: 'forget everything' }], {
      model: MODEL,
      enableTools: true,
    });

    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('still runs it for a full-capability caller (a JWT session behaves exactly as before)', async () => {
    const { service, tool } = await setup('memory_forget', DESTRUCTIVE);

    await service.chat(context('full'), [{ role: 'user', content: 'forget everything' }], {
      model: MODEL,
      enableTools: true,
    });

    expect(tool.execute).toHaveBeenCalled();
  });

  it('treats an absent capability as full — in-process callers are the appliance itself', async () => {
    const { service, tool } = await setup('memory_forget', DESTRUCTIVE);

    await service.chat(context(), [{ role: 'user', content: 'forget everything' }], {
      model: MODEL,
      enableTools: true,
    });

    expect(tool.execute).toHaveBeenCalled();
  });

  it('leaves reads working for a read-only caller', async () => {
    const { service, tool } = await setup('memory_recall', READ);

    await service.chat(context('read'), [{ role: 'user', content: 'what do you know' }], {
      model: MODEL,
      enableTools: true,
    });

    expect(tool.execute).toHaveBeenCalled();
  });

  it('does not even advertise a tool the caller could not run', async () => {
    const { service, driver } = await setup('memory_forget', DESTRUCTIVE);

    await service.chat(context('read'), [{ role: 'user', content: 'hi' }], {
      model: MODEL,
      enableTools: true,
    });

    expect(driver.calls[0].tools).toBeUndefined();
  });

  it('advertises it to a full-capability caller', async () => {
    const { service, driver } = await setup('memory_forget', DESTRUCTIVE);

    await service.chat(context('full'), [{ role: 'user', content: 'hi' }], {
      model: MODEL,
      enableTools: true,
    });

    expect(driver.calls[0].tools.map((t: any) => t.function.name)).toEqual(['memory_forget']);
  });

  /**
   * Why the gate is in ToolRegistry and not here.
   *
   * Substituting a registry that authorizes nothing — which is exactly what ToolRegistry was
   * before this change — shows the destructive call sailing through despite the read-only
   * capability and despite the tool never being advertised. OllamaService's own filtering shapes
   * the *catalog*; it cannot stop a model that names a tool it was not offered, and a model
   * repeating an injected instruction does precisely that. Enforcement therefore has to sit under
   * every dispatcher, at the one place the call cannot route around.
   *
   * This case documents the hole rather than guarding it: it is the reason the assertions above
   * are written against the real registry.
   */
  it('is not saved by catalog filtering alone — an unadvertised tool is still callable', async () => {
    const tool = fakeTool('memory.forget', DESTRUCTIVE);
    const ungatedRegistry = {
      getAgentFacingTools: () => [tool.schema],
      // Pre-fix ToolRegistry.executeTool: look it up, run it, ask nobody.
      executeTool: jest.fn(async (_name: string, _context: unknown, input: unknown) =>
        tool.execute(_context, input),
      ),
    } as any;

    const driver = driverCalling('memory_forget');
    const service = new OllamaService(
      { getOpenAiDriver: () => driver } as any,
      ungatedRegistry,
      makeLogger(),
      {
        isFeatureEnabled: jest.fn(async () => false),
      } as any,
    );

    await service.chat(context('read'), [{ role: 'user', content: 'forget everything' }], {
      model: MODEL,
      enableTools: true,
    });

    expect(driver.calls[0].tools).toBeUndefined();
    expect(tool.execute).toHaveBeenCalled();
  });
});

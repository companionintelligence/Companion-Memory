/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';

import { ToolRegistry } from '../ToolRegistry';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function fakeTool(name: string, data: unknown = { ok: true }) {
  return {
    schema: {
      name,
      domain: 'memory',
      title: name,
      description: name,
      parameters: { type: 'object' },
      privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    },
    execute: jest.fn(async () => ({ success: true, data, executionTimeMs: 1 })),
  } as any;
}

function fakeProvider(tools: Record<string, any>) {
  const map = new Map(Object.entries(tools));

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

const context: RequestContext = { userId: 'user-1' };

describe('ToolRegistry', () => {
  function makeRegistry() {
    const donate = jest.fn();
    const registry = new ToolRegistry(makeLogger(), { donate } as any);

    return { registry, donate };
  }

  it('keys tools by the executable (underscored) name while exposing the dotted intent name', async () => {
    const { registry } = makeRegistry();
    await registry.registerProvider(fakeProvider({ 'memory.recall': fakeTool('memory.recall') }));

    expect(registry.getRegisteredToolNames()).toEqual(['memory_recall']);
    expect(registry.hasTool('memory_recall')).toBe(true);
    expect(registry.getAvailableTools().map((s) => s.name)).toEqual(['memory.recall']);
  });

  it('getAgentFacingTools returns every tool (no raw/intent two-tier)', async () => {
    const { registry } = makeRegistry();
    await registry.registerProvider(
      fakeProvider({ 'memory.recall': fakeTool('memory.recall'), 'people.find': fakeTool('people.find') }),
    );

    expect(
      registry
        .getAgentFacingTools()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['memory.recall', 'people.find']);
  });

  it('executes a tool by its executable name and donates the invocation', async () => {
    const { registry, donate } = makeRegistry();
    const tool = fakeTool('memory.recall', { hits: [] });
    await registry.registerProvider(fakeProvider({ 'memory.recall': tool }));

    const result = await registry.executeTool('memory_recall', context, { q: 1 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ hits: [] });
    expect(tool.execute).toHaveBeenCalledWith(context, { q: 1 });
    expect(donate).toHaveBeenCalledTimes(1);
    expect(donate.mock.calls[0][0]).toMatchObject({
      intent: 'memory.recall',
      domain: 'memory',
      userId: 'user-1',
      success: true,
      access: 'read',
      external: false,
    });
  });

  it('returns TOOL_NOT_FOUND (and does not donate) for an unknown tool', async () => {
    const { registry, donate } = makeRegistry();
    await registry.registerProvider(fakeProvider({ 'memory.recall': fakeTool('memory.recall') }));

    const result = await registry.executeTool('does_not_exist', context, {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_FOUND');
    expect(donate).not.toHaveBeenCalled();
  });
});

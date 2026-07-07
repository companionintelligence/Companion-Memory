/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';

import { IntentDispatcherService, DEFAULT_INTENT_POLICY } from '../../services/IntentDispatcherService';
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

function forgetTool(name = 'memory.forget') {
  return {
    schema: {
      name,
      domain: 'memory',
      title: name,
      description: name,
      parameters: { type: 'object' },
      privacy: { access: 'delete', sensitivity: 'personal', destructive: true, external: false },
    },
    execute: jest.fn(async () => ({ success: true, data: { ok: true }, executionTimeMs: 1 })),
  } as any;
}

describe('ToolRegistry', () => {
  // The dispatcher gets its own events spy so its audit emits don't pollute the registry's
  // `tool.invoked` telemetry assertions. `policy` overrides let a test flip the deny-by-default
  // posture (e.g. to still allow a destructive tool through and assert execution).
  function makeRegistry(policy = DEFAULT_INTENT_POLICY) {
    const send = jest.fn().mockResolvedValue([]);
    const dispatchSend = jest.fn().mockResolvedValue([]);
    const dispatcher = new IntentDispatcherService(makeLogger(), { send: dispatchSend } as any, policy);
    const registry = new ToolRegistry(makeLogger(), { send } as any, dispatcher);

    return { registry, send, dispatchSend, dispatcher };
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

  it('executes a tool by its executable name and emits tool.invoked via EventService', async () => {
    const { registry, send } = makeRegistry();
    const tool = fakeTool('memory.recall', { hits: [] });
    await registry.registerProvider(fakeProvider({ 'memory.recall': tool }));

    const result = await registry.executeTool('memory_recall', context, { q: 1 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ hits: [] });
    expect(tool.execute).toHaveBeenCalledWith(context, { q: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const [eventName, payload, options] = send.mock.calls[0];
    expect(eventName).toBe('tool.invoked');
    expect(payload).toMatchObject({
      intent: 'memory.recall',
      tool: 'memory_recall',
      domain: 'memory',
      userId: 'user-1',
      success: true,
      access: 'read',
      external: false,
    });
    expect(options).toEqual({ queue: 'telemetry' });
  });

  it('never fails the tool call when telemetry emission throws', async () => {
    const send = jest.fn().mockRejectedValue(new Error('bus down'));
    const dispatcher = new IntentDispatcherService(
      makeLogger(),
      { send: jest.fn() } as any,
      DEFAULT_INTENT_POLICY,
    );
    const registry = new ToolRegistry(makeLogger(), { send } as any, dispatcher);
    await registry.registerProvider(fakeProvider({ 'memory.recall': fakeTool('memory.recall', { ok: 1 }) }));

    const result = await registry.executeTool('memory_recall', context, {});

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('denies a destructive intent by default (deny-by-default policy) and does not execute it', async () => {
    const { registry, send, dispatchSend } = makeRegistry();
    const tool = forgetTool();
    await registry.registerProvider(fakeProvider({ 'memory.forget': tool }));

    const result = await registry.executeTool('memory_forget', context, { entityIds: ['x'] });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INTENT_DENIED');
    expect(result.error?.details).toMatchObject({ reason: 'destructive_denied_by_policy' });
    // Blocked before execution and before the post-hoc tool.invoked telemetry emit.
    expect(tool.execute).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // A durable intent.denied audit event was emitted on the telemetry queue.
    expect(dispatchSend).toHaveBeenCalledTimes(1);
    const [eventName, payload, options] = dispatchSend.mock.calls[0];
    expect(eventName).toBe('intent.denied');
    expect(payload).toMatchObject({
      intent: 'memory.forget',
      tool: 'memory_forget',
      surface: 'native',
      reason: 'destructive_denied_by_policy',
      destructive: true,
    });
    expect(options).toEqual({ queue: 'telemetry' });
  });

  it('allows a destructive intent when policy opts out of denyDestructive', async () => {
    const { registry, dispatchSend } = makeRegistry({ ...DEFAULT_INTENT_POLICY, denyDestructive: false });
    const tool = forgetTool();
    await registry.registerProvider(fakeProvider({ 'memory.forget': tool }));

    const result = await registry.executeTool('memory_forget', context, { entityIds: ['x'] });

    expect(result.success).toBe(true);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(dispatchSend.mock.calls[0][0]).toBe('intent.authorized');
  });

  it('authorizes an external read but flags it as warned', async () => {
    const { registry, dispatchSend } = makeRegistry();
    const tool = fakeTool('media.streamingAvailability');
    tool.schema.domain = 'media';
    tool.schema.privacy = { access: 'read', sensitivity: 'low', destructive: false, external: true };
    await registry.registerProvider(fakeProvider({ 'media.streamingAvailability': tool }));

    const result = await registry.executeTool('media_streamingAvailability', context, {});

    expect(result.success).toBe(true);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    const [eventName, payload] = dispatchSend.mock.calls[0];
    expect(eventName).toBe('intent.authorized');
    expect(payload).toMatchObject({ external: true, warned: true });
  });

  it('returns TOOL_NOT_FOUND (and does not emit) for an unknown tool', async () => {
    const { registry, send } = makeRegistry();
    await registry.registerProvider(fakeProvider({ 'memory.recall': fakeTool('memory.recall') }));

    const result = await registry.executeTool('does_not_exist', context, {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_FOUND');
    expect(send).not.toHaveBeenCalled();
  });
});

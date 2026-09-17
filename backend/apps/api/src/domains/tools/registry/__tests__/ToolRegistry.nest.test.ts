/* eslint-disable @typescript-eslint/no-explicit-any */
import type { EventService } from '@ci/domains/events';
import { TOOL_INVOCATION_ERROR_MAX_LENGTH } from '@ci/tool-core';

import type { BaseTool } from '../../core/BaseTool';
import type { IntentDefinition, ToolInvocationContext } from '../../core/types';
import type { PendingActionService } from '../../services/PendingActionService';
import { ToolRegistry } from '../ToolRegistry';

import { openGate } from './gateDouble';

/**
 * What this appliance adds to `ToolRegistryCore`, and nothing else.
 *
 * The rules the registry applies — capability, ownership, the dispatch gate, the shape of a ledger
 * row — moved to `@ci/tool-core` along with the 75 cases that cover them, because three frontends
 * need them and only the in-process ones could reach them here. Left behind is the wiring, and the
 * wiring is not free of consequence: the core hands a finished payload to a
 * {@link ToolInvocationSink}, and if this subclass routed it to the wrong queue — or dropped the
 * event name — `ci.tool_invocations` would simply stop filling, silently, with every core test
 * still green.
 *
 * So these cases assert exactly the three facts the extraction put on this side of the boundary:
 * the constructor still takes the same three Nest providers, the lifecycle hooks still reach the
 * core, and a recorded invocation still arrives as `tool.invoked` on the `telemetry` queue.
 */
function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function schema(name: string): IntentDefinition {
  return {
    name,
    domain: 'memory',
    title: name,
    description: name,
    parameters: { type: 'object' },
    localCapable: true,
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
  };
}

function fakeProvider(tool: BaseTool) {
  return {
    name: 'native',
    initialize: jest.fn(async () => undefined),
    shutdown: jest.fn(async () => undefined),
    getAvailableTools: jest.fn(async () => [tool.schema]),
    getTool: jest.fn(() => tool),
    canHandle: jest.fn(() => true),
    getHealthStatus: jest.fn(async () => ({
      name: 'native',
      status: 'healthy' as const,
      toolCount: 1,
      lastCheck: new Date(),
    })),
  };
}

function setup(result: unknown = { success: true, data: { hits: [] }, executionTimeMs: 3 }) {
  const send = jest.fn().mockResolvedValue([]);
  const events = { send } as unknown as EventService;
  const gate = openGate();
  const registry = new ToolRegistry(makeLogger(), events, gate.double as PendingActionService);
  const tool = { schema: schema('memory.recall'), execute: jest.fn(async () => result) } as unknown as BaseTool;

  return { registry, send, tool, provider: fakeProvider(tool) };
}

const CONTEXT: ToolInvocationContext = { userId: 'user-1', capability: 'full' };

describe('ToolRegistry (the Nest adapter over ToolRegistryCore)', () => {
  it('sends a recorded invocation as tool.invoked on the telemetry queue', async () => {
    const { registry, send, provider } = setup();
    await registry.registerProvider(provider);

    await registry.executeTool('memory_recall', CONTEXT, {});

    expect(send).toHaveBeenCalledTimes(1);
    const [eventName, payload, options] = send.mock.calls[0];
    expect(eventName).toBe('tool.invoked');
    expect(options).toEqual({ queue: 'telemetry' });
    expect(payload).toMatchObject({ intent: 'memory.recall', tool: 'memory_recall', outcome: 'success' });
  });

  it('truncates the error before it reaches the bus, so pgboss.job never holds an unbounded one', async () => {
    const long = 'x'.repeat(TOOL_INVOCATION_ERROR_MAX_LENGTH + 100);
    const { registry, send, provider } = setup({
      success: false,
      error: { code: 'BOOM', message: long, retryable: false },
    });
    await registry.registerProvider(provider);

    await registry.executeTool('memory_recall', CONTEXT, {});

    expect(send.mock.calls[0][1].error).toHaveLength(TOOL_INVOCATION_ERROR_MAX_LENGTH);
  });

  it('never fails the tool call when the bus is down', async () => {
    const { registry, provider } = setup();
    const events = { send: jest.fn().mockRejectedValue(new Error('bus down')) } as unknown as EventService;
    const broken = new ToolRegistry(makeLogger(), events, openGate().double as PendingActionService);
    await broken.registerProvider(provider);

    await expect(broken.executeTool('memory_recall', CONTEXT, {})).resolves.toMatchObject({ success: true });
    expect(registry).toBeDefined();
  });

  it('drives the core lifecycle from Nest\'s module hooks', async () => {
    const { registry, provider } = setup();
    await registry.onModuleInit();
    await registry.registerProvider(provider);
    expect(registry.getRegisteredToolNames()).toEqual(['memory_recall']);

    await registry.onModuleDestroy();

    // stop() shuts every provider down and empties the maps — proof the hook reached the core
    // rather than being an inherited no-op.
    expect(provider.shutdown).toHaveBeenCalledTimes(1);
    expect(registry.getRegisteredToolNames()).toEqual([]);
  });

  it('still hands back a BaseTool, not the core\'s narrower ToolHandle', async () => {
    const { registry, provider, tool } = setup();
    await registry.registerProvider(provider);

    const found: BaseTool | undefined = registry.getTool('memory_recall');

    expect(found).toBe(tool);
  });
});

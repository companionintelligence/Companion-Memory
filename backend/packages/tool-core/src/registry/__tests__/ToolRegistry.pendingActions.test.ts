/* eslint-disable @typescript-eslint/no-explicit-any */
import { FULL_CAPABILITY, READ_CAPABILITY } from '../../capability';
import type { ToolHandle } from '../../core/ToolHandle';
import type { IntentDefinition, ToolInvocationContext } from '../../core/types';
import type { ToolGateRuling } from '../../policy/toolGate';
import { ToolRegistryCore } from '../ToolRegistry';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function schema(name: string, privacy: Partial<IntentDefinition['privacy']> = {}): IntentDefinition {
  return {
    name,
    domain: 'memory',
    title: name,
    description: name,
    parameters: {},
    localCapable: true,
    privacy: {
      access: 'read',
      sensitivity: 'personal',
      destructive: false,
      external: false,
      ...privacy,
    },
  };
}

function fakeProvider(tools: ToolHandle[]) {
  return {
    name: 'fake',
    initialize: jest.fn(async () => undefined),
    shutdown: jest.fn(async () => undefined),
    getAvailableTools: jest.fn(async () => tools.map((t) => t.schema)),
    getTool: jest.fn((name: string) => tools.find((t) => t.schema.name === name)),
    getHealthStatus: jest.fn(async () => ({ name: 'fake', healthy: true })),
  } as any;
}

function fakeTool(definition: IntentDefinition, execute = jest.fn(async () => ({ success: true }))) {
  return { schema: definition, execute } as unknown as ToolHandle & { execute: jest.Mock };
}

async function harness(definition: IntentDefinition, ruling: ToolGateRuling) {
  const tool = fakeTool(definition);
  const propose = jest.fn(async (..._args: unknown[]) => ({
    id: 'pa-77',
    expiresAt: new Date('2026-08-27T00:00:00.000Z'),
  }));
  const evaluate = jest.fn(async (..._args: unknown[]) => ruling);
  const record = jest.fn().mockResolvedValue([]);

  const registry = new ToolRegistryCore(makeLogger(), { record }, { evaluate, propose } as any);
  await registry.registerProvider(fakeProvider([tool]));

  return { registry, tool, propose, evaluate, record };
}

const QUEUE_RULING: ToolGateRuling = {
  decision: 'queue',
  reason: 'destructive-requires-confirmation',
  explanation: '"memory.forget" removes data and must be confirmed',
};

const EXECUTE_RULING: ToolGateRuling = {
  decision: 'execute',
  reason: 'allowed',
  explanation: 'ok',
};

const FORGET = schema('memory.forget', { access: 'delete', destructive: true });

function context(overrides: Partial<ToolInvocationContext> = {}): ToolInvocationContext {
  return { userId: 'user-1', capability: FULL_CAPABILITY, ...overrides };
}

describe('ToolRegistry.executeTool — the capability check still comes first', () => {
  it('refuses a read-only caller a delete and writes NOTHING to the queue', async () => {
    const { registry, tool, propose, evaluate } = await harness(FORGET, QUEUE_RULING);

    const result = await registry.executeTool('memory_forget', context({ capability: READ_CAPABILITY }), {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TOOL_FORBIDDEN');

    // The rule dispatchPolicy.ts orders capability before tier to protect: a
    // denial must never become a pending action that succeeds after one tap.
    expect(propose).not.toHaveBeenCalled();
    // The gate is not even consulted — a refusal leaves the queue untouched.
    expect(evaluate).not.toHaveBeenCalled();
    expect((tool as any).execute).not.toHaveBeenCalled();
  });

  it('refuses outright, without queueing, when the gate itself returns deny', async () => {
    const { registry, tool, propose } = await harness(FORGET, {
      decision: 'deny',
      reason: 'capability-insufficient',
      explanation: 'nope',
    });

    const result = await registry.executeTool('memory_forget', context(), {});

    expect(result.error?.code).toBe('TOOL_FORBIDDEN');
    expect(propose).not.toHaveBeenCalled();
    expect((tool as any).execute).not.toHaveBeenCalled();
  });
});

describe('ToolRegistry.executeTool — a queue ruling parks the call', () => {
  it('returns TOOL_QUEUED naming the row, and does not run the tool', async () => {
    const { registry, tool, propose, record } = await harness(FORGET, QUEUE_RULING);

    const result = await registry.executeTool('memory_forget', context(), { entityId: 'e-1' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TOOL_QUEUED');
    expect(result.error?.message).toBe(QUEUE_RULING.explanation);
    expect(result.error?.details).toStrictEqual({
      pendingActionId: 'pa-77',
      reason: 'destructive-requires-confirmation',
      expiresAt: '2026-08-27T00:00:00.000Z',
    });

    expect((tool as any).execute).not.toHaveBeenCalled();
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0][1]).toBe('memory_forget');
    expect(propose.mock.calls[0][3]).toStrictEqual({ entityId: 'e-1' });

    // A queued proposal is not an invocation: feeding it into the behavioural
    // signal would teach prediction that the user did this.
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses rather than executing when a queue ruling arrives with no owner to ask', async () => {
    const { registry, tool, propose } = await harness(FORGET, QUEUE_RULING);

    const result = await registry.executeTool(
      'memory_forget',
      { capability: FULL_CAPABILITY } as ToolInvocationContext,
      {},
    );

    expect(result.error?.code).toBe('TOOL_CONFIRMATION_UNAVAILABLE');
    expect(propose).not.toHaveBeenCalled();
    expect((tool as any).execute).not.toHaveBeenCalled();
  });
});

describe('ToolRegistry.executeTool — an execute ruling is the unchanged path', () => {
  it('runs the tool and still emits the behavioural signal', async () => {
    const { registry, tool, propose, record } = await harness(FORGET, EXECUTE_RULING);

    const result = await registry.executeTool('memory_forget', context(), {});

    expect(result.success).toBe(true);
    expect((tool as any).execute).toHaveBeenCalledTimes(1);
    expect(propose).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('passes the whole invocation context — tier and confirmation id included — to the gate', async () => {
    const { registry, evaluate } = await harness(FORGET, EXECUTE_RULING);

    await registry.executeTool('memory_forget', context({ tier: 'local', pendingActionId: 'pa-9' }), {});

    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][1]).toMatchObject({
      tier: 'local',
      pendingActionId: 'pa-9',
      capability: FULL_CAPABILITY,
    });
  });
});

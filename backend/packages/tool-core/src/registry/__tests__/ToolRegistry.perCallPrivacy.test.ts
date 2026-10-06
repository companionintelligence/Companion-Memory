/* eslint-disable @typescript-eslint/no-explicit-any */
import { FULL_CAPABILITY, READ_CAPABILITY, WRITE_CAPABILITY } from '../../capability';
import type { ToolHandle } from '../../core/ToolHandle';
import type { IntentDefinition, IntentPrivacy, ToolInvocationContext } from '../../core/types';
import type { ToolGateRuling } from '../../policy/toolGate';
import { ToolRegistryCore } from '../ToolRegistry';

import { openGate, recordingSink } from './gateDouble';

/**
 * A tool's declared label describes its mildest use. `memory.remember` adds facts, and on some
 * inputs it replaces or erases them. These pin that the registry judges each call by the stricter
 * of the declared label and the tool's own per-call answer, everywhere it reads a label.
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

const WRITE: IntentPrivacy = {
  access: 'write',
  sensitivity: 'personal',
  destructive: false,
  external: false,
};
const ERASES: IntentPrivacy = { ...WRITE, destructive: true };

function rememberTool(privacyFor?: jest.Mock) {
  const schema: IntentDefinition = {
    name: 'memory.remember',
    domain: 'memory',
    title: 'Remember',
    description: 'Remember',
    parameters: { type: 'object', properties: { count: { type: 'integer' } } },
    localCapable: true,
    privacy: WRITE,
  };
  const execute = jest.fn(async () => ({ success: true, data: { ok: true } }));

  return { schema, execute, ...(privacyFor ? { privacyFor } : {}) } as unknown as ToolHandle & {
    execute: jest.Mock;
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

async function harness(tool: ToolHandle, ruling?: Partial<ToolGateRuling>) {
  const gate = openGate(ruling);
  const sink = recordingSink();
  gate.propose.mockResolvedValue({ id: 'pa-1', expiresAt: null });
  const registry = new ToolRegistryCore(makeLogger(), sink.double, gate.double);
  await registry.registerProvider(fakeProvider([tool]));

  return { registry, ...gate, record: sink.record };
}

function context(overrides: Partial<ToolInvocationContext> = {}): ToolInvocationContext {
  return { userId: 'user-1', capability: FULL_CAPABILITY, ...overrides };
}

describe('ToolRegistry.executeTool with a per-call label', () => {
  it('refuses a write key a call that erases data, although the tool is declared a plain write', async () => {
    const tool = rememberTool(jest.fn(async () => ERASES));
    const { registry, evaluate, propose } = await harness(tool);

    const result = await registry.executeTool(
      'memory_remember',
      context({ capability: WRITE_CAPABILITY }),
      {},
    );

    expect(result.error?.code).toBe('TOOL_FORBIDDEN');
    expect(result.error?.message).toContain('"full"');
    expect(tool.execute).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
  });

  it('still runs the additive call for the same write key', async () => {
    const tool = rememberTool(jest.fn(async () => undefined));
    const { registry } = await harness(tool);

    const result = await registry.executeTool(
      'memory_remember',
      context({ capability: WRITE_CAPABILITY }),
      {},
    );

    expect(result.success).toBe(true);
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it('hands the gate, and the queued row, the per-call label', async () => {
    const tool = rememberTool(jest.fn(async () => ERASES));
    const { registry, evaluate, propose } = await harness(tool, {
      decision: 'queue',
      reason: 'confirmation-required',
      explanation: 'asks first',
    });

    const result = await registry.executeTool('memory_remember', context(), { count: 1 });

    expect(result.error?.code).toBe('TOOL_QUEUED');
    expect(((evaluate.mock.calls[0] as unknown[])[0] as IntentDefinition).privacy).toStrictEqual(ERASES);
    expect((propose.mock.calls[0] as unknown[])[0]).toMatchObject({ privacy: ERASES });
    // The row keeps what the caller sent; the confirmed replay labels it again from that.
    expect((propose.mock.calls[0] as unknown[])[3]).toStrictEqual({ count: 1 });
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('asks the tool about the coerced input the tool will run on', async () => {
    const privacyFor = jest.fn(async (_context: unknown, _input: unknown) => undefined);
    const tool = rememberTool(privacyFor);
    const { registry } = await harness(tool);

    await registry.executeTool('memory_remember', context(), { count: '15' });

    expect(privacyFor.mock.calls[0][1]).toStrictEqual({ count: 15 });
    expect(tool.execute.mock.calls[0][1]).toStrictEqual({ count: 15 });
  });

  it('cannot weaken the declared label', async () => {
    const tool = rememberTool(jest.fn(async () => ({ ...WRITE, access: 'read' })));
    const { registry } = await harness(tool);

    const result = await registry.executeTool(
      'memory_remember',
      context({ capability: READ_CAPABILITY }),
      {},
    );

    expect(result.error?.code).toBe('TOOL_FORBIDDEN');
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('reads a per-call answer that throws as destructive, not as the declared label', async () => {
    const tool = rememberTool(
      jest.fn(async () => {
        throw new Error('lookup failed');
      }),
    );
    const { registry } = await harness(tool);

    const result = await registry.executeTool(
      'memory_remember',
      context({ capability: WRITE_CAPABILITY }),
      {},
    );

    expect(result.error?.code).toBe('TOOL_FORBIDDEN');
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('does not ask the tool anything for a caller its declared label already refuses', async () => {
    const privacyFor = jest.fn(async () => ERASES);
    const tool = rememberTool(privacyFor);
    const { registry } = await harness(tool);

    const result = await registry.executeTool(
      'memory_remember',
      context({ capability: READ_CAPABILITY }),
      {},
    );

    expect(result.error?.code).toBe('TOOL_FORBIDDEN');
    expect(privacyFor).not.toHaveBeenCalled();
  });

  it('records the per-call label in the ledger', async () => {
    const tool = rememberTool(jest.fn(async () => ERASES));
    const { registry, record } = await harness(tool);

    await registry.executeTool('memory_remember', context(), {});

    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ outcome: 'success', destructive: true, access: 'write' });
  });
});

describe('ToolRegistry.privacyOf', () => {
  it('answers the label a call would be judged by', async () => {
    const tool = rememberTool(jest.fn(async () => ERASES));
    const { registry } = await harness(tool);

    await expect(registry.privacyOf('memory_remember', context(), {})).resolves.toStrictEqual(ERASES);
  });

  it('answers the declared label for a tool with no per-call answer', async () => {
    const { registry } = await harness(rememberTool());

    await expect(registry.privacyOf('memory_remember', context(), {})).resolves.toStrictEqual(WRITE);
  });

  it('answers nothing for a tool the caller cannot see', async () => {
    const tool = rememberTool(jest.fn(async () => ERASES));
    (tool.schema as IntentDefinition).ownerUserId = 'someone-else';
    const { registry } = await harness(tool);

    await expect(registry.privacyOf('memory_remember', context(), {})).resolves.toBeUndefined();
  });
});

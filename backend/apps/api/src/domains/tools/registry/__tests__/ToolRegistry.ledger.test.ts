/* eslint-disable @typescript-eslint/no-explicit-any */
import type { IntentPrivacy, ToolInvocationContext, ToolResult } from '../../core/types';
import { TOOL_INVOCATION_ERROR_MAX_LENGTH } from '../../events';
import { ToolRegistry, outcomeOf } from '../ToolRegistry';

import { openGate } from './gateDouble';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

const READ_PRIVACY: IntentPrivacy = {
  access: 'read',
  sensitivity: 'personal',
  destructive: false,
  external: false,
};

function fakeTool(name: string, result: ToolResult, privacy: IntentPrivacy = READ_PRIVACY) {
  return {
    schema: {
      name,
      domain: 'memory',
      title: name,
      description: name,
      parameters: { type: 'object' },
      privacy,
      localCapable: true,
    },
    execute: jest.fn(async () => result),
  } as any;
}

function fakeProvider(name: string, tools: Record<string, any>) {
  const map = new Map(Object.entries(tools));

  return {
    name,
    initialize: jest.fn(async () => {}),
    shutdown: jest.fn(async () => {}),
    getAvailableTools: jest.fn(async () => [...map.values()].map((t) => t.schema)),
    getTool: (n: string) => map.get(n),
    canHandle: (n: string) => map.has(n),
    getHealthStatus: jest.fn(async () => ({ name, status: 'healthy', toolCount: map.size, lastCheck: new Date() })),
  } as any;
}

function makeRegistry() {
  const send = jest.fn().mockResolvedValue([]);
  const { double: pendingActions } = openGate();
  const registry = new ToolRegistry(makeLogger(), { send } as any, pendingActions);

  return { registry, send };
}

/**
 * The facts the `ci.tool_invocations` ledger is built from. Each of these is a column that reads
 * NULL — i.e. a row that cannot answer the question it exists for — if the payload drops it.
 */
describe('ToolRegistry → tool.invoked payload (the ledger row)', () => {
  it('threads the actor identity (apiKeyId) and the correlation id off the request context', async () => {
    const { registry, send } = makeRegistry();
    await registry.registerProvider(
      fakeProvider('native', { 'memory.recall': fakeTool('memory.recall', { success: true, data: {} }) }),
    );

    const context: ToolInvocationContext = {
      userId: 'user-1',
      capability: 'full',
      traceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };

    await registry.executeTool('memory_recall', context, {});

    const [, payload] = send.mock.calls[0];
    // WHICH key called, not merely which user: on a single-owner appliance every agent key
    // resolves to the same account, so userId alone cannot tell two agents apart.
    expect(payload.apiKeyId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(payload.correlationId).toBe('ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(payload.capability).toBe('full');
  });

  it('records the provider that served the tool as `source`', async () => {
    const { registry, send } = makeRegistry();
    await registry.registerProvider(
      fakeProvider('mcp-client', { 'mcp.thing': fakeTool('mcp.thing', { success: true, data: {} }) }),
    );

    await registry.executeTool('mcp_thing', { userId: 'u', capability: 'full' }, {});

    expect(send.mock.calls[0][1].source).toBe('mcp-client');
  });

  it('carries a failing tool through as outcome=error with its code and message', async () => {
    const { registry, send } = makeRegistry();
    await registry.registerProvider(
      fakeProvider('native', {
        'memory.recall': fakeTool('memory.recall', {
          success: false,
          error: { code: 'UPSTREAM_DOWN', message: 'ollama refused the connection', retryable: true },
          executionTimeMs: 12,
        }),
      }),
    );

    await registry.executeTool('memory_recall', { userId: 'u', capability: 'full' }, {});

    expect(send.mock.calls[0][1]).toMatchObject({
      outcome: 'error',
      errorCode: 'UPSTREAM_DOWN',
      error: 'ollama refused the connection',
      durationMs: 12,
    });
  });

  it('separates a deadline from a defect: a TIMEOUT code becomes outcome=timeout', async () => {
    const { registry, send } = makeRegistry();
    await registry.registerProvider(
      fakeProvider('native', {
        'messaging.send': fakeTool('messaging.send', {
          success: false,
          error: { code: 'BLUEBUBBLES_TIMEOUT', message: 'no response in 8s', retryable: true },
        }),
      }),
    );

    await registry.executeTool('messaging_send', { userId: 'u', capability: 'full' }, {});

    expect(send.mock.calls[0][1].outcome).toBe('timeout');
  });

  it('truncates the error at the emit, so an unbounded message is never copied into pgboss.job', async () => {
    const { registry, send } = makeRegistry();
    const long = 'x'.repeat(TOOL_INVOCATION_ERROR_MAX_LENGTH + 250);
    await registry.registerProvider(
      fakeProvider('native', {
        'memory.recall': fakeTool('memory.recall', {
          success: false,
          error: { code: 'BOOM', message: long, retryable: false },
        }),
      }),
    );

    await registry.executeTool('memory_recall', { userId: 'u', capability: 'full' }, {});

    expect(send.mock.calls[0][1].error).toHaveLength(TOOL_INVOCATION_ERROR_MAX_LENGTH);
  });

  it('carries NO tool input and NO tool output — the whole reason ci.api_logs was dropped', async () => {
    const { registry, send } = makeRegistry();
    await registry.registerProvider(
      fakeProvider('native', {
        'memory.recall': fakeTool('memory.recall', {
          success: true,
          data: { secret: 'the user private note' },
        }),
      }),
    );

    await registry.executeTool('memory_recall', { userId: 'u', capability: 'full' }, {
      query: 'my therapist said',
    });

    const serialized = JSON.stringify(send.mock.calls[0][1]);
    expect(serialized).not.toContain('my therapist said');
    expect(serialized).not.toContain('the user private note');
  });
});

describe('outcomeOf', () => {
  it('maps success, plain failure, and every timeout spelling', () => {
    expect(outcomeOf({ success: true })).toBe('success');
    expect(outcomeOf({ success: false, error: { code: 'NOPE', message: '', retryable: false } })).toBe('error');
    expect(outcomeOf({ success: false })).toBe('error');
    expect(outcomeOf({ success: false, error: { code: 'ETIMEDOUT', message: '', retryable: true } })).toBe(
      'timeout',
    );
    expect(outcomeOf({ success: false, error: { code: 'REQUEST_TIMED_OUT', message: '', retryable: true } })).toBe(
      'timeout',
    );
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * What the chat model is told when the confirmation gate queues its call.
 *
 * Drives the REAL ToolRegistry with a gate double that queues, so the tool
 * message asserted on is the one `handleToolCalls` actually builds from a real
 * `TOOL_QUEUED` result — not a hand-written stand-in for it.
 */
import { UNTRUSTED_TOOL_RESULTS_GUARD, unguardToolResult } from '@ci/common/prompt/untrustedBlock';
import { ModelTierRouter } from '@ci/domains/model-routing';
import { ToolRegistry } from '@ci/domains/tools';

import { OllamaService, TOOL_QUEUED_NOTE } from '../OllamaService';

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
      domain: 'messaging',
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

/** A model that emits `toolCalls` on its first turn, then answers. */
function driverCalling(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>) {
  const calls: any[] = [];

  return {
    calls,
    listModels: jest.fn(async () => [MODEL]),
    chat: jest.fn(async (request: any) => {
      calls.push(request);

      if (calls.length === 1) {
        return {
          model: MODEL,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: toolCalls.map((call) => ({ function: call })),
          },
        };
      }

      return { model: MODEL, message: { role: 'assistant', content: 'done' } };
    }),
  };
}

const SEND = { access: 'write', sensitivity: 'personal', destructive: true, external: true };
const RECALL = { access: 'read', sensitivity: 'personal', destructive: false, external: false };

/** Queues `messaging.send`, runs everything else. */
function queueingGate() {
  return {
    evaluate: jest.fn(async (schema: any) =>
      schema.name === 'messaging.send'
        ? { decision: 'queue', reason: 'confirmation-required', explanation: 'asks first' }
        : { decision: 'execute', reason: 'allowed', explanation: 'open' },
    ),
    propose: jest.fn(async () => ({ id: 'pa-1', expiresAt: new Date('2026-09-28T00:00:00.000Z') })),
  } as any;
}

async function setup(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>) {
  const send = fakeTool('messaging.send', SEND);
  const recall = fakeTool('memory.recall', RECALL);
  const registry = new ToolRegistry(
    makeLogger(),
    { send: jest.fn().mockResolvedValue([]) } as any,
    queueingGate(),
  );
  await registry.registerProvider(fakeProvider([send, recall]));

  const driver = driverCalling(toolCalls);
  const service = new OllamaService(
    { getOpenAiDriver: () => driver } as any,
    registry,
    makeLogger(),
    { isFeatureEnabled: jest.fn(async () => false) } as any,
    new ModelTierRouter(),
  );

  await service.chat({ userId: 'user-1' }, [{ role: 'user', content: 'text Sam I am late' }], {
    model: MODEL,
    enableTools: true,
  });

  const toolMessages = driver.calls[1].messages.filter((m: any) => m.role === 'tool');

  return { send, recall, toolMessages };
}

describe('OllamaService — a queued call, as the chat model reads it', () => {
  it('says the action has not run and must not be called again, next to the TOOL_QUEUED error', async () => {
    const { send, toolMessages } = await setup([
      { name: 'messaging_send', arguments: { to: 'Sam', text: 'late' } },
    ]);

    expect(send.execute).not.toHaveBeenCalled();

    const result = JSON.parse(unguardToolResult(toolMessages[0].content));
    expect(result.note).toBe(TOOL_QUEUED_NOTE);
    expect(result.error.code).toBe('TOOL_QUEUED');
    expect(result.error.details.pendingActionId).toBe('pa-1');
  });

  it('leaves a result that ran, and one that failed for another reason, without the note', async () => {
    const { toolMessages } = await setup([
      { name: 'memory_recall', arguments: {} },
      { name: 'no_such_tool', arguments: {} },
    ]);

    const [ran, missing] = toolMessages.map((m: any) => JSON.parse(unguardToolResult(m.content)));
    expect(ran).toStrictEqual({ ran: 'memory.recall' });
    expect(missing.note).toBeUndefined();
    expect(missing.error.code).toBe('TOOL_NOT_FOUND');
  });

  it('guards the first result of the round only', async () => {
    const { toolMessages } = await setup([
      { name: 'memory_recall', arguments: {} },
      { name: 'messaging_send', arguments: { to: 'Sam', text: 'late' } },
    ]);

    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0].content.startsWith(`${UNTRUSTED_TOOL_RESULTS_GUARD}\n`)).toBe(true);
    expect(toolMessages[1].content.startsWith(UNTRUSTED_TOOL_RESULTS_GUARD)).toBe(false);
    expect(JSON.parse(toolMessages[1].content).note).toBe(TOOL_QUEUED_NOTE);
  });
});

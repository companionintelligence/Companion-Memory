import type { Request } from 'express';

import type { ApiKeyScopedRequest } from '@ci/common/guards';

import { ToolExecutionError } from '../../types';
import type { GraphQLToolAdapter } from '../GraphQLToolAdapter';
import type { McpExecutorService } from '../McpExecutorService';
import { McpToolService } from '../McpToolService';

/**
 * A queued action must survive the MCP plane with its identity intact.
 *
 * `executeTool` used to end `throw new Error(result.error?.message)`, which
 * flattened a structured `ToolError` into a sentence — destroying `code` and
 * `details`, and `details` is where the approval queue puts `pendingActionId`.
 *
 * That contradicted the appliance's own instructions. The dispatch packet tells
 * the harness: "A destructive intent is not refused, it is QUEUED … the call
 * returns TOOL_QUEUED with error.details.pendingActionId", and "report blocked,
 * name the pendingActionId, and stop". On this plane there was no code to
 * recognise and no id to name, so the harness could not tell "waiting on your
 * owner" from "denied" — and a model that reads a queue as a failure retries,
 * which files a second approval card for one intent.
 *
 * The REST intent path returns the whole ToolError in its body and both harness
 * plugins read `error.code` / `error.details.pendingActionId` from it. This
 * plane now presents the same shape rather than a lossier dialect of it.
 */
describe('McpToolService — a queued action keeps its identity', () => {
  const nativeIntent = {
    name: 'messaging.send',
    description: 'Send a message',
    parameters: { type: 'object' as const, properties: {} },
    privacy: { access: 'write', sensitivity: 'personal', destructive: true, external: true },
  };

  function buildService(executeResult: unknown) {
    const adapter = {
      getTools: () => [],
      getSchemaSDL: () => '',
    } as unknown as GraphQLToolAdapter;

    const registry = {
      getAgentFacingTools: () => [nativeIntent],
      getOutboundCatalogTools: () => [nativeIntent],
      getRegisteredToolNames: () => [nativeIntent.name],
      executeTool: jest.fn().mockResolvedValue(executeResult),
      recordInvocation: jest.fn().mockResolvedValue(undefined),
    };

    const logger = { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const service = new McpToolService(
      adapter,
      registry as never,
      {} as unknown as McpExecutorService,
      logger as never,
      { evaluate: async () => ({ decision: 'execute', reason: 'allowed', explanation: 'open' }) } as never,
      { register: () => undefined } as never,
    );

    service.onModuleInit();

    return { service, registry };
  }

  const harnessKeyRequest = () =>
    ({
      apiKeyScopes: ['memory', 'intents', 'mcp'],
      apiKeyCapability: 'full',
      apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      apiKeyManagedBy: 'connect',
      apiKeyName: 'app:ci-openclaw:ci-marketplace',
      user: { id: 'user-1' },
    }) as unknown as ApiKeyScopedRequest;

  const QUEUED = {
    success: false,
    error: {
      code: 'TOOL_QUEUED',
      message: 'Waiting for the owner to confirm',
      retryable: false,
      details: {
        pendingActionId: 'pa-1',
        reason: 'confirmation-required',
        expiresAt: '2026-09-11T08:00:00.000Z',
      },
    },
  };

  it('carries the code and the pendingActionId through the throw', async () => {
    const { service } = buildService(QUEUED);

    await expect(
      service.executeTool('messaging_send', {}, { req: harnessKeyRequest() as Request }),
    ).rejects.toMatchObject({
      code: 'TOOL_QUEUED',
      // The id the harness is told to name. Flattened to a sentence, it was gone.
      details: { pendingActionId: 'pa-1', expiresAt: '2026-09-11T08:00:00.000Z' },
    });
  });

  it('is a ToolExecutionError, so the transport can tell it from an unexpected throw', async () => {
    const { service } = buildService(QUEUED);

    await expect(
      service.executeTool('messaging_send', {}, { req: harnessKeyRequest() as Request }),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it('still carries a code for an ordinary failure, rather than inventing a queue', async () => {
    const { service } = buildService({
      success: false,
      error: { code: 'TOOL_FORBIDDEN', message: 'nope', retryable: false },
    });

    await expect(
      service.executeTool('messaging_send', {}, { req: harnessKeyRequest() as Request }),
    ).rejects.toMatchObject({ code: 'TOOL_FORBIDDEN', details: undefined });
  });

  it('falls back to a code rather than throwing a bare Error when the result names none', async () => {
    // A tool that fails without a structured error still has to arrive as
    // something the transport can serialize uniformly.
    const { service } = buildService({ success: false });

    await expect(
      service.executeTool('messaging_send', {}, { req: harnessKeyRequest() as Request }),
    ).rejects.toMatchObject({ code: 'TOOL_FAILED' });
  });
});

import type { Request } from 'express';

import { ContextService } from '@ci/common/context';
import type { ApiKeyScopedRequest } from '@ci/common/guards';

import type { GraphQLToolAdapter } from '../GraphQLToolAdapter';
import type { McpExecutorService } from '../McpExecutorService';
import { McpToolService, describeFailure } from '../McpToolService';

/**
 * Two holes on the MCP surface, both of which made a call invisible to `ci.tool_invocations`:
 *
 *  1. The GraphQL-over-MCP plane returns through `McpExecutorService` and never touches
 *     `ToolRegistry`, so it emitted no `tool.invoked` at all — an MCP client calling
 *     `delete_person` left no row anywhere.
 *  2. The native plane built its `ToolInvocationContext` from a bare literal, dropping the
 *     ambient `traceId` and `apiKeyId`, so every MCP-originated row recorded a NULL actor.
 */
describe('McpToolService — invocation ledger', () => {
  const graphqlDeleteTool = {
    name: 'delete_person',
    description: 'Delete a person',
    inputSchema: {},
    privacy: { access: 'delete', sensitivity: 'personal', destructive: true, external: false },
  };

  const nativeIntent = {
    name: 'memory.search',
    description: 'Search memory',
    parameters: { type: 'object' as const, properties: {} },
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
  };

  function buildService(executorResult: { throws?: Error } = {}) {
    const adapter = {
      getTools: () => [graphqlDeleteTool],
      getSchemaSDL: () => '',
    } as unknown as GraphQLToolAdapter;

    const registry = {
      getAgentFacingTools: () => [nativeIntent],
      getOutboundCatalogTools: () => [nativeIntent],
      getOutboundCatalogToolsForEveryOwner: () => [nativeIntent],
      isToolVisibleTo: () => true,
      getRegisteredToolNames: () => [nativeIntent.name],
      executeTool: jest.fn().mockResolvedValue({ success: true, data: { ok: true } }),
      recordInvocation: jest.fn().mockResolvedValue(undefined),
    };

    const executor = {
      executeTool: executorResult.throws
        ? jest.fn().mockRejectedValue(executorResult.throws)
        : jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as McpExecutorService;

    const logger = { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const service = new McpToolService(
      adapter,
      registry as never,
      executor,
      logger as never,
      // An open gate: these tests are about the ledger, not about confirmation.
      { evaluate: async () => ({ decision: 'execute', reason: 'allowed', explanation: 'open' }) } as never,
      { register: () => undefined } as never,
    );

    service.onModuleInit();

    return { service, executor, registry };
  }

  const fullKeyRequest = () =>
    ({
      apiKeyScopes: [],
      apiKeyCapability: 'full',
      apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      user: { id: 'user-1' },
    }) as unknown as ApiKeyScopedRequest;

  it('records a GraphQL-plane call that previously emitted nothing at all', async () => {
    const { service, registry } = buildService();

    await service.executeTool('delete_person', { id: 'p1' }, { req: fullKeyRequest() as Request });

    expect(registry.recordInvocation).toHaveBeenCalledTimes(1);
    const [payload] = registry.recordInvocation.mock.calls[0];
    expect(payload).toMatchObject({
      intent: 'delete_person',
      tool: 'delete_person',
      // The value that tells a ledger reader this row did not come through the intent catalog.
      source: 'graphql',
      userId: 'user-1',
      apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      capability: 'full',
      outcome: 'success',
      access: 'delete',
      destructive: true,
      external: false,
    });
    expect(typeof payload.durationMs).toBe('number');
    // No domain: the GraphQL plane has no domain vocabulary, and inventing one would lie.
    expect(payload.domain).toBeUndefined();
  });

  it('records a FAILING GraphQL-plane call and still rethrows it to the client', async () => {
    const boom = new Error('resolver exploded');
    const { service, registry } = buildService({ throws: boom });

    await expect(service.executeTool('delete_person', {}, { req: fullKeyRequest() as Request })).rejects.toBe(
      boom,
    );

    expect(registry.recordInvocation).toHaveBeenCalledTimes(1);
    expect(registry.recordInvocation.mock.calls[0][0]).toMatchObject({
      outcome: 'error',
      error: 'resolver exploded',
    });
  });

  it('carries the ambient traceId and apiKeyId into the NATIVE invocation context', async () => {
    const { service, registry } = buildService();

    await ContextService.run(
      {
        traceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        apiKeyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
      async () => service.executeTool('memory_search', {}, { req: fullKeyRequest() as Request }),
    );

    const [, invocationContext] = registry.executeTool.mock.calls[0];
    // Without the spread these two were dropped and every MCP row recorded a NULL actor.
    expect(invocationContext.traceId).toBe('ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(invocationContext.apiKeyId).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    // …while the userId the transport resolved still wins over anything in the store.
    expect(invocationContext.userId).toBe('user-1');
    expect(invocationContext.capability).toBe('full');
  });

  it('works with no ambient context at all (an in-process caller)', async () => {
    const { service, registry } = buildService();

    await service.executeTool('memory_search', {}, { req: fullKeyRequest() as Request });

    const [, invocationContext] = registry.executeTool.mock.calls[0];
    expect(invocationContext.userId).toBe('user-1');
    expect(invocationContext.traceId).toBeUndefined();
  });
});

describe('describeFailure', () => {
  it('names the exception class as the code so the two planes share one outcome rule', () => {
    expect(describeFailure(new (class ForbiddenException extends Error {})('nope'))).toStrictEqual({
      code: 'ForbiddenException',
      message: 'nope',
      retryable: false,
    });
    expect(describeFailure('a string')).toStrictEqual({
      code: 'UNKNOWN_ERROR',
      message: 'a string',
      retryable: false,
    });
  });
});

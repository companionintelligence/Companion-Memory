import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

import { type ApiKeyScopedRequest, isScopeLimitedApiKey } from '@ci/common/guards';

import type { GraphQLToolAdapter } from '../GraphQLToolAdapter';
import type { McpExecutorService } from '../McpExecutorService';
import { McpToolService } from '../McpToolService';

/**
 * A `memory`-scoped connect key (what CI-Hub injects into OpenClaw/Hermes) is
 * confined off the GraphQL data plane by deny-by-default scope enforcement. The
 * MCP surface must reflect that: the GraphQL-derived tools execute against those
 * same guarded resolvers, so they must neither be advertised to nor executable by
 * such a key.
 */
describe('McpToolService — scope-limited callers', () => {
  const graphqlTool = {
    name: 'query_people',
    description: 'Query people',
    inputSchema: {},
    privacy: { destructive: false, external: false, write: false },
  };

  const nativeIntent = {
    name: 'memory.search',
    description: 'Search memory',
    parameters: { type: 'object' as const, properties: {} },
    privacy: { destructive: false, external: false, write: false },
  };

  const buildService = () => {
    const adapter = {
      getTools: () => [graphqlTool],
      getSchemaSDL: () => '',
    } as unknown as GraphQLToolAdapter;

    const registry = {
      getAgentFacingTools: () => [nativeIntent],
      getRegisteredToolNames: () => [nativeIntent.name],
      executeTool: jest.fn().mockResolvedValue({ success: true, data: { ok: true } }),
    };

    const executor = {
      executeTool: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as McpExecutorService;

    const logger = { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() };

    const service = new McpToolService(adapter, registry as never, executor, logger as never);

    service.onModuleInit();

    return { service, executor, registry };
  };

  const requestWithScopes = (scopes?: string[]) => ({ apiKeyScopes: scopes }) as ApiKeyScopedRequest;

  it('hides GraphQL-derived tools from a scope-limited key but keeps native intents', () => {
    const { service } = buildService();

    const tools = service.getToolsForRequest(requestWithScopes(['memory', 'intents', 'mcp']));

    expect(tools.map((tool) => tool.name)).toEqual(['memory_search']);
  });

  it('advertises every tool to an empty-scope (full-access) key', () => {
    const { service } = buildService();

    const tools = service.getToolsForRequest(requestWithScopes([]));

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['query_people', 'memory_search']));
  });

  it('advertises every tool to a session/JWT principal (no api-key scopes)', () => {
    const { service } = buildService();

    const tools = service.getToolsForRequest(requestWithScopes(undefined));

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['query_people', 'memory_search']));
  });

  it('refuses to execute a GraphQL tool named directly by a scope-limited key', async () => {
    const { service, executor } = buildService();

    await expect(
      service.executeTool('query_people', {}, { req: requestWithScopes(['memory']) as Request }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(executor.executeTool).not.toHaveBeenCalled();
  });

  it('still executes a GraphQL tool for a full-access key', async () => {
    const { service, executor } = buildService();

    await service.executeTool('query_people', {}, { req: requestWithScopes([]) as Request });

    expect(executor.executeTool).toHaveBeenCalled();
  });

  it('executes native intents for a scope-limited key that carries `intents`', async () => {
    const { service, registry } = buildService();

    await service.executeTool(
      'memory_search',
      {},
      { req: requestWithScopes(['memory', 'intents', 'mcp']) as Request },
    );

    expect(registry.executeTool).toHaveBeenCalled();
  });

  // The intent plane is not a free rider on the `mcp` scope. ToolRegistry performs no
  // authorization of its own, so without this check a key holding `mcp` alone — 403'd by
  // deny-by-default on `/api/intents` — could execute those very intents over MCP,
  // including the ones that read across the whole personal graph.
  it('refuses to execute a native intent for a key without the `intents` scope', async () => {
    const { service, registry } = buildService();

    await expect(
      service.executeTool('memory_search', {}, { req: requestWithScopes(['mcp']) as Request }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(registry.executeTool).not.toHaveBeenCalled();
  });

  it('advertises no tools to a key without the `intents` scope', () => {
    const { service } = buildService();

    expect(service.getToolsForRequest(requestWithScopes(['mcp'])).map((tool) => tool.name)).toEqual([]);
  });
});

/**
 * The predicate that decides what a caller may SEE must be the same one the guard
 * uses to decide what it may DO, or the catalog drifts out of lockstep with
 * enforcement (advertising tools that always 403, or worse, the reverse).
 */
describe('isScopeLimitedApiKey matches the guard it mirrors', () => {
  it('treats only a non-empty api-key scope set as scope-limited', () => {
    expect(isScopeLimitedApiKey({ apiKeyScopes: ['memory'] } as ApiKeyScopedRequest)).toBe(true);
    // Empty-scope key = legacy/full-access (e.g. the bulk importer's connect key).
    expect(isScopeLimitedApiKey({ apiKeyScopes: [] } as unknown as ApiKeyScopedRequest)).toBe(false);
    // Session / JWT / Portal principal — not an api-key at all.
    expect(isScopeLimitedApiKey({} as ApiKeyScopedRequest)).toBe(false);
  });
});

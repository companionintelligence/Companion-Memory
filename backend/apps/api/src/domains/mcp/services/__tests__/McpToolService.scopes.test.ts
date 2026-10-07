import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

import type { ApiKeyCapability } from '@ci/common/decorators';
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
  // Privacy labels as GraphQLToolAdapter actually synthesizes them: a query is a read, a mutation a
  // write, a `delete*` mutation a destructive delete. The capability gate reads these fields, so a
  // fixture that omitted `access` would exercise a shape the adapter never produces.
  const graphqlTool = {
    name: 'query_people',
    description: 'Query people',
    inputSchema: {},
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
  };

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

  const nativeWriteIntent = {
    name: 'memory.record',
    description: 'Record a memory',
    parameters: { type: 'object' as const, properties: {} },
    privacy: { access: 'write', sensitivity: 'personal', destructive: false, external: false },
  };

  const buildService = () => {
    const adapter = {
      getTools: () => [graphqlTool, graphqlDeleteTool],
      getSchemaSDL: () => '',
    } as unknown as GraphQLToolAdapter;

    const registry = {
      getAgentFacingTools: () => [nativeIntent, nativeWriteIntent],
      // registerNativeTools() reads the outbound-catalog list (excludes MCP-client-sourced
      // tools); both native intents here belong to the always-included `native` provider, so the
      // fixture is the same list either way.
      getOutboundCatalogTools: () => [nativeIntent, nativeWriteIntent],
      getOutboundCatalogToolsForEveryOwner: () => [nativeIntent, nativeWriteIntent],
      isToolVisibleTo: () => true,
      getRegisteredToolNames: () => [nativeIntent.name, nativeWriteIntent.name],
      executeTool: jest.fn().mockResolvedValue({ success: true, data: { ok: true } }),
      // The GraphQL branch now records its own tool.invoked through the registry (it never
      // reaches executeTool), so the fixture has to offer it.
      recordInvocation: jest.fn().mockResolvedValue(undefined),
    };

    const executor = {
      executeTool: jest.fn().mockResolvedValue({ ok: true }),
    } as unknown as McpExecutorService;

    const logger = { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() };

    const service = new McpToolService(
      adapter,
      registry as never,
      executor,
      logger as never,
      // An open gate: these tests are about scopes and capability, not about confirmation.
      { evaluate: async () => ({ decision: 'execute', reason: 'allowed', explanation: 'open' }) } as never,
      { register: () => undefined } as never,
    );

    service.onModuleInit();

    return { service, executor, registry };
  };

  /** A request as ApiKeyStrategy leaves it. `capability` defaults to 'full' so the scope tests below
   *  keep asserting scope behaviour alone; the capability tests state it explicitly. */
  const requestWithScopes = (scopes?: string[], capability: ApiKeyCapability = 'full') =>
    ({ apiKeyScopes: scopes, apiKeyCapability: capability }) as ApiKeyScopedRequest;

  it('hides GraphQL-derived tools from a scope-limited key but keeps native intents', () => {
    const { service } = buildService();

    const tools = service.getToolsForRequest(requestWithScopes(['memory', 'intents', 'mcp']));

    expect(tools.map((tool) => tool.name)).toEqual(['memory_search', 'memory_record']);
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

  /**
   * The privacy labels were already there and already correct — derived structurally from the
   * GraphQL operation type — but until now they were advisory: emitted as MCP annotation hints and
   * enforced nowhere, so a client that ignored the hint and called a delete mutation succeeded.
   * Capability is what makes them mean something.
   */
  describe('capability', () => {
    it('shows a read-only key only the tools that read', () => {
      const { service } = buildService();

      const tools = service.getToolsForRequest(requestWithScopes([], 'read'));

      expect(tools.map((tool) => tool.name)).toEqual(['query_people', 'memory_search']);
    });

    it('shows a write key everything except what removes data', () => {
      const { service } = buildService();

      const tools = service.getToolsForRequest(requestWithScopes([], 'write'));

      expect(tools.map((tool) => tool.name)).toEqual(['query_people', 'memory_search', 'memory_record']);
      expect(tools.map((tool) => tool.name)).not.toContain('delete_person');
    });

    it('applies to an empty-scope key too — full surface is not full authority', async () => {
      // The bulk importer holds no scopes and reaches every surface. That is exactly the credential
      // that should be able to write without being able to delete.
      const { service, executor } = buildService();

      // `await` matters: an un-awaited `.rejects` does not gate the test. If the capability gate
      // regressed and the call RESOLVED, this assertion would not fail — the rejection would surface
      // later as an unhandled rejection that kills the jest worker, reporting "test suite failed to
      // run" with no test names, which reads like an infrastructure flake rather than a broken gate.
      await expect(
        service.executeTool('delete_person', {}, { req: requestWithScopes([], 'write') as Request }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(executor.executeTool).not.toHaveBeenCalled();
    });

    it('refuses a mutating intent to a read-only key, naming the level it would need', async () => {
      const { service, registry } = buildService();

      await expect(
        service.executeTool(
          'memory_record',
          {},
          { req: requestWithScopes(['memory', 'intents', 'mcp'], 'read') as Request },
        ),
      ).rejects.toThrow(/requires "write" access/);

      expect(registry.executeTool).not.toHaveBeenCalled();
    });

    it('refuses a destructive tool below full, and allows it at full', async () => {
      const { service, executor } = buildService();

      await expect(
        service.executeTool('delete_person', {}, { req: requestWithScopes([], 'write') as Request }),
      ).rejects.toThrow(/requires "full" access/);

      await service.executeTool('delete_person', {}, { req: requestWithScopes([], 'full') as Request });

      expect(executor.executeTool).toHaveBeenCalled();
    });

    it('leaves session/JWT principals at full authority', () => {
      // A session IS the user. Capability describes what a delegated credential may do on their
      // behalf; it is not a way to restrict the person themselves.
      const { service } = buildService();

      const tools = service.getToolsForRequest({} as ApiKeyScopedRequest);

      expect(tools.map((tool) => tool.name)).toContain('delete_person');
    });

    it('treats an api-key request carrying no capability as read-only', async () => {
      // Unreachable in practice — ApiKeyStrategy always sets it — so its absence means the request
      // did not come through the strategy, and the safe reading of an unknown caller is the least
      // authority rather than the most.
      const { service, executor } = buildService();
      const req = { apiKeyScopes: [] } as unknown as ApiKeyScopedRequest;

      expect(service.getToolsForRequest(req).map((tool) => tool.name)).toEqual([
        'query_people',
        'memory_search',
      ]);

      await expect(service.executeTool('delete_person', {}, { req: req as Request })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(executor.executeTool).not.toHaveBeenCalled();
    });
  });
});

/**
 * A native tool can belong to one account: the `messaging.*` intents belong to whoever the
 * BlueBubbles connector was set up for. MCP builds its tool map once at boot, so it has to keep
 * those tools in the map (their owner needs them) and decide per request who sees them, by the
 * registry's own rule.
 */
describe('McpToolService native tools owned by one account', () => {
  const owned = {
    name: 'messaging.listChats',
    description: 'List chats',
    parameters: { type: 'object' as const, properties: {} },
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: true },
    ownerUserId: 'owner-1',
  };
  const shared = {
    name: 'memory.search',
    description: 'Search memory',
    parameters: { type: 'object' as const, properties: {} },
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
  };

  function buildService() {
    const registry = {
      // What a context-free catalog read returns: owned tools are nobody's.
      getOutboundCatalogTools: () => [shared],
      getOutboundCatalogToolsForEveryOwner: () => [shared, owned],
      getRegisteredToolNames: () => [shared.name, owned.name],
      isToolVisibleTo: jest.fn(
        (name: string, userId?: string) => name !== 'messaging_listChats' || userId === 'owner-1',
      ),
      executeTool: jest.fn(),
      recordInvocation: jest.fn(),
    };
    const adapter = { getTools: () => [], getSchemaSDL: () => '' } as unknown as GraphQLToolAdapter;
    const logger = { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const service = new McpToolService(
      adapter,
      registry as never,
      {} as McpExecutorService,
      logger as never,
      // An open gate: these tests are about which owner sees a tool, not about confirmation.
      { evaluate: async () => ({ decision: 'execute', reason: 'allowed', explanation: 'open' }) } as never,
      { register: () => undefined } as never,
    );

    service.onModuleInit();

    return { service, registry };
  }

  const as = (userId: string, scopes?: string[]) =>
    ({
      user: { id: userId },
      apiKeyScopes: scopes,
      apiKeyCapability: 'full',
    }) as unknown as ApiKeyScopedRequest;

  it("lists the owner's tool to the owner", () => {
    const { service } = buildService();

    expect(service.getToolsForRequest(as('owner-1')).map((tool) => tool.name)).toEqual([
      'memory_search',
      'messaging_listChats',
    ]);
    expect(service.getToolsForRequest(as('owner-1', ['intents', 'mcp'])).map((tool) => tool.name)).toEqual([
      'memory_search',
      'messaging_listChats',
    ]);
  });

  it('hides it from every other account, session or key', () => {
    const { service, registry } = buildService();

    expect(service.getToolsForRequest(as('member-1')).map((tool) => tool.name)).toEqual(['memory_search']);
    expect(service.getToolsForRequest(as('member-1', ['intents', 'mcp'])).map((tool) => tool.name)).toEqual([
      'memory_search',
    ]);
    expect(registry.isToolVisibleTo).toHaveBeenCalledWith('messaging_listChats', 'member-1');
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

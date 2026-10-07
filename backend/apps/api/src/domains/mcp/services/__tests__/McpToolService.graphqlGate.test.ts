import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';

import type { ApiKeyScopedRequest } from '@ci/common/guards';
import type { PendingActionReplayer } from '@ci/domains/tools';

import { ToolExecutionError } from '../../types';
import type { GraphQLToolAdapter } from '../GraphQLToolAdapter';
import type { McpExecutorService } from '../McpExecutorService';
import { McpToolService } from '../McpToolService';

/**
 * Native intents called over /api/mcp go through the registry and the pending-action gate. The
 * GraphQL plane used to skip it: with the dial on Balanced, `memory_forget` waited for a card
 * while `mutation_deletePerson` over the same connection ran at once. These pin that GraphQL-plane
 * calls now meet the same gate, and that a parked one can be replayed once the owner confirms.
 */
describe('McpToolService — the GraphQL plane meets the pending-action gate', () => {
  const deletePerson = {
    name: 'mutation_deletePerson',
    description: 'Delete a person',
    inputSchema: {},
    privacy: { access: 'delete', sensitivity: 'personal', destructive: true, external: false },
  };

  const queryPeople = {
    name: 'query_people',
    description: 'Query people',
    inputSchema: {},
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
  };

  const nativeIntent = {
    name: 'memory.search',
    description: 'Search memory',
    parameters: { type: 'object' as const, properties: {} },
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
  };

  function buildService(
    ruling: { decision: 'execute' | 'queue' | 'deny'; reason?: string } = { decision: 'execute' },
  ) {
    const adapter = {
      getTools: () => [deletePerson, queryPeople],
      getSchemaSDL: () => '',
    } as unknown as GraphQLToolAdapter;

    const registry = {
      getAgentFacingTools: () => [nativeIntent],
      getOutboundCatalogTools: () => [nativeIntent],
      // One shared intent, so the boot-time map and the per-request ownership view agree.
      getOutboundCatalogToolsForEveryOwner: () => [nativeIntent],
      isToolVisibleTo: () => true,
      getRegisteredToolNames: () => [nativeIntent.name],
      executeTool: jest.fn().mockResolvedValue({ success: true, data: {} }),
      recordInvocation: jest.fn().mockResolvedValue(undefined),
    };

    const executor = {
      executeTool: jest.fn().mockResolvedValue({ success: true }),
    };

    const pendingActions = {
      evaluate: jest.fn(async (..._args: unknown[]) => ({
        decision: ruling.decision,
        reason: ruling.reason ?? 'confirmation-required',
        explanation:
          '"mutation_deletePerson" removes data and this appliance is set to confirm before acting',
      })),
      propose: jest.fn(async (..._args: unknown[]) => ({
        id: 'pa-9',
        expiresAt: new Date('2026-10-07T00:00:00.000Z'),
      })),
    };

    let replayer: PendingActionReplayer | undefined;
    const replays = {
      register: jest.fn((registered: PendingActionReplayer) => {
        replayer = registered;
      }),
    };

    const logger = {
      setContext: jest.fn(),
      log: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const service = new McpToolService(
      adapter,
      registry as never,
      executor as unknown as McpExecutorService,
      logger as never,
      pendingActions as never,
      replays as never,
    );

    service.onModuleInit();

    return { service, executor, registry, pendingActions, replayer: () => replayer! };
  }

  // A signed-in session: no api-key scopes, full authority. The only kind of caller that reaches
  // the GraphQL plane at all, besides an unscoped key.
  const session = (userId: string | null = 'user-1') =>
    ({ user: userId ? { id: userId } : undefined }) as unknown as Request;

  it('parks a destructive mutation and hands back the pending action, without running it', async () => {
    const { service, executor, pendingActions } = buildService({ decision: 'queue' });

    const error = await service
      .executeTool('mutation_deletePerson', { id: 'person-1' }, { req: session() })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ToolExecutionError);
    expect(error).toMatchObject({
      code: 'TOOL_QUEUED',
      details: {
        pendingActionId: 'pa-9',
        reason: 'confirmation-required',
        expiresAt: '2026-10-07T00:00:00.000Z',
      },
    });
    expect(executor.executeTool).not.toHaveBeenCalled();

    const [schema, toolName, context, input] = pendingActions.propose.mock.calls[0] as [
      { name: string; privacy: unknown },
      string,
      { userId: string; capability: string; principal: string },
      unknown,
    ];
    expect(schema).toMatchObject({ name: 'mutation_deletePerson', privacy: deletePerson.privacy });
    expect(toolName).toBe('mutation_deletePerson');
    expect(context).toMatchObject({ userId: 'user-1', capability: 'full', principal: 'owner' });
    expect(input).toStrictEqual({ id: 'person-1' });
  });

  it('asks the gate with the tool label and the caller authority', async () => {
    const { service, pendingActions } = buildService();

    await service.executeTool('mutation_deletePerson', { id: 'person-1' }, { req: session() });

    expect(pendingActions.evaluate.mock.calls[0]![0]).toMatchObject({
      name: 'mutation_deletePerson',
      privacy: deletePerson.privacy,
    });
    expect(pendingActions.evaluate.mock.calls[0]![1]).toMatchObject({
      userId: 'user-1',
      capability: 'full',
      principal: 'owner',
    });
  });

  it('runs the call when the gate says execute', async () => {
    const { service, executor, pendingActions } = buildService();

    await expect(service.executeTool('query_people', {}, { req: session() })).resolves.toStrictEqual({
      success: true,
    });

    expect(executor.executeTool).toHaveBeenCalledTimes(1);
    expect(pendingActions.propose).not.toHaveBeenCalled();
  });

  it('records a call whose resolver failed as a failure, though the executor returned it', async () => {
    const { service, executor, registry } = buildService();
    const failed = { errors: [{ message: 'Forbidden resource' }], data: null };

    executor.executeTool.mockResolvedValueOnce(failed);

    await expect(service.executeTool('query_people', {}, { req: session() })).resolves.toStrictEqual(failed);
    expect(registry.recordInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'query_people',
        outcome: 'error',
        errorCode: 'GRAPHQL_ERROR',
        error: 'Forbidden resource',
      }),
    );
  });

  it('refuses a deny outright and never queues it', async () => {
    const { service, executor, pendingActions } = buildService({
      decision: 'deny',
      reason: 'capability-insufficient',
    });

    await expect(
      service.executeTool('mutation_deletePerson', { id: 'person-1' }, { req: session() }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(executor.executeTool).not.toHaveBeenCalled();
    expect(pendingActions.propose).not.toHaveBeenCalled();
  });

  it('refuses a call that would queue but has nobody to confirm it', async () => {
    const { service, executor, pendingActions } = buildService({ decision: 'queue' });

    await expect(
      service.executeTool('mutation_deletePerson', { id: 'person-1' }, { req: session(null) }),
    ).rejects.toMatchObject({ code: 'TOOL_CONFIRMATION_UNAVAILABLE' });

    expect(executor.executeTool).not.toHaveBeenCalled();
    expect(pendingActions.propose).not.toHaveBeenCalled();
  });

  describe('the replayer it registers', () => {
    it('claims GraphQL-plane tools only, with their labels', () => {
      const { replayer } = buildService();

      expect(replayer().privacyOf('mutation_deletePerson')).toStrictEqual(deletePerson.privacy);
      expect(replayer().privacyOf('memory_search')).toBeUndefined();
      expect(replayer().privacyOf('mutation_nothing')).toBeUndefined();
    });

    it('refuses a scope-limited confirming key, or no request at all', () => {
      const { replayer } = buildService();
      const scoped = {
        apiKeyScopes: ['intents'],
        apiKeyCapability: 'full',
      } as unknown as ApiKeyScopedRequest;

      expect(() => replayer().assertMayReplay('mutation_deletePerson', scoped)).toThrow(ForbiddenException);
      expect(() => replayer().assertMayReplay('mutation_deletePerson', undefined)).toThrow(
        ForbiddenException,
      );
      expect(() => replayer().assertMayReplay('mutation_deletePerson', session())).not.toThrow();
    });

    it('runs the stored call as the confirming request and records it', async () => {
      const { replayer, executor, registry } = buildService();
      const confirming = session();

      const result = await replayer().replay('mutation_deletePerson', { id: 'person-1' }, confirming);

      expect(result).toStrictEqual({ success: true, data: { success: true } });
      expect(executor.executeTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'mutation_deletePerson' }),
        { id: 'person-1' },
        { req: confirming },
      );
      expect(registry.recordInvocation).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'mutation_deletePerson', source: 'graphql', outcome: 'success' }),
      );
    });

    it('records the app that asked, not the owner who confirmed', async () => {
      const { replayer, registry } = buildService();

      await replayer().replay('mutation_deletePerson', { id: 'person-1' }, session(), {
        principalName: 'ci-openclaw',
      });

      expect(registry.recordInvocation).toHaveBeenCalledWith(
        expect.objectContaining({
          principal: 'managed-app',
          principalName: 'ci-openclaw',
          capability: 'full',
        }),
      );
    });

    it('reports GraphQL errors and thrown failures as a failed result instead of throwing', async () => {
      const { replayer, executor } = buildService();

      executor.executeTool.mockResolvedValueOnce({ errors: [{ message: 'Person not found' }], data: null });
      await expect(replayer().replay('mutation_deletePerson', {}, session())).resolves.toMatchObject({
        success: false,
        error: { code: 'GRAPHQL_ERROR', message: 'Person not found' },
      });

      executor.executeTool.mockRejectedValueOnce(new ForbiddenException('nope'));
      await expect(replayer().replay('mutation_deletePerson', {}, session())).resolves.toMatchObject({
        success: false,
        error: { code: 'ForbiddenException' },
      });
    });
  });
});

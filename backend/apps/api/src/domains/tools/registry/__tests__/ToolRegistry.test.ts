/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ApiKeyCapability } from '@ci/common/decorators';

import type { IntentPrivacy, ToolInvocationContext } from '../../core/types';
import { ToolRegistry } from '../ToolRegistry';

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

const DESTRUCTIVE_PRIVACY: IntentPrivacy = {
  access: 'delete',
  sensitivity: 'personal',
  destructive: true,
  external: false,
};

function fakeTool(name: string, data: unknown = { ok: true }, privacy: IntentPrivacy = READ_PRIVACY) {
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
    execute: jest.fn(async () => ({ success: true, data, executionTimeMs: 1 })),
  } as any;
}

/** A tool materialized from one user's stored config (what the MCP-client provider builds). */
function ownedTool(name: string, ownerUserId: string, data: unknown = { ok: true }) {
  const tool = fakeTool(name, data);
  tool.schema.domain = 'mcp';
  tool.schema.ownerUserId = ownerUserId;

  return tool;
}

function fakeProvider(tools: Record<string, any>) {
  const map = new Map(Object.entries(tools));

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

const context: ToolInvocationContext = { userId: 'user-1', capability: 'full' };

function asCapability(capability: ApiKeyCapability): ToolInvocationContext {
  return { userId: 'user-1', capability };
}

describe('ToolRegistry', () => {
  function makeRegistry() {
    const send = jest.fn().mockResolvedValue([]);
    const registry = new ToolRegistry(makeLogger(), { send } as any);

    return { registry, send };
  }

  it('keys tools by the executable (underscored) name while exposing the dotted intent name', async () => {
    const { registry } = makeRegistry();
    await registry.registerProvider(fakeProvider({ 'memory.recall': fakeTool('memory.recall') }));

    expect(registry.getRegisteredToolNames()).toEqual(['memory_recall']);
    expect(registry.hasTool('memory_recall')).toBe(true);
    expect(registry.getAvailableTools().map((s) => s.name)).toEqual(['memory.recall']);
  });

  it('getAgentFacingTools returns every tool (no raw/intent two-tier)', async () => {
    const { registry } = makeRegistry();
    await registry.registerProvider(
      fakeProvider({ 'memory.recall': fakeTool('memory.recall'), 'people.find': fakeTool('people.find') }),
    );

    expect(
      registry
        .getAgentFacingTools()
        .map((s) => s.name)
        .sort(),
    ).toEqual(['memory.recall', 'people.find']);
  });

  it('executes a tool by its executable name and emits tool.invoked via EventService', async () => {
    const { registry, send } = makeRegistry();
    const tool = fakeTool('memory.recall', { hits: [] });
    await registry.registerProvider(fakeProvider({ 'memory.recall': tool }));

    const result = await registry.executeTool('memory_recall', context, { q: 1 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ hits: [] });
    expect(tool.execute).toHaveBeenCalledWith(context, { q: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const [eventName, payload, options] = send.mock.calls[0];
    expect(eventName).toBe('tool.invoked');
    expect(payload).toMatchObject({
      intent: 'memory.recall',
      tool: 'memory_recall',
      domain: 'memory',
      userId: 'user-1',
      outcome: 'success',
      access: 'read',
      external: false,
      destructive: false,
      // The provider that served it, which is what tells a ledger reader whether a call came from
      // a native intent or a user's own MCP server.
      source: 'fake',
    });
    expect(typeof (payload as { occurredAt?: unknown }).occurredAt).toBe('string');
    expect(options).toEqual({ queue: 'telemetry' });
  });

  it('never fails the tool call when telemetry emission throws', async () => {
    const send = jest.fn().mockRejectedValue(new Error('bus down'));
    const registry = new ToolRegistry(makeLogger(), { send } as any);
    await registry.registerProvider(fakeProvider({ 'memory.recall': fakeTool('memory.recall', { ok: 1 }) }));

    const result = await registry.executeTool('memory_recall', context, {});

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns TOOL_NOT_FOUND (and does not emit) for an unknown tool', async () => {
    const { registry, send } = makeRegistry();
    await registry.registerProvider(fakeProvider({ 'memory.recall': fakeTool('memory.recall') }));

    const result = await registry.executeTool('does_not_exist', context, {});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('TOOL_NOT_FOUND');
    expect(send).not.toHaveBeenCalled();
  });

  /**
   * The gap this closes: enforcement used to live only in McpToolService, so whether the privacy
   * label meant anything depended on which door the caller came through. Every case here drives
   * the registry directly — the shared floor under MCP, the chat model, and the on-device tier
   * alike — and each would have passed (executed the tool) against the pre-fix registry, which
   * performed no authorization at all.
   */
  describe('capability enforcement (the floor every dispatcher stands on)', () => {
    async function registryWithForget() {
      const { registry, send } = makeRegistry();
      const forget = fakeTool('memory.forget', { archived: 1 }, DESTRUCTIVE_PRIVACY);
      await registry.registerProvider(fakeProvider({ 'memory.forget': forget }));

      return { registry, send, forget };
    }

    it('refuses a destructive tool to a read-only caller without executing it', async () => {
      const { registry, send, forget } = await registryWithForget();

      const result = await registry.executeTool('memory_forget', asCapability('read'), {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TOOL_FORBIDDEN');
      expect(result.error?.retryable).toBe(false);
      expect(result.error?.message).toContain('"full"');
      // The point of the whole exercise: the tool never ran.
      expect(forget.execute).not.toHaveBeenCalled();
      // …and the refusal IS recorded, as `outcome: 'refused'`. The original reason for staying
      // silent — that feeding a refusal into the behavioral signal would record a deletion the
      // user never made — is preserved by the outcome value rather than by the silence: a
      // behavioural consumer filters `outcome <> 'refused'`, while an operator can finally see the
      // denied call.
      expect(send).toHaveBeenCalledTimes(1);
      const [, payload] = send.mock.calls[0];
      expect(payload).toMatchObject({
        intent: 'memory.forget',
        tool: 'memory_forget',
        outcome: 'refused',
        errorCode: 'TOOL_FORBIDDEN',
        capability: 'read',
        destructive: true,
        access: 'delete',
      });
      // Nothing ran, so nothing took time. A 0 here would read as "returned instantly".
      expect(payload.durationMs).toBeUndefined();
    });

    it('refuses a destructive tool to a write caller too (delete is its own level)', async () => {
      const { registry, forget } = await registryWithForget();

      const result = await registry.executeTool('memory_forget', asCapability('write'), {});

      expect(result.error?.code).toBe('TOOL_FORBIDDEN');
      expect(forget.execute).not.toHaveBeenCalled();
    });

    it('lets a full-capability caller run the destructive tool exactly as before', async () => {
      const { registry, send, forget } = await registryWithForget();

      const result = await registry.executeTool('memory_forget', asCapability('full'), {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ archived: 1 });
      expect(forget.execute).toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('still allows a read-only caller the read tools it is entitled to', async () => {
      const { registry } = makeRegistry();
      await registry.registerProvider(fakeProvider({ 'memory.recall': fakeTool('memory.recall') }));

      const result = await registry.executeTool('memory_recall', asCapability('read'), {});

      expect(result.success).toBe(true);
    });

    it('refuses a write tool to a read-only caller but allows it at write', async () => {
      const { registry } = makeRegistry();
      const write: IntentPrivacy = { ...READ_PRIVACY, access: 'write' };
      await registry.registerProvider(
        fakeProvider({ 'memory.remember': fakeTool('memory.remember', { ok: 1 }, write) }),
      );

      await expect(registry.executeTool('memory_remember', asCapability('read'), {})).resolves.toMatchObject({
        success: false,
        error: { code: 'TOOL_FORBIDDEN' },
      });
      await expect(registry.executeTool('memory_remember', asCapability('write'), {})).resolves.toMatchObject(
        { success: true },
      );
    });

    it('checks the tool exists before the capability, so a bad name is not reported as forbidden', async () => {
      const { registry } = await registryWithForget();

      const result = await registry.executeTool('does_not_exist', asCapability('read'), {});

      expect(result.error?.code).toBe('TOOL_NOT_FOUND');
    });

    it('resolves mashed Qwen names like memoryremember onto memory_remember', async () => {
      const { registry } = makeRegistry();
      const write: IntentPrivacy = { ...READ_PRIVACY, access: 'write' };
      await registry.registerProvider(
        fakeProvider({ 'memory.remember': fakeTool('memory.remember', { ok: 1 }, write) }),
      );

      const result = await registry.executeTool('memoryremember', asCapability('write'), {});

      expect(result.success).toBe(true);
    });

    it('routes invented memory_create_relationships onto memory_remember', async () => {
      const { registry } = makeRegistry();
      const write: IntentPrivacy = { ...READ_PRIVACY, access: 'write' };
      await registry.registerProvider(
        fakeProvider({ 'memory.remember': fakeTool('memory.remember', { ok: 1 }, write) }),
      );

      const result = await registry.executeTool('memory_create_relationships', asCapability('write'), {});

      expect(result.success).toBe(true);
    });
  });

  /**
   * The registry is one process-global map, loaded once per provider, outside any request. A tool
   * materialized from a single user's stored config (an MCP-client tool, bound to that user's
   * server and secrets) therefore used to be listed to — and executable by — every other account
   * on the appliance. Every case below fails against the pre-fix registry, which filtered nothing
   * and only logged `context.userId`.
   *
   * On a single-account appliance this is a no-op; it is correctness for a multi-account box.
   */
  describe('per-user tool ownership', () => {
    async function registryWithOwnedTool() {
      const { registry, send } = makeRegistry();
      const owned = ownedTool('mcp.github.create_issue', 'user-1', { issue: 7 });
      await registry.registerProvider(
        fakeProvider({ 'mcp.github.create_issue': owned, 'memory.recall': fakeTool('memory.recall') }),
      );

      return { registry, send, owned };
    }

    it('lists an owned tool to its owner alongside the unowned ones', async () => {
      const { registry } = await registryWithOwnedTool();

      expect(
        registry
          .getAvailableTools({ userId: 'user-1' })
          .map((s) => s.name)
          .sort(),
      ).toEqual(['mcp.github.create_issue', 'memory.recall']);
    });

    it('hides another user\'s owned tool while still listing the unowned ones', async () => {
      const { registry } = await registryWithOwnedTool();

      expect(registry.getAvailableTools({ userId: 'user-2' }).map((s) => s.name)).toEqual(['memory.recall']);
      expect(registry.getAgentFacingTools({ userId: 'user-2' }).map((s) => s.name)).toEqual(['memory.recall']);
    });

    it('treats a caller with no userId as nobody, not as everybody', async () => {
      const { registry } = await registryWithOwnedTool();

      expect(registry.getAvailableTools().map((s) => s.name)).toEqual(['memory.recall']);
      expect(registry.getOutboundCatalogTools().map((s) => s.name)).toEqual(['memory.recall']);
    });

    it('refuses to execute another user\'s owned tool, and does not run or record it', async () => {
      const { registry, send, owned } = await registryWithOwnedTool();

      const result = await registry.executeTool('mcp_github_create_issue', {
        userId: 'user-2',
        capability: 'full',
      }, {});

      expect(result.success).toBe(false);
      // Reported as missing, not forbidden: a distinct refusal would confirm the other account
      // has a server by that name.
      expect(result.error?.code).toBe('TOOL_NOT_FOUND');
      expect(owned.execute).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses it to an unauthenticated caller too (naming it directly is not a way in)', async () => {
      const { registry, owned } = await registryWithOwnedTool();

      const result = await registry.executeTool('mcp_github_create_issue', { capability: 'full' }, {});

      expect(result.error?.code).toBe('TOOL_NOT_FOUND');
      expect(owned.execute).not.toHaveBeenCalled();
    });

    it('still executes the owned tool for its owner', async () => {
      const { registry, send, owned } = await registryWithOwnedTool();

      const result = await registry.executeTool('mcp_github_create_issue', {
        userId: 'user-1',
        capability: 'full',
      }, {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ issue: 7 });
      expect(owned.execute).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('leaves unowned native tools reachable by any user, including one with no userId', async () => {
      const { registry } = await registryWithOwnedTool();

      await expect(
        registry.executeTool('memory_recall', { userId: 'user-2', capability: 'full' }, {}),
      ).resolves.toMatchObject({ success: true });
      await expect(registry.executeTool('memory_recall', { capability: 'full' }, {})).resolves.toMatchObject({
        success: true,
      });
    });
  });

  it('logs an egress warning when an external intent runs, and none when it does not', async () => {
    const logger = makeLogger();
    const registry = new ToolRegistry(logger, { send: jest.fn().mockResolvedValue([]) } as any);
    const external: IntentPrivacy = { ...READ_PRIVACY, external: true, sensitivity: 'low' };
    await registry.registerProvider(
      fakeProvider({
        'media.streamingAvailability': fakeTool('media.streamingAvailability', { titles: [] }, external),
        'memory.recall': fakeTool('memory.recall'),
      }),
    );

    await registry.executeTool('memory_recall', context, {});
    expect(logger.warn).not.toHaveBeenCalled();

    await registry.executeTool('media_streamingAvailability', context, {});
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('leaves the appliance'),
      expect.objectContaining({ intent: 'media.streamingAvailability' }),
    );
  });
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { ToolRegistry } from '@ci/domains/tools';

import { McpServerConfigEntity } from '../entities/McpServerConfigEntity';
import { decryptedDraftFromEntity } from '../mapping';
import type {
  McpApprovedTool,
  McpAuthConfig,
  McpDiscoveredTool,
  McpProbeResult,
  McpSecretEntry,
  McpServerConfigDraft,
} from '../types';

import { McpSecretCodec } from './McpSecretCodec';
import { grandfatherApprovals } from './mcpToolDigest';

interface LiveConnection {
  client: Client;
  transport: Transport;
}

const MCP_PROVIDER_NAME = 'mcp';

/**
 * Owns every live connection to a user-configured external MCP server: spawning/opening the
 * transport, running `tools/list`, routing `tools/call`, and keeping `ci.mcp_server_configs` in
 * sync with what actually happened (status/last_connected_at/last_error), so the settings list
 * view never has to live-probe a server just to render a status badge.
 *
 * Deliberately does NOT implement `OnModuleInit` itself — see
 * {@link McpToolsRegistrationService} for why the boot sweep has to run from there instead.
 */
@Injectable()
export class McpClientManagerService implements OnModuleDestroy {
  /** 2s → 4s → 8s → … capped at 60s. */
  private static readonly INITIAL_BACKOFF_MS = 2000;

  private static readonly MAX_BACKOFF_MS = 60000;

  /** One hung stdio spawn (or a server that never answers `initialize`) must not hang app boot. */
  private static readonly CONNECT_TIMEOUT_MS = 8000;

  /** Overall budget for the boot-time sweep across every enabled config, of every user. */
  private static readonly BOOT_SWEEP_TIMEOUT_MS = 15000;

  private readonly connections = new Map<string, LiveConnection>();

  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly backoffAttempts = new Map<string, number>();

  constructor(
    @InjectRepository(McpServerConfigEntity)
    private readonly repo: Repository<McpServerConfigEntity>,
    private readonly secretCodec: McpSecretCodec,
    private readonly toolRegistry: ToolRegistry,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(McpClientManagerService.name);
  }

  async onModuleDestroy(): Promise<void> {
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }

    this.reconnectTimers.clear();

    await Promise.allSettled(
      Array.from(this.connections.keys()).map((configId) => this.disconnect(configId)),
    );
  }

  /**
   * Bounded initial connect sweep over every enabled config, for every user. Called explicitly by
   * {@link McpToolsRegistrationService} AFTER the MCP tool provider is registered, so every
   * `connect()` this kicks off can safely call `ToolRegistry.refreshProvider('mcp')`.
   *
   * Bounded to ~15s total: a config that is still connecting when the budget runs out keeps
   * connecting in the background (Promise.allSettled never cancels the underlying attempts) and
   * will report in via its own status update + registry refresh whenever it finishes.
   */
  async connectAllEnabled(): Promise<void> {
    const configs = await this.repo.find({ where: { enabled: true } });

    const sweep = Promise.allSettled(configs.map((config) => this.connect(config.id))).then(() => undefined);

    try {
      await this.withTimeout(sweep, McpClientManagerService.BOOT_SWEEP_TIMEOUT_MS, 'MCP boot connect sweep');
    } catch (error) {
      this.logger.warn(
        'MCP boot connect sweep exceeded its time budget; remaining connects continue in background',
        {
          error: (error as Error)?.message,
          configCount: configs.length,
        },
      );
    }
  }

  /**
   * Connect (or reconnect) one server config: spawn/open the transport, run `tools/list`, persist
   * the result, and refresh the `mcp` tool provider so chat sees the new tool set. Failures are
   * caught and turned into a scheduled reconnect rather than thrown — every caller (the boot sweep,
   * a reconnect timer, `onConfigChanged`) treats a connect attempt as fire-and-forget.
   */
  async connect(configId: string): Promise<void> {
    const config = await this.repo.findOne({ where: { id: configId } });

    if (!config) {
      this.logger.warn('connect(): no such MCP server config', { configId });

      return;
    }

    if (!config.enabled) {
      return;
    }

    this.clearReconnectTimer(configId);
    await this.persist(configId, { connectionStatus: 'connecting' });

    let live: LiveConnection;

    try {
      const draft = decryptedDraftFromEntity(config, this.secretCodec);

      live = await this.withTimeout(
        this.openConnection(draft, config.slug),
        McpClientManagerService.CONNECT_TIMEOUT_MS,
        `MCP connect (${config.slug})`,
      );
    } catch (error) {
      await this.handleConnectFailure(configId, error);

      return;
    }

    // If a connection was already live (shouldn't normally happen — connect() is always preceded
    // by a disconnect on every path that re-invokes it), close it before replacing.
    if (this.connections.has(configId)) {
      await this.disconnect(configId);
    }

    live.transport.onclose = () => this.handleUnexpectedDisconnect(configId);
    live.transport.onerror = (error) => {
      this.logger.warn(`MCP transport error (${config.slug})`, { configId, error: error?.message });
    };

    this.connections.set(configId, live);

    try {
      const discoveredTools = (await live.client.listTools()).tools.map(toDiscoveredTool);

      await this.persist(configId, {
        discoveredTools,
        // One-shot conversion of a pre-approval-gate row (approved_tools IS NULL): grandfather
        // whatever this server offers right now so an appliance that was already using these tools
        // does not lose them at deploy, then leave an explicit set behind so the NEXT reconnect's
        // drift is caught. Rows created after the gate start at `[]` and never take this branch.
        ...(config.approvedTools == null
          ? {
              approvedTools: grandfatherApprovals(
                discoveredTools,
                null,
                'legacy:grandfathered',
                new Date().toISOString(),
              ),
            }
          : {}),
        connectionStatus: 'connected',
        lastConnectedAt: new Date(),
        lastError: null,
      });

      this.backoffAttempts.delete(configId);
    } catch (error) {
      await this.handleConnectFailure(configId, error);

      return;
    }

    await this.safeRefreshProvider();
  }

  /** Kill the subprocess / close the transport and drop it from the live pool. Idempotent. */
  async disconnect(configId: string): Promise<void> {
    this.clearReconnectTimer(configId);

    const live = this.connections.get(configId);
    this.connections.delete(configId);

    if (!live) {
      return;
    }

    live.transport.onclose = undefined;
    live.transport.onerror = undefined;

    try {
      await live.client.close();
    } catch (error) {
      this.logger.warn('Error closing MCP client connection', { configId, error: (error as Error)?.message });
    }

    await this.persist(configId, { connectionStatus: 'disconnected' }).catch(() => {});
    await this.safeRefreshProvider();
  }

  /**
   * Disconnect (if live), reset backoff, and — unless the config was just deleted — reconnect if
   * it is (still) enabled. Called by {@link McpServerConfigService} after every create / update /
   * delete / enable / disable so the live pool never drifts from the stored config.
   */
  async onConfigChanged(
    configId: string,
    action: 'created' | 'updated' | 'deleted' | 'toggled',
  ): Promise<void> {
    await this.disconnect(configId);
    this.backoffAttempts.delete(configId);

    if (action === 'deleted') {
      return;
    }

    const config = await this.repo.findOne({ where: { id: configId } });

    if (config?.enabled) {
      // Fire-and-forget: the HTTP request that changed the config should not block on a
      // potentially-slow stdio spawn or a slow remote handshake.
      void this.connect(configId);
    }
  }

  /**
   * Tools for one server: from the live connection when connected, else the last successful
   * `discovered_tools` cache.
   */
  async listTools(configId: string): Promise<McpDiscoveredTool[]> {
    const live = this.connections.get(configId);

    if (live) {
      return (await live.client.listTools()).tools.map(toDiscoveredTool);
    }

    const config = await this.repo.findOne({ where: { id: configId } });

    return config?.discoveredTools ?? [];
  }

  /**
   * Every discovered tool across every enabled config, for {@link McpToolProvider}, each carrying
   * its server's stored grant. The approval set travels WITH the tool rather than being fetched
   * separately by the provider so the intersect can never read a grant from a different row than
   * the tool it is judging.
   *
   * Deliberately NOT filtered by user, for the same reason {@link connectAllEnabled} is not: the
   * provider is loaded into the process-global {@link ToolRegistry} once, outside any request, so
   * there is no user to filter by at this point. Each entry instead carries the `userId` that owns
   * the config, and the provider stamps it onto the synthesized intent as `ownerUserId` — that is
   * what the registry filters on, per request, when it lists or executes a tool.
   */
  async listAllDiscoveredTools(): Promise<
    Array<{
      configId: string;
      userId: string;
      slug: string;
      tool: McpDiscoveredTool;
      approvedTools: McpApprovedTool[] | null;
    }>
  > {
    const configs = await this.repo.find({ where: { enabled: true } });
    const entries: Array<{
      configId: string;
      userId: string;
      slug: string;
      tool: McpDiscoveredTool;
      approvedTools: McpApprovedTool[] | null;
    }> = [];

    for (const config of configs) {
      for (const tool of config.discoveredTools ?? []) {
        entries.push({
          configId: config.id,
          userId: config.userId,
          slug: config.slug,
          tool,
          approvedTools: config.approvedTools ?? null,
        });
      }
    }

    return entries;
  }

  /**
   * An approval changed — rebuild the assistant's MCP tool set without touching the live
   * connection. Deliberately not routed through {@link onConfigChanged}: approving a tool must not
   * tear down and respawn a working stdio subprocess.
   */
  async onToolApprovalsChanged(): Promise<void> {
    await this.safeRefreshProvider();
  }

  /** Route a `tools/call` to the live connection. Throws if the server is not currently connected. */
  async callTool(configId: string, toolName: string, input: unknown): Promise<unknown> {
    const live = this.connections.get(configId);

    if (!live) {
      throw new Error(`MCP server "${configId}" is not currently connected`);
    }

    const result = await live.client.callTool({
      name: toolName,
      arguments: (input ?? {}) as Record<string, unknown>,
    });

    if (result.isError) {
      throw new Error(extractTextContent(result) ?? `Tool "${toolName}" reported an error`);
    }

    return result.structuredContent ?? extractTextContent(result) ?? result.content;
  }

  /**
   * Connect + `tools/list` + immediately disconnect, touching neither the DB nor the live pool.
   * Backs `test-connection` for both a saved config (caller decrypts it first via
   * {@link decryptedDraftFromEntity}) and an unsaved draft (submitted as plaintext, never
   * persisted).
   */
  async probe(draft: McpServerConfigDraft): Promise<McpProbeResult> {
    let live: LiveConnection | undefined;

    try {
      live = await this.withTimeout(
        this.openConnection(draft, 'probe'),
        McpClientManagerService.CONNECT_TIMEOUT_MS,
        'MCP probe connect',
      );

      const tools = (await live.client.listTools()).tools.map(toDiscoveredTool);

      return { success: true, tools };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (live) {
        await live.client.close().catch(() => {});
      }
    }
  }

  // ── connection transitions ────────────────────────────────────────────────────────────────

  private async handleConnectFailure(configId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    this.logger.warn('MCP connect failed', { configId, error: message });

    this.connections.delete(configId);
    await this.persist(configId, { connectionStatus: 'error', lastError: message });
    this.scheduleReconnect(configId);
    await this.safeRefreshProvider();
  }

  /** The server closed the connection on its own (crash, restart) — not something we initiated. */
  private handleUnexpectedDisconnect(configId: string): void {
    if (!this.connections.has(configId)) {
      // Already handled by our own disconnect()/handleConnectFailure(), which clear the map
      // before closing — this callback firing afterward is expected, not a second event.
      return;
    }

    this.connections.delete(configId);

    void this.persist(configId, { connectionStatus: 'disconnected' })
      .catch(() => {})
      .then(() => this.safeRefreshProvider())
      .then(() => this.reconnectIfStillEnabled(configId));
  }

  private async reconnectIfStillEnabled(configId: string): Promise<void> {
    const config = await this.repo.findOne({ where: { id: configId } });

    if (config?.enabled) {
      this.scheduleReconnect(configId);
    }
  }

  private scheduleReconnect(configId: string): void {
    if (this.reconnectTimers.has(configId)) {
      return;
    }

    const attempt = (this.backoffAttempts.get(configId) ?? 0) + 1;
    this.backoffAttempts.set(configId, attempt);

    const delayMs = Math.min(
      McpClientManagerService.INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
      McpClientManagerService.MAX_BACKOFF_MS,
    );

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(configId);
      void this.connect(configId);
    }, delayMs);

    // Never keep the process alive on this timer alone.
    timer.unref?.();
    this.reconnectTimers.set(configId, timer);
  }

  private clearReconnectTimer(configId: string): void {
    const timer = this.reconnectTimers.get(configId);

    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(configId);
    }
  }

  // ── transport plumbing ───────────────────────────────────────────────────────────────────

  private async openConnection(draft: McpServerConfigDraft, label: string): Promise<LiveConnection> {
    const transport = this.buildTransport(draft);
    const client = new Client({ name: `ci-server-mcp-client-${label}`, version: '1.0.0' });

    await client.connect(transport);

    return { client, transport };
  }

  private buildTransport(draft: McpServerConfigDraft): Transport {
    if (draft.transport === 'stdio') {
      if (!draft.command) {
        throw new Error('stdio MCP server config is missing a command');
      }

      return new StdioClientTransport({
        command: draft.command,
        args: draft.args ?? [],
        env: { ...getDefaultEnvironment(), ...toEnvRecord(draft.env ?? []) },
      });
    }

    if (draft.transport === 'http') {
      if (!draft.url) {
        throw new Error('http MCP server config is missing a url');
      }

      const headers = buildAuthHeaders(draft.auth ?? null);

      return new StreamableHTTPClientTransport(
        new URL(draft.url),
        headers ? { requestInit: { headers } } : undefined,
      );
    }

    throw new Error(`Unsupported MCP transport: ${(draft as { transport: string }).transport}`);
  }

  private async persist(configId: string, patch: Partial<McpServerConfigEntity>): Promise<void> {
    try {
      // `discoveredTools`/its nested `inputSchema: Record<string, unknown>` jsonb shape does not
      // satisfy TypeORM's `_QueryDeepPartialEntity` — the same cast this codebase already uses at
      // every other jsonb `.update()` call site (see e.g. `ContextPromptService.markWritten`).
      await this.repo.update(configId, patch as never);
    } catch (error) {
      this.logger.warn('Failed to persist MCP connection state', {
        configId,
        error: (error as Error)?.message,
      });
    }
  }

  private async safeRefreshProvider(): Promise<void> {
    try {
      await this.toolRegistry.refreshProvider(MCP_PROVIDER_NAME);
    } catch (error) {
      // Expected only if this fires before McpToolsRegistrationService has registered the
      // provider (a boot-time race). Once registered, every later refresh succeeds normally.
      this.logger.debug('Skipped MCP tool registry refresh — provider not yet registered', {
        error: (error as Error)?.message,
      });
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }
}

function toDiscoveredTool(tool: {
  name: string;
  description?: string;
  inputSchema: unknown;
}): McpDiscoveredTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
  };
}

function toEnvRecord(entries: McpSecretEntry[]): Record<string, string> {
  const record: Record<string, string> = {};

  for (const entry of entries) {
    if (entry.value != null) {
      record[entry.key] = entry.value;
    }
  }

  return record;
}

/**
 * Conventional field keys per `auth.type` — see the doc comment on {@link McpAuthConfig} in
 * `../types`. Returns `undefined` when the required field(s) are missing so a half-configured
 * auth block fails the connection with a clear MCP/transport error rather than sending a
 * malformed header.
 */
function buildAuthHeaders(auth: McpAuthConfig | null): Record<string, string> | undefined {
  if (!auth) {
    return undefined;
  }

  const byKey = new Map(auth.fields.map((field) => [field.key, field.value]));

  switch (auth.type) {
    case 'bearer': {
      const token = byKey.get('token');

      return token ? { Authorization: `Bearer ${token}` } : undefined;
    }

    case 'basic': {
      const username = byKey.get('username') ?? '';
      const password = byKey.get('password') ?? '';

      return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
    }

    case 'api_key': {
      const headerName = byKey.get('headerName');
      const value = byKey.get('value');

      return headerName && value ? { [headerName]: value } : undefined;
    }

    default:
      return undefined;
  }
}

/**
 * Join every `type: 'text'` content block — the common case for an error message.
 *
 * Untyped input deliberately: `Client.callTool`'s return type is a union that also covers
 * experimental task-augmented results with no `content` array at all, so this only needs to be
 * safe against a shape it does not recognize, not type-faithful to every branch.
 */
function extractTextContent(result: unknown): string | undefined {
  const content = (result as { content?: unknown } | undefined)?.content;

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();

  return text.length > 0 ? text : undefined;
}

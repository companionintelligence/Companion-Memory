import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import type {
  BaseTool,
  IntentDefinition,
  JSONSchema,
  ProviderHealthStatus,
  ToolProvider,
  ToolSchema,
} from '@ci/domains/tools';

import { buildMcpIntentName } from '../naming';
import { McpClientManagerService } from '../services/McpClientManagerService';
import { isToolApproved } from '../services/mcpToolDigest';
import { McpDynamicTool } from '../tools/McpDynamicTool';
import type { McpDiscoveredTool } from '../types';

/**
 * Second tool provider alongside {@link NativeToolProvider}: every tool discovered from a user's
 * connected external MCP servers, wrapped as a {@link McpDynamicTool}.
 *
 * `includeInOutboundCatalog = false` (the fixed decision this domain implements): these tools are
 * assistant-only. Re-publishing them on CI-Server's own outbound `/api/intents` manifest or its
 * own MCP server surface would let an outside caller reach back through CI-Server to the very
 * external server it came from — the recursive re-exposure that flag exists to prevent.
 *
 * Discovery is not adoption. `getAvailableTools()` INTERSECTS what each server currently offers
 * against that server's stored `approved_tools`, so a tool nobody approved — or one whose
 * `inputSchema` no longer digests to what was approved — is not merely flagged, it is absent from
 * the assistant's tool set entirely. Before this, `tools/list` on every reconnect was written
 * straight into `discovered_tools` and rebuilt this cache with nothing to compare against.
 *
 * The uniform pessimistic privacy label below is NOT a substitute for that gate, despite looking
 * like one: it demands FULL capability, but `apiKeyCapabilityOf` (`common/guards/apiKeyScopeEnforcement.ts`)
 * returns FULL_CAPABILITY whenever `apiKeyScopes === undefined`, which is exactly what a JWT/session
 * principal is. Browser chat authenticates by JWT, so the label filters nothing on the surface where
 * a drifted tool actually lands.
 *
 * Every discovered tool gets the SAME synthetic privacy label, deliberately not configurable
 * per-tool in this version: raw `tools/list` carries no privacy metadata at all, and treating an
 * unknown external tool as anything less than "sensitive, destructive, external, write" would be
 * guessing. `localCapable: false` because nothing sourced from a network/subprocess call to code
 * this appliance does not own can be served from on-device data.
 */
@Injectable()
export class McpToolProvider implements ToolProvider {
  readonly name = 'mcp';

  readonly includeInOutboundCatalog = false;

  /**
   * Rebuilt on every {@link getAvailableTools} call, keyed by the dotted intent name. `getTool` is
   * synchronous (the {@link ToolProvider} interface), so the registry's load path — which always
   * calls `getAvailableTools()` once and then `getTool(schema.name)` per returned schema — relies
   * on this cache being rebuilt as a side effect of the former.
   */
  private toolCache = new Map<string, McpDynamicTool>();

  constructor(
    private readonly manager: McpClientManagerService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(McpToolProvider.name);
  }

  async initialize(): Promise<void> {
    // Nothing to do: the manager owns connection lifecycle. Tool discovery happens lazily in
    // getAvailableTools(), driven off whatever the manager currently has connected/cached.
  }

  async shutdown(): Promise<void> {
    this.toolCache.clear();
  }

  async getAvailableTools(): Promise<ToolSchema[]> {
    const entries = await this.manager.listAllDiscoveredTools();
    const next = new Map<string, McpDynamicTool>();

    for (const { configId, userId, slug, tool, approvedTools } of entries) {
      if (!isToolApproved(tool, approvedTools)) {
        this.logger.debug('Withholding unapproved MCP tool from the assistant tool set', {
          configId,
          slug,
          tool: tool.name,
        });
        continue;
      }

      const intentName = buildMcpIntentName(slug, tool.name);

      if (next.has(intentName)) {
        this.logger.warn('Duplicate MCP tool intent name after sanitization, skipping', { intentName });
        continue;
      }

      next.set(intentName, this.buildDynamicTool(intentName, configId, userId, tool));
    }

    this.toolCache = next;

    return Array.from(this.toolCache.values()).map((tool) => tool.schema);
  }

  getTool(name: string): BaseTool | undefined {
    return this.toolCache.get(name);
  }

  canHandle(toolName: string): boolean {
    return this.toolCache.has(toolName);
  }

  async getHealthStatus(): Promise<ProviderHealthStatus> {
    return {
      name: this.name,
      status: this.toolCache.size > 0 ? 'healthy' : 'unknown',
      toolCount: this.toolCache.size,
      lastCheck: new Date(),
    };
  }

  private buildDynamicTool(
    intentName: string,
    configId: string,
    ownerUserId: string,
    tool: McpDiscoveredTool,
  ): McpDynamicTool {
    const schema: IntentDefinition = {
      name: intentName,
      domain: 'mcp',
      title: tool.name,
      description: tool.description || `Tool "${tool.name}" from a connected MCP server.`,
      parameters: (tool.inputSchema as JSONSchema) ?? { type: 'object', properties: {} },
      privacy: { access: 'write', sensitivity: 'sensitive', destructive: true, external: true },
      localCapable: false,
      category: 'mcp',
      // Unlike a native intent, this tool is not a capability of the appliance: it is a bound call
      // into one user's configured server, authenticated with the secrets that user saved (the
      // `configId` closed over below decides whose credentials go out on the wire). The registry
      // is process-global, so without this the tool would be listed to, and runnable by, every
      // other account on the box.
      ownerUserId,
    };

    return new McpDynamicTool(schema, this.logger, (input) =>
      this.manager.callTool(configId, tool.name, input),
    );
  }
}

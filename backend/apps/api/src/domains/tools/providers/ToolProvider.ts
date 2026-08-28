import type { BaseTool } from '../core/BaseTool';
import type { ToolSchema } from '../core/types';

/**
 * Base interface for tool providers
 * Providers are responsible for discovering, managing, and providing tools
 */
export interface ToolProvider {
  /**
   * Unique identifier for this provider
   */
  readonly name: string;

  /**
   * Whether this provider's tools should be advertised on CI-Server's OWN outbound surfaces —
   * the `/api/intents` manifest and the tools CI-Server's own MCP server exposes to a connecting
   * client.
   *
   * Default (undefined) is `true`, matching every provider's behaviour before this flag existed:
   * a provider only needs to set this when it has a reason to hide its tools from those two
   * surfaces specifically. Chat/agent dispatch is untouched either way — {@link ToolRegistry.getAvailableTools}
   * and {@link ToolRegistry.getAgentFacingTools} always see every provider's tools; this only
   * gates {@link ToolRegistry.getOutboundCatalogTools}.
   *
   * Set to `false` by a provider whose tools were themselves sourced from an external MCP
   * server: re-publishing them on CI-Server's outbound catalog/MCP surface would let a client
   * reach back out to that same external server through CI-Server, which is a recursive
   * re-exposure this flag exists to prevent, not a capability this appliance means to offer.
   */
  readonly includeInOutboundCatalog?: boolean;

  /**
   * Initialize the provider (discover tools, connect to services, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Shutdown the provider and cleanup resources
   */
  shutdown(): Promise<void>;

  /**
   * Get all available tool schemas from this provider
   */
  getAvailableTools(): Promise<ToolSchema[]>;

  /**
   * Get a specific tool instance by name
   */
  getTool(name: string): BaseTool | undefined;

  /**
   * Check if this provider can handle a specific tool
   */
  canHandle(toolName: string): boolean;

  /**
   * Get provider health status
   */
  getHealthStatus(): Promise<ProviderHealthStatus>;
}

/**
 * Health status for a tool provider
 */
export interface ProviderHealthStatus {
  name: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  toolCount: number;
  lastCheck: Date;
  error?: string;
}

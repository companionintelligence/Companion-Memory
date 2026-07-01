import type { BaseTool } from '../core/BaseTool';

/**
 * Base interface for tool providers
 * Providers are responsible for discovering, managing, and providing tools.
 *
 * A provider hands back tool *instances* — each {@link BaseTool} already carries
 * its own `schema`, so there is no separate schema projection for the registry
 * to reconcile by name. Do any async discovery in `initialize()`; `getTools()`
 * is a cheap accessor over what discovery produced.
 */
export interface ToolProvider {
  /**
   * Unique identifier for this provider
   */
  readonly name: string;

  /**
   * Initialize the provider (discover tools, connect to services, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Shutdown the provider and cleanup resources
   */
  shutdown(): Promise<void>;

  /**
   * The tools this provider contributes. Each tool carries its own schema, so
   * the registry never re-fetches an instance by name.
   */
  getTools(): BaseTool[];

  /**
   * Optional: raw tool names whose capability this provider's tools supersede.
   * The registry demotes these from the agent-facing list, so the model is
   * offered the curated tool, not the low-level one it wraps. Providers that
   * wrap nothing omit this.
   */
  getSupersededToolNames?(): string[];

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

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

import * as fs from 'fs/promises';
import * as path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import type { BaseTool } from '../../core/BaseTool';
import type { ToolSchema } from '../../core/types';
import type { ToolProvider, ProviderHealthStatus } from '../ToolProvider';

import { McpClientManager } from './McpClientManager';
import { McpToolWrapper } from './McpToolWrapper';
import type { McpServerConfig, McpServersConfig, McpSession, McpToolResult, McpHealthStatus } from './types';

/**
 * Provider for MCP (Model Context Protocol) tools from external servers
 */
@Injectable()
export class McpToolProvider implements ToolProvider {
  readonly name = 'mcp';

  private readonly logger = new LoggerService(McpToolProvider.name);

  private readonly activeSessions = new Map<string, McpSession>();

  private readonly tools = new Map<string, BaseTool>();

  private serversConfig: McpServersConfig | null = null;

  // Health monitoring
  private readonly healthCheckIntervals = new Map<string, NodeJS.Timeout>();

  private readonly DEFAULT_HEALTH_CHECK_INTERVAL = 30000; // 30 seconds

  private readonly DEFAULT_HEALTH_CHECK_TIMEOUT = 5000; // 5 seconds

  private readonly DEFAULT_MAX_FAILURES = 3; // Max consecutive failures before restart

  constructor(private readonly clientManager: McpClientManager) {}

  async initialize(): Promise<void> {
    await this.loadConfiguration();
    await this.initializeEnabledServers();
  }

  async shutdown(): Promise<void> {
    await this.disconnectAllServers();
  }

  async getAvailableTools(): Promise<ToolSchema[]> {
    return Array.from(this.tools.values()).map((tool) => tool.schema);
  }

  getTool(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  canHandle(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  async getHealthStatus(): Promise<ProviderHealthStatus> {
    const healthStatuses = await this.getServersHealthStatus();
    const unhealthyServers = healthStatuses.filter((h) => h.status === 'unhealthy');

    return {
      name: this.name,
      status: unhealthyServers.length === 0 ? 'healthy' : 'unhealthy',
      toolCount: this.tools.size,
      lastCheck: new Date(),
      error: unhealthyServers.length > 0 ? `${unhealthyServers.length} unhealthy servers` : undefined,
    };
  }

  /**
   * Load MCP servers configuration from file
   */
  private async loadConfiguration(): Promise<void> {
    try {
      // Try multiple possible config paths for robustness
      const possiblePaths = [
        path.resolve(process.cwd(), 'backend/apps/api/config/mcp-servers.json'),
        path.resolve(__dirname, '../../../../config/mcp-servers.json'),
        path.resolve(__dirname, '../../../config/mcp-servers.json'),
        path.resolve(process.cwd(), 'config/mcp-servers.json'),
      ];

      let configContent: string | null = null;
      let usedPath: string | null = null;

      for (const configPath of possiblePaths) {
        try {
          configContent = await fs.readFile(configPath, 'utf-8');
          usedPath = configPath;
          break;
        } catch (error) {
          this.logger.debug(`Config not found at ${configPath}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!configContent || !usedPath) {
        throw new Error(
          `MCP configuration file not found in any of the expected locations: ${possiblePaths.join(', ')}`,
        );
      }

      this.serversConfig = JSON.parse(configContent) as McpServersConfig;
      this.logger.log('Loaded MCP servers configuration', {
        serverCount: Object.keys(this.serversConfig?.servers || {}).length,
        configPath: usedPath,
      });
    } catch (error) {
      this.logger.error(
        'Failed to load MCP servers configuration',
        error instanceof Error ? error : new Error(String(error)),
      );
      this.serversConfig = { servers: {} };
    }
  }

  /**
   * Initialize all enabled servers on startup
   */
  private async initializeEnabledServers(): Promise<void> {
    if (!this.serversConfig?.servers) {
      return;
    }

    for (const [serverName, config] of Object.entries(this.serversConfig.servers)) {
      if (config.enabled) {
        try {
          await this.startServer(serverName);
        } catch (error) {
          this.logger.error(`Failed to start enabled server: ${serverName}`, error as Error);
        }
      }
    }
  }

  /**
   * Start an MCP server by name
   */
  async startServer(serverName: string): Promise<void> {
    const config = this.getServerConfig(serverName);
    if (!config) {
      throw new Error(`Server configuration not found: ${serverName}`);
    }

    if (this.activeSessions.has(serverName)) {
      this.logger.warn(`Server ${serverName} is already running`);

      return;
    }

    const session: McpSession = {
      id: `${serverName}-${Date.now()}`,
      serverName,
      status: 'connecting',
      startedAt: new Date(),
    };

    this.activeSessions.set(serverName, session);

    try {
      // Use the client manager to create and connect
      const client = await this.clientManager.createClient(serverName, config);

      // Update session
      session.client = client;
      session.status = 'connected';

      // Discover tools and register them
      await this.discoverAndRegisterTools(serverName, client);

      // Start health monitoring if enabled
      this.startHealthMonitoring(serverName);

      this.logger.log(`Started MCP server: ${serverName}`, {
        sessionId: session.id,
        serverName,
      });
    } catch (error) {
      session.status = 'error';
      session.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to start MCP server: ${serverName}`, error as Error);
      throw error;
    }
  }

  /**
   * Stop an MCP server by name
   */
  async stopServer(serverName: string): Promise<void> {
    const session = this.activeSessions.get(serverName);
    if (!session) {
      this.logger.warn(`Server ${serverName} is not running`);

      return;
    }

    try {
      if (session.client) {
        await this.clientManager.closeClient(session.client, serverName);
      }

      // Stop health monitoring
      this.stopHealthMonitoring(serverName);

      this.unregisterServerTools(serverName);
      this.activeSessions.delete(serverName);

      this.logger.log(`Stopped MCP server: ${serverName}`, {
        sessionId: session.id,
      });
    } catch (error) {
      this.logger.error(`Failed to stop MCP server: ${serverName}`, error as Error);
      throw error;
    }
  }

  /**
   * Disconnect all servers
   */
  private async disconnectAllServers(): Promise<void> {
    const promises = Array.from(this.activeSessions.keys()).map((serverName) =>
      this.stopServer(serverName).catch((error) =>
        this.logger.error(`Error stopping server ${serverName}`, error),
      ),
    );
    await Promise.all(promises);

    // Ensure all health monitoring is stopped
    this.healthCheckIntervals.forEach((interval, serverName) => {
      clearInterval(interval);
      this.logger.debug(`Cleared health monitoring interval for ${serverName}`);
    });
    this.healthCheckIntervals.clear();
  }

  /**
   * Execute a tool on an MCP server
   */
  async executeServerTool(serverName: string, toolName: string, args: unknown): Promise<McpToolResult> {
    const session = this.activeSessions.get(serverName);
    if (!session || session.status !== 'connected' || !session.client) {
      return {
        success: false,
        error: `MCP server ${serverName} not available`,
      };
    }

    const startTime = Date.now();

    try {
      const { content } = await session.client.callTool({
        name: toolName,
        arguments: (args as Record<string, unknown>) || {},
      });

      return {
        success: true,
        content,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Discover tools from a server and register them in the local tools map
   */
  private async discoverAndRegisterTools(serverName: string, client: Client): Promise<void> {
    try {
      const { tools } = await client.listTools();

      for (const tool of tools) {
        // Create prefixed tool name: "filesystem:read_file", "web-search:search"
        const prefixedToolName = `${serverName}:${tool.name}`;

        // Create a tool schema for the registry
        const toolSchema: ToolSchema = {
          name: prefixedToolName, // Use prefixed name for uniqueness
          description: `[${serverName}] ${tool.description || ''}`,
          parameters: (tool.inputSchema as ToolSchema['parameters']) || { type: 'object' },
          category: 'mcp',
        };

        // Create and register the tool wrapper with prefixed name
        const toolWrapper = new McpToolWrapper(toolSchema, this, serverName, tool.name);
        this.tools.set(prefixedToolName, toolWrapper);
      }

      this.logger.log(`Registered ${tools.length} tools from ${serverName}`, {
        serverName,
        toolNames: tools.map((t) => `${serverName}:${t.name}`),
      });
    } catch (error) {
      this.logger.error(
        `Failed to discover tools from ${serverName}`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Unregister tools from a server
   */
  private unregisterServerTools(serverName: string): void {
    // Find tools that belong to this server by prefix and remove them
    const toolsToRemove: string[] = [];
    const serverPrefix = `${serverName}:`;

    for (const [toolName] of this.tools) {
      if (toolName.startsWith(serverPrefix)) {
        toolsToRemove.push(toolName);
      }
    }

    // Remove the tools
    for (const toolName of toolsToRemove) {
      this.tools.delete(toolName);
    }

    this.logger.log(`Unregistered ${toolsToRemove.length} tools from ${serverName}`, {
      serverName,
      removedTools: toolsToRemove,
    });
  }

  /**
   * Get server configuration by name
   */
  private getServerConfig(serverName: string): McpServerConfig | null {
    return this.serversConfig?.servers[serverName] || null;
  }
  // ===================================================================
  // HEALTH MONITORING METHODS
  // ===================================================================

  /**
   * Start health monitoring for a server
   */
  private startHealthMonitoring(serverName: string): void {
    const config = this.getServerConfig(serverName);
    if (!config?.healthCheck?.enabled) {
      return;
    }

    const interval = config.healthCheck.intervalMs || this.DEFAULT_HEALTH_CHECK_INTERVAL;

    const healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck(serverName);
    }, interval);

    this.healthCheckIntervals.set(serverName, healthCheckInterval);

    this.logger.debug(`Started health monitoring for ${serverName}`, {
      serverName,
      intervalMs: interval,
    });
  }

  /**
   * Stop health monitoring for a server
   */
  private stopHealthMonitoring(serverName: string): void {
    const interval = this.healthCheckIntervals.get(serverName);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(serverName);

      this.logger.debug(`Stopped health monitoring for ${serverName}`, {
        serverName,
      });
    }
  }

  /**
   * Perform health check on a server
   */
  private async performHealthCheck(serverName: string): Promise<McpHealthStatus> {
    const session = this.activeSessions.get(serverName);
    const config = this.getServerConfig(serverName);

    if (!session) {
      return {
        serverName,
        status: 'unknown',
        lastCheck: new Date(),
        consecutiveFailures: 0,
        uptime: 0,
        error: 'Session not found',
      };
    }

    const startTime = Date.now();
    const timeout = config?.healthCheck?.timeoutMs || this.DEFAULT_HEALTH_CHECK_TIMEOUT;

    try {
      // Use the client manager to test the connection
      const isHealthy = session.client
        ? await this.clientManager.testConnection(session.client, timeout)
        : false;

      if (!isHealthy) {
        throw new Error('Health check failed');
      }

      const responseTime = Date.now() - startTime;
      const uptime = session.startedAt ? Date.now() - session.startedAt.getTime() : 0;

      // Reset failure count on success
      session.healthCheckFailures = 0;
      session.lastHealthCheck = new Date();

      return {
        serverName,
        status: 'healthy',
        lastCheck: new Date(),
        consecutiveFailures: 0,
        uptime,
        responseTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const failures = (session.healthCheckFailures || 0) + 1;
      const uptime = session.startedAt ? Date.now() - session.startedAt.getTime() : 0;

      session.healthCheckFailures = failures;
      session.lastHealthCheck = new Date();
      session.lastError = errorMessage;

      this.logger.warn(`Health check failed for ${serverName}`, {
        serverName,
        consecutiveFailures: failures,
        error: errorMessage,
      });

      // Check if we should restart the server
      const maxFailures = config?.healthCheck?.retryCount || this.DEFAULT_MAX_FAILURES;
      const shouldRestart = config?.healthCheck?.restartOnFailure && failures >= maxFailures;

      if (shouldRestart && !session.isRestarting) {
        this.logger.error(`Server ${serverName} exceeded maximum failures, restarting...`, {
          serverName,
          maxFailures,
          consecutiveFailures: failures,
        });

        // Use setImmediate to avoid blocking the health check
        setImmediate(() => this.restartServer(serverName));
      }

      return {
        serverName,
        status: 'unhealthy',
        lastCheck: new Date(),
        consecutiveFailures: failures,
        uptime,
        error: errorMessage,
      };
    }
  }

  /**
   * Restart a failed server
   */
  private async restartServer(serverName: string): Promise<void> {
    const session = this.activeSessions.get(serverName);
    if (!session || session.isRestarting) {
      return;
    }

    session.isRestarting = true;

    try {
      this.logger.log(`Restarting server ${serverName}`, { serverName });

      // Stop the server
      await this.stopServer(serverName);

      // Small delay before restart
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Start the server again
      await this.startServer(serverName);

      this.logger.log(`Server ${serverName} restarted successfully`, { serverName });
    } catch (error) {
      this.logger.error(`Failed to restart server ${serverName}`, {
        serverName,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      // Clear the restarting flag whether successful or not
      const currentSession = this.activeSessions.get(serverName);
      if (currentSession) {
        currentSession.isRestarting = false;
      }
    }
  }

  /**
   * Get health status for all servers
   */
  async getServersHealthStatus(): Promise<McpHealthStatus[]> {
    const healthStatuses: McpHealthStatus[] = [];

    for (const serverName of this.activeSessions.keys()) {
      const status = await this.performHealthCheck(serverName);
      healthStatuses.push(status);
    }

    return healthStatuses;
  }

  /**
   * Get active sessions
   */
  getActiveSessions(): McpSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Get available servers
   */
  getAvailableServers(): McpServerConfig[] {
    if (!this.serversConfig?.servers) {
      return [];
    }

    return Object.entries(this.serversConfig.servers).map(([name, config]) => ({
      ...config,
      name,
    }));
  }
}

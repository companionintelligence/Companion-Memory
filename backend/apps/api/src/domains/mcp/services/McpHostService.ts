import * as fs from 'fs/promises';
import * as path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';
import { ToolRegistry, type ToolSchema, BaseTool, type ToolExecutionContext } from '@ci/domains/llm/tools';

import type { McpServerConfig, McpServersConfig, McpSession, McpToolResult } from '../types/mcp-config';

/**
 * Wrapper class to adapt MCP tools to our BaseTool interface
 */
class McpToolWrapper extends BaseTool {
  readonly schema: ToolSchema;

  constructor(
    schema: ToolSchema,
    private readonly mcpService: McpHostService,
    private readonly toolName: string,
  ) {
    super();
    this.schema = schema;
  }

  protected async executeInternal(context: ToolExecutionContext, input: unknown): Promise<unknown> {
    const result = await this.mcpService.executeServerTool(this.toolName, input);
    if (!result.success) {
      throw new Error(result.error || 'MCP tool execution failed');
    }

    return result.content;
  }
}

@Injectable()
export class McpHostService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new LoggerService(McpHostService.name);

  private readonly activeSessions = new Map<string, McpSession>();

  private serversConfig: McpServersConfig | null = null;

  constructor(private readonly toolRegistry: ToolRegistry) {}

  async onModuleInit() {
    await this.loadConfiguration();
    await this.initializeEnabledServers();
  }

  async onModuleDestroy() {
    await this.disconnectAllServers();
  }

  /**
   * Load MCP servers configuration from file
   */
  private async loadConfiguration(): Promise<void> {
    try {
      // In production, this would be a proper config service
      const configPath = path.resolve(__dirname, '../../../config/mcp-servers.json');
      const configContent = await fs.readFile(configPath, 'utf-8');
      this.serversConfig = JSON.parse(configContent) as McpServersConfig;
      this.logger.log('Loaded MCP servers configuration', {
        serverCount: Object.keys(this.serversConfig?.servers || {}).length,
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
      // Resolve environment variables
      const resolvedEnv = this.resolveEnvironmentVariables(config.env || {});

      // Create transport using SDK
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: {
          ...(Object.fromEntries(
            Object.entries(process.env).filter(([, value]) => value !== undefined),
          ) as Record<string, string>),
          ...resolvedEnv,
        },
        ...(config.workingDirectory && { cwd: config.workingDirectory }),
      });

      // Create client using SDK
      const client = new Client(
        {
          name: 'ci-server',
          version: '1.0.0',
        },
        {
          capabilities: {},
        },
      );

      // Connect to the server
      await client.connect(transport);

      // Update session
      session.client = client;
      session.status = 'connected';

      // Discover tools and register them
      await this.discoverAndRegisterTools(serverName, client);

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
        await session.client.close();
      }

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

  /**
   * Get active sessions
   */
  getActiveSessions(): McpSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Get all available tools from active MCP servers
   */
  async getAvailableTools(): Promise<ToolSchema[]> {
    const allTools: ToolSchema[] = [];

    for (const [serverName, session] of this.activeSessions) {
      if (session.status !== 'connected' || !session.client) {
        continue;
      }

      try {
        const { tools } = await session.client.listTools();

        const prefixedTools = tools.map((tool) => ({
          name: `${serverName}:${tool.name}`,
          description: `[${serverName}] ${tool.description || ''}`,
          parameters: (tool.inputSchema as ToolSchema['parameters']) || { type: 'object' },
          category: 'mcp',
          examples: [],
        }));

        allTools.push(...prefixedTools);
      } catch (error) {
        this.logger.error(`Failed to list tools from ${serverName}`, error as Error);
      }
    }

    return allTools;
  }

  /**
   * Execute a tool on an MCP server
   */
  async executeServerTool(toolName: string, args: unknown): Promise<McpToolResult> {
    const [serverName, actualToolName] = toolName.split(':', 2);

    if (!actualToolName) {
      return {
        success: false,
        error: 'Invalid tool name format. Expected "server:tool"',
      };
    }

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
        name: actualToolName,
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
   * Discover tools from a server and register them in the tool registry
   */
  private async discoverAndRegisterTools(serverName: string, client: Client): Promise<void> {
    try {
      const { tools } = await client.listTools();

      for (const tool of tools) {
        const prefixedName = `${serverName}:${tool.name}`;

        // Create a tool schema for the registry
        const toolSchema: ToolSchema = {
          name: prefixedName,
          description: `[${serverName}] ${tool.description || ''}`,
          parameters: (tool.inputSchema as ToolSchema['parameters']) || { type: 'object' },
          category: 'mcp',
        };

        // Create and register the tool wrapper
        const toolWrapper = new McpToolWrapper(toolSchema, this, prefixedName);
        this.toolRegistry.register(toolWrapper);
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
    // Note: This would require extending ToolRegistry to support unregistration
    // For now, we'll log and continue
    this.logger.log(`Unregistering tools from ${serverName}`, { serverName });
  }

  /**
   * Get server configuration by name
   */
  private getServerConfig(serverName: string): McpServerConfig | null {
    return this.serversConfig?.servers[serverName] || null;
  }

  /**
   * Resolve environment variables in config values
   */
  private resolveEnvironmentVariables(env: Record<string, string>): Record<string, string> {
    const resolved: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
      // Simple variable substitution: ${VAR_NAME}
      const resolvedValue = value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
        return process.env[varName] || '';
      });
      resolved[key] = resolvedValue;
    }

    return resolved;
  }
}

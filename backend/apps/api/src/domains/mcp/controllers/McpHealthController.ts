import { Controller, Get, Param } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import { McpHostService } from '../services/McpHostService';
import type { McpHealthStatus, McpSession } from '../types/mcp-config';

@Controller('mcp')
export class McpHealthController {
  private readonly logger = new LoggerService(McpHealthController.name);

  constructor(private readonly mcpHostService: McpHostService) {}

  /**
   * Get health status for all MCP servers
   */
  @Get('health')
  async getHealthStatus(): Promise<McpHealthStatus[]> {
    this.logger.debug('Fetching health status for all MCP servers');

    try {
      const healthStatuses = await this.mcpHostService.getHealthStatus();

      this.logger.debug(`Retrieved health status for ${healthStatuses.length} servers`, {
        serverCount: healthStatuses.length,
        healthyCount: healthStatuses.filter((s) => s.status === 'healthy').length,
        unhealthyCount: healthStatuses.filter((s) => s.status === 'unhealthy').length,
      });

      return healthStatuses;
    } catch (error) {
      this.logger.error(
        'Failed to fetch health status',
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  /**
   * Get health status for a specific MCP server
   */
  @Get('health/:serverName')
  async getServerHealthStatus(@Param('serverName') serverName: string): Promise<McpHealthStatus | null> {
    this.logger.debug(`Fetching health status for server: ${serverName}`, { serverName });

    try {
      const healthStatus = await this.mcpHostService.getServerHealthStatus(serverName);

      if (!healthStatus) {
        this.logger.warn(`Server not found: ${serverName}`, { serverName });

        return null;
      }

      this.logger.debug(`Retrieved health status for ${serverName}`, {
        serverName,
        status: healthStatus.status,
        consecutiveFailures: healthStatus.consecutiveFailures,
      });

      return healthStatus;
    } catch (error) {
      this.logger.error(`Failed to fetch health status for ${serverName}`, {
        serverName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get active MCP sessions
   */
  @Get('sessions')
  getActiveSessions(): McpSession[] {
    this.logger.debug('Fetching active MCP sessions');

    const sessions = this.mcpHostService.getActiveSessions();

    this.logger.debug(`Retrieved ${sessions.length} active sessions`, {
      sessionCount: sessions.length,
      connectedCount: sessions.filter((s) => s.status === 'connected').length,
    });

    return sessions;
  }

  /**
   * Get available MCP servers (configured)
   */
  @Get('servers')
  getAvailableServers() {
    this.logger.debug('Fetching available MCP servers');

    const servers = this.mcpHostService.getAvailableServers();

    this.logger.debug(`Retrieved ${servers.length} configured servers`, {
      serverCount: servers.length,
      enabledCount: servers.filter((s) => s.enabled).length,
    });

    return servers;
  }

  /**
   * Get available tools from all MCP servers
   */
  @Get('tools')
  async getAvailableTools() {
    this.logger.debug('Fetching available MCP tools');

    try {
      const tools = await this.mcpHostService.getAvailableTools();

      this.logger.debug(`Retrieved ${tools.length} available tools`, {
        toolCount: tools.length,
        serverBreakdown: tools.reduce(
          (acc, tool) => {
            const serverName = tool.name.split(':')[0];
            acc[serverName] = (acc[serverName] || 0) + 1;

            return acc;
          },
          {} as Record<string, number>,
        ),
      });

      return tools;
    } catch (error) {
      this.logger.error(
        'Failed to fetch available tools',
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }
}

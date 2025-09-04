import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';
import { EventService, Events, EventPayloads, OnEvent } from '@ci/domains/events';

import { McpHostService } from '../services/McpHostService';

const executeToolSchema = z.object({
  toolName: z.string(),
  arguments: z.unknown(),
});

const queueToolSchema = z.object({
  toolName: z.string(),
  arguments: z.unknown(),
});

@Controller('mcp')
export class McpController {
  private readonly logger = new LoggerService(McpController.name);

  constructor(
    private readonly mcpHostService: McpHostService,
    private readonly eventService: EventService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get('servers')
  async getServers() {
    return this.mcpHostService.getAvailableServers();
  }

  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  async getSessions() {
    return this.mcpHostService.getActiveSessions();
  }

  @UseGuards(JwtAuthGuard)
  @Post('servers/:name/start')
  async startServer(@Param('name') name: string) {
    await this.mcpHostService.startServer(name);

    return { success: true, message: `Server ${name} started successfully` };
  }

  @UseGuards(JwtAuthGuard)
  @Post('servers/:name/stop')
  async stopServer(@Param('name') name: string) {
    await this.mcpHostService.stopServer(name);

    return { success: true, message: `Server ${name} stopped successfully` };
  }

  @UseGuards(JwtAuthGuard)
  @Get('tools')
  async getAvailableTools() {
    return this.mcpHostService.getAvailableTools();
  }

  @UseGuards(JwtAuthGuard)
  @Post('execute')
  @HttpCode(200)
  async executeTool(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(executeToolSchema)) input: { toolName: string; arguments: unknown },
  ) {
    const result = await this.mcpHostService.executeServerTool(input.toolName, input.arguments);

    return result;
  }

  @UseGuards(JwtAuthGuard)
  @Post('queue')
  @HttpCode(200)
  async queueTool(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(queueToolSchema)) input: { toolName: string; arguments: unknown },
  ) {
    // Queue the MCP tool call for asynchronous execution
    const jobId = await this.eventService.send(Events.MCP_TOOL_CALL, {
      userId: context.userId!,
      toolName: input.toolName,
      arguments: input.arguments,
    });

    return {
      success: true,
      jobId,
      message: 'MCP tool call queued for execution',
    };
  }

  @OnEvent(Events.MCP_TOOL_CALL)
  async handleMcpToolCall(payload: EventPayloads[Events.MCP_TOOL_CALL]) {
    this.logger.log('Processing queued MCP tool call', {
      userId: payload.userId,
      toolName: payload.toolName,
    });

    try {
      const result = await this.mcpHostService.executeServerTool(payload.toolName, payload.arguments);

      this.logger.log('MCP tool call completed', {
        userId: payload.userId,
        toolName: payload.toolName,
        success: result.success,
        executionTimeMs: result.executionTimeMs,
      });

      // Could store results or emit completion events here
    } catch (error) {
      this.logger.error('MCP tool call failed', {
        userId: payload.userId,
        toolName: payload.toolName,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

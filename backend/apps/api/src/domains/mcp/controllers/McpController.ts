import { Controller, Get, Post, Body } from '@nestjs/common';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { ValidationPipe } from '@ci/common/pipes';
import type { RequestContext } from '@ci/common/types';
import { OnEvent, Events, type EventPayloads } from '@ci/domains/events';

import { McpService } from '../services/McpService';
import type { McpTool, McpToolCall, McpCallRequest } from '../types';

// Validation schemas
const mcpToolCallSchema = z.object({
  name: z.string().min(1, 'Tool name is required'),
  arguments: z.record(z.unknown()).default({}),
});

const mcpCallRequestSchema = z.object({
  toolName: z.string().min(1, 'Tool name is required'),
  arguments: z.record(z.unknown()).default({}),
  requestId: z.string().optional(),
});

/**
 * MCP (Model Context Protocol) Controller
 * Provides REST API endpoints for MCP functionality
 */
@Controller('mcp')
export class McpController {
  constructor(private mcpService: McpService) {}

  /**
   * Get all available MCP tools
   * GET /mcp/tools
   */
  @Get('tools')
  async getTools(@Context() context: RequestContext): Promise<McpTool[]> {
    return await this.mcpService.getAvailableTools(context);
  }

  /**
   * Execute an MCP tool call synchronously
   * POST /mcp/execute
   */
  @Post('execute')
  async executeTool(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(mcpToolCallSchema)) toolCall: McpToolCall,
  ) {
    return await this.mcpService.executeTool(context, toolCall);
  }

  /**
   * Queue an MCP tool call for asynchronous processing
   * POST /mcp/queue
   */
  @Post('queue')
  async queueTool(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(mcpCallRequestSchema)) request: McpCallRequest,
  ) {
    // Ensure userId is set from context - throw error if not authenticated
    if (!context.userId) {
      throw new Error('User authentication required');
    }

    const mcpRequest: McpCallRequest = {
      ...request,
      userId: context.userId,
    };

    return await this.mcpService.queueToolCall(context, mcpRequest);
  }

  /**
   * Handle queued MCP tool calls
   */
  @OnEvent(Events.MCP_CALL)
  async handleMcpCallEvent(payload: EventPayloads[Events.MCP_CALL]) {
    await this.mcpService.handleQueuedCall(payload);
  }
}

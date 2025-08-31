import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';
import { EventService, Events, type EventPayloads } from '@ci/domains/events';
import { ToolRegistry } from '@ci/domains/llm/tools';

import type { McpTool, McpToolCall, McpToolResult, McpCallRequest, McpCallResponse } from '../types';

/**
 * MCP (Model Context Protocol) Service
 * Handles MCP tool registration, execution, and queueing
 */
@Injectable()
export class McpService {
  private logger = new LoggerService(McpService.name);

  constructor(
    private toolRegistry: ToolRegistry,
    private eventService: EventService,
  ) {}

  /**
   * Get all available MCP tools
   */
  async getAvailableTools(context: RequestContext): Promise<McpTool[]> {
    this.logger.debug('Retrieving available MCP tools', {
      userId: context.userId,
    });

    const toolSchemas = this.toolRegistry.getAvailableTools(context);

    const mcpTools: McpTool[] = toolSchemas.map((schema) => ({
      name: schema.name,
      description: schema.description,
      inputSchema: schema.parameters as unknown as Record<string, unknown>,
    }));

    this.logger.debug(`Found ${mcpTools.length} MCP tools`, {
      userId: context.userId,
      toolNames: mcpTools.map((t) => t.name),
    });

    return mcpTools;
  }

  /**
   * Execute an MCP tool call synchronously
   */
  async executeTool(context: RequestContext, toolCall: McpToolCall): Promise<McpToolResult> {
    const startTime = Date.now();

    this.logger.log('Executing MCP tool call', {
      toolName: toolCall.name,
      userId: context.userId,
    });

    try {
      const result = await this.toolRegistry.executeTool(toolCall.name, context, toolCall.arguments);

      const executionTimeMs = Date.now() - startTime;

      if (result.success) {
        this.logger.debug('MCP tool execution completed successfully', {
          toolName: toolCall.name,
          userId: context.userId,
          executionTimeMs,
        });

        return {
          success: true,
          content: result.data,
          executionTimeMs,
        };
      } else {
        this.logger.warn('MCP tool execution failed', {
          toolName: toolCall.name,
          userId: context.userId,
          error: result.error?.message,
          executionTimeMs,
        });

        return {
          success: false,
          error: result.error?.message || 'Tool execution failed',
          executionTimeMs,
        };
      }
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;

      this.logger.error('MCP tool execution threw an error', {
        error: error as Error,
        toolName: toolCall.name,
        userId: context.userId,
        executionTimeMs,
      });

      return {
        success: false,
        error: (error as Error).message || 'Unknown error occurred',
        executionTimeMs,
      };
    }
  }

  /**
   * Queue an MCP tool call for asynchronous execution
   */
  async queueToolCall(context: RequestContext, request: McpCallRequest): Promise<McpCallResponse> {
    const requestId = request.requestId || uuidv4();

    // Ensure we have a userId for the request
    if (!request.userId) {
      return {
        success: false,
        error: 'User ID is required for MCP tool calls',
        requestId,
      };
    }

    this.logger.log('Queueing MCP tool call', {
      toolName: request.toolName,
      userId: context.userId,
      requestId,
    });

    try {
      // Validate that the tool exists
      if (!this.toolRegistry.hasTool(request.toolName)) {
        const error = `Tool '${request.toolName}' not found`;
        this.logger.warn('Attempted to queue unknown MCP tool', {
          toolName: request.toolName,
          userId: context.userId,
          requestId,
        });

        return {
          success: false,
          error,
          requestId,
        };
      }

      const eventPayload: EventPayloads[Events.MCP_CALL] = {
        toolName: request.toolName,
        arguments: request.arguments,
        userId: request.userId,
        requestId,
      };

      const jobId = await this.eventService.send(Events.MCP_CALL, eventPayload);

      if (jobId) {
        this.logger.debug('MCP tool call queued successfully', {
          toolName: request.toolName,
          userId: context.userId,
          requestId,
          jobId,
        });

        return {
          success: true,
          requestId,
        };
      } else {
        const error = 'Failed to queue MCP tool call';
        this.logger.error(error, {
          toolName: request.toolName,
          userId: context.userId,
          requestId,
        });

        return {
          success: false,
          error,
          requestId,
        };
      }
    } catch (error) {
      this.logger.error('Error queueing MCP tool call', {
        error: error as Error,
        toolName: request.toolName,
        userId: context.userId,
        requestId,
      });

      return {
        success: false,
        error: (error as Error).message || 'Unknown error occurred',
        requestId,
      };
    }
  }

  /**
   * Handle queued MCP tool calls (called by event handler)
   */
  async handleQueuedCall(payload: EventPayloads[Events.MCP_CALL]): Promise<void> {
    const { toolName, arguments: args, userId, requestId } = payload;

    this.logger.log('Processing queued MCP tool call', {
      toolName,
      userId,
      requestId,
    });

    const context: RequestContext = { userId };

    const toolCall: McpToolCall = {
      name: toolName,
      arguments: args,
    };

    try {
      const result = await this.executeTool(context, toolCall);

      this.logger.debug('Queued MCP tool call completed', {
        toolName,
        userId,
        requestId,
        success: result.success,
        executionTimeMs: result.executionTimeMs,
      });

      // Here you could emit another event with the result if needed
      // or store the result in a database for later retrieval
    } catch (error) {
      this.logger.error('Error processing queued MCP tool call', {
        error: error as Error,
        toolName,
        userId,
        requestId,
      });
    }
  }
}

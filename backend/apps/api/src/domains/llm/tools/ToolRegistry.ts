import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';

import { BaseTool } from './BaseTool';
import { GetUserPreferencesTool } from './GetUserPreferencesTool';
import { GetEntertainmentPreferencesTool } from './GetEntertainmentPreferencesTool';
import { GetStreamingAvailabilityTool } from './GetStreamingAvailabilityTool';
import type { ToolSchema, ToolResult } from './types';

/**
 * Registry for managing and executing tools
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new LoggerService(ToolRegistry.name);

  private readonly tools = new Map<string, BaseTool>();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    this.initializeTools();
  }

  /**
   * Initialize all available tools
   */
  private initializeTools(): void {
    const getUserPreferencesTool = new GetUserPreferencesTool(this.dataSource);
    const getEntertainmentPreferencesTool = new GetEntertainmentPreferencesTool(this.dataSource);
    const getStreamingAvailabilityTool = new GetStreamingAvailabilityTool();
    // const getFamilyMembersTool = new GetFamilyMembersTool(this.dataSource); // Disabled for demo

    this.register(getUserPreferencesTool);
    this.register(getEntertainmentPreferencesTool);
    this.register(getStreamingAvailabilityTool);
    // this.register(getFamilyMembersTool); // Disabled for demo

    this.logger.debug('Initialized tools registry', {
      toolCount: this.getRegisteredToolNames().length,
      tools: this.getRegisteredToolNames(),
    });
  }

  /**
   * Register a tool instance
   */
  register(tool: BaseTool): void {
    const { name } = tool.schema;

    if (this.tools.has(name)) {
      throw new Error(`Tool '${name}' is already registered`);
    }

    this.tools.set(name, tool);
    this.logger.debug(`Registered tool: ${name}`, {
      toolName: name,
      category: tool.schema.category,
    });
  }

  /**
   * Get all available tool schemas (for LLM function calling)
   */
  getAvailableTools(context?: RequestContext): ToolSchema[] {
    const schemas = Array.from(this.tools.values()).map((tool) => tool.schema);

    this.logger.debug(`Retrieved ${schemas.length} available tools`, {
      userId: context?.userId,
      toolNames: schemas.map((s) => s.name),
    });

    return schemas;
  }

  /**
   * Check if a tool exists
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Execute a tool by name
   */
  async executeTool(name: string, context: RequestContext, input: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      this.logger.warn(`Attempted to execute unknown tool: ${name}`, {
        toolName: name,
        userId: context.userId,
        availableTools: Array.from(this.tools.keys()),
      });

      return {
        success: false,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: `Tool '${name}' not found`,
          retryable: false,
        },
      };
    }

    this.logger.log(`Executing tool: ${name}`, {
      toolName: name,
      userId: context.userId,
    });

    return await tool.execute(context, input);
  }

  /**
   * Get tool by name (for testing/debugging)
   */
  getTool(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  /**
   * List all registered tool names
   */
  getRegisteredToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}

import { Controller, Get, Post, Param, Body } from '@nestjs/common';

import type { RequestContext } from '@ci/common/types';

import type { ToolSchema, ToolResult } from '../core/types';
import { ToolRegistry } from '../registry/ToolRegistry';

@Controller('tools')
export class ToolsController {
  constructor(private readonly toolRegistry: ToolRegistry) {}

  @Get('/')
  getAvailableTools(): ToolSchema[] {
    return this.toolRegistry.getAvailableTools();
  }

  @Get('/names')
  getToolNames(): string[] {
    return this.toolRegistry.getRegisteredToolNames();
  }

  @Get('/providers/:providerName')
  getToolsByProvider(@Param('providerName') providerName: string): ToolSchema[] {
    return this.toolRegistry.getToolsByProvider(providerName);
  }

  @Post('/execute/:toolName')
  async executeTool(
    @Param('toolName') toolName: string,
    @Body() body: { input: unknown; context: RequestContext },
  ): Promise<ToolResult> {
    return await this.toolRegistry.executeTool(toolName, body.context, body.input);
  }

  @Get('/health')
  async getProvidersHealth() {
    return await this.toolRegistry.getProvidersHealthStatus();
  }
}

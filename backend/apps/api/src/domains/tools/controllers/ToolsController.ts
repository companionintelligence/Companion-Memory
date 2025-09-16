import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import type { RequestContext } from '@ci/common/types';

import type { ToolSchema, ToolResult } from '../core/types';
import { ToolRegistry } from '../registry/ToolRegistry';

@Controller('tools')
export class ToolsController {
  constructor(private readonly toolRegistry: ToolRegistry) {}

  @UseGuards(JwtAuthGuard)
  @Get('/')
  getAvailableTools(@Context() context: RequestContext): ToolSchema[] {
    return this.toolRegistry.getAvailableTools(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get('/names')
  getToolNames(): string[] {
    return this.toolRegistry.getRegisteredToolNames();
  }

  @UseGuards(JwtAuthGuard)
  @Get('/providers/:providerName')
  getToolsByProvider(
    @Context() context: RequestContext,
    @Param('providerName') providerName: string,
  ): ToolSchema[] {
    return this.toolRegistry.getToolsByProvider(providerName);
  }

  @UseGuards(JwtAuthGuard)
  @Post('/execute/:toolName')
  async executeTool(
    @Context() context: RequestContext,
    @Param('toolName') toolName: string,
    @Body() body: { input: unknown },
  ): Promise<ToolResult> {
    return await this.toolRegistry.executeTool(toolName, context, body.input);
  }

  @UseGuards(JwtAuthGuard)
  @Get('/health')
  async getProvidersHealth() {
    return await this.toolRegistry.getProvidersHealthStatus();
  }
}

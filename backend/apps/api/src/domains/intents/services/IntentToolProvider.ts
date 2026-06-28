import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import {
  type BaseTool,
  type ProviderHealthStatus,
  ToolRegistry,
  type ToolProvider,
  type ToolSchema,
} from '@ci/domains/tools';

import { IntentRegistry } from './IntentRegistry';
import { IntentTool } from './IntentTool';

/**
 * Exposes the curated CI Intent catalog as a {@link ToolProvider}. Because it
 * plugs into the same {@link ToolRegistry} the native tools use, every intent
 * automatically becomes available to the local LLM (function-calling) AND the MCP
 * server (`McpToolService` consolidates the registry) — one registration, two
 * surfaces, plus the external manifest. This is the seam that lets CI-Hermes and
 * CI-OpenClaw consume one typed catalog instead of bespoke per-harness glue.
 */
@Injectable()
export class IntentToolProvider implements ToolProvider {
  readonly name = 'intents';

  private readonly tools = new Map<string, BaseTool>();

  private isInitialized = false;

  constructor(
    private readonly intentRegistry: IntentRegistry,
    private readonly toolRegistry: ToolRegistry,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(IntentToolProvider.name);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    for (const intent of this.intentRegistry.getIntents()) {
      const tool = new IntentTool(intent, this.toolRegistry, this.logger);
      this.tools.set(tool.schema.name, tool);
    }

    this.isInitialized = true;

    this.logger.debug(`Initialized intent provider with ${this.tools.size} intents`, {
      toolNames: Array.from(this.tools.keys()),
    });
  }

  async shutdown(): Promise<void> {
    this.tools.clear();
    this.isInitialized = false;
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
    return {
      name: this.name,
      status: this.isInitialized ? 'healthy' : 'unknown',
      toolCount: this.tools.size,
      lastCheck: new Date(),
    };
  }
}

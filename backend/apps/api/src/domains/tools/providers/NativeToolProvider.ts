import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { BaseTool } from '../core/BaseTool';
import type { ToolSchema } from '../core/types';

import type { ToolProvider, ProviderHealthStatus } from './ToolProvider';

/**
 * Provider for native (built-in) tools
 */
@Injectable()
export class NativeToolProvider implements ToolProvider {
  readonly name = 'native';

  private readonly tools = new Map<string, BaseTool>();

  private isInitialized = false;

  constructor(
    private readonly nativeTools: BaseTool[],
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(NativeToolProvider.name);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    for (const tool of this.nativeTools) {
      this.tools.set(tool.schema.name, tool);
    }

    this.isInitialized = true;

    this.logger.debug(`Initialized native tool provider with ${this.tools.size} tools`, {
      toolNames: Array.from(this.tools.keys()),
    });
  }

  async shutdown(): Promise<void> {
    this.tools.clear();
    this.isInitialized = false;
    this.logger.debug('Native tool provider shut down');
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

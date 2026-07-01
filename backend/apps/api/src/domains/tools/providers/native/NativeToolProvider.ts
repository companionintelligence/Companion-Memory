import { Injectable, type OnModuleInit } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import type { BaseTool } from '../../core/BaseTool';
import { ToolRegistry } from '../../registry/ToolRegistry';
import type { ToolProvider, ProviderHealthStatus } from '../ToolProvider';

/**
 * Provider for native (built-in) tools. Self-registers with the shared
 * {@link ToolRegistry} at boot — no separate registration service needed.
 */
@Injectable()
export class NativeToolProvider implements ToolProvider, OnModuleInit {
  readonly name = 'native';

  private readonly tools = new Map<string, BaseTool>();

  private isInitialized = false;

  constructor(
    private readonly nativeTools: BaseTool[],
    private readonly logger: LoggerService,
    private readonly toolRegistry: ToolRegistry,
  ) {
    this.logger.setContext(NativeToolProvider.name);
  }

  async onModuleInit(): Promise<void> {
    await this.toolRegistry.registerProvider(this);
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

  getTools(): BaseTool[] {
    return Array.from(this.tools.values());
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

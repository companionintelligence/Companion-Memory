import { Injectable, OnModuleInit } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import { McpToolProvider } from '../providers/mcp/McpToolProvider';
import { NativeToolProvider } from '../providers/native/NativeToolProvider';
import { ToolRegistry } from '../registry/ToolRegistry';

/**
 * Service responsible for registering all tool providers with the ToolRegistry
 */
@Injectable()
export class ToolsRegistrationService implements OnModuleInit {
  private readonly logger = new LoggerService(ToolsRegistrationService.name);

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly nativeProvider: NativeToolProvider,
    private readonly mcpProvider: McpToolProvider,
  ) {}

  async onModuleInit() {
    this.logger.log('Registering tool providers');

    try {
      await this.toolRegistry.registerProvider(this.nativeProvider);
      await this.toolRegistry.registerProvider(this.mcpProvider);

      this.logger.log('Successfully registered all tool providers');
    } catch (error) {
      this.logger.error('Failed to register tool providers', error as Error);
      throw error;
    }
  }
}

import { Injectable, type OnModuleInit } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { ToolRegistry } from '@ci/domains/tools';

import { IntentToolProvider } from './IntentToolProvider';

/**
 * Registers the {@link IntentToolProvider} with the shared {@link ToolRegistry} at
 * boot. The native-tool provider is registered by ToolsModule's own
 * registration service; this adds the curated intent layer on top.
 *
 * Ordering note: `McpToolService` consolidates the registry in its own
 * `onModuleInit`. To guarantee intents are present before that runs, McpModule
 * imports IntentsModule — Nest initialises imported modules first.
 */
@Injectable()
export class IntentsRegistrationService implements OnModuleInit {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly intentProvider: IntentToolProvider,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(IntentsRegistrationService.name);
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.toolRegistry.registerProvider(this.intentProvider);
      this.logger.debug('Registered intent tool provider');
    } catch (error) {
      this.logger.error('Failed to register intent tool provider', error as Error);
      throw error;
    }
  }
}

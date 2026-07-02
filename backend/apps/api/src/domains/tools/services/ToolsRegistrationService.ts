import { Injectable, OnModuleInit } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';

import { isIntentDomain } from '../catalog/domains';
import { NativeToolProvider } from '../providers/NativeToolProvider';
import { ToolRegistry } from '../registry/ToolRegistry';

/**
 * Service responsible for registering all tool providers with the ToolRegistry
 */
@Injectable()
export class ToolsRegistrationService implements OnModuleInit {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly nativeProvider: NativeToolProvider,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ToolsRegistrationService.name);
  }

  async onModuleInit() {
    this.logger.debug('Registering tool providers');

    try {
      await this.toolRegistry.registerProvider(this.nativeProvider);
      this.validateDomains();

      this.logger.debug('Successfully registered all tool providers');
    } catch (error) {
      this.logger.error('Failed to register tool providers', error as Error);
      throw error;
    }
  }

  /**
   * Fail fast if a tool declares an unregistered schema domain. Runs here, right after the tools
   * are loaded, so the check sees the full registry (rather than racing module-init order).
   */
  private validateDomains(): void {
    for (const schema of this.toolRegistry.getAvailableTools()) {
      if (!isIntentDomain(schema.domain)) {
        throw new Error(`Tool ${schema.name} references unknown domain "${schema.domain}"`);
      }
    }
  }
}

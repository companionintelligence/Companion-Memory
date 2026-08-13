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
      this.validateLocalCapability();

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

  /**
   * Fail fast on an incoherent local-capability claim, and record the split at boot.
   *
   * The type already forces every tool to state `localCapable`, so the missing-label case cannot
   * reach here. What the compiler cannot catch is the *contradiction*: an intent that reaches a
   * third-party service (`privacy.external`) cannot also be servable from on-device data, and a
   * tool claiming both would publish a manifest promising an offline answer that can only ever
   * fail — quietly, on a device, offline, where nobody is watching a log.
   *
   * A wrong-but-coherent label (a genuinely server-only intent marked local) is still only
   * catchable by review; that is what the per-tool rationale comments are for.
   */
  private validateLocalCapability(): void {
    const schemas = this.toolRegistry.getAvailableTools();

    for (const schema of schemas) {
      if (schema.localCapable && schema.privacy.external) {
        throw new Error(
          `Tool ${schema.name} is marked localCapable but its privacy label says it is external — ` +
            'an intent that calls a third-party service cannot be served from on-device data',
        );
      }
    }

    this.logger.debug('Validated intent local-capability labels', {
      total: schemas.length,
      localCapable: schemas.filter((schema) => schema.localCapable).map((schema) => schema.name),
    });
  }
}

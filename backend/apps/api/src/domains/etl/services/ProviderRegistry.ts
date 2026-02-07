import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import type { ServiceContext } from '@ci/common/context';

import { ProviderConfigEntity } from '../entities/ProviderConfigEntity';
import type { ProviderConfig } from '../types/provider';

/**
 * ProviderRegistry manages provider configurations.
 * It loads provider configs from database and provides methods to access them.
 */
@Injectable()
export class ProviderRegistry {
  private configCache = new Map<string, ProviderConfig>();
  private cacheInitialized = false;

  constructor(
    @InjectRepository(ProviderConfigEntity)
    private readonly providerConfigRepository: Repository<ProviderConfigEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ProviderRegistry.name);
  }

  /**
   * Get provider configuration by ID
   */
  async getProvider(context: ServiceContext, providerId: string): Promise<ProviderConfig | null> {
    await this.ensureCacheInitialized();
    return this.configCache.get(providerId) ?? null;
  }

  /**
   * Get all enabled provider configurations
   */
  async getAllProviders(context: ServiceContext): Promise<ProviderConfig[]> {
    await this.ensureCacheInitialized();
    return Array.from(this.configCache.values()).filter((config) => config.enabled);
  }

  /**
   * Reload provider configurations from database
   */
  async reloadConfigs(): Promise<void> {
    this.logger.log('Reloading provider configurations');
    const entities = await this.providerConfigRepository.find({
      where: { enabled: true },
    });

    this.configCache.clear();
    for (const entity of entities) {
      const config = ProviderConfigEntity.toEgressType(entity);
      this.configCache.set(config.id, config);
    }

    this.cacheInitialized = true;
    this.logger.log(`Loaded ${this.configCache.size} provider configurations`);
  }

  /**
   * Validate provider configuration
   */
  validateConfig(config: ProviderConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config.name) {
      errors.push('Provider name is required');
    }

    if (!config.apiSpecId) {
      errors.push('API spec ID is required');
    }

    if (!config.sources || config.sources.length === 0) {
      errors.push('At least one source is required');
    }

    if (!config.auth || !config.auth.type) {
      errors.push('Auth configuration is required');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private async ensureCacheInitialized(): Promise<void> {
    if (!this.cacheInitialized) {
      await this.reloadConfigs();
    }
  }
}

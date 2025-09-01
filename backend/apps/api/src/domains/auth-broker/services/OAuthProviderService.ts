import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/services';

import { OAuthProviderEntity } from '../entities/OAuthProviderEntity';
import type { OAuthProvider, SupportedProvider } from '../types';

@Injectable()
export class OAuthProviderService {
  private logger = new LoggerService(OAuthProviderService.name);

  constructor(
    @InjectRepository(OAuthProviderEntity)
    private readonly oauthProviderRepository: Repository<OAuthProviderEntity>,
  ) {}

  async findAll(): Promise<OAuthProviderEntity[]> {
    return this.oauthProviderRepository.find({
      where: { active: true },
      order: { name: 'ASC' },
    });
  }

  async findById(id: string): Promise<OAuthProviderEntity | null> {
    return this.oauthProviderRepository.findOne({
      where: { id, active: true },
    });
  }

  async findByName(name: string): Promise<OAuthProviderEntity | null> {
    return this.oauthProviderRepository.findOne({
      where: { name, active: true },
    });
  }

  async getSupportedProviders(): Promise<SupportedProvider[]> {
    const providers = await this.findAll();
    
    return providers.map(provider => ({
      id: provider.id,
      name: provider.name,
      displayName: provider.displayName,
      scopes: provider.scopes,
      logoUrl: provider.logoUrl,
      description: provider.description,
    }));
  }

  async createProvider(providerData: Omit<OAuthProvider, 'active'>): Promise<OAuthProviderEntity> {
    const provider = this.oauthProviderRepository.create({
      ...providerData,
      active: true,
    });

    const savedProvider = await this.oauthProviderRepository.save(provider);
    this.logger.log('OAuth provider created', { providerId: savedProvider.id, name: savedProvider.name });
    
    return savedProvider;
  }

  async updateProvider(id: string, updates: Partial<OAuthProvider>): Promise<OAuthProviderEntity | null> {
    const provider = await this.findById(id);
    if (!provider) {
      return null;
    }

    Object.assign(provider, updates);
    const updatedProvider = await this.oauthProviderRepository.save(provider);
    
    this.logger.log('OAuth provider updated', { providerId: id });
    return updatedProvider;
  }

  async deactivateProvider(id: string): Promise<boolean> {
    const result = await this.oauthProviderRepository.update(id, { active: false });
    
    if (result.affected && result.affected > 0) {
      this.logger.log('OAuth provider deactivated', { providerId: id });
      return true;
    }
    
    return false;
  }
}
/**
 * Provider Registry Integration Tests
 * 
 * Tests provider configuration loading, caching, and validation
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { createMockLogger } from '@ci/test/mocks';

import { ProviderRegistry } from '../../services/ProviderRegistry';
import { ProviderConfigEntity } from '../../entities/ProviderConfigEntity';
import type { ProviderConfig } from '../../types/provider';

describe('ProviderRegistry Integration Tests', () => {
  let providerRegistry: ProviderRegistry;
  let providerConfigRepository: jest.Mocked<Repository<ProviderConfigEntity>>;
  let module: TestingModule;

  beforeEach(async () => {
    const mockRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    };

    module = await Test.createTestingModule({
      providers: [
        ProviderRegistry,
        {
          provide: getRepositoryToken(ProviderConfigEntity),
          useValue: mockRepository,
        },
        {
          provide: LoggerService,
          useValue: createMockLogger(),
        },
      ],
    }).compile();

    providerRegistry = module.get<ProviderRegistry>(ProviderRegistry);
    providerConfigRepository = module.get(getRepositoryToken(ProviderConfigEntity));
  });

  afterEach(async () => {
    await module.close();
  });

  describe('getProvider', () => {
    it('should load provider configuration', async () => {
      const mockConfig: Partial<ProviderConfigEntity> = {
        id: 'google',
        name: 'Google',
        enabled: true,
        sources: [
          {
            name: 'Gmail',
            description: 'Email',
            enabledByDefault: true,
            endpoints: ['GmailMessages'],
            scopes: ['gmail.readonly'],
            transformMap: 'google_gmail_to_communication',
          },
        ],
      };

      providerConfigRepository.find.mockResolvedValue([mockConfig as ProviderConfigEntity]);

      const context = { userId: 'test-user' } as any;
      const provider = await providerRegistry.getProvider(context, 'google');

      expect(provider).toBeDefined();
      expect(provider?.id).toBe('google');
      expect(provider?.name).toBe('Google');
    });

    it('should return null for non-existent provider', async () => {
      providerConfigRepository.find.mockResolvedValue([]);

      const context = { userId: 'test-user' } as any;
      const provider = await providerRegistry.getProvider(context, 'nonexistent');

      expect(provider).toBeNull();
    });

    it('should cache provider configurations', async () => {
      const mockConfig: Partial<ProviderConfigEntity> = {
        id: 'google',
        name: 'Google',
        enabled: true,
        sources: [],
      };

      providerConfigRepository.find.mockResolvedValue([mockConfig as ProviderConfigEntity]);

      const context = { userId: 'test-user' } as any;
      
      // First call
      await providerRegistry.getProvider(context, 'google');
      
      // Second call - should use cache
      await providerRegistry.getProvider(context, 'google');

      // Repository should only be called once during initialization
      expect(providerConfigRepository.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAllProviders', () => {
    it('should return all enabled providers', async () => {
      const mockConfigs: Partial<ProviderConfigEntity>[] = [
        { id: 'google', name: 'Google', enabled: true, sources: [] },
        { id: 'microsoft', name: 'Microsoft', enabled: true, sources: [] },
      ];

      providerConfigRepository.find.mockResolvedValue(mockConfigs as ProviderConfigEntity[]);

      const context = { userId: 'test-user' } as any;
      const providers = await providerRegistry.getAllProviders(context);

      expect(providers.length).toBe(2);
      expect(providers.map((p) => p.id)).toEqual(['google', 'microsoft']);
    });

    it('should filter out disabled providers', async () => {
      const mockConfigs: Partial<ProviderConfigEntity>[] = [
        { id: 'google', name: 'Google', enabled: true, sources: [] },
        { id: 'disabled', name: 'Disabled', enabled: false, sources: [] },
      ];

      providerConfigRepository.find.mockResolvedValue([mockConfigs[0]] as ProviderConfigEntity[]);

      const context = { userId: 'test-user' } as any;
      const providers = await providerRegistry.getAllProviders(context);

      expect(providers.length).toBe(1);
      expect(providers[0].id).toBe('google');
    });
  });

  describe('reloadConfigs', () => {
    it('should reload configurations from database', async () => {
      const mockConfigs: Partial<ProviderConfigEntity>[] = [
        { id: 'google', name: 'Google', enabled: true, sources: [] },
      ];

      providerConfigRepository.find.mockResolvedValue(mockConfigs as ProviderConfigEntity[]);

      await providerRegistry.reloadConfigs();

      expect(providerConfigRepository.find).toHaveBeenCalled();
    });

    it('should clear existing cache when reloading', async () => {
      const mockConfig1: Partial<ProviderConfigEntity> = {
        id: 'google',
        name: 'Google',
        enabled: true,
        sources: [],
      };

      const mockConfig2: Partial<ProviderConfigEntity> = {
        id: 'microsoft',
        name: 'Microsoft',
        enabled: true,
        sources: [],
      };

      // First load
      providerConfigRepository.find.mockResolvedValue([mockConfig1 as ProviderConfigEntity]);
      await providerRegistry.reloadConfigs();

      const context = { userId: 'test-user' } as any;
      let provider = await providerRegistry.getProvider(context, 'google');
      expect(provider).toBeDefined();

      // Reload with different config
      providerConfigRepository.find.mockResolvedValue([mockConfig2 as ProviderConfigEntity]);
      await providerRegistry.reloadConfigs();

      provider = await providerRegistry.getProvider(context, 'google');
      expect(provider).toBeNull();

      provider = await providerRegistry.getProvider(context, 'microsoft');
      expect(provider).toBeDefined();
    });
  });

  describe('validateConfig', () => {
    it('should validate valid provider configuration', () => {
      const config: ProviderConfig = {
        id: 'google',
        name: 'Google',
        description: 'Google services',
        logoUrl: '/logo.svg',
        theme: { backgroundColor: '#fff', borderColor: '#000' },
        sources: [
          {
            name: 'Gmail',
            description: 'Email',
            enabledByDefault: true,
            endpoints: ['GmailMessages'],
            scopes: ['gmail.readonly'],
            transformMap: 'google_gmail_to_communication',
          },
        ],
        auth: {
          type: 'oauth2',
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          scopes: [],
        },
        apiSpecId: 'google_apis_v1',
        enabled: true,
      };

      const result = providerRegistry.validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject config without name', () => {
      const config: any = {
        id: 'test',
        sources: [{ name: 'Source1' }],
        apiSpecId: 'test_api',
      };

      const result = providerRegistry.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Provider name is required');
    });

    it('should reject config without apiSpecId', () => {
      const config: any = {
        id: 'test',
        name: 'Test Provider',
        sources: [{ name: 'Source1' }],
      };

      const result = providerRegistry.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('API spec ID is required');
    });

    it('should reject config without sources', () => {
      const config: any = {
        id: 'test',
        name: 'Test Provider',
        apiSpecId: 'test_api',
        sources: [],
      };

      const result = providerRegistry.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('At least one source is required');
    });
  });
});

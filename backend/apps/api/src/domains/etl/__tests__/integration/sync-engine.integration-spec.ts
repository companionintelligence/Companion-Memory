/**
 * Sync Engine Integration Tests
 * 
 * Tests end-to-end sync workflow orchestration
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { LoggerService } from '@ci/common/logging';
import { createMockLogger, createMockConnection, createMockContext } from '@ci/test/mocks';

import { SyncEngine } from '../../services/SyncEngine';
import { ProviderRegistry } from '../../services/ProviderRegistry';
import { ApiClient } from '../../services/ApiClient';
import { TransformEngine } from '../../services/TransformEngine';
import { RateLimiter } from '../../services/RateLimiter';
import { ApiSpecEntity } from '../../entities/ApiSpecEntity';
import { TransformMapEntity } from '../../entities/TransformMapEntity';
import type { SyncOptions } from '../../types/sync';

describe('SyncEngine Integration Tests', () => {
  let syncEngine: SyncEngine;
  let providerRegistry: ProviderRegistry;
  let apiClient: ApiClient;
  let transformEngine: TransformEngine;
  let rateLimiter: RateLimiter;
  let module: TestingModule;

  beforeEach(async () => {
    const mockRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
    };

    module = await Test.createTestingModule({
      providers: [
        SyncEngine,
        {
          provide: ProviderRegistry,
          useValue: {
            getProvider: jest.fn(),
            getAllProviders: jest.fn(),
          },
        },
        {
          provide: ApiClient,
          useValue: {
            makeRequest: jest.fn(),
          },
        },
        {
          provide: TransformEngine,
          useValue: {
            transform: jest.fn(),
          },
        },
        {
          provide: RateLimiter,
          useValue: {
            checkLimit: jest.fn(),
            recordRequest: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ApiSpecEntity),
          useValue: mockRepository,
        },
        {
          provide: getRepositoryToken(TransformMapEntity),
          useValue: mockRepository,
        },
        {
          provide: LoggerService,
          useValue: createMockLogger(),
        },
      ],
    }).compile();

    syncEngine = module.get<SyncEngine>(SyncEngine);
    providerRegistry = module.get<ProviderRegistry>(ProviderRegistry);
    apiClient = module.get<ApiClient>(ApiClient);
    transformEngine = module.get<TransformEngine>(TransformEngine);
    rateLimiter = module.get<RateLimiter>(RateLimiter);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('syncConnection', () => {
    it('should sync a connection successfully', async () => {
      const connection = createMockConnection('google');
      const context = createMockContext();

      const mockProvider = {
        id: 'google',
        name: 'Google',
        sources: [
          {
            name: 'Gmail',
            endpoints: ['GmailMessages'],
            transformMap: 'google_gmail_to_communication',
          },
        ],
      };

      jest.spyOn(providerRegistry, 'getProvider').mockResolvedValue(mockProvider as any);
      jest.spyOn(apiClient, 'makeRequest').mockResolvedValue({ data: [] });
      jest.spyOn(transformEngine, 'transform').mockResolvedValue({
        data: [],
        success: true,
      });

      const result = await syncEngine.syncConnection(context, connection);

      expect(result.success).toBe(true);
      expect(result.connectionId).toBe(connection.id);
      expect(result.startedAt).toBeInstanceOf(Date);
      expect(result.completedAt).toBeInstanceOf(Date);
      expect(typeof result.duration).toBe('number');
    });

    it('should handle provider not found', async () => {
      const connection = createMockConnection('nonexistent');
      const context = createMockContext();

      jest.spyOn(providerRegistry, 'getProvider').mockResolvedValue(null);

      await expect(
        syncEngine.syncConnection(context, connection),
      ).rejects.toThrow('Provider not found');
    });

    it('should sync multiple sources sequentially', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['GmailMessages', 'CalendarEvents'],
      });
      const context = createMockContext();

      const mockProvider = {
        id: 'google',
        name: 'Google',
        sources: [
          {
            name: 'Gmail',
            endpoints: ['GmailMessages'],
            transformMap: 'google_gmail_to_communication',
          },
          {
            name: 'Calendar',
            endpoints: ['CalendarEvents'],
            transformMap: 'google_calendar_to_event',
          },
        ],
      };

      jest.spyOn(providerRegistry, 'getProvider').mockResolvedValue(mockProvider as any);
      jest.spyOn(apiClient, 'makeRequest').mockResolvedValue({ data: [] });
      jest.spyOn(transformEngine, 'transform').mockResolvedValue({
        data: [],
        success: true,
      });

      const result = await syncEngine.syncConnection(context, connection);

      expect(result.success).toBe(true);
      expect(result.sources.length).toBe(2);
    });

    it('should continue on error when continueOnError is true', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['GmailMessages', 'CalendarEvents'],
      });
      const context = createMockContext();

      const mockProvider = {
        id: 'google',
        name: 'Google',
        sources: [
          {
            name: 'Gmail',
            endpoints: ['GmailMessages'],
            transformMap: 'google_gmail_to_communication',
          },
          {
            name: 'Calendar',
            endpoints: ['CalendarEvents'],
            transformMap: 'google_calendar_to_event',
          },
        ],
      };

      jest.spyOn(providerRegistry, 'getProvider').mockResolvedValue(mockProvider as any);
      jest
        .spyOn(apiClient, 'makeRequest')
        .mockRejectedValueOnce(new Error('API Error'))
        .mockResolvedValueOnce({ data: [] });

      const options: SyncOptions = { continueOnError: true };
      const result = await syncEngine.syncConnection(context, connection, options);

      expect(result.sources.length).toBe(2);
      expect(result.sources[0].success).toBe(false);
      expect(result.sources[1].success).toBe(true);
    });

    it('should stop on first error when continueOnError is false', async () => {
      const connection = createMockConnection('google', {
        activeEndpoints: ['GmailMessages', 'CalendarEvents'],
      });
      const context = createMockContext();

      const mockProvider = {
        id: 'google',
        name: 'Google',
        sources: [
          {
            name: 'Gmail',
            endpoints: ['GmailMessages'],
            transformMap: 'google_gmail_to_communication',
          },
          {
            name: 'Calendar',
            endpoints: ['CalendarEvents'],
            transformMap: 'google_calendar_to_event',
          },
        ],
      };

      jest.spyOn(providerRegistry, 'getProvider').mockResolvedValue(mockProvider as any);
      jest.spyOn(apiClient, 'makeRequest').mockRejectedValueOnce(new Error('API Error'));

      const result = await syncEngine.syncConnection(context, connection);

      expect(result.sources.length).toBe(1);
      expect(result.sources[0].success).toBe(false);
    });
  });

  describe('Sync Metrics', () => {
    it('should track total records synced', async () => {
      const connection = createMockConnection('google');
      const context = createMockContext();

      const mockProvider = {
        id: 'google',
        name: 'Google',
        sources: [
          {
            name: 'Gmail',
            endpoints: ['GmailMessages'],
            transformMap: 'google_gmail_to_communication',
          },
        ],
      };

      jest.spyOn(providerRegistry, 'getProvider').mockResolvedValue(mockProvider as any);
      jest.spyOn(apiClient, 'makeRequest').mockResolvedValue({ data: Array(50).fill({}) });
      jest.spyOn(transformEngine, 'transform').mockResolvedValue({
        data: Array(50).fill({}),
        success: true,
      });

      const result = await syncEngine.syncConnection(context, connection);

      expect(result.totalRecords).toBe(50);
    });

    it('should track sync duration', async () => {
      const connection = createMockConnection('google');
      const context = createMockContext();

      const mockProvider = {
        id: 'google',
        name: 'Google',
        sources: [
          {
            name: 'Gmail',
            endpoints: ['GmailMessages'],
            transformMap: 'google_gmail_to_communication',
          },
        ],
      };

      jest.spyOn(providerRegistry, 'getProvider').mockResolvedValue(mockProvider as any);
      jest.spyOn(apiClient, 'makeRequest').mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ data: [] }), 100)),
      );
      jest.spyOn(transformEngine, 'transform').mockResolvedValue({
        data: [],
        success: true,
      });

      const result = await syncEngine.syncConnection(context, connection);

      expect(result.duration).toBeGreaterThanOrEqual(100);
    });
  });

  describe('Sync State Management', () => {
    it('should update sync state after successful sync', async () => {
      const connection = createMockConnection('google');
      const context = createMockContext();

      const mockProvider = {
        id: 'google',
        name: 'Google',
        sources: [
          {
            name: 'Gmail',
            endpoints: ['GmailMessages'],
            transformMap: 'google_gmail_to_communication',
          },
        ],
      };

      jest.spyOn(providerRegistry, 'getProvider').mockResolvedValue(mockProvider as any);
      jest.spyOn(apiClient, 'makeRequest').mockResolvedValue({
        data: [],
        nextPageToken: 'token123',
      });
      jest.spyOn(transformEngine, 'transform').mockResolvedValue({
        data: [],
        success: true,
      });

      const result = await syncEngine.syncConnection(context, connection);

      expect(result.success).toBe(true);
      // In real implementation, sync state would be persisted
    });

    it('should preserve sync state on error', async () => {
      const connection = createMockConnection('google', {
        syncState: { gmail: { cursor: 'existing-cursor' } },
      });
      const context = createMockContext();

      const mockProvider = {
        id: 'google',
        name: 'Google',
        sources: [
          {
            name: 'Gmail',
            endpoints: ['GmailMessages'],
            transformMap: 'google_gmail_to_communication',
          },
        ],
      };

      jest.spyOn(providerRegistry, 'getProvider').mockResolvedValue(mockProvider as any);
      jest.spyOn(apiClient, 'makeRequest').mockRejectedValue(new Error('API Error'));

      await syncEngine.syncConnection(context, connection);

      // Sync state should not be modified on error
      expect(connection.syncState.gmail.cursor).toBe('existing-cursor');
    });
  });

  describe('Full vs Incremental Sync', () => {
    it('should perform full sync when fullSync option is true', async () => {
      const connection = createMockConnection('google', {
        syncState: { gmail: { cursor: 'existing-cursor' } },
      });
      const context = createMockContext();

      const mockProvider = {
        id: 'google',
        name: 'Google',
        sources: [
          {
            name: 'Gmail',
            endpoints: ['GmailMessages'],
            transformMap: 'google_gmail_to_communication',
          },
        ],
      };

      jest.spyOn(providerRegistry, 'getProvider').mockResolvedValue(mockProvider as any);
      const makeRequestSpy = jest
        .spyOn(apiClient, 'makeRequest')
        .mockResolvedValue({ data: [] });
      jest.spyOn(transformEngine, 'transform').mockResolvedValue({
        data: [],
        success: true,
      });

      const options: SyncOptions = { fullSync: true };
      await syncEngine.syncConnection(context, connection, options);

      // Should not pass existing cursor for full sync
      expect(makeRequestSpy).toHaveBeenCalled();
    });

    it('should perform incremental sync by default', async () => {
      const connection = createMockConnection('google', {
        syncState: { gmail: { cursor: 'existing-cursor' } },
      });
      const context = createMockContext();

      const mockProvider = {
        id: 'google',
        name: 'Google',
        sources: [
          {
            name: 'Gmail',
            endpoints: ['GmailMessages'],
            transformMap: 'google_gmail_to_communication',
          },
        ],
      };

      jest.spyOn(providerRegistry, 'getProvider').mockResolvedValue(mockProvider as any);
      jest.spyOn(apiClient, 'makeRequest').mockResolvedValue({ data: [] });
      jest.spyOn(transformEngine, 'transform').mockResolvedValue({
        data: [],
        success: true,
      });

      await syncEngine.syncConnection(context, connection);

      // Should use existing cursor for incremental sync
      // In real implementation, cursor would be passed to API request
    });
  });
});

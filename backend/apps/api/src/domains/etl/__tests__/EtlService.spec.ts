/**
 * ETL Service Tests
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { EtlService } from '../services/EtlService';
import { ApiLogEntity } from '../entities/ApiLogEntity';
import { ClientFactory } from '@ci/domains/connections/clients';
import { ConnectionService } from '@ci/domains/connections';
import { LoggerService } from '@ci/common/logging';
import {
  createMockConnection,
  createMockContext,
  createMockLogger,
  createMockSyncResponse,
} from '@ci/test/mocks';

describe('EtlService', () => {
  let service: EtlService;
  let mockClientFactory: jest.Mocked<ClientFactory>;
  let mockConnectionService: jest.Mocked<ConnectionService>;
  let mockApiLogRepository: jest.Mocked<any>;

  beforeEach(async () => {
    mockClientFactory = {
      getClientByProviderId: jest.fn(),
    } as any;

    mockConnectionService = {
      findById: jest.fn(),
      updateSyncState: jest.fn(),
    } as any;

    mockApiLogRepository = {
      save: jest.fn(),
      find: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EtlService,
        {
          provide: getRepositoryToken(ApiLogEntity),
          useValue: mockApiLogRepository,
        },
        {
          provide: ClientFactory,
          useValue: mockClientFactory,
        },
        {
          provide: ConnectionService,
          useValue: mockConnectionService,
        },
        {
          provide: LoggerService,
          useValue: createMockLogger(),
        },
      ],
    }).compile();

    service = module.get<EtlService>(EtlService);
  });

  describe('handleConnectionSync', () => {
    it('should sync a valid Google connection', async () => {
      const mockConnection = createMockConnection('google', {
        activeEndpoints: ['Calendar', 'Gmail'],
      });
      const context = createMockContext();
      
      mockConnectionService.findById.mockResolvedValue(mockConnection);
      
      const mockClient = {
        sync: jest.fn().mockResolvedValue([
          createMockSyncResponse('Calendar'),
          createMockSyncResponse('Gmail'),
        ]),
      };
      mockClientFactory.getClientByProviderId.mockReturnValue(mockClient as any);

      await service.handleConnectionSync(context, mockConnection.id);

      expect(mockConnectionService.findById).toHaveBeenCalledWith(
        { userId: context.userId },
        mockConnection.id,
      );
      expect(mockClient.sync).toHaveBeenCalledWith(mockConnection);
    });

    it('should throw UnauthorizedException when userId is missing', async () => {
      const context = createMockContext();
      context.userId = null as any;

      await expect(
        service.handleConnectionSync(context, 'connection-id'),
      ).rejects.toThrow('Unauthorized');
    });

    it('should skip sync for non-existent connection', async () => {
      const context = createMockContext();
      mockConnectionService.findById.mockResolvedValue(null);

      // Should not throw, just return early
      await service.handleConnectionSync(context, 'non-existent-id');

      expect(mockClientFactory.getClientByProviderId).not.toHaveBeenCalled();
    });

    it('should handle sync errors gracefully', async () => {
      const mockConnection = createMockConnection('google');
      const context = createMockContext();
      
      mockConnectionService.findById.mockResolvedValue(mockConnection);
      
      const mockClient = {
        sync: jest.fn().mockRejectedValue(new Error('API rate limited')),
      };
      mockClientFactory.getClientByProviderId.mockReturnValue(mockClient as any);

      // Should handle error without throwing
      await expect(
        service.handleConnectionSync(context, mockConnection.id),
      ).resolves.not.toThrow();
    });
  });
});

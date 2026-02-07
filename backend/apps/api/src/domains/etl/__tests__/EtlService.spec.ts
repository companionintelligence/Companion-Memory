/**
 * ETL Service Tests
 */

import type { Repository } from 'typeorm';

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { ClientFactory, Connection, ConnectionService } from '@ci/domains/connections';
import {
  createMockConnection,
  createMockContext,
  createMockLogger,
  createMockSyncResponse,
} from '@ci/test/mocks';

import type { ApiLogEntity } from '../entities/ApiLogEntity';
import { ConnectionPipelineOrchestrator } from '../pipeline/ConnectionPipelineOrchestrator';
import { EtlService } from '../services/EtlService';

const GOOGLE_PROVIDER_ID = '0198779b-182c-716e-9275-b81d99a47fdb';

describe('EtlService', () => {
  let service: EtlService;
  let mockClientFactory: { getClientByProviderId: jest.Mock };
  let mockConnectionService: {
    findById: jest.Mock<Promise<Connection | null>, [RequestContext, string]>;
    update: jest.Mock;
  };
  let mockApiLogRepository: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
  };
  let connectionPipelineOrchestrator: ConnectionPipelineOrchestrator;

  beforeEach(() => {
    mockClientFactory = {
      getClientByProviderId: jest.fn(),
    };

    mockConnectionService = {
      findById: jest.fn(),
      update: jest.fn(),
    };

    mockApiLogRepository = {
      create: jest.fn().mockImplementation((value) => value),
      save: jest.fn(),
      find: jest.fn(),
    };

    connectionPipelineOrchestrator = new ConnectionPipelineOrchestrator();

    service = new EtlService(
      mockApiLogRepository as unknown as Repository<ApiLogEntity>,
      mockClientFactory as unknown as ClientFactory,
      mockConnectionService as unknown as ConnectionService,
      connectionPipelineOrchestrator,
      createMockLogger() as unknown as LoggerService,
    );
  });

  describe('handleConnectionSync', () => {
    it('should sync a valid Google connection', async () => {
      const mockConnection = createMockConnection('google', {
        providerId: GOOGLE_PROVIDER_ID,
        active: true,
        activeEndpoints: ['Calendar', 'Gmail'],
        provider: { id: GOOGLE_PROVIDER_ID } as unknown as Connection['provider'],
      });
      const context = createMockContext();

      mockConnectionService.findById.mockResolvedValue(mockConnection);

      const mockClient = {
        sync: jest
          .fn()
          .mockResolvedValue([createMockSyncResponse('Calendar'), createMockSyncResponse('Gmail')]),
      };
      mockClientFactory.getClientByProviderId.mockReturnValue(mockClient);

      await service.handleConnectionSync(context, mockConnection.id);

      expect(mockConnectionService.findById).toHaveBeenCalledWith(
        { userId: context.userId },
        mockConnection.id,
      );
      expect(mockClient.sync).toHaveBeenCalledWith(mockConnection);
    });

    it('should throw UnauthorizedException when userId is missing', async () => {
      const context: RequestContext = {};

      await expect(service.handleConnectionSync(context, 'connection-id')).rejects.toThrow('Unauthorized');
    });

    it('should skip sync for non-existent connection', async () => {
      const context = createMockContext();
      mockConnectionService.findById.mockResolvedValue(null);

      // Should not throw, just return early
      await service.handleConnectionSync(context, 'non-existent-id');

      expect(mockClientFactory.getClientByProviderId).not.toHaveBeenCalled();
    });

    it('should handle sync errors gracefully', async () => {
      const mockConnection = createMockConnection(GOOGLE_PROVIDER_ID, {
        active: true,
        provider: { id: GOOGLE_PROVIDER_ID } as unknown as Connection['provider'],
      });
      const context = createMockContext();

      mockConnectionService.findById.mockResolvedValue(mockConnection);

      const mockClient = {
        sync: jest.fn().mockRejectedValue(new Error('API rate limited')),
      };
      mockClientFactory.getClientByProviderId.mockReturnValue(mockClient);

      await expect(service.handleConnectionSync(context, mockConnection.id)).rejects.toThrow(
        'API rate limited',
      );
    });
  });
});

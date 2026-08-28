import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { ConnectionService } from '@ci/domains/connections';

import type { ConnectionSyncJobService } from './ConnectionSyncJobService';
import { SyncNowService } from './SyncNowService';

describe('SyncNowService', () => {
  const context = { userId: 'user-1' };

  let service: SyncNowService;
  let connectionService: jest.Mocked<Pick<ConnectionService, 'findAll'>>;
  let connectionSyncJobService: jest.Mocked<Pick<ConnectionSyncJobService, 'search' | 'create'>>;
  let featureService: jest.Mocked<Pick<FeatureService, 'isFeatureEnabled'>>;

  beforeEach(() => {
    connectionService = {
      findAll: jest.fn(),
    };
    connectionSyncJobService = {
      search: jest.fn(),
      create: jest.fn(),
    };
    featureService = {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
    };

    const logger = { setContext: jest.fn(), log: jest.fn() } as unknown as LoggerService;

    service = new SyncNowService(
      connectionService as unknown as ConnectionService,
      connectionSyncJobService as unknown as ConnectionSyncJobService,
      featureService as unknown as FeatureService,
      logger,
    );
  });

  it('refuses rather than enqueuing work the gated executor can never drain', async () => {
    featureService.isFeatureEnabled.mockResolvedValue(false);

    const result = await service.enqueueForUser(context as never);

    expect(result).toEqual({
      jobIds: [],
      enqueued: 0,
      skipped: 0,
      disabledReason: 'scheduled_sync_disabled',
    });
    expect(connectionService.findAll).not.toHaveBeenCalled();
    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('enqueues pending jobs for active connection endpoints', async () => {
    connectionService.findAll.mockResolvedValue([
      {
        id: 'conn-1',
        active: true,
        needsReauth: false,
        activeEndpoints: ['gmail', 'calendar'],
      },
    ] as never);
    connectionSyncJobService.search.mockImplementation(async (_ctx, query) => {
      if (query?.connectionId && query?.endpointName) {
        return [];
      }

      return [];
    });
    connectionSyncJobService.create.mockImplementation(
      async (_ctx, data) =>
        ({
          id: `job-${data.endpointName}`,
          ...data,
          status: 'pending',
          createdAt: new Date(),
          updatedAt: new Date(),
        }) as never,
    );

    const result = await service.enqueueForUser(context);

    expect(result.enqueued).toBe(2);
    expect(result.jobIds).toEqual(['job-gmail', 'job-calendar']);
    expect(connectionSyncJobService.create).toHaveBeenCalledTimes(2);
  });

  it('skips endpoints that already have pending work', async () => {
    connectionService.findAll.mockResolvedValue([
      {
        id: 'conn-1',
        active: true,
        needsReauth: false,
        activeEndpoints: ['gmail'],
      },
    ] as never);
    connectionSyncJobService.search.mockImplementation(async (_ctx, query) => {
      if (query?.status === 'pending') {
        return [{ status: 'pending', updatedAt: new Date() } as never];
      }

      return [];
    });

    const result = await service.enqueueForUser(context);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('skips all endpoints when user has sync work awaiting transform', async () => {
    connectionService.findAll.mockResolvedValue([
      {
        id: 'conn-1',
        active: true,
        needsReauth: false,
        activeEndpoints: ['gmail', 'calendar'],
      },
    ] as never);
    connectionSyncJobService.search.mockImplementation(async (_ctx, query) => {
      if (query?.status === 'success' && query?.lastTransformed === null) {
        return [{ status: 'success', lastTransformed: null, updatedAt: new Date() } as never];
      }

      return [];
    });

    const result = await service.enqueueForUser(context);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(2);
    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });
});

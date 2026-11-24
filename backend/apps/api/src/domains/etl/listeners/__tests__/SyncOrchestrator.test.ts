import type { FeatureService } from '@ci/common/feature';
import type { ClientFactory, Connection } from '@ci/domains/connections';
import { EventListenerRegistry } from '@ci/domains/events';

import { ConnectionSyncJobExecuteEvent, ConnectionSyncJobTransformEvent } from '../../events';
import { ConnectionSyncJobService } from '../../services/ConnectionSyncJobService';
import type { EndpointServiceMap } from '../../services/EndpointServiceMap';
import type { ConnectionSyncJob, SearchConnectionSyncJobDto } from '../../types';
import { SyncOrchestrator } from '../SyncOrchestrator';

const HOUR_MS = 60 * 60 * 1000;

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    userId: 'user-1',
    active: true,
    activeEndpoints: ['messages'],
    refreshToken: null,
    tokenExpiry: null,
    syncState: {},
    provider: {
      id: 'provider-1',
      name: 'signal',
      endpoints: [{ name: 'messages', iterationType: 'incremental', TTL: undefined }],
    },
    ...overrides,
  } as unknown as Connection;
}

function makeSyncJob(overrides: Partial<ConnectionSyncJob> = {}): ConnectionSyncJob {
  return {
    id: 'job-1',
    userId: 'user-1',
    connectionId: 'conn-1',
    endpointName: 'messages',
    status: 'pending',
    type: 'incremental',
    data: {},
    cursor: {},
    nextCursor: {},
    lastTransformed: null,
    // A row the sync executor fetched, which is the only kind the transform takes.
    fetchedByExecutor: true,
    updatedAt: new Date(),
    completedAt: null,
    ...overrides,
  } as unknown as ConnectionSyncJob;
}

/**
 * The REAL {@link ConnectionSyncJobService} claim methods, over a `manager.query`
 * that answers the two claim UPDATEs the way Postgres does: the WHERE is
 * evaluated and the row mutated in one uninterrupted step (nothing awaits
 * inside), and the result is TypeORM's UPDATE shape — the pair
 * `[rows, rowCount]`, NOT the RETURNING rows.
 *
 * Both of those matter. The atomicity is what a real row lock gives two racing
 * UPDATEs, and is what makes "exactly one winner" a meaningful assertion. The
 * shape is what the previous version of these tests could not see: they replaced
 * `claimPending`/`claimTransform` with hand-written mocks implementing the
 * INTENDED semantics, so they exercised the mock and stayed green while the
 * service itself read `[[], 0]` as two rows and let every caller win.
 */
function claimingSyncJobService(
  row: { status: string; lastTransformed: Date | null; transformClaimedAt: Date | null } = {
    status: 'pending',
    lastTransformed: null,
    transformClaimedAt: null,
  },
) {
  const managerQuery = jest.fn(async (sql: string, params: unknown[]) => {
    const isPendingClaim = sql.includes("SET status = 'in_progress'");
    const matched = isPendingClaim
      ? row.status === 'pending'
      : row.lastTransformed == null &&
        (row.transformClaimedAt == null || row.transformClaimedAt.getTime() < Date.now() - HOUR_MS);

    if (!matched) {
      return [[], 0];
    }

    if (isPendingClaim) {
      row.status = 'in_progress';
    } else {
      row.transformClaimedAt = new Date();
    }

    return [[{ id: params[0] as string }], 1];
  });

  const logger = { setContext() {}, log() {}, warn() {}, error() {} };
  const service = new ConnectionSyncJobService(
    { manager: { query: managerQuery } } as never,
    logger as never,
  );

  return { service, row, managerQuery };
}

function buildOrchestrator(
  overrides: {
    connectionService?: Record<string, jest.Mock>;
    connectionSyncJobService?: Record<string, jest.Mock>;
    eventService?: Record<string, jest.Mock>;
    endpointServiceMap?: Record<string, jest.Mock>;
    clientFactory?: Record<string, jest.Mock>;
    syncFeatureEnabled?: boolean;
  } = {},
) {
  const connectionService = {
    findActiveConnections: jest.fn().mockResolvedValue([]),
    findById: jest.fn().mockResolvedValue(makeConnection()),
    update: jest.fn().mockImplementation(async (_ctx, _id, patch) => ({ ...makeConnection(), ...patch })),
    ...overrides.connectionService,
  };

  const connectionSyncJobService = {
    search: jest.fn().mockResolvedValue([]),
    countInProgress: jest.fn().mockResolvedValue(0),
    findDispatchablePending: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue(makeSyncJob()),
    findById: jest.fn().mockResolvedValue(makeSyncJob()),
    update: jest.fn().mockResolvedValue(makeSyncJob()),
    markAsCompleted: jest.fn().mockResolvedValue(makeSyncJob({ status: 'failed' })),
    claimPending: jest.fn().mockResolvedValue(true),
    claimTransform: jest.fn().mockResolvedValue(true),
    ...overrides.connectionSyncJobService,
  };

  const eventService = {
    send: jest.fn().mockResolvedValue(['job-id']),
    ...overrides.eventService,
  };

  const endpointServiceMap = {
    getSyncFunction: jest.fn(),
    getTransformFunction: jest.fn(),
    ...overrides.endpointServiceMap,
  };

  const clientFactory = {
    getClientByProviderId: jest.fn().mockReturnValue({ refreshAccessToken: jest.fn() }),
    ...overrides.clientFactory,
  };

  const featureService = {
    isFeatureEnabled: jest
      .fn()
      .mockImplementation(
        async (key: string) => key === 'scheduled.connection.sync' && overrides.syncFeatureEnabled !== false,
      ),
  };

  const logger = { setContext() {}, log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

  const orchestrator = new SyncOrchestrator(
    connectionService as never,
    connectionSyncJobService as unknown as ConnectionSyncJobService,
    eventService as never,
    endpointServiceMap as unknown as EndpointServiceMap,
    clientFactory as unknown as ClientFactory,
    featureService as unknown as FeatureService,
    logger as never,
  );

  return {
    orchestrator,
    connectionService,
    connectionSyncJobService,
    eventService,
    endpointServiceMap,
    clientFactory,
    featureService,
    logger,
  };
}

/**
 * The selection rules themselves — one job per connection, five in flight —
 * now live in `ConnectionSyncJobService.findDispatchablePending`'s SQL, and are
 * pinned against real Postgres in
 * `services/__tests__/ConnectionSyncJobService.bounds.integration.spec.ts`.
 * They had to move: this cron runs every 30 seconds against a table with no
 * index but its primary key, and a rule applied in JavaScript needs every
 * candidate row in memory to apply it. What is left to assert here is that the
 * cron asks for no more than it can dispatch.
 */
describe('SyncOrchestrator.executeSyncJobs — bounded reads and the in-flight budget', () => {
  it('asks only for the ids this tick can dispatch, instead of reading every pending and in-progress row', async () => {
    const { orchestrator, connectionSyncJobService, eventService } = buildOrchestrator({
      connectionSyncJobService: {
        countInProgress: jest.fn().mockResolvedValue(3),
        findDispatchablePending: jest.fn().mockResolvedValue(['job-a1', 'job-b1']),
      },
    });

    await orchestrator.executeSyncJobs();

    // The count stops at the cap, and the dispatch query gets what is left of it.
    expect(connectionSyncJobService.countInProgress).toHaveBeenCalledWith(expect.anything(), 5);
    expect(connectionSyncJobService.findDispatchablePending).toHaveBeenCalledWith(expect.anything(), 2);
    expect(connectionSyncJobService.search).not.toHaveBeenCalled();
    expect(eventService.send).toHaveBeenCalledTimes(2);
  });

  it('spends the whole cap as budget when nothing is in flight', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator();

    await orchestrator.executeSyncJobs();

    expect(connectionSyncJobService.findDispatchablePending).toHaveBeenCalledWith(expect.anything(), 5);
  });

  it('dispatches nothing — and does not go looking for work at all — once the cap is full', async () => {
    const { orchestrator, connectionSyncJobService, eventService } = buildOrchestrator({
      connectionSyncJobService: { countInProgress: jest.fn().mockResolvedValue(5) },
    });

    await orchestrator.executeSyncJobs();

    expect(connectionSyncJobService.findDispatchablePending).not.toHaveBeenCalled();
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('sends one execute event per dispatchable id, keyed on that id', async () => {
    const { orchestrator, eventService } = buildOrchestrator({
      connectionSyncJobService: {
        findDispatchablePending: jest.fn().mockResolvedValue(['job-a1', 'job-b1']),
      },
    });

    await orchestrator.executeSyncJobs();

    expect(eventService.send).toHaveBeenNthCalledWith(
      1,
      ConnectionSyncJobExecuteEvent,
      { connectionSyncJobId: 'job-a1' },
      { singletonKey: 'job-a1' },
    );
    expect(eventService.send).toHaveBeenNthCalledWith(
      2,
      ConnectionSyncJobExecuteEvent,
      { connectionSyncJobId: 'job-b1' },
      { singletonKey: 'job-b1' },
    );
  });

  it('dispatches nothing when there is no dispatchable pending job', async () => {
    const { orchestrator, eventService } = buildOrchestrator();

    await orchestrator.executeSyncJobs();

    expect(eventService.send).not.toHaveBeenCalled();
  });
});

describe('SyncOrchestrator.handleSyncJobExecuteEvent — claim check and lifecycle', () => {
  it('logs and returns when the sync job cannot be found', async () => {
    const { orchestrator, connectionSyncJobService, logger } = buildOrchestrator({
      connectionSyncJobService: { findById: jest.fn().mockResolvedValue(null) },
    });

    await orchestrator.handleSyncJobExecuteEvent({ connectionSyncJobId: 'missing' });

    expect(logger.error).toHaveBeenCalled();
    expect(connectionSyncJobService.update).not.toHaveBeenCalled();
  });

  it('skips a job whose claim is lost — the redelivery/duplicate-tick claim check', async () => {
    const { orchestrator, connectionSyncJobService, connectionService } = buildOrchestrator({
      connectionSyncJobService: {
        findById: jest.fn().mockResolvedValue(makeSyncJob({ status: 'in_progress' })),
        claimPending: jest.fn().mockResolvedValue(false),
      },
    });

    await orchestrator.handleSyncJobExecuteEvent({ connectionSyncJobId: 'job-1' });

    expect(connectionSyncJobService.claimPending).toHaveBeenCalledWith(expect.anything(), 'job-1');
    expect(connectionSyncJobService.update).not.toHaveBeenCalled();
    expect(connectionService.findById).not.toHaveBeenCalled();
  });

  it('marks the job failed when its connection no longer exists', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findById: jest.fn().mockResolvedValue(null) },
    });

    await orchestrator.handleSyncJobExecuteEvent({ connectionSyncJobId: 'job-1' });

    expect(connectionSyncJobService.claimPending).toHaveBeenCalledWith(expect.anything(), 'job-1');
    expect(connectionSyncJobService.markAsCompleted).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      'failed',
      expect.objectContaining({ error: 'Connection not found' }),
    );
  });

  it('marks the job failed when the connection has no provider', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findById: jest.fn().mockResolvedValue(makeConnection({ provider: undefined })) },
    });

    await orchestrator.handleSyncJobExecuteEvent({ connectionSyncJobId: 'job-1' });

    expect(connectionSyncJobService.markAsCompleted).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      'failed',
      expect.objectContaining({ error: 'Provider not found for connection' }),
    );
  });

  it('marks the job failed when no sync function is registered for the provider/endpoint', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      endpointServiceMap: { getSyncFunction: jest.fn().mockReturnValue(undefined) },
    });

    await orchestrator.handleSyncJobExecuteEvent({ connectionSyncJobId: 'job-1' });

    expect(connectionSyncJobService.markAsCompleted).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      'failed',
      expect.objectContaining({ error: 'No service function found for provider and endpoint' }),
    );
  });

  it('refreshes an expired access token before syncing and strips a null refreshToken from the update', async () => {
    const refreshAccessToken = jest.fn().mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: null,
      tokenExpiry: new Date(Date.now() + HOUR_MS),
    });
    const serviceFunction = jest.fn().mockResolvedValue({ data: {}, nextCursor: {} });
    const expiredConnection = makeConnection({
      refreshToken: 'old-refresh-token',
      tokenExpiry: new Date(Date.now() - 1000),
    } as never);

    const { orchestrator, connectionService } = buildOrchestrator({
      connectionService: { findById: jest.fn().mockResolvedValue(expiredConnection) },
      endpointServiceMap: { getSyncFunction: jest.fn().mockReturnValue(serviceFunction) },
      clientFactory: { getClientByProviderId: jest.fn().mockReturnValue({ refreshAccessToken }) },
    });

    await orchestrator.handleSyncJobExecuteEvent({ connectionSyncJobId: 'job-1' });

    expect(refreshAccessToken).toHaveBeenCalledWith(expiredConnection);
    const updateCall = connectionService.update.mock.calls.find(
      (call: unknown[]) => !('syncState' in (call[2] as Record<string, unknown>)),
    );
    expect(updateCall?.[2]).not.toHaveProperty('refreshToken');
    expect(updateCall?.[2]).toMatchObject({ accessToken: 'new-access-token' });
  });

  it('does not refresh the token when it has not expired', async () => {
    const refreshAccessToken = jest.fn();
    const serviceFunction = jest.fn().mockResolvedValue({ data: {}, nextCursor: {} });
    const freshConnection = makeConnection({
      refreshToken: 'refresh-token',
      tokenExpiry: new Date(Date.now() + HOUR_MS),
    } as never);

    const { orchestrator } = buildOrchestrator({
      connectionService: { findById: jest.fn().mockResolvedValue(freshConnection) },
      endpointServiceMap: { getSyncFunction: jest.fn().mockReturnValue(serviceFunction) },
      clientFactory: { getClientByProviderId: jest.fn().mockReturnValue({ refreshAccessToken }) },
    });

    await orchestrator.handleSyncJobExecuteEvent({ connectionSyncJobId: 'job-1' });

    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('on success, records the result on the job and merges lastSyncedAt into the existing syncState', async () => {
    const serviceFunction = jest.fn().mockResolvedValue({ data: { messages: 3 }, nextCursor: { page: 2 } });
    const connectionWithState = makeConnection({ syncState: { someExistingKey: 'keep-me' } } as never);

    const { orchestrator, connectionSyncJobService, connectionService } = buildOrchestrator({
      connectionService: { findById: jest.fn().mockResolvedValue(connectionWithState) },
      endpointServiceMap: { getSyncFunction: jest.fn().mockReturnValue(serviceFunction) },
    });

    await orchestrator.handleSyncJobExecuteEvent({ connectionSyncJobId: 'job-1' });

    expect(connectionSyncJobService.update).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      expect.objectContaining({
        data: { messages: 3 },
        nextCursor: { page: 2 },
        status: 'success',
        // The executor's mark: the only rows the transform sweep trusts.
        fetchedByExecutor: true,
      }),
    );

    const syncStateUpdateCall = connectionService.update.mock.calls.find((call: unknown[]) =>
      Object.prototype.hasOwnProperty.call(call[2] as Record<string, unknown>, 'syncState'),
    );
    expect(syncStateUpdateCall?.[2]).toMatchObject({
      syncState: expect.objectContaining({ someExistingKey: 'keep-me', lastSyncedAt: expect.any(String) }),
    });
  });

  it('marks the job failed (without throwing) when the sync function itself throws, persisting a readable message', async () => {
    const serviceFunction = jest.fn().mockRejectedValue(new Error('provider rate limited'));

    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      endpointServiceMap: { getSyncFunction: jest.fn().mockReturnValue(serviceFunction) },
    });

    await expect(
      orchestrator.handleSyncJobExecuteEvent({ connectionSyncJobId: 'job-1' }),
    ).resolves.not.toThrow();

    // The bug: passing the raw `Error` object into a jsonb column persists as
    // `{}` — `Error` has no own enumerable properties, so `JSON.stringify`
    // (and every jsonb write path) drops `message` and `stack` entirely.
    // Asserting the exact string (not `expect.any(Error)`) is what catches a
    // regression back to that.
    expect(connectionSyncJobService.markAsCompleted).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      'failed',
      { error: 'provider rate limited' },
    );
  });
});

describe('SyncOrchestrator.handleSyncJobExecuteEvent — concurrent-duplicate races', () => {
  it('runs the sync exactly once when the same job is delivered twice concurrently', async () => {
    const { service } = claimingSyncJobService();
    const claimPending = jest.fn((ctx: never, id: string) => service.claimPending(ctx, id));
    const serviceFunction = jest.fn().mockResolvedValue({ data: {}, nextCursor: {} });

    const { orchestrator } = buildOrchestrator({
      connectionSyncJobService: { claimPending },
      endpointServiceMap: { getSyncFunction: jest.fn().mockReturnValue(serviceFunction) },
    });

    await Promise.all([
      orchestrator.handleSyncJobExecuteEvent({ connectionSyncJobId: 'job-1' }),
      orchestrator.handleSyncJobExecuteEvent({ connectionSyncJobId: 'job-1' }),
    ]);

    expect(claimPending).toHaveBeenCalledTimes(2);
    expect(serviceFunction).toHaveBeenCalledTimes(1);
  });

  it('does not re-run a redelivered job that already reached a terminal status', async () => {
    // The defensive `if (syncJob.status !== 'pending') return;` this handler used
    // to carry was deleted in favour of the claim, so the claim is now the ONLY
    // thing standing between a pg-boss redelivery of a finished job and a second
    // provider fetch + ingest of the same data.
    const { service, row } = claimingSyncJobService({
      status: 'success',
      lastTransformed: null,
      transformClaimedAt: null,
    });
    const serviceFunction = jest.fn().mockResolvedValue({ data: {}, nextCursor: {} });

    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionSyncJobService: {
        claimPending: jest.fn((ctx: never, id: string) => service.claimPending(ctx, id)),
        findById: jest.fn().mockResolvedValue(makeSyncJob({ status: 'success' })),
      },
      endpointServiceMap: { getSyncFunction: jest.fn().mockReturnValue(serviceFunction) },
    });

    await orchestrator.handleSyncJobExecuteEvent({ connectionSyncJobId: 'job-1' });

    expect(serviceFunction).not.toHaveBeenCalled();
    expect(connectionSyncJobService.update).not.toHaveBeenCalled();
    expect(row.status).toBe('success');
  });
});

describe('SyncOrchestrator.executeTransformJobs', () => {
  it('asks Postgres for at most 2 transform jobs, instead of slicing the full result in JavaScript', async () => {
    const { orchestrator, eventService, connectionSyncJobService } = buildOrchestrator({
      connectionSyncJobService: {
        search: jest.fn().mockResolvedValue([makeSyncJob({ id: 'j1' }), makeSyncJob({ id: 'j2' })]),
      },
    });

    await orchestrator.executeTransformJobs();

    expect(connectionSyncJobService.search).toHaveBeenCalledWith(expect.anything(), {
      status: 'success',
      lastTransformed: null,
      transformClaimable: true,
      // Only payloads the executor fetched, on connections that are active. A client used to be
      // able to write a "successful" job whose data the transforms then acted on.
      fetchedByExecutor: true,
      connectionActive: true,
      // Oldest first. The sweep is one two-slot queue for the whole box while
      // every connection completes up to two sync jobs a minute, so
      // newest-first left anything that once fell behind untransformed forever.
      orderBy: 'updated_at:ASC',
      limit: 2,
    });

    expect(eventService.send).toHaveBeenCalledTimes(2);
    expect(eventService.send).toHaveBeenNthCalledWith(
      1,
      ConnectionSyncJobTransformEvent,
      { connectionSyncJobId: 'j1' },
      { singletonKey: 'j1' },
    );
    expect(eventService.send).toHaveBeenNthCalledWith(
      2,
      ConnectionSyncJobTransformEvent,
      { connectionSyncJobId: 'j2' },
      { singletonKey: 'j2' },
    );
  });

  it('dispatches nothing when there is nothing to transform', async () => {
    const { orchestrator, eventService } = buildOrchestrator();

    await orchestrator.executeTransformJobs();

    expect(eventService.send).not.toHaveBeenCalled();
  });
});

describe('SyncOrchestrator.handleSyncJobTransformEvent — claim check and lifecycle', () => {
  it('returns when the sync job cannot be found', async () => {
    const { orchestrator, logger } = buildOrchestrator({
      connectionSyncJobService: { findById: jest.fn().mockResolvedValue(null) },
    });

    await orchestrator.handleSyncJobTransformEvent({ connectionSyncJobId: 'missing' });

    expect(logger.error).toHaveBeenCalled();
  });

  it('skips a job that is already claimed or transformed — the self-DoS-prevention claim check', async () => {
    const transformFn = jest.fn().mockResolvedValue(undefined);
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionSyncJobService: {
        findById: jest.fn().mockResolvedValue(makeSyncJob({ lastTransformed: new Date() })),
        claimTransform: jest.fn().mockResolvedValue(false),
      },
      endpointServiceMap: { getTransformFunction: jest.fn().mockReturnValue(transformFn) },
    });

    await orchestrator.handleSyncJobTransformEvent({ connectionSyncJobId: 'job-1' });

    expect(connectionSyncJobService.claimTransform).toHaveBeenCalledWith(expect.anything(), 'job-1');
    expect(transformFn).not.toHaveBeenCalled();
    expect(connectionSyncJobService.update).not.toHaveBeenCalled();
  });

  it('returns without updating when the connection cannot be found', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findById: jest.fn().mockResolvedValue(null) },
    });

    await orchestrator.handleSyncJobTransformEvent({ connectionSyncJobId: 'job-1' });

    expect(connectionSyncJobService.update).not.toHaveBeenCalled();
  });

  it('logs and returns (without updating) when no transform function is registered', async () => {
    const { orchestrator, connectionSyncJobService, logger } = buildOrchestrator({
      endpointServiceMap: { getTransformFunction: jest.fn().mockReturnValue(undefined) },
    });

    await orchestrator.handleSyncJobTransformEvent({ connectionSyncJobId: 'job-1' });

    expect(logger.error).toHaveBeenCalled();
    expect(connectionSyncJobService.update).not.toHaveBeenCalled();
  });

  it('does not transform, or even claim, a job the sync executor did not fetch', async () => {
    const transformFn = jest.fn().mockResolvedValue(undefined);
    const { orchestrator, connectionSyncJobService, logger } = buildOrchestrator({
      connectionSyncJobService: {
        findById: jest.fn().mockResolvedValue(makeSyncJob({ status: 'success', fetchedByExecutor: false })),
      },
      endpointServiceMap: { getTransformFunction: jest.fn().mockReturnValue(transformFn) },
    });

    await orchestrator.handleSyncJobTransformEvent({ connectionSyncJobId: 'job-1' });

    expect(transformFn).not.toHaveBeenCalled();
    expect(connectionSyncJobService.claimTransform).not.toHaveBeenCalled();
    expect(connectionSyncJobService.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Not transforming a sync job the sync executor did not fetch',
      expect.anything(),
    );
  });

  it('does not transform a job whose connection is not active, and leaves it for later', async () => {
    // A connection that never finished signing in, or one the user paused. Not marked
    // transformed: if the connection comes back, its data still gets transformed.
    const transformFn = jest.fn().mockResolvedValue(undefined);
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findById: jest.fn().mockResolvedValue(makeConnection({ active: false })) },
      endpointServiceMap: { getTransformFunction: jest.fn().mockReturnValue(transformFn) },
    });

    await orchestrator.handleSyncJobTransformEvent({ connectionSyncJobId: 'job-1' });

    expect(transformFn).not.toHaveBeenCalled();
    // Not claimed either: a claim would hold it (and push it to the back of the queue) for an
    // hour after the connection comes back.
    expect(connectionSyncJobService.claimTransform).not.toHaveBeenCalled();
    expect(connectionSyncJobService.update).not.toHaveBeenCalled();
  });

  it('marks lastTransformed on success', async () => {
    const transformFn = jest.fn().mockResolvedValue(undefined);
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      endpointServiceMap: { getTransformFunction: jest.fn().mockReturnValue(transformFn) },
    });

    await orchestrator.handleSyncJobTransformEvent({ connectionSyncJobId: 'job-1' });

    expect(transformFn).toHaveBeenCalled();
    expect(connectionSyncJobService.update).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      expect.objectContaining({ lastTransformed: expect.any(Date) }),
    );
  });

  it('still marks lastTransformed (with the error recorded) when the transform throws — so it does not requeue forever', async () => {
    const transformFn = jest.fn().mockRejectedValue(new Error('OOM during transform'));
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      endpointServiceMap: { getTransformFunction: jest.fn().mockReturnValue(transformFn) },
    });

    await expect(
      orchestrator.handleSyncJobTransformEvent({ connectionSyncJobId: 'job-1' }),
    ).resolves.not.toThrow();

    expect(connectionSyncJobService.update).toHaveBeenCalledWith(
      expect.anything(),
      'job-1',
      expect.objectContaining({
        lastTransformed: expect.any(Date),
        error: expect.objectContaining({ transformError: 'OOM during transform' }),
      }),
    );
  });
});

describe('SyncOrchestrator.handleSyncJobTransformEvent — concurrent-duplicate races', () => {
  it('runs the transform exactly once when the same job is delivered twice concurrently', async () => {
    // The production bug the claim closes: `lastTransformed` is only written on
    // COMPLETION, so a transform still in flight when the next tick fired was
    // re-enqueued and re-run alongside itself — observed as six concurrent
    // copies of GmailTransformService.transformGmail.
    const { service } = claimingSyncJobService();
    const claimTransform = jest.fn((ctx: never, id: string) => service.claimTransform(ctx, id));
    const transformFn = jest.fn().mockResolvedValue(undefined);

    const { orchestrator } = buildOrchestrator({
      connectionSyncJobService: { claimTransform },
      endpointServiceMap: { getTransformFunction: jest.fn().mockReturnValue(transformFn) },
    });

    await Promise.all([
      orchestrator.handleSyncJobTransformEvent({ connectionSyncJobId: 'job-1' }),
      orchestrator.handleSyncJobTransformEvent({ connectionSyncJobId: 'job-1' }),
    ]);

    expect(claimTransform).toHaveBeenCalledTimes(2);
    expect(transformFn).toHaveBeenCalledTimes(1);
  });

  it('does not re-run a transform for a job already transformed', async () => {
    // `if (syncJob.lastTransformed != null) return;` was deleted in favour of the
    // claim, so `last_transformed IS NULL` in the claim's WHERE is now the only
    // guard against a redelivery re-transforming finished data.
    const { service } = claimingSyncJobService({
      status: 'success',
      lastTransformed: new Date(),
      transformClaimedAt: null,
    });
    const transformFn = jest.fn().mockResolvedValue(undefined);

    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionSyncJobService: {
        claimTransform: jest.fn((ctx: never, id: string) => service.claimTransform(ctx, id)),
        findById: jest
          .fn()
          .mockResolvedValue(makeSyncJob({ status: 'success', lastTransformed: new Date() })),
      },
      endpointServiceMap: { getTransformFunction: jest.fn().mockReturnValue(transformFn) },
    });

    await orchestrator.handleSyncJobTransformEvent({ connectionSyncJobId: 'job-1' });

    expect(transformFn).not.toHaveBeenCalled();
    expect(connectionSyncJobService.update).not.toHaveBeenCalled();
  });
});

describe('SyncOrchestrator.orchestrateSyncJobs', () => {
  function activeConnection(overrides: Partial<Connection> = {}) {
    return { connection: makeConnection(overrides), lastSyncedAt: null };
  }

  function historicalConnection(TTL?: number) {
    return makeConnection({
      provider: {
        id: 'provider-1',
        name: 'signal',
        endpoints: [{ name: 'messages', iterationType: 'historical', TTL }],
      } as never,
    });
  }

  /**
   * A `search()` stand-in that applies the filters it is handed.
   *
   * The sweep now issues up to three DIFFERENT bounded queries per endpoint —
   * the live job, the last success, and (only when there is neither) whether the
   * endpoint has any history at all — where it used to issue one unbounded one
   * and sort the answer out in JavaScript. A mock that returns the same array
   * whatever it is asked cannot tell those apart: it would answer "the most
   * recent success" with an in-progress row, and every assertion below would be
   * about the mock rather than about the sweep.
   */
  function searchOver(rows: ConnectionSyncJob[]) {
    return jest.fn(async (_ctx: unknown, query: SearchConnectionSyncJobDto) => {
      // Honour the sort the sweep asks for: the latest-success read sorts on
      // completed_at, everything else on updated_at. A stand-in that always
      // sorted on updated_at could not tell the two apart — which is exactly
      // the confusion the sweep itself used to have.
      const [field = 'updated_at', direction = 'DESC'] = (query.orderBy ?? 'updated_at:DESC').split(':');
      const key = (row: ConnectionSyncJob) =>
        new Date((field === 'completed_at' ? row.completedAt : row.updatedAt) ?? 0).getTime();
      const sign = direction === 'ASC' ? 1 : -1;

      const matched = rows
        .filter((row) => query.connectionId == null || row.connectionId === query.connectionId)
        .filter((row) => query.endpointName == null || row.endpointName === query.endpointName)
        .filter((row) => query.type == null || row.type === query.type)
        .filter((row) => query.status == null || row.status === query.status)
        .filter((row) => query.statuses == null || query.statuses.includes(row.status))
        .sort((a, b) => sign * (key(a) - key(b)));

      return query.limit == null ? matched : matched.slice(0, query.limit);
    });
  }

  it('logs and continues past an endpoint the provider no longer declares', async () => {
    const connection = makeConnection({ activeEndpoints: ['ghost-endpoint'] });
    const { orchestrator, connectionSyncJobService, logger } = buildOrchestrator({
      connectionService: {
        findActiveConnections: jest.fn().mockResolvedValue([{ connection, lastSyncedAt: null }]),
      },
    });

    await expect(orchestrator.orchestrateSyncJobs()).resolves.not.toThrow();

    expect(logger.error).toHaveBeenCalledWith('Active endpoint not found on provider', expect.anything());
    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('creates the first incremental sync job when none exists yet', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findActiveConnections: jest.fn().mockResolvedValue([activeConnection()]) },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'incremental', status: 'pending' }),
    );
  });

  it('does not create a duplicate incremental job while one is already pending', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findActiveConnections: jest.fn().mockResolvedValue([activeConnection()]) },
      connectionSyncJobService: {
        search: searchOver([makeSyncJob({ status: 'pending' })]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('does not create a second incremental job while a healthy one is in progress', async () => {
    // The inverted predicate, in one case. "Is anything already live?" was
    // answered by a test that counted an in-progress job only once it had gone
    // STALE — so a sync that had been running for a minute counted as nothing at
    // all, and every tick queued another job beside it for the same endpoint.
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findActiveConnections: jest.fn().mockResolvedValue([activeConnection()]) },
      connectionSyncJobService: {
        search: searchOver([
          makeSyncJob({
            id: 'running',
            status: 'in_progress',
            updatedAt: new Date(Date.now() - 60_000),
          }),
          makeSyncJob({
            id: 'done',
            status: 'success',
            nextCursor: { page: 3 },
            updatedAt: new Date(Date.now() - 10 * 60_000),
          }),
        ]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
    expect(connectionSyncJobService.markAsCompleted).not.toHaveBeenCalled();
  });

  it('does not create a second historical job while a healthy one is in progress', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: {
        findActiveConnections: jest
          .fn()
          .mockResolvedValue([{ connection: historicalConnection(), lastSyncedAt: null }]),
      },
      connectionSyncJobService: {
        search: searchOver([
          makeSyncJob({
            id: 'running',
            type: 'historical',
            status: 'in_progress',
            updatedAt: new Date(Date.now() - 60_000),
          }),
          makeSyncJob({
            id: 'done',
            type: 'historical',
            status: 'success',
            nextCursor: { page: 3 },
            completedAt: new Date(Date.now() - 10 * 60_000),
            updatedAt: new Date(Date.now() - 10 * 60_000),
          }),
        ]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('marks a stalled (> 1hr) in-progress incremental job failed and enqueues a fresh one', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findActiveConnections: jest.fn().mockResolvedValue([activeConnection()]) },
      connectionSyncJobService: {
        search: searchOver([
          makeSyncJob({
            id: 'stalled-job',
            status: 'in_progress',
            updatedAt: new Date(Date.now() - HOUR_MS - 60_000),
          }),
          makeSyncJob({
            id: 'done',
            status: 'success',
            nextCursor: { page: 4 },
            updatedAt: new Date(Date.now() - 3 * HOUR_MS),
          }),
        ]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.markAsCompleted).toHaveBeenCalledWith(
      expect.anything(),
      'stalled-job',
      'failed',
      expect.objectContaining({ error: 'Sync job stalled in progress' }),
    );
    expect(connectionSyncJobService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'incremental', cursor: { page: 4 }, status: 'pending' }),
    );
  });

  it("starts a new incremental job carrying forward the previous success's nextCursor once the interval has passed", async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findActiveConnections: jest.fn().mockResolvedValue([activeConnection()]) },
      connectionSyncJobService: {
        search: searchOver([
          makeSyncJob({
            status: 'success',
            nextCursor: { page: 9 },
            completedAt: new Date(Date.now() - 11 * 60_000),
            updatedAt: new Date(Date.now() - 11 * 60_000),
          }),
        ]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'incremental', cursor: { page: 9 }, status: 'pending' }),
    );
  });

  it('does not start the next incremental job until 10 minutes after the last success', async () => {
    // Only the FIRST incremental job on an endpoint is immediate (the
    // `creates the first incremental sync job` case above). After that the
    // sweep used to queue the next one the minute the previous one succeeded —
    // a provider call per endpoint per minute, and a sync job for the transform
    // sweep to spend a slot on, whether or not anything had changed.
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findActiveConnections: jest.fn().mockResolvedValue([activeConnection()]) },
      connectionSyncJobService: {
        search: searchOver([
          makeSyncJob({
            status: 'success',
            nextCursor: { page: 9 },
            completedAt: new Date(Date.now() - 9 * 60_000),
            updatedAt: new Date(Date.now() - 9 * 60_000),
          }),
        ]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('measures the interval from the most recently COMPLETED success, not the most recently touched one', async () => {
    // The transform sweep bumps updated_at when it claims/finishes a job, and
    // it drains oldest-first — so an old success is "touched" every minute.
    // Sorting the latest-success read on updated_at made that old job the
    // latest, its completedAt was long past the interval, and a new poll was
    // queued every tick regardless of the job that actually just finished.
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findActiveConnections: jest.fn().mockResolvedValue([activeConnection()]) },
      connectionSyncJobService: {
        search: searchOver([
          makeSyncJob({
            id: 'old-but-just-transformed',
            status: 'success',
            nextCursor: { page: 1 },
            completedAt: new Date(Date.now() - 40 * 60_000),
            updatedAt: new Date(),
          }),
          makeSyncJob({
            id: 'actually-latest',
            status: 'success',
            nextCursor: { page: 2 },
            completedAt: new Date(Date.now() - 2 * 60_000),
            updatedAt: new Date(Date.now() - 2 * 60_000),
          }),
        ]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('does not restart a finished historical walk from an old page that was merely re-transformed', async () => {
    // Same updated_at trap on the historical side, and worse: the old page
    // still carries its nextCursor, so "latest success has a cursor" queued a
    // job that re-fetched every page after it.
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: {
        findActiveConnections: jest
          .fn()
          .mockResolvedValue([{ connection: historicalConnection(undefined), lastSyncedAt: null }]),
      },
      connectionSyncJobService: {
        search: searchOver([
          makeSyncJob({
            id: 'page-1-just-transformed',
            type: 'historical',
            status: 'success',
            nextCursor: { nextLink: 'https://graph.example/page2' },
            completedAt: new Date(Date.now() - 60 * 60_000),
            updatedAt: new Date(),
          }),
          makeSyncJob({
            id: 'last-page',
            type: 'historical',
            status: 'success',
            nextCursor: {},
            completedAt: new Date(Date.now() - 50 * 60_000),
            updatedAt: new Date(Date.now() - 50 * 60_000),
          }),
        ]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('falls back to updatedAt for the interval when a success row carries no completedAt', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findActiveConnections: jest.fn().mockResolvedValue([activeConnection()]) },
      connectionSyncJobService: {
        search: searchOver([
          makeSyncJob({
            status: 'success',
            nextCursor: { page: 9 },
            completedAt: null,
            updatedAt: new Date(),
          }),
        ]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('leaves an endpoint whose only history is failures alone, rather than retrying it every minute', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findActiveConnections: jest.fn().mockResolvedValue([activeConnection()]) },
      connectionSyncJobService: {
        search: searchOver([makeSyncJob({ id: 'failed-1', status: 'failed' })]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('creates the first historical sync job when none exists yet', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: {
        findActiveConnections: jest
          .fn()
          .mockResolvedValue([{ connection: historicalConnection(), lastSyncedAt: null }]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'historical', status: 'pending' }),
    );
  });

  it('does not create a new historical job while one is pending or in progress', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: {
        findActiveConnections: jest
          .fn()
          .mockResolvedValue([{ connection: historicalConnection(), lastSyncedAt: null }]),
      },
      connectionSyncJobService: {
        search: searchOver([makeSyncJob({ type: 'historical', status: 'pending' })]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('starts a new historical job when the previous success left a nextCursor (more pages to fetch)', async () => {
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: {
        findActiveConnections: jest
          .fn()
          .mockResolvedValue([{ connection: historicalConnection(), lastSyncedAt: null }]),
      },
      connectionSyncJobService: {
        search: searchOver([
          makeSyncJob({
            type: 'historical',
            status: 'success',
            nextCursor: { page: 2 },
            completedAt: new Date(),
          }),
        ]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'historical', cursor: { page: 2 } }),
    );
  });

  it('re-triggers a completed historical sync once its TTL has elapsed', async () => {
    const longAgo = new Date(Date.now() - 120_000); // 120s ago > 60s TTL
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: {
        findActiveConnections: jest
          .fn()
          .mockResolvedValue([{ connection: historicalConnection(60), lastSyncedAt: null }]),
      },
      connectionSyncJobService: {
        search: searchOver([
          makeSyncJob({ type: 'historical', status: 'success', nextCursor: {}, completedAt: longAgo }),
        ]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'historical', status: 'pending' }),
    );
  });

  it('does NOT re-trigger a completed historical sync before its TTL has elapsed', async () => {
    const justNow = new Date(Date.now() - 1000); // 1s ago, well under the 1hr TTL
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: {
        findActiveConnections: jest
          .fn()
          .mockResolvedValue([{ connection: historicalConnection(3600), lastSyncedAt: null }]),
      },
      connectionSyncJobService: {
        search: searchOver([
          makeSyncJob({ type: 'historical', status: 'success', nextCursor: {}, completedAt: justNow }),
        ]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('processes every remaining connection even when one earlier in the sweep has a missing-endpoint error', async () => {
    const badConnection = makeConnection({ id: 'bad-conn', activeEndpoints: ['ghost'] });
    const goodConnection = makeConnection({ id: 'good-conn' });

    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: {
        findActiveConnections: jest.fn().mockResolvedValue([
          { connection: badConnection, lastSyncedAt: null },
          { connection: goodConnection, lastSyncedAt: null },
        ]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ connectionId: 'good-conn' }),
    );
  });

  it('bounds every read it makes, instead of fetching an endpoint’s whole history', async () => {
    // The cost, not the correctness: one search per connection × endpoint ×
    // iteration type, each returning every job that endpoint has ever run, once
    // a minute — of which the sweep used `[0]` and `.length`.
    const { orchestrator, connectionSyncJobService } = buildOrchestrator({
      connectionService: { findActiveConnections: jest.fn().mockResolvedValue([activeConnection()]) },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(connectionSyncJobService.search).toHaveBeenCalled();

    for (const [, query] of connectionSyncJobService.search.mock.calls as Array<
      [unknown, SearchConnectionSyncJobDto]
    >) {
      expect(query.limit).toBe(1);
      expect(query.connectionId).toBe('conn-1');
      expect(query.endpointName).toBe('messages');
    }
  });

  it('does not start a second sweep while the previous one is still running', async () => {
    // The cron has a one-minute period and the sweep is a database round trip
    // per connection × endpoint × iteration type, so a slow tick meets the next
    // one. Without the guard both sweeps read the same state and both act on it.
    let releaseFirstSweep: () => void = () => undefined;

    const firstSweepGate = new Promise<void>((resolve) => {
      releaseFirstSweep = () => resolve();
    });

    const findActiveConnections = jest.fn(async () => {
      await firstSweepGate;

      return [];
    });

    const { orchestrator, logger } = buildOrchestrator({
      connectionService: { findActiveConnections },
    });

    const firstTick = orchestrator.orchestrateSyncJobs();

    // Let the feature-flag await settle so the first tick is genuinely inside
    // the sweep, which is the state the second tick has to find.
    await new Promise((resolve) => setImmediate(resolve));

    expect(findActiveConnections).toHaveBeenCalledTimes(1);

    // Started but not awaited: an unguarded second tick walks straight into the
    // sweep and blocks on the same gate, so awaiting it here would report the
    // defect as a test timeout instead of as the extra call it is.
    const secondTick = orchestrator.orchestrateSyncJobs();

    await new Promise((resolve) => setImmediate(resolve));

    expect(findActiveConnections).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Skipping sync orchestration; previous run still in progress');

    releaseFirstSweep();
    await Promise.all([firstTick, secondTick]);

    // And the guard clears: a skipped tick must not disable the schedule.
    await orchestrator.orchestrateSyncJobs();

    expect(findActiveConnections).toHaveBeenCalledTimes(2);
  });

  it('clears the overlap guard even when the sweep throws', async () => {
    // A flag set outside a `try`/`finally` would latch on the first failure and
    // silently retire the schedule. The @Cron wrapper swallows the throw (it
    // logs and returns), so nothing else would report it either.
    const findActiveConnections = jest
      .fn()
      .mockRejectedValueOnce(new Error('pool timeout'))
      .mockResolvedValue([]);

    const { orchestrator } = buildOrchestrator({ connectionService: { findActiveConnections } });

    await orchestrator.orchestrateSyncJobs();
    await orchestrator.orchestrateSyncJobs();

    expect(findActiveConnections).toHaveBeenCalledTimes(2);
  });
});

describe('SyncOrchestrator — scheduled.connection.sync', () => {
  it('creates no sync job when the feature is off, even with an active connection due for one', async () => {
    const { orchestrator, connectionSyncJobService, featureService } = buildOrchestrator({
      syncFeatureEnabled: false,
      connectionService: {
        findActiveConnections: jest
          .fn()
          .mockResolvedValue([{ connection: makeConnection(), lastSyncedAt: null }]),
      },
    });

    await orchestrator.orchestrateSyncJobs();

    expect(featureService.isFeatureEnabled).toHaveBeenCalledWith('scheduled.connection.sync');
    expect(connectionSyncJobService.create).not.toHaveBeenCalled();
  });

  it('enqueues no execute event when the feature is off, even with a job already pending', async () => {
    const { orchestrator, eventService } = buildOrchestrator({
      syncFeatureEnabled: false,
      connectionSyncJobService: {
        search: jest
          .fn()
          .mockImplementation(async (_ctx, filter: { status: string }) =>
            filter.status === 'pending' ? [makeSyncJob({ id: 'job-pending' })] : [],
          ),
      },
    });

    await orchestrator.executeSyncJobs();

    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('enqueues no transform event when the feature is off, even with untransformed jobs waiting', async () => {
    const { orchestrator, eventService } = buildOrchestrator({
      syncFeatureEnabled: false,
      connectionSyncJobService: {
        search: jest.fn().mockResolvedValue([makeSyncJob({ id: 'j1' }), makeSyncJob({ id: 'j2' })]),
      },
    });

    await orchestrator.executeTransformJobs();

    expect(eventService.send).not.toHaveBeenCalled();
  });
});

/**
 * The de-duplication ImportStageListener's own dedicated test
 * (importStageListenerRole.test.ts) pins: asserting a mocked `events.send`
 * carries a `singletonKey` can never observe whether the QUEUE enforces it —
 * pg-boss 10 makes de-duplication a queue property (its unique index on
 * (name, singleton_key) is partial, `WHERE state='created' AND
 * policy='short'`), and under the default `standard` policy a singletonKey is
 * stored but never enforced. This asserts the queue DECLARATION itself.
 */
describe("SyncOrchestrator's 'etl' queue policy", () => {
  it("declares policy 'short' on the shared etl queue, so singletonKey bites", () => {
    expect(EventListenerRegistry.getQueueOptions('etl')?.policy).toBe('short');
  });
});

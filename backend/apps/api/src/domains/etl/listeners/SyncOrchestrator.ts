import { Injectable } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';

import { SYSTEM_USER } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';
import { ConnectionService, ClientFactory } from '@ci/domains/connections';
import { OnEvent, EventService } from '@ci/domains/events';

import { ConnectionSyncJobExecuteEvent, ConnectionSyncJobTransformEvent } from '../events';
import { ConnectionSyncJobService } from '../services/ConnectionSyncJobService';
import { EndpointServiceMap } from '../services/EndpointServiceMap';

@Injectable()
export class SyncOrchestrator {
  constructor(
    private readonly connectionService: ConnectionService,
    private readonly connectionSyncJobService: ConnectionSyncJobService,
    private readonly eventService: EventService,
    private readonly endpointServiceMap: EndpointServiceMap,
    private readonly clientFactory: ClientFactory,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SyncOrchestrator.name);
  }

  /**
   * This method creates sync jobs for connection endpoints that are ready to be run again.
   * For incremental syncs, this is where there are no prior ones, or the last one was successful.
   * For historical syncs, this is where there are no prior ones, or the last one was successful and has a nextCursor,
   * or the last one was successful and has no nextCursor but was completed more than TTL ago.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async orchestrateSyncJobs(): Promise<void> {
    const activeConnections = await this.connectionService.findActiveConnections();

    activeConnections.forEach(({ connection }) => {
      connection.activeEndpoints.forEach(async (endpoint) => {
        const providerEndpoint = connection.provider!.endpoints.find((e) => e.name === endpoint);
        if (!providerEndpoint) {
          this.logger.error('Active endpoint not found on provider', {
            connectionId: connection.id,
            endpoint,
          });

          return;
        }

        const iterationType = providerEndpoint.iterationType;

        const iterationTypes = iterationType.split(',');

        if (iterationTypes.includes('incremental')) {
          const existingIncrementalSyncs = await this.connectionSyncJobService.search(
            { userId: connection.userId },
            {
              connectionId: connection.id,
              userId: connection.userId,
              endpointName: endpoint,
              type: 'incremental',
            },
          );

          if (existingIncrementalSyncs.length === 0) {
            await this.connectionSyncJobService.create(
              { userId: connection.userId },
              {
                connectionId: connection.id,
                userId: connection.userId,
                endpointName: endpoint,
                type: 'incremental',
                status: 'pending',
              },
            );
          } else {
            const pendingOrInProgress = existingIncrementalSyncs.some(
              (sync) =>
                sync.status === 'pending' ||
                (sync.status === 'in_progress' &&
                  new Date().getTime() > new Date(sync.updatedAt).getTime() + 60 * 60 * 1000),
            );
            const successes = existingIncrementalSyncs.filter((sync) => sync.status === 'success');
            const stalledInProgress = existingIncrementalSyncs.filter(
              (sync) =>
                sync.status === 'in_progress' &&
                new Date().getTime() > new Date(sync.updatedAt).getTime() + 60 * 60 * 1000,
            );

            if (stalledInProgress) {
              stalledInProgress.forEach(async (sync) => {
                await this.connectionSyncJobService.markAsCompleted(
                  { userId: connection.userId },
                  sync.id,
                  'failed',
                  { error: 'Sync job stalled in progress' },
                );
              });
            }

            if (successes.length > 0 && (!pendingOrInProgress || stalledInProgress.length > 0)) {
              const success0 = successes[0];
              await this.connectionSyncJobService.create(
                { userId: connection.userId },
                {
                  connectionId: connection.id,
                  userId: connection.userId,
                  endpointName: endpoint,
                  type: 'incremental',
                  cursor: success0.nextCursor,
                  status: 'pending',
                },
              );
            }
          }
        }

        if (iterationTypes.includes('historical')) {
          const existingHistoricalSyncs = await this.connectionSyncJobService.search(
            { userId: connection.userId },
            {
              connectionId: connection.id,
              userId: connection.userId,
              endpointName: endpoint,
              type: 'historical',
            },
          );

          if (existingHistoricalSyncs.length === 0) {
            await this.connectionSyncJobService.create(
              { userId: connection.userId },
              {
                connectionId: connection.id,
                userId: connection.userId,
                endpointName: endpoint,
                type: 'historical',
                status: 'pending',
              },
            );
          } else {
            const pendingOrInProgress = existingHistoricalSyncs.some(
              (sync) =>
                sync.status === 'pending' ||
                (sync.status === 'in_progress' &&
                  new Date().getTime() > new Date(sync.updatedAt).getTime() + 60 * 60 * 1000),
            );
            const successes = existingHistoricalSyncs.filter((sync) => sync.status === 'success');
            const stalledInProgress = existingHistoricalSyncs.filter(
              (sync) =>
                sync.status === 'in_progress' &&
                new Date().getTime() > new Date(sync.updatedAt).getTime() + 60 * 60 * 1000,
            );

            if (stalledInProgress.length > 0) {
              stalledInProgress.forEach(async (sync) => {
                await this.connectionSyncJobService.markAsCompleted(
                  { userId: connection.userId },
                  sync.id,
                  'failed',
                  { error: 'Sync job stalled in progress' },
                );
              });
            }

            if (pendingOrInProgress) {
              return;
            }

            if (successes.length > 0) {
              const success0 = successes[0];
              if (Object.keys(success0.nextCursor).length > 0) {
                await this.connectionSyncJobService.create(
                  { userId: connection.userId },
                  {
                    connectionId: connection.id,
                    userId: connection.userId,
                    endpointName: endpoint,
                    type: 'historical',
                    status: 'pending',
                    cursor: success0.nextCursor,
                  },
                );
              }

              if (
                Object.keys(success0.nextCursor).length === 0 &&
                success0.completedAt &&
                providerEndpoint.TTL != null
              ) {
                const dateNow = new Date().getTime();
                const completedAt = new Date(success0.completedAt).getTime();

                if (dateNow > completedAt + providerEndpoint.TTL * 1000) {
                  await this.connectionSyncJobService.create(
                    { userId: connection.userId },
                    {
                      connectionId: connection.id,
                      userId: connection.userId,
                      endpointName: endpoint,
                      type: 'historical',
                      status: 'pending',
                    },
                  );
                }
              }
            }
          }
        }
      });
    });
  }

  /**
   * This method finds sync jobs that are ready to be run (status pending) and executes them.
   * It will only execute one endpoint job per connection to avoid rate limits.
   * It will also limit itself to 5 total jobs in progress to avoid overwhelming the system.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async executeSyncJobs(): Promise<void> {
    const pendingSyncJobs = await this.connectionSyncJobService.search(
      { userId: SYSTEM_USER },
      {
        status: 'pending',
        orderBy: 'updated_at:asc',
      },
    );

    const inProgressSyncJobs = await this.connectionSyncJobService.search(
      { userId: SYSTEM_USER },
      {
        status: 'in_progress',
      },
    );

    const connectionsToRun = new Set<string>();
    const syncJobsToRun = new Set<string>();

    for (const syncJob of inProgressSyncJobs) {
      connectionsToRun.add(syncJob.connectionId);
    }

    for (const syncJob of pendingSyncJobs) {
      if (connectionsToRun.has(syncJob.connectionId)) {
        continue;
      } else {
        connectionsToRun.add(syncJob.connectionId);
        syncJobsToRun.add(syncJob.id);
      }

      if (syncJobsToRun.size + inProgressSyncJobs.length >= 5) {
        break;
      }
    }

    for (const jobId of syncJobsToRun) {
      await this.eventService.send(ConnectionSyncJobExecuteEvent, {
        connectionSyncJobId: jobId,
      });
    }
  }

  @OnEvent(ConnectionSyncJobExecuteEvent, { queue: 'etl' })
  async handleSyncJobExecuteEvent(payload: { connectionSyncJobId: string }): Promise<void> {
    const syncJob = await this.connectionSyncJobService.findById(
      { userId: SYSTEM_USER },
      payload.connectionSyncJobId,
    );

    if (!syncJob) {
      this.logger.error('Sync job not found for execution', {
        connectionSyncJobId: payload.connectionSyncJobId,
      });

      return;
    }

    await this.connectionSyncJobService.update({ userId: SYSTEM_USER }, syncJob.id, {
      status: 'in_progress',
    });

    let connection = await this.connectionService.findById({ userId: SYSTEM_USER }, syncJob.connectionId);

    if (!connection) {
      this.logger.error('Connection not found for sync job execution', {
        connectionId: syncJob.connectionId,
        connectionSyncJobId: syncJob.id,
      });

      await this.connectionSyncJobService.markAsCompleted({ userId: SYSTEM_USER }, syncJob.id, 'failed', {
        error: 'Connection not found',
      });

      return;
    }

    if (!connection.provider) {
      this.logger.error('Provider not found for connection during sync job execution', {
        connectionId: connection.id,
        connectionSyncJobId: syncJob.id,
      });

      await this.connectionSyncJobService.markAsCompleted({ userId: SYSTEM_USER }, syncJob.id, 'failed', {
        error: 'Provider not found for connection',
      });

      return;
    }

    const { refreshToken, tokenExpiry } = connection;
    const client = this.clientFactory.getClientByProviderId(connection.provider?.id);

    if (refreshToken && tokenExpiry && new Date(tokenExpiry) < new Date()) {
      let newCredentials;
      const refreshCredentials = await client.refreshAccessToken(connection);

      //Some providers explicitly return null for refreshToken, which was overwriting the
      //existing refreshToken. Strip it out in those cases.
      if (refreshCredentials.refreshToken == null) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { refreshToken, ...stripped } = refreshCredentials;
        newCredentials = stripped;
      } else {
        newCredentials = { ...refreshCredentials };
      }

      connection = await this.connectionService.update({ userId: connection.userId }, connection.id, {
        ...newCredentials,
      });
    }

    const providerName = connection!.provider!.name;

    const serviceFunction = this.endpointServiceMap.getSyncFunction(providerName!, syncJob.endpointName);

    if (!serviceFunction) {
      this.logger.error('No service function found for provider and endpoint', {
        providerName,
        endpointName: syncJob.endpointName,
      });

      await this.connectionSyncJobService.markAsCompleted({ userId: SYSTEM_USER }, syncJob.id, 'failed', {
        error: 'No service function found for provider and endpoint',
      });

      return;
    }

    try {
      const results = await serviceFunction({
        connection: connection!,
        client,
        nextCursor: syncJob.cursor!,
        historical: syncJob.type === 'historical',
      });

      await this.connectionSyncJobService.update({ userId: SYSTEM_USER }, syncJob.id, {
        data: results.data,
        nextCursor: results.nextCursor || {},
        error: undefined,
        status: 'success',
        completedAt: new Date(),
      });
    } catch (err) {
      this.logger.error('Error executing sync job', {
        connectionSyncJobId: syncJob.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });

      await this.connectionSyncJobService.markAsCompleted({ userId: SYSTEM_USER }, syncJob.id, 'failed', {
        error: err,
      });
    }
  }

  /**
   * This method finds sync jobs that need to be transformed, retrieves their data, then
   * calls the appropriate transformation function based on the connection and endpoint.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async executeTransformJobs(): Promise<void> {
    const syncJobsToTransform = (
      await this.connectionSyncJobService.search(
        { userId: SYSTEM_USER },
        {
          status: 'success',
          lastTransformed: null,
        },
      )
    ).slice(0, 10);

    for (const { id } of syncJobsToTransform) {
      await this.eventService.send(ConnectionSyncJobTransformEvent, {
        connectionSyncJobId: id,
      });
    }
  }

  @OnEvent(ConnectionSyncJobTransformEvent, { queue: 'etl' })
  async handleSyncJobTransformEvent(payload: { connectionSyncJobId: string }): Promise<void> {
    const syncJob = await this.connectionSyncJobService.findById(
      { userId: SYSTEM_USER },
      payload.connectionSyncJobId,
    );

    if (!syncJob) {
      this.logger.error('Sync job not found for transformation', {
        connectionSyncJobId: payload.connectionSyncJobId,
      });

      return;
    }

    const connection = await this.connectionService.findById({ userId: SYSTEM_USER }, syncJob.connectionId);

    if (!connection) {
      this.logger.error('Connection not found for transformation', {
        connectionSyncJobId: payload.connectionSyncJobId,
      });

      return;
    }

    const providerName = connection!.provider!.name;

    const serviceFunction = this.endpointServiceMap.getTransformFunction(providerName!, syncJob.endpointName);

    if (!serviceFunction) {
      this.logger.error('No service function found for provider and endpoint transform', {
        providerName,
        endpointName: syncJob.endpointName,
      });

      return;
    }

    try {
      await serviceFunction({
        syncJob,
        connection,
      });

      await this.connectionSyncJobService.update({ userId: SYSTEM_USER }, syncJob.id, {
        lastTransformed: new Date(),
      });

      await this.logger.log('Successfully transformed sync job', {
        connectionSyncJobId: syncJob.id,
      });
    } catch (err) {
      this.logger.error('Error executing sync job', {
        connectionSyncJobId: syncJob.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }
}

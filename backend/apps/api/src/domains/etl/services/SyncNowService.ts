import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { ConnectionService } from '@ci/domains/connections';

import { ConnectionSyncJobService } from './ConnectionSyncJobService';

export interface SyncNowResult {
  jobIds: string[];
  enqueued: number;
  skipped: number;
  /**
   * Set when `scheduled.connection.sync` is off. The executor that drains these
   * rows is gated on the same flag, so enqueuing anyway would hand the caller a
   * job id for work that cannot start until an operator flips the switch back.
   */
  disabledReason?: 'scheduled_sync_disabled';
}

@Injectable()
export class SyncNowService {
  constructor(
    private readonly connectionService: ConnectionService,
    private readonly connectionSyncJobService: ConnectionSyncJobService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SyncNowService.name);
  }

  /**
   * Enqueue pending incremental sync jobs for each active endpoint on the caller's
   * connections, skipping endpoints that already have pending/in-progress work.
   */
  async enqueueForUser(context: UserServiceContext): Promise<SyncNowResult> {
    if (!(await this.featureService.isFeatureEnabled('scheduled.connection.sync'))) {
      this.logger.log('Refusing sync-now: scheduled connection sync is switched off', {
        userId: context.userId,
      });

      return { jobIds: [], enqueued: 0, skipped: 0, disabledReason: 'scheduled_sync_disabled' };
    }

    const connections = await this.connectionService.findAll(context);
    const activeConnections = connections.filter((c) => c.active && !c.needsReauth);

    const endpointCount = activeConnections.reduce((count, c) => count + c.activeEndpoints.length, 0);

    if (endpointCount === 0) {
      return { jobIds: [], enqueued: 0, skipped: 0 };
    }

    const hasActivePipeline = await this.userHasActiveSyncPipeline(context);

    if (hasActivePipeline) {
      this.logger.log('Skipping sync-now: user already has pending, running, or untransformed sync work', {
        userId: context.userId,
      });

      return { jobIds: [], enqueued: 0, skipped: endpointCount };
    }

    const jobIds: string[] = [];
    let skipped = 0;

    for (const connection of activeConnections) {
      for (const endpoint of connection.activeEndpoints) {
        const existing = await this.connectionSyncJobService.search(context, {
          connectionId: connection.id,
          userId: context.userId,
          endpointName: endpoint,
          orderBy: 'updated_at:DESC',
        });

        const hasPendingOrRunning = existing.some(
          (job) =>
            job.status === 'pending' ||
            (job.status === 'in_progress' && Date.now() - new Date(job.updatedAt).getTime() < 60 * 60 * 1000),
        );

        if (hasPendingOrRunning) {
          skipped += 1;
          continue;
        }

        const job = await this.connectionSyncJobService.create(context, {
          connectionId: connection.id,
          userId: context.userId,
          endpointName: endpoint,
          type: 'incremental',
          status: 'pending',
        });

        jobIds.push(job.id);
      }
    }

    return {
      jobIds,
      enqueued: jobIds.length,
      skipped,
    };
  }

  /**
   * True when the user already has sync work in flight or fetched data awaiting transform.
   * Enqueueing more jobs in that state stacks heavy calendar transforms in the API process.
   *
   * "Awaiting transform" is what the transform sweep will pick up: rows the executor fetched, on
   * connections that are active. A paused connection's fetched data waits for it to come back, so
   * counting it here would turn "Sync now" off for every other connection until then.
   */
  private async userHasActiveSyncPipeline(context: UserServiceContext): Promise<boolean> {
    // `limit: 1`: only whether any row exists is read, and each row carries its whole `data`
    // payload, so without it this hydrated every waiting job's fetch result to count them.
    const [pending, inProgress, awaitingTransform] = await Promise.all([
      this.connectionSyncJobService.search(context, {
        status: 'pending',
        orderBy: 'updated_at:DESC',
        limit: 1,
      }),
      this.connectionSyncJobService.search(context, {
        status: 'in_progress',
        orderBy: 'updated_at:DESC',
        limit: 1,
      }),
      this.connectionSyncJobService.search(context, {
        status: 'success',
        lastTransformed: null,
        fetchedByExecutor: true,
        connectionActive: true,
        orderBy: 'updated_at:DESC',
        limit: 1,
      }),
    ]);

    return pending.length > 0 || inProgress.length > 0 || awaitingTransform.length > 0;
  }
}

import { Controller } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';
import config from '@ci/configuration';

import { EtlService } from '../services/EtlService';

interface ConnectionWithUser {
  id: string;
  userId: string;
  schedule: string | null;
  lastSyncedAt?: Date;
  createdAt: Date;
}

@Controller('etl')
export class EtlController {
  private logger = new LoggerService(EtlController.name);

  constructor(private readonly etlService: EtlService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async syncConnections(): Promise<void> {
    if (!config.features['scheduled.connection.sync']) {
      return;
    }

    try {
      const connections = await this.etlService.findActiveConnections();
      const now = new Date();

      for (const connection of connections) {
        if (this.shouldSyncConnection(connection, now)) {
          await this.syncConnection(connection);
        }
      }
    } catch (error) {
      this.logger.error('Error syncing connections', error as Error);
    }
  }

  private shouldSyncConnection(connection: ConnectionWithUser, now: Date): boolean {
    if (!connection.schedule) {
      return false;
    }

    // Use lastSyncedAt if available, otherwise use createdAt
    const lastSync = connection.lastSyncedAt || connection.createdAt;
    const timeSinceLastSync = now.getTime() - lastSync.getTime();

    const scheduleInterval = this.getScheduleIntervalMs(connection.schedule);

    return timeSinceLastSync >= scheduleInterval;
  }

  private getScheduleIntervalMs(schedule: string): number {
    const intervals: Record<string, number> = {
      '1 min': 1 * 60 * 1000, // 1 minute
      '5 min': 5 * 60 * 1000, // 5 minutes
      '10 min': 10 * 60 * 1000, // 10 minutes
      '30 min': 30 * 60 * 1000, // 30 minutes
      '1 hour': 60 * 60 * 1000, // 1 hour
      '2 hours': 2 * 60 * 60 * 1000, // 2 hours
      '6 hours': 6 * 60 * 60 * 1000, // 6 hours
      '12 hours': 12 * 60 * 60 * 1000, // 12 hours
      daily: 24 * 60 * 60 * 1000, // 24 hours
      weekly: 7 * 24 * 60 * 60 * 1000, // 7 days
    };

    return intervals[schedule] || 60 * 60 * 1000;
  }

  private async syncConnection(connection: ConnectionWithUser): Promise<void> {
    try {
      await this.etlService.handleConnectionSync(
        { userId: connection.userId } as RequestContext,
        connection.id,
      );
    } catch (error) {
      this.logger.error('Error syncing connection', {
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

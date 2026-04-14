import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';

import { ConnectionSyncJob } from '../../../types';

@Injectable()
export class GitHubEventsTransformService {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(GitHubEventsTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }) {
    const { userId, data } = syncJob;

    this.logger.log('Starting GitHub Events transformation', {
      userId,
      connectionId: connection.id,
    });

    const eventsMap = (data?.events as Record<string, unknown[]>) || {};

    const totalEvents = Object.values(eventsMap).reduce((sum, arr) => sum + arr.length, 0);

    if (totalEvents === 0) {
      this.logger.log('No GitHub events found to transform', {
        userId,
        connectionId: connection.id,
      });

      return;
    }

    // TODO: Implement transformation once actual data shape is known
    this.logger.log('GitHub Events transformation stubbed — not yet implemented', {
      userId,
      connectionId: connection.id,
      repoCount: Object.keys(eventsMap).length,
      totalEvents,
    });
  }
}


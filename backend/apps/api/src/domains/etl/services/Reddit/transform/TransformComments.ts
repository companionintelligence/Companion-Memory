import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';

import { ConnectionSyncJob } from '../../../types';
import type { RedditComment } from '../sync/redditListing';

import { RedditRecordWriter, commentRecord } from './RedditRecordWriter';

/**
 * The user's own comments (the `comments` listing).
 * Each one becomes the same communication (+ media content) row the GDPR
 * export importer writes for it — see {@link RedditRecordWriter}.
 */
@Injectable()
export class RedditCommentsTransformService {
  constructor(
    private readonly writer: RedditRecordWriter,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RedditCommentsTransformService.name);
  }

  async transform({ connection, syncJob }: { connection: Connection; syncJob: ConnectionSyncJob }) {
    const { userId, data } = syncJob;

    this.logger.log('Starting Reddit comments transformation', {
      userId,
      connectionId: connection.id,
    });

    const items = (data?.comments as RedditComment[]) || [];

    if (items.length === 0) {
      this.logger.log('No Reddit comments found to transform', {
        userId,
        connectionId: connection.id,
      });

      return;
    }

    const outcomes = { created: 0, updated: 0, content_only: 0 };

    for (const item of items) {
      try {
        outcomes[await this.writer.write({ userId, connection }, commentRecord(item))] += 1;
      } catch (error) {
        // Per-row isolation, matching Slack/Gmail/Signal's transforms:
        // SyncOrchestrator marks a job lastTransformed even on an uncaught
        // error, so one bad row here would otherwise silently drop the rest
        // of this sync batch with no retry.
        this.logger.error('Failed to transform Reddit comment', {
          userId,
          connectionId: connection.id,
          name: item.name,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log('Reddit comments transformation completed', {
      userId,
      connectionId: connection.id,
      total: items.length,
      ...outcomes,
    });
  }
}

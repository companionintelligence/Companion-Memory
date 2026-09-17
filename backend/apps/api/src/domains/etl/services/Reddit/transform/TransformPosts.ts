import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';

import { ConnectionSyncJob } from '../../../types';
import type { RedditPost } from '../sync/redditListing';

import { RedditRecordWriter, postRecord } from './RedditRecordWriter';

/**
 * The user's own posts (the `submitted` listing).
 * Each one becomes the same communication (+ media content) row the GDPR
 * export importer writes for it — see {@link RedditRecordWriter}.
 */
@Injectable()
export class RedditPostsTransformService {
  constructor(
    private readonly writer: RedditRecordWriter,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RedditPostsTransformService.name);
  }

  async transform({ connection, syncJob }: { connection: Connection; syncJob: ConnectionSyncJob }) {
    const { userId, data } = syncJob;

    this.logger.log('Starting Reddit posts transformation', {
      userId,
      connectionId: connection.id,
    });

    const items = (data?.posts as RedditPost[]) || [];

    if (items.length === 0) {
      this.logger.log('No Reddit posts found to transform', {
        userId,
        connectionId: connection.id,
      });

      return;
    }

    const outcomes = { created: 0, updated: 0, content_only: 0 };

    for (const item of items) {
      try {
        outcomes[await this.writer.write({ userId, connection }, postRecord(item))] += 1;
      } catch (error) {
        // Per-row isolation, matching Slack/Gmail/Signal's transforms:
        // SyncOrchestrator marks a job lastTransformed even on an uncaught
        // error, so one bad row here would otherwise silently drop the rest
        // of this sync batch with no retry.
        this.logger.error('Failed to transform Reddit post', {
          userId,
          connectionId: connection.id,
          name: item.name,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log('Reddit posts transformation completed', {
      userId,
      connectionId: connection.id,
      total: items.length,
      ...outcomes,
    });
  }
}

import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';

import { ConnectionSyncJob } from '../../../types';
import type { RedditSavedItem } from '../sync/redditListing';

import { RedditRecordWriter, savedRecord } from './RedditRecordWriter';

/**
 * Posts and comments the user saved (the `saved` listing, a mix of both).
 * Each one becomes the same content-only row the GDPR export importer writes
 * for it — no communication, because neither side knows WHEN it was saved —
 * see {@link RedditRecordWriter}.
 */
@Injectable()
export class RedditSavedTransformService {
  constructor(
    private readonly writer: RedditRecordWriter,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RedditSavedTransformService.name);
  }

  async transform({ connection, syncJob }: { connection: Connection; syncJob: ConnectionSyncJob }) {
    const { userId, data } = syncJob;

    this.logger.log('Starting Reddit saved items transformation', {
      userId,
      connectionId: connection.id,
    });

    const items = (data?.saved as RedditSavedItem[]) || [];

    if (items.length === 0) {
      this.logger.log('No Reddit saved items found to transform', {
        userId,
        connectionId: connection.id,
      });

      return;
    }

    const outcomes = { created: 0, updated: 0, content_only: 0 };

    for (const item of items) {
      try {
        outcomes[await this.writer.write({ userId, connection }, savedRecord(item))] += 1;
      } catch (error) {
        // Per-row isolation, matching Slack/Gmail/Signal's transforms:
        // SyncOrchestrator marks a job lastTransformed even on an uncaught
        // error, so one bad row here would otherwise silently drop the rest
        // of this sync batch with no retry.
        this.logger.error('Failed to transform Reddit saved item', {
          userId,
          connectionId: connection.id,
          name: item.name,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log('Reddit saved items transformation completed', {
      userId,
      connectionId: connection.id,
      total: items.length,
      ...outcomes,
    });
  }
}

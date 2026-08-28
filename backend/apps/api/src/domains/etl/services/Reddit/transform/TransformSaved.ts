import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, EventService, SOURCE_NATIVE_EXTERNAL_ID_KIND } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import type { RedditSavedItem } from '../sync/redditListing';

@Injectable()
export class RedditSavedTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
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

    const savedItems = (data?.saved as RedditSavedItem[]) || [];

    if (savedItems.length === 0) {
      this.logger.log('No Reddit saved items found to transform', {
        userId,
        connectionId: connection.id,
      });

      return;
    }

    for (const item of savedItems) {
      const permalink = item.permalink.startsWith('http')
        ? item.permalink
        : `https://www.reddit.com${item.permalink}`;

      const isComment = item.name.startsWith('t1_');
      const contentType = isComment ? 'reddit_comment' : 'reddit_post';
      const eventType = isComment ? 'reddit_saved_comment' : 'reddit_saved_post';
      const sourceSystem = 'reddit_saved';
      const title = isComment
        ? `Saved comment on "${item.link_title}" in r/${item.subreddit}`
        : `Saved post in r/${item.subreddit}: ${item.title || item.name}`;
      const text = isComment ? item.body || '' : item.selftext || item.title || '';

      const existingContent = await this.contentService.search({ userId }, { external_id: item.name });

      if (existingContent.length === 0) {
        await this.contentService.create(
          { userId },
          {
            connection_id: connection.id,
            type: contentType,
            title,
            text,
            url: permalink,
            external_id: item.name,
            external_id_kind: SOURCE_NATIVE_EXTERNAL_ID_KIND,
            source_url: permalink,
            source_data: {
              reddit_item_id: item.id,
              subreddit: item.subreddit,
              saved: true,
              score: item.score,
            },
          },
        );
      }

      const existingEvent = await this.eventService.search(
        { userId },
        {
          sourceSystem,
          sourceId: item.name,
        },
      );

      if (existingEvent.length === 0) {
        await this.eventService.create(
          { userId },
          {
            connection_id: connection.id,
            event_type: eventType,
            source_id: item.name,
            start_time: new Date(item.created_utc * 1000),
            title,
            description: text,
            source_system: sourceSystem,
          },
        );
      }
    }

    this.logger.log('Reddit saved items transformation completed', {
      userId,
      connectionId: connection.id,
      totalItems: savedItems.length,
    });
  }
}

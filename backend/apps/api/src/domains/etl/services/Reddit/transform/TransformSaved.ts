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
      try {
        await this.transformOne(item, { connection, userId });
      } catch (error) {
        // Per-row isolation, matching Slack/Gmail/Signal's transforms:
        // SyncOrchestrator marks a job lastTransformed even on an uncaught
        // error, so one bad row here would otherwise silently drop the rest
        // of this sync batch with no retry.
        this.logger.error('Failed to transform Reddit saved item', {
          userId,
          connectionId: connection.id,
          itemName: item.name,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log('Reddit saved items transformation completed', {
      userId,
      connectionId: connection.id,
      totalItems: savedItems.length,
    });
  }

  private async transformOne(
    item: RedditSavedItem,
    { connection, userId }: { connection: Connection; userId: string },
  ): Promise<void> {
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
          // content_source_triple_uniq backstops the racy search-then-create
          // above. source_system is 'reddit' (matching the posts/comments
          // transforms) because the content row IS the post or comment —
          // whichever transform writes it first owns the key.
          source_type: 'ETL',
          source_system: 'reddit',
          source_id: item.name,
          source_url: permalink,
          source_data: {
            reddit_item_id: item.id,
            subreddit: item.subreddit,
            saved: true,
            score: item.score,
            // RedditSavedItem has no is_self flag (unlike RedditPost), so a
            // link post is identified by its url differing from its own
            // permalink — a self post's url is the permalink itself.
            ...(!isComment && item.url && item.url !== permalink ? { link_url: item.url } : {}),
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
          // Without source_type, EventService.createOne skips its
          // find-or-create AND events_source_triple_uniq treats the row as
          // NULL-distinct — only the search above stood between a replay
          // and a duplicate.
          source_type: 'ETL',
          source_id: item.name,
          start_time: new Date(item.created_utc * 1000),
          title,
          description: text,
          source_system: sourceSystem,
        },
      );
    }
  }
}

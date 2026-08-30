import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, CalendarEventService, SOURCE_NATIVE_EXTERNAL_ID_KIND } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import type { RedditPost } from '../sync/redditListing';

@Injectable()
export class RedditPostsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: CalendarEventService,
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

    const posts = (data?.posts as RedditPost[]) || [];

    if (posts.length === 0) {
      this.logger.log('No Reddit posts found to transform', {
        userId,
        connectionId: connection.id,
      });

      return;
    }

    for (const post of posts) {
      try {
        await this.transformOne(post, { connection, userId });
      } catch (error) {
        // Per-row isolation, matching Slack/Gmail/Signal's transforms:
        // SyncOrchestrator marks a job lastTransformed even on an uncaught
        // error, so one bad row here would otherwise silently drop the rest
        // of this sync batch with no retry.
        this.logger.error('Failed to transform Reddit post', {
          userId,
          connectionId: connection.id,
          postName: post.name,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log('Reddit posts transformation completed', {
      userId,
      connectionId: connection.id,
      totalPosts: posts.length,
    });
  }

  private async transformOne(
    post: RedditPost,
    { connection, userId }: { connection: Connection; userId: string },
  ): Promise<void> {
    const permalink = post.permalink.startsWith('http')
      ? post.permalink
      : `https://www.reddit.com${post.permalink}`;

    const existingContent = await this.contentService.search({ userId }, { external_id: post.name });

    if (existingContent.length === 0) {
      await this.contentService.create(
        { userId },
        {
          connection_id: connection.id,
          type: 'reddit_post',
          title: post.title,
          text: post.selftext || post.title,
          url: permalink,
          external_id: post.name,
          external_id_kind: SOURCE_NATIVE_EXTERNAL_ID_KIND,
          // content_source_triple_uniq backstops the racy search-then-create
          // above. source_system is 'reddit' (not 'reddit_posts') so the
          // saved-items transform, which writes the same underlying thing,
          // lands on the same key.
          source_type: 'ETL',
          source_system: 'reddit',
          source_id: post.name,
          source_url: permalink,
          source_data: {
            reddit_post_id: post.id,
            subreddit: post.subreddit,
            score: post.score,
            num_comments: post.num_comments,
            is_self: post.is_self,
            link_url: post.is_self ? undefined : post.url,
            author: post.author,
          },
        },
      );
    }

    const existingEvent = await this.eventService.search(
      { userId },
      {
        sourceSystem: 'reddit_posts',
        sourceId: post.name,
      },
    );

    if (existingEvent.length === 0) {
      await this.eventService.create(
        { userId },
        {
          connection_id: connection.id,
          event_type: 'reddit_post',
          // Without source_type, CalendarEventService.createOne skips its
          // find-or-create AND events_source_triple_uniq treats the row as
          // NULL-distinct — only the search above stood between a replay
          // and a duplicate.
          source_type: 'ETL',
          source_id: post.name,
          start_time: new Date(post.created_utc * 1000),
          title: `Posted in r/${post.subreddit}: ${post.title}`,
          description: post.selftext || post.title,
          source_system: 'reddit_posts',
        },
      );
    }
  }
}

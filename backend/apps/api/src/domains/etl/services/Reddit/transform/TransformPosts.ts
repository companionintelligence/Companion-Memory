import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, EventService, SOURCE_NATIVE_EXTERNAL_ID_KIND } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import type { RedditPost } from '../sync/redditListing';

@Injectable()
export class RedditPostsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
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
            source_url: permalink,
            source_data: {
              reddit_post_id: post.id,
              subreddit: post.subreddit,
              score: post.score,
              num_comments: post.num_comments,
              is_self: post.is_self,
              link_url: post.is_self ? undefined : post.url,
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
            source_id: post.name,
            start_time: new Date(post.created_utc * 1000),
            title: `Posted in r/${post.subreddit}: ${post.title}`,
            description: post.selftext || post.title,
            source_system: 'reddit_posts',
          },
        );
      }
    }

    this.logger.log('Reddit posts transformation completed', {
      userId,
      connectionId: connection.id,
      totalPosts: posts.length,
    });
  }
}

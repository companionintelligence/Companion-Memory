import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, EventService, SOURCE_NATIVE_EXTERNAL_ID_KIND } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import type { RedditComment } from '../sync/redditListing';

@Injectable()
export class RedditCommentsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
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

    const comments = (data?.comments as RedditComment[]) || [];

    if (comments.length === 0) {
      this.logger.log('No Reddit comments found to transform', {
        userId,
        connectionId: connection.id,
      });

      return;
    }

    for (const comment of comments) {
      const permalink = comment.permalink.startsWith('http')
        ? comment.permalink
        : `https://www.reddit.com${comment.permalink}`;

      const existingContent = await this.contentService.search({ userId }, { external_id: comment.name });

      if (existingContent.length === 0) {
        await this.contentService.create(
          { userId },
          {
            connection_id: connection.id,
            type: 'reddit_comment',
            title: `Comment on "${comment.link_title}" in r/${comment.subreddit}`,
            text: comment.body,
            url: permalink,
            external_id: comment.name,
            external_id_kind: SOURCE_NATIVE_EXTERNAL_ID_KIND,
            // content_source_triple_uniq backstops the racy search-then-create
            // above. source_system is 'reddit' (not 'reddit_comments') so the
            // saved-items transform, which writes the same underlying thing,
            // lands on the same key.
            source_type: 'ETL',
            source_system: 'reddit',
            source_id: comment.name,
            source_url: permalink,
            source_data: {
              reddit_comment_id: comment.id,
              subreddit: comment.subreddit,
              link_title: comment.link_title,
              score: comment.score,
            },
          },
        );
      }

      const existingEvent = await this.eventService.search(
        { userId },
        {
          sourceSystem: 'reddit_comments',
          sourceId: comment.name,
        },
      );

      if (existingEvent.length === 0) {
        await this.eventService.create(
          { userId },
          {
            connection_id: connection.id,
            event_type: 'reddit_comment',
            // Without source_type, EventService.createOne skips its
            // find-or-create AND events_source_triple_uniq treats the row as
            // NULL-distinct — only the search above stood between a replay
            // and a duplicate.
            source_type: 'ETL',
            source_id: comment.name,
            start_time: new Date(comment.created_utc * 1000),
            title: `Commented on "${comment.link_title}" in r/${comment.subreddit}`,
            description: comment.body,
            source_system: 'reddit_comments',
          },
        );
      }
    }

    this.logger.log('Reddit comments transformation completed', {
      userId,
      connectionId: connection.id,
      totalComments: comments.length,
    });
  }
}

import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { type CreateContentDto, ContentService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import { bestThumbnail, YOUTUBE_SOURCE_SYSTEM, type YouTubeThumbnailSet } from './youtubeMedia';

interface YouTubeSubscription {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelId?: string;
    channelTitle?: string;
    publishedAt?: string;
    resourceId?: {
      channelId?: string;
    };
    thumbnails?: YouTubeThumbnailSet;
  };
}

@Injectable()
export class YouTubeSubscriptionsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly connectionService: ConnectionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(YouTubeSubscriptionsTransformService.name);
  }

  async transformYouTubeSubscriptions({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting YouTube Subscriptions transformation', {
        userId,
        syncJobId,
      });

      const subscriptions = this.extractSubscriptions(data);

      if (subscriptions.length === 0) {
        this.logger.log('No YouTube subscriptions found to transform', { userId, syncJobId });

        return;
      }

      this.logger.log(`Processing ${subscriptions.length} YouTube subscriptions`, {
        userId,
        syncJobId,
        subscriptionCount: subscriptions.length,
      });

      const contents = subscriptions
        .map((subscription) =>
          this.buildSubscriptionContent({ subscription, connectionId: connection.id, userId }),
        )
        .filter((dto): dto is CreateContentDto => dto !== null);

      // createMany dedupes on the provenance triple, so a re-sync of an unchanged
      // subscription list inserts zero rows (create() would raise 23505).
      await this.contentService.createMany({ userId }, contents, { emitCreated: true });

      this.logger.log('YouTube Subscriptions transformation completed', {
        userId,
        syncJobId,
        processedCount: contents.length,
        skippedCount: subscriptions.length - contents.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error transforming YouTube Subscriptions', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractSubscriptions(data: unknown): YouTubeSubscription[] {
    if (!data || typeof data !== 'object') {
      this.logger.warn('Invalid data type for YouTube subscriptions', {
        dataType: typeof data,
      });

      return [];
    }

    const dataObj = data as Record<string, unknown>;

    // Handle the structure from YouTube API
    if ('items' in dataObj && Array.isArray(dataObj.items)) {
      return dataObj.items as YouTubeSubscription[];
    }

    if ('id' in dataObj && 'snippet' in dataObj) {
      return [dataObj as YouTubeSubscription];
    }

    this.logger.warn('No YouTube subscriptions found in data', {
      dataKeys: Object.keys(dataObj),
    });

    return [];
  }

  private buildSubscriptionContent({
    subscription,
    userId,
    connectionId,
  }: {
    subscription: YouTubeSubscription;
    userId: string;
    connectionId: string;
  }): CreateContentDto | null {
    const snippet = subscription.snippet;

    if (!snippet) {
      this.logger.debug('Skipping subscription without snippet', {
        userId,
        connectionId,
      });

      return null;
    }

    const channelId = snippet.resourceId?.channelId || snippet.channelId || '';

    // Without a channel id the row has no url, no external id and no stable
    // provenance, so every re-sync would insert another copy of it. Drop it.
    if (!channelId) {
      this.logger.debug('Skipping subscription without a channel id', {
        userId,
        connectionId,
      });

      return null;
    }

    const channelTitle = snippet.title || snippet.channelTitle || 'Untitled Channel';
    const description = snippet.description || '';
    const url = `https://www.youtube.com/channel/${channelId}`;
    const thumbnail = bestThumbnail(snippet.thumbnails);

    return {
      type: 'youtube_subscription',
      title: channelTitle,
      text: description,
      url,
      external_id: channelId,
      source_url: url,
      source_type: 'ETL',
      source_system: YOUTUBE_SOURCE_SYSTEM,
      source_id: `subscription:${channelId}`,
      source_data: {
        connectionId,
        channelId,
        publishedAt: snippet.publishedAt,
        providerRef: `youtube:channel:${channelId}`,
        ...(thumbnail ? { thumbnail } : {}),
      },
      user: { id: userId },
    };
  }
}

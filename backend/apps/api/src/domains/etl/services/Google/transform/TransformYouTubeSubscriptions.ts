import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { ContentService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

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
    thumbnails?: {
      default?: { url?: string };
      medium?: { url?: string };
      high?: { url?: string };
    };
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

      await Promise.all(
        subscriptions.map(
          async (subscription) =>
            await this.processSubscription({
              subscription,
              connectionId: connection.id,
              userId,
            }),
        ),
      );

      this.logger.log('YouTube Subscriptions transformation completed', {
        userId,
        syncJobId,
        processedCount: subscriptions.length,
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

  private async processSubscription({
    subscription,
    userId,
    connectionId,
  }: {
    subscription: YouTubeSubscription;
    userId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      const snippet = subscription.snippet;
      if (!snippet) {
        this.logger.debug('Skipping subscription without snippet', {
          userId,
          connectionId,
        });

        return;
      }

      const channelId = snippet.resourceId?.channelId || snippet.channelId || '';
      const channelTitle = snippet.title || snippet.channelTitle || 'Untitled Channel';
      const description = snippet.description || '';
      const url = channelId ? `https://www.youtube.com/channel/${channelId}` : undefined;

      this.logger.log('Processing YouTube subscription', {
        channelId,
        channelTitle,
      });

      await this.contentService.create(
        { userId },
        {
          type: 'youtube_subscription',
          title: channelTitle,
          text: description,
          url,
          external_id: channelId || undefined,
          source_url: url,
          source_data: { connectionId },
          user: { id: userId },
        },
      );

      this.logger.log('YouTube subscription saved successfully', {
        channelId,
        channelTitle,
      });
    } catch (error) {
      this.logger.error('Error processing individual YouTube subscription', {
        userId,
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other subscriptions
    }
  }
}

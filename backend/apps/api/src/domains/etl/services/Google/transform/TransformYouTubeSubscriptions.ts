import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { ContentService, type CreateContentDto } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import { type YouTubeThumbnails, channelProviderRef, youtubeEmbedSourceData } from './youtubeMedia';

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
    thumbnails?: YouTubeThumbnails;
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

      // Map first, then write ONCE: createMany dedupes on the provenance triple,
      // so a re-sync inserts zero rows. The previous per-item create() had no ON
      // CONFLICT and duplicated every subscription on every sync.
      const records = subscriptions
        .map((subscription) => this.toContentDto({ subscription, connectionId: connection.id, userId }))
        .filter((record): record is CreateContentDto => record !== null);

      if (records.length > 0) {
        await this.contentService.createMany({ userId }, records, { emitCreated: true });
      }

      this.logger.log('YouTube Subscriptions transformation completed', {
        userId,
        syncJobId,
        processedCount: subscriptions.length,
        writtenCount: records.length,
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

  /**
   * Maps one subscription to a content row, or `null` when it carries no
   * channel id. Pure — no I/O — so a malformed item is skipped without
   * affecting the rest of the batch.
   *
   * A subscription without a channel id is skipped rather than written: it has
   * no URL, no external id and no triple, so it could never be deduped and
   * would accumulate a fresh copy on every sync.
   */
  private toContentDto({
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
    if (!channelId) {
      this.logger.debug('Skipping subscription without channel id', {
        userId,
        connectionId,
      });

      return null;
    }

    const channelTitle = snippet.title || snippet.channelTitle || 'Untitled Channel';
    const description = snippet.description || '';
    const url = `https://www.youtube.com/channel/${channelId}`;

    return {
      type: 'youtube_subscription',
      title: channelTitle,
      text: description,
      url,
      external_id: channelId,
      source_url: url,
      // Provenance triple: makes a re-sync idempotent against
      // content_source_triple_uniq. Matches the ETL convention.
      source_type: 'ETL',
      source_system: 'youtube_subscriptions',
      source_id: channelId,
      source_data: {
        connectionId,
        ...youtubeEmbedSourceData({
          providerRef: channelProviderRef(channelId),
          thumbnails: snippet.thumbnails,
        }),
      },
      user: { id: userId },
    };
  }
}

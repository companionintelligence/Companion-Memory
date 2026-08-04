import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { type CreateContentDto, ContentService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import { bestThumbnail, YOUTUBE_SOURCE_SYSTEM, type YouTubeThumbnailSet } from './youtubeMedia';

interface YouTubeActivity {
  id?: string;
  snippet?: {
    type?: string;
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    thumbnails?: YouTubeThumbnailSet;
  };
  contentDetails?: {
    upload?: {
      videoId?: string;
    };
  };
}

@Injectable()
export class YouTubeActivitiesTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly connectionService: ConnectionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(YouTubeActivitiesTransformService.name);
  }

  async transformYouTubeActivities({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting YouTube Activities transformation', {
        userId,
        syncJobId,
      });

      const activities = this.extractActivities(data);

      if (activities.length === 0) {
        this.logger.log('No YouTube activities found to transform', { userId, syncJobId });

        return;
      }

      this.logger.log(`Processing ${activities.length} YouTube activities`, {
        userId,
        syncJobId,
        activityCount: activities.length,
      });

      const contents = activities
        .map((activity) => this.buildActivityContent({ activity, connectionId: connection.id, userId }))
        .filter((dto): dto is CreateContentDto => dto !== null);

      // createMany dedupes on the provenance triple, so re-syncing the activity
      // feed inserts zero rows (create() would raise 23505).
      await this.contentService.createMany({ userId }, contents, { emitCreated: true });

      this.logger.log('YouTube Activities transformation completed', {
        userId,
        syncJobId,
        processedCount: contents.length,
        skippedCount: activities.length - contents.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error transforming YouTube Activities', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractActivities(data: unknown): YouTubeActivity[] {
    if (!data || typeof data !== 'object') {
      this.logger.warn('Invalid data type for YouTube activities', {
        dataType: typeof data,
      });

      return [];
    }

    const dataObj = data as Record<string, unknown>;

    // Handle the structure from YouTube API
    if ('items' in dataObj && Array.isArray(dataObj.items)) {
      return dataObj.items as YouTubeActivity[];
    }

    if ('id' in dataObj && 'snippet' in dataObj) {
      return [dataObj as YouTubeActivity];
    }

    this.logger.warn('No YouTube activities found in data', {
      dataKeys: Object.keys(dataObj),
    });

    return [];
  }

  private buildActivityContent({
    activity,
    userId,
    connectionId,
  }: {
    activity: YouTubeActivity;
    userId: string;
    connectionId: string;
  }): CreateContentDto | null {
    const snippet = activity.snippet;
    const contentDetails = activity.contentDetails;

    if (!snippet) {
      this.logger.debug('Skipping activity without snippet', {
        userId,
        connectionId,
      });

      return null;
    }

    const type = snippet.type;

    if (type !== 'upload' || !contentDetails?.upload) {
      this.logger.debug('Skipping unsupported YouTube activity', {
        type,
        userId,
        connectionId,
      });

      return null;
    }

    const videoId = contentDetails.upload.videoId;

    // Without a video id there is no url and no stable provenance, so every
    // re-sync would insert another copy of the row.
    if (!videoId) {
      this.logger.debug('Skipping upload activity without a video id', {
        userId,
        connectionId,
      });

      return null;
    }

    const title = snippet.title || 'Untitled Video';
    const description = snippet.description || '';
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const thumbnail = bestThumbnail(snippet.thumbnails);

    return {
      type: 'youtube_activity_upload',
      title,
      text: description,
      url,
      mimetype: 'video/youtube',
      external_id: videoId,
      source_url: url,
      source_type: 'ETL',
      source_system: YOUTUBE_SOURCE_SYSTEM,
      source_id: `upload:${videoId}`,
      source_data: {
        connectionId,
        channelTitle: snippet.channelTitle ?? '',
        channelId: snippet.channelId ?? '',
        publishedAt: snippet.publishedAt,
        providerRef: `youtube:video:${videoId}`,
        ...(thumbnail ? { thumbnail } : {}),
      },
      user: { id: userId },
    };
  }
}

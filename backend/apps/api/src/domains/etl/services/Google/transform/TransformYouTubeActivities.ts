import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { ContentService, type CreateContentDto } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import { type YouTubeThumbnails, videoProviderRef, youtubeEmbedSourceData } from './youtubeMedia';

interface YouTubeActivity {
  id?: string;
  snippet?: {
    type?: string;
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    thumbnails?: YouTubeThumbnails;
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

      // Map first, then write ONCE: createMany dedupes on the provenance triple,
      // so a re-sync inserts zero rows. The previous per-item create() had no ON
      // CONFLICT and duplicated every upload activity on every sync.
      const records = activities
        .map((activity) => this.toContentDto({ activity, connectionId: connection.id, userId }))
        .filter((record): record is CreateContentDto => record !== null);

      if (records.length > 0) {
        await this.contentService.createMany({ userId }, records, { emitCreated: true });
      }

      this.logger.log('YouTube Activities transformation completed', {
        userId,
        syncJobId,
        processedCount: activities.length,
        writtenCount: records.length,
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

  /**
   * Maps one activity to a content row, or `null` when it is not a supported
   * activity type. Pure — no I/O — so a malformed item is skipped without
   * affecting the rest of the batch.
   *
   * Only `upload` activities are materialised today. An upload without a video
   * id is skipped rather than written: it has no URL and no triple, so it could
   * never be deduped and would accumulate a fresh copy on every sync.
   */
  private toContentDto({
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
    if (!videoId) {
      this.logger.debug('Skipping upload activity without video id', {
        userId,
        connectionId,
      });

      return null;
    }

    const title = snippet.title || 'Untitled Video';
    const description = snippet.description || '';
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    return {
      type: 'youtube_activity_upload',
      title,
      text: description,
      url,
      external_id: videoId,
      source_url: url,
      // Provenance triple: makes a re-sync idempotent against
      // content_source_triple_uniq. Matches the ETL convention.
      source_type: 'ETL',
      source_system: 'youtube_activities',
      source_id: videoId,
      source_data: {
        connectionId,
        // activities.list carries no duration — only videos.list does.
        ...youtubeEmbedSourceData({
          providerRef: videoProviderRef(videoId),
          thumbnails: snippet.thumbnails,
        }),
      },
      user: { id: userId },
    };
  }
}

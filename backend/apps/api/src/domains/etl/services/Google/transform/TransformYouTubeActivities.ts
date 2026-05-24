import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { ContentService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

interface YouTubeActivity {
  id?: string;
  snippet?: {
    type?: string;
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    thumbnails?: {
      default?: { url?: string };
      medium?: { url?: string };
      high?: { url?: string };
    };
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

      await Promise.all(
        activities.map(
          async (activity) =>
            await this.processActivity({
              activity,
              connectionId: connection.id,
              userId,
            }),
        ),
      );

      this.logger.log('YouTube Activities transformation completed', {
        userId,
        syncJobId,
        processedCount: activities.length,
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

  private async processActivity({
    activity,
    userId,
    connectionId,
  }: {
    activity: YouTubeActivity;
    userId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      const snippet = activity.snippet;
      const contentDetails = activity.contentDetails;

      if (!snippet) {
        this.logger.debug('Skipping activity without snippet', {
          userId,
          connectionId,
        });

        return;
      }

      const type = snippet.type;

      // Process upload activities
      if (type === 'upload' && contentDetails?.upload) {
        const upload = contentDetails.upload;
        const videoId = upload.videoId;
        const title = snippet.title || 'Untitled Video';
        const description = snippet.description || '';
        const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined;

        this.logger.log('Processing YouTube upload activity', {
          videoId,
          title,
        });

        await this.contentService.create(
          { userId },
          {
            type: 'youtube_activity_upload',
            title,
            text: description,
            url,
            external_id: videoId,
            source_url: url,
            source_data: { connectionId },
            user: { id: userId },
          },
        );

        this.logger.log('YouTube upload activity saved successfully', {
          videoId,
          title,
        });

        return;
      }

      // Log unsupported activity types for debugging
      this.logger.debug('Skipping unsupported YouTube activity', {
        type,
        userId,
        connectionId,
      });
    } catch (error) {
      this.logger.error('Error processing individual YouTube activity', {
        userId,
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other activities
    }
  }
}

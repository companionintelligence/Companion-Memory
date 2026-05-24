import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { ContentService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

interface YouTubePlaylistItem {
  id?: string;
  snippet?: {
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
    resourceId?: {
      videoId?: string;
    };
  };
  contentDetails?: {
    videoId?: string;
    videoPublishedAt?: string;
  };
}

@Injectable()
export class YouTubeLikesTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly connectionService: ConnectionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(YouTubeLikesTransformService.name);
  }

  async transformYouTubeLikes({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting YouTube Likes transformation', {
        userId,
        syncJobId,
      });

      const items = this.extractLikedVideos(data);

      if (items.length === 0) {
        this.logger.log('No YouTube liked videos found to transform', { userId, syncJobId });

        return;
      }

      this.logger.log(`Processing ${items.length} YouTube liked videos`, {
        userId,
        syncJobId,
        itemCount: items.length,
      });

      await Promise.all(
        items.map(
          async (item) =>
            await this.processLikedVideo({
              item,
              connectionId: connection.id,
              userId,
            }),
        ),
      );

      this.logger.log('YouTube Likes transformation completed', {
        userId,
        syncJobId,
        processedCount: items.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error transforming YouTube Likes', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractLikedVideos(data: unknown): YouTubePlaylistItem[] {
    if (!data || typeof data !== 'object') {
      this.logger.warn('Invalid data type for YouTube likes', {
        dataType: typeof data,
      });

      return [];
    }

    const dataObj = data as Record<string, unknown>;

    // Handle the structure from YouTube API
    if ('items' in dataObj && Array.isArray(dataObj.items)) {
      return dataObj.items as YouTubePlaylistItem[];
    }

    if ('id' in dataObj && 'snippet' in dataObj) {
      return [dataObj as YouTubePlaylistItem];
    }

    this.logger.warn('No YouTube liked videos found in data', {
      dataKeys: Object.keys(dataObj),
    });

    return [];
  }

  private async processLikedVideo({
    item,
    userId,
    connectionId,
  }: {
    item: YouTubePlaylistItem;
    userId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      console.log('processLikedVideo', item);
      const videoId = item.id || item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
      console.log('videoId', videoId);
      if (!videoId) {
        this.logger.debug('Skipping liked video without id', {
          userId,
          connectionId,
        });

        return;
      }

      const title = item.snippet?.title || 'Untitled Video';
      const description = item.snippet?.description || '';
      const channelTitle = item.snippet?.channelTitle || '';
      const channelId = item.snippet?.channelId || '';
      const url = `https://www.youtube.com/watch?v=${videoId}`;

      this.logger.log('Processing YouTube liked video', {
        videoId,
        title,
        channelTitle,
      });

      console.log('creating content for liked video', {
        videoId,
        title,
      });
      await this.contentService.create(
        { userId },
        {
          type: 'youtube_video_like',
          title,
          text: description,
          url,
          mimetype: 'video/youtube',
          external_id: videoId,
          source_url: url,
          source_data: { connectionId, channelTitle, channelId },
          user: { id: userId },
        },
      );

      this.logger.log('YouTube liked video saved successfully', {
        videoId,
        title,
      });
    } catch (error) {
      this.logger.error('Error processing individual YouTube liked video', {
        userId,
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other videos
    }
  }
}

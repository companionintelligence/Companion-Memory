import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, type CreateContentDto } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
interface FacebookVideo {
  id: string;
  title?: string;
  description?: string;
  created_time: string;
  source?: string;
  permalink_url?: string;
}
@Injectable()
export class FacebookVideosTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookVideosTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;
    this.logger.log('Starting Facebook videos transformation', {
      userId,
      connectionId: connection.id,
    });
    try {
      const videos = this.extractVideos(data);
      if (videos.length === 0) {
        this.logger.log('No Facebook videos found to transform', { userId, connectionId: connection.id });

        return;
      }

      for (const video of videos) {
        try {
          // Search for existing content by external_id
          const existingContent = await this.contentService.search({ userId }, { external_id: video.id });
          if (existingContent.length > 0) {
            // Update existing content
            const existingItem = existingContent[0];
            await this.contentService.update({ userId }, existingItem.id, {
              type: 'Content',
              title: video.title || `Video ${video.id}`,
              text: video.description || '',
              url: video.permalink_url
                ? `https://facebook.com${video.permalink_url}`
                : video.source
                  ? video.source
                  : undefined,
              mimetype: 'video/mp4',
              external_id: video.id,
              source_url: video.source || undefined,
              source_data: {
                facebook_video_id: video.id,
                title: video.title,
                description: video.description,
                created_time: video.created_time,
                source_url: video.source,
                permalink_url: video.permalink_url,
                connection_id: connection.id,
                contentType: 'facebook_video',
              },
            });
            this.logger.log('Updated existing Facebook video content', {
              videoId: video.id,
              contentId: existingItem.id,
            });
          } else {
            // Create new content
            const contentDto = {
              id: uuidv7(),
              type: 'Content',
              title: video.title || `Video ${video.id}`,
              text: video.description || '',
              url: video.permalink_url || video.source || undefined,
              mimetype: 'video/mp4',
              external_id: video.id,
              source_url: video.source || undefined,
              source_data: {
                facebook_video_id: video.id,
                title: video.title,
                description: video.description,
                created_time: video.created_time,
                source_url: video.source,
                permalink_url: video.permalink_url,
                connection_id: connection.id,
                contentType: 'facebook_video',
              },
              user: { id: userId },
            };
            await this.contentService.create({ userId }, contentDto as unknown as CreateContentDto);
            this.logger.log('Created new Facebook video content', {
              videoId: video.id,
            });
          }
        } catch (error) {
          this.logger.error('Error processing Facebook video', {
            videoId: video.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      this.logger.log('Facebook videos transformation completed', {
        userId,
        connectionId: connection.id,
        processedCount: videos.length,
      });
    } catch (error) {
      this.logger.error('Error transforming Facebook videos', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractVideos(content: unknown): FacebookVideo[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;
    if (Array.isArray(contentObj)) {
      return contentObj as FacebookVideo[];
    }

    if ('videos' in contentObj && Array.isArray(contentObj.videos)) {
      return contentObj.videos as FacebookVideo[];
    }

    return [];
  }
}

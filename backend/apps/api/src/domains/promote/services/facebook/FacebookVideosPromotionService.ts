import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import { FacebookPromotionUtils } from './FacebookPromotionUtils';

interface FacebookVideo {
  id: string;
  title?: string;
  description?: string;
  created_time: string;
  source?: string;
  permalink_url?: string;
}

@Injectable()
export class FacebookVideosPromotionService {
  private logger = new LoggerService(FacebookVideosPromotionService.name);

  constructor(private readonly utils: FacebookPromotionUtils) {}

  /**
   * Promote Facebook videos: create files AND content records
   * Videos are stored as files and also have content records that reference those files
   */
  async promoteVideosAsPosts(apiLogContent: unknown, userId: string, connectionId: string): Promise<void> {
    this.logger.log('Promoting Facebook videos as files and content', { userId, connectionId });

    const videos = this.extractVideos(apiLogContent);
    if (videos.length === 0) {
      this.logger.log('No Facebook videos found to promote', { userId, connectionId });

      return;
    }

    for (const video of videos) {
      try {
        if (!video.source) {
          this.logger.warn('No video source found', { videoId: video.id });
          continue;
        }

        // Download and save the video as a file
        const fileRecord = await this.utils.downloadAndSaveFile(
          video.source,
          video.id,
          userId,
          connectionId,
          'video',
          `facebook video ${video.id}`,
        );

        if (!fileRecord) {
          this.logger.warn('Failed to save video as file', { videoId: video.id });
          continue;
        }

        // Only create file record - content records are created by promotePosts
        this.logger.log('Created file record for Facebook video', {
          videoId: video.id,
          fileId: fileRecord.id,
        });
      } catch (error) {
        this.logger.error('Error processing Facebook video', {
          videoId: video.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log('Facebook videos promotion completed (as files and content)', {
      userId,
      connectionId,
      processedCount: videos.length,
    });
  }

  private extractVideos(content: unknown): FacebookVideo[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;
    if (Array.isArray(contentObj)) {
      return contentObj as FacebookVideo[];
    }

    if ('data' in contentObj && Array.isArray(contentObj.data)) {
      return contentObj.data as FacebookVideo[];
    }

    return [];
  }
}

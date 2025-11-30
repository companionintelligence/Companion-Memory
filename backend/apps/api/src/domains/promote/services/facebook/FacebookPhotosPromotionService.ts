import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/services';

import { FacebookPromotionUtils } from './FacebookPromotionUtils';

interface FacebookPhoto {
  id: string;
  name?: string;
  created_time: string;
  images?: Array<{ height: number; width: number; source: string }>;
  link?: string;
  picture?: string;
}

@Injectable()
export class FacebookPhotosPromotionService {
  private logger = new LoggerService(FacebookPhotosPromotionService.name);

  constructor(private readonly utils: FacebookPromotionUtils) {}

  /**
   * Promote Facebook photos: create files AND content records
   * Photos are stored as files and also have content records that reference those files
   */
  async promotePhotosAsPosts(apiLogContent: unknown, userId: string, connectionId: string): Promise<void> {
    this.logger.log('Promoting Facebook photos as files and content', { userId, connectionId });

    const photos = this.extractPhotos(apiLogContent);
    if (photos.length === 0) {
      this.logger.log('No Facebook photos found to promote', { userId, connectionId });

      return;
    }

    for (const photo of photos) {
      try {
        // Get the best quality image source
        const imageSource = this.utils.getBestImageSource(photo);
        if (!imageSource) {
          this.logger.warn('No image source found for photo', { photoId: photo.id });
          continue;
        }

        // Download and save the image as a file
        const fileRecord = await this.utils.downloadAndSaveFile(
          imageSource,
          photo.id,
          userId,
          connectionId,
          'image',
          `facebook photo ${photo.id}`,
        );

        if (!fileRecord) {
          this.logger.warn('Failed to save photo as file', { photoId: photo.id });
          continue;
        }

        // Only create file record - content records are created by promotePosts
        this.logger.log('Created file record for Facebook photo', {
          photoId: photo.id,
          fileId: fileRecord.id,
        });
      } catch (error) {
        this.logger.error('Error processing Facebook photo', {
          photoId: photo.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log('Facebook photos promotion completed (as files and content)', {
      userId,
      connectionId,
      processedCount: photos.length,
    });
  }

  private extractPhotos(content: unknown): FacebookPhoto[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;
    if (Array.isArray(contentObj)) {
      return contentObj as FacebookPhoto[];
    }

    if ('data' in contentObj && Array.isArray(contentObj.data)) {
      return contentObj.data as FacebookPhoto[];
    }

    return [];
  }
}

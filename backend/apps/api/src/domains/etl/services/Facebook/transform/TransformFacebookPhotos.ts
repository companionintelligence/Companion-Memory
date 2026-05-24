import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, type CreateContentDto } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
interface FacebookPhoto {
  id: string;
  name?: string;
  created_time: string;
  images?: Array<{
    source: string;
  }>;
  link?: string;
}
@Injectable()
export class FacebookPhotosTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FacebookPhotosTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;
    this.logger.log('Starting Facebook photos transformation', {
      userId,
      connectionId: connection.id,
    });
    try {
      const photos = this.extractPhotos(data);
      if (photos.length === 0) {
        this.logger.log('No Facebook photos found to transform', { userId, connectionId: connection.id });

        return;
      }

      for (const photo of photos) {
        try {
          // Search for existing content by external_id
          const existingContent = await this.contentService.search({ userId }, { external_id: photo.id });
          if (existingContent.length > 0) {
            // Update existing content
            const existingItem = existingContent[0];
            await this.contentService.update({ userId }, existingItem.id, {
              type: 'Content',
              title: photo.name || `Photo ${photo.id}`,
              text: photo.name || '',
              url: photo.link || photo.images?.[0]?.source || undefined,
              mimetype: 'image/jpeg',
              external_id: photo.id,
              source_url: photo.images?.[0]?.source || undefined,
              source_data: {
                facebook_photo_id: photo.id,
                created_time: photo.created_time,
                image_url: photo.images?.[0]?.source,
                connection_id: connection.id,
                contentType: 'facebook_photo',
              },
            });
            this.logger.log('Updated existing Facebook photo content', {
              photoId: photo.id,
              contentId: existingItem.id,
            });
          } else {
            // Create new content
            const contentDto = {
              id: uuidv7(),
              type: 'Content',
              title: photo.name || `Photo ${photo.id}`,
              text: photo.name || '',
              url: photo.link || photo.images?.[0]?.source || undefined,
              mimetype: 'image/jpeg',
              external_id: photo.id,
              source_url: photo.images?.[0]?.source || undefined,
              source_data: {
                facebook_photo_id: photo.id,
                created_time: photo.created_time,
                image_url: photo.images?.[0]?.source,
                connection_id: connection.id,
                contentType: 'facebook_photo',
              },
              user: { id: userId },
            };
            await this.contentService.create({ userId }, contentDto as unknown as CreateContentDto);
            this.logger.log('Created new Facebook photo content', {
              photoId: photo.id,
            });
          }
        } catch (error) {
          this.logger.error('Error processing Facebook photo', {
            photoId: photo.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      this.logger.log('Facebook photos transformation completed', {
        userId,
        connectionId: connection.id,
        processedCount: photos.length,
      });
    } catch (error) {
      this.logger.error('Error transforming Facebook photos', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractPhotos(content: unknown): FacebookPhoto[] {
    if (!content || typeof content !== 'object') {
      return [];
    }

    const contentObj = content as Record<string, unknown>;
    if (Array.isArray(contentObj)) {
      return contentObj as FacebookPhoto[];
    }

    if ('photos' in contentObj && Array.isArray(contentObj.photos)) {
      return contentObj.photos as FacebookPhoto[];
    }

    return [];
  }
}

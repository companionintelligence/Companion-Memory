import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, type FacebookPhoto } from '@ci/domains/connections';

import { ConnectionSyncJob } from '../../../types';
import { FacebookMediaService, facebookUrl } from '../FacebookMediaService';

/**
 * `/me/photos?type=uploaded` → one `ci.content` row per photo, with the
 * bytes in the object store. The row shape, the download, and the "one row
 * per Graph id even when a post also carries it" rule all live in
 * FacebookMediaService; this only maps the endpoint's payload onto it.
 */
@Injectable()
export class FacebookPhotosTransformService {
  constructor(
    private readonly facebookMediaService: FacebookMediaService,
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

      let stored = 0;

      for (const photo of photos) {
        try {
          // Graph lists `images` largest first.
          const largest = photo.images?.[0];

          const { fileId } = await this.facebookMediaService.upsertMedia({
            userId,
            connectionId: connection.id,
            media: {
              kind: 'photo',
              id: photo.id,
              title: photo.name?.trim() || `Photo ${photo.id}`,
              text: photo.name ?? '',
              pageUrl: facebookUrl(photo.link),
              cdnUrl: largest?.source,
              mimetype: 'image/jpeg',
              createdTime: photo.created_time,
              sourceData: {
                width: largest?.width,
                height: largest?.height,
                place: photo.place,
              },
            },
          });

          if (fileId) {
            stored += 1;
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
        storedCount: stored,
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

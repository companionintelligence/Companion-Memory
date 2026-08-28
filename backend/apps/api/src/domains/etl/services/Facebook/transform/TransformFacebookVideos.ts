import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, type FacebookVideo } from '@ci/domains/connections';

import { ConnectionSyncJob } from '../../../types';
import { FacebookMediaService, facebookUrl } from '../FacebookMediaService';

/**
 * `/me/videos?type=uploaded` → one `ci.content` row per video, with the MP4
 * in the object store. See FacebookMediaService for the row shape and why
 * the bytes are copied.
 *
 * Graph returns a video's `permalink_url` host-relative
 * (`/<user-id>/videos/<video-id>`); it is made absolute here. The create
 * path used to store it verbatim, so every video's link was a bare path.
 */
@Injectable()
export class FacebookVideosTransformService {
  constructor(
    private readonly facebookMediaService: FacebookMediaService,
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

      let stored = 0;

      for (const video of videos) {
        try {
          const { fileId } = await this.facebookMediaService.upsertMedia({
            userId,
            connectionId: connection.id,
            media: {
              kind: 'video',
              id: video.id,
              title: video.title?.trim() || video.description?.trim() || `Video ${video.id}`,
              text: video.description ?? '',
              pageUrl: facebookUrl(video.permalink_url),
              cdnUrl: video.source,
              mimetype: 'video/mp4',
              createdTime: video.created_time,
              sourceData: {
                title: video.title,
                description: video.description,
                length_seconds: video.length,
                permalink_url: video.permalink_url,
                thumbnail_url: video.thumbnails?.data?.[0]?.uri,
              },
            },
          });

          if (fileId) {
            stored += 1;
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
        storedCount: stored,
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

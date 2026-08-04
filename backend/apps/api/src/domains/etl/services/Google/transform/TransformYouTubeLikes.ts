import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { ContentService, type CreateContentDto } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import { type YouTubeThumbnails, videoProviderRef, youtubeEmbedSourceData } from './youtubeMedia';

interface YouTubePlaylistItem {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    thumbnails?: YouTubeThumbnails;
    resourceId?: {
      videoId?: string;
    };
  };
  contentDetails?: {
    videoId?: string;
    videoPublishedAt?: string;
    // SyncYouTubeLikes calls /youtube/v3/videos?part=snippet,contentDetails, and
    // the videos resource carries an ISO-8601 duration. playlists.list and
    // activities.list do NOT, which is why only this transform records one.
    duration?: string;
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

      // Map first (per-item, skipping anything unusable), then write ONCE.
      // createMany dedupes on the provenance triple via
      // content_source_triple_uniq, so a re-sync of the same likes inserts zero
      // rows; the previous per-item create() was a plain save with no ON
      // CONFLICT, so every sync duplicated the entire library.
      const records = items
        .map((item) => this.toContentDto({ item, connectionId: connection.id, userId }))
        .filter((record): record is CreateContentDto => record !== null);

      if (records.length > 0) {
        await this.contentService.createMany({ userId }, records, { emitCreated: true });
      }

      this.logger.log('YouTube Likes transformation completed', {
        userId,
        syncJobId,
        processedCount: items.length,
        writtenCount: records.length,
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

  /**
   * Maps one liked video to a content row, or `null` when it carries no usable
   * video id. Pure — no I/O — so a malformed item is skipped without affecting
   * the rest of the batch.
   */
  private toContentDto({
    item,
    userId,
    connectionId,
  }: {
    item: YouTubePlaylistItem;
    userId: string;
    connectionId: string;
  }): CreateContentDto | null {
    const videoId = item.id || item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
    if (!videoId) {
      this.logger.debug('Skipping liked video without id', {
        userId,
        connectionId,
      });

      return null;
    }

    const title = item.snippet?.title || 'Untitled Video';
    const description = item.snippet?.description || '';
    const channelTitle = item.snippet?.channelTitle || '';
    const channelId = item.snippet?.channelId || '';
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    return {
      type: 'youtube_video_like',
      title,
      text: description,
      url,
      // A watch page is not a playable media file. The pseudo-type is kept
      // because it records what this row IS, but the gallery no longer treats a
      // `video/*` pseudo-type as a direct <video> source — see
      // GalleryView/media.ts, which is where the broken render was fixed so
      // that already-imported rows heal without a backfill.
      mimetype: 'video/youtube',
      external_id: videoId,
      source_url: url,
      // Provenance triple: makes a re-sync idempotent against
      // content_source_triple_uniq (user_id, source_type, source_system,
      // source_id). Matches the ETL convention used by google_calendar.
      source_type: 'ETL',
      source_system: 'youtube_likes',
      source_id: videoId,
      source_data: {
        connectionId,
        channelTitle,
        channelId,
        ...youtubeEmbedSourceData({
          providerRef: videoProviderRef(videoId),
          thumbnails: item.snippet?.thumbnails,
          durationIso: item.contentDetails?.duration,
        }),
      },
      user: { id: userId },
    };
  }
}

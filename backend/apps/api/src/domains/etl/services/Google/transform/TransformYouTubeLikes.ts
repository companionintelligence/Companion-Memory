import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { type CreateContentDto, ContentService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import { bestThumbnail, parseIso8601DurationSeconds, YOUTUBE_SOURCE_SYSTEM } from './youtubeMedia';

interface YouTubePlaylistItem {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    thumbnails?: {
      default?: { url?: string; width?: number; height?: number };
      medium?: { url?: string; width?: number; height?: number };
      high?: { url?: string; width?: number; height?: number };
      standard?: { url?: string; width?: number; height?: number };
      maxres?: { url?: string; width?: number; height?: number };
    };
    resourceId?: {
      videoId?: string;
    };
  };
  contentDetails?: {
    videoId?: string;
    videoPublishedAt?: string;
    /** ISO 8601 duration, e.g. `PT4M13S`. Present on `videos.list` responses. */
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

      const contents = items
        .map((item) => this.buildLikedVideoContent({ item, connectionId: connection.id, userId }))
        .filter((dto): dto is CreateContentDto => dto !== null);

      // createMany, not create: create() is a plain save and a re-sync of the same
      // liked video raises 23505 against content_source_triple_uniq. createMany is
      // one set-based INSERT ... ON CONFLICT DO NOTHING keyed on the provenance
      // triple, so re-running a sync inserts zero rows. emitCreated stays true so
      // these stay search-indexed (createMany defaults it to false for bulk import).
      await this.contentService.createMany({ userId }, contents, { emitCreated: true });

      this.logger.log('YouTube Likes transformation completed', {
        userId,
        syncJobId,
        processedCount: contents.length,
        skippedCount: items.length - contents.length,
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

  private buildLikedVideoContent({
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

    // The provider already returns a poster and a runtime; both were parsed and
    // dropped before. Persist them so the embed tiers can render a poster and a
    // duration badge without a second API call (design §6, tier 0).
    const thumbnail = bestThumbnail(item.snippet?.thumbnails);
    const durationSeconds = parseIso8601DurationSeconds(item.contentDetails?.duration);

    return {
      type: 'youtube_video_like',
      title,
      text: description,
      url,
      mimetype: 'video/youtube',
      external_id: videoId,
      source_url: url,
      source_type: 'ETL',
      source_system: YOUTUBE_SOURCE_SYSTEM,
      source_id: `like:${videoId}`,
      source_data: {
        connectionId,
        channelTitle,
        channelId,
        publishedAt: item.snippet?.publishedAt,
        providerRef: `youtube:video:${videoId}`,
        ...(thumbnail ? { thumbnail } : {}),
        ...(item.contentDetails?.duration ? { durationIso: item.contentDetails.duration } : {}),
        ...(durationSeconds !== null ? { durationSeconds } : {}),
      },
      user: { id: userId },
    };
  }
}

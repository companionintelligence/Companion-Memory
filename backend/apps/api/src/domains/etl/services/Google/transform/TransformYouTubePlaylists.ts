import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { type CreateContentDto, ContentService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import { bestThumbnail, YOUTUBE_SOURCE_SYSTEM, type YouTubeThumbnailSet } from './youtubeMedia';

interface YouTubePlaylist {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    thumbnails?: YouTubeThumbnailSet;
  };
  contentDetails?: {
    itemCount?: number;
  };
}

@Injectable()
export class YouTubePlaylistsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly connectionService: ConnectionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(YouTubePlaylistsTransformService.name);
  }

  async transformYouTubePlaylists({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { id: syncJobId, userId, data } = syncJob;

    try {
      this.logger.log('Starting YouTube Playlists transformation', {
        userId,
        syncJobId,
      });

      const playlists = this.extractPlaylists(data);

      if (playlists.length === 0) {
        this.logger.log('No YouTube playlists found to transform', { userId, syncJobId });

        return;
      }

      this.logger.log(`Processing ${playlists.length} YouTube playlists`, {
        userId,
        syncJobId,
        playlistCount: playlists.length,
      });

      const contents = playlists
        .map((playlist) => this.buildPlaylistContent({ playlist, connectionId: connection.id, userId }))
        .filter((dto): dto is CreateContentDto => dto !== null);

      // createMany dedupes on the provenance triple, so re-syncing the same
      // playlists inserts zero rows (create() would raise 23505).
      await this.contentService.createMany({ userId }, contents, { emitCreated: true });

      this.logger.log('YouTube Playlists transformation completed', {
        userId,
        syncJobId,
        processedCount: contents.length,
        skippedCount: playlists.length - contents.length,
      });
    } catch (error: unknown) {
      this.logger.error('Error transforming YouTube Playlists', {
        userId,
        syncJobId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private extractPlaylists(data: unknown): YouTubePlaylist[] {
    if (!data || typeof data !== 'object') {
      this.logger.warn('Invalid data type for YouTube playlists', {
        dataType: typeof data,
      });

      return [];
    }

    const dataObj = data as Record<string, unknown>;

    // Handle the structure from YouTube API
    if ('items' in dataObj && Array.isArray(dataObj.items)) {
      return dataObj.items as YouTubePlaylist[];
    }

    if ('id' in dataObj && 'snippet' in dataObj) {
      return [dataObj as YouTubePlaylist];
    }

    this.logger.warn('No YouTube playlists found in data', {
      dataKeys: Object.keys(dataObj),
    });

    return [];
  }

  private buildPlaylistContent({
    playlist,
    userId,
    connectionId,
  }: {
    playlist: YouTubePlaylist;
    userId: string;
    connectionId: string;
  }): CreateContentDto | null {
    const playlistId = playlist.id;

    if (!playlistId) {
      this.logger.debug('Skipping playlist without id', {
        userId,
        connectionId,
      });

      return null;
    }

    const title = playlist.snippet?.title || 'Untitled Playlist';
    const description = playlist.snippet?.description || '';
    const channelTitle = playlist.snippet?.channelTitle || '';
    const channelId = playlist.snippet?.channelId || '';
    const url = `https://www.youtube.com/playlist?list=${playlistId}`;
    const itemCount = playlist.contentDetails?.itemCount ?? 0;
    const thumbnail = bestThumbnail(playlist.snippet?.thumbnails);

    return {
      type: 'youtube_playlist',
      title,
      text: description,
      url,
      external_id: playlistId,
      source_url: url,
      source_type: 'ETL',
      source_system: YOUTUBE_SOURCE_SYSTEM,
      source_id: `playlist:${playlistId}`,
      source_data: {
        connectionId,
        channelTitle,
        channelId,
        itemCount,
        publishedAt: playlist.snippet?.publishedAt,
        providerRef: `youtube:playlist:${playlistId}`,
        ...(thumbnail ? { thumbnail } : {}),
      },
      user: { id: userId },
    };
  }
}

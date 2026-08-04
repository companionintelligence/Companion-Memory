import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { ContentService, type CreateContentDto } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import { type YouTubeThumbnails, playlistProviderRef, youtubeEmbedSourceData } from './youtubeMedia';

interface YouTubePlaylist {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    thumbnails?: YouTubeThumbnails;
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

      // Map first, then write ONCE: createMany dedupes on the provenance triple,
      // so a re-sync inserts zero rows. The previous per-item create() had no ON
      // CONFLICT and duplicated every playlist on every sync.
      const records = playlists
        .map((playlist) => this.toContentDto({ playlist, connectionId: connection.id, userId }))
        .filter((record): record is CreateContentDto => record !== null);

      if (records.length > 0) {
        await this.contentService.createMany({ userId }, records, { emitCreated: true });
      }

      this.logger.log('YouTube Playlists transformation completed', {
        userId,
        syncJobId,
        processedCount: playlists.length,
        writtenCount: records.length,
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

  /**
   * Maps one playlist to a content row, or `null` when it carries no id. Pure —
   * no I/O — so a malformed item is skipped without affecting the rest of the
   * batch.
   */
  private toContentDto({
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

    return {
      type: 'youtube_playlist',
      title,
      text: description,
      url,
      external_id: playlistId,
      source_url: url,
      // Provenance triple: makes a re-sync idempotent against
      // content_source_triple_uniq. Matches the ETL convention.
      source_type: 'ETL',
      source_system: 'youtube_playlists',
      source_id: playlistId,
      source_data: {
        connectionId,
        channelTitle,
        channelId,
        itemCount,
        // playlists.list carries no duration — only videos.list does.
        ...youtubeEmbedSourceData({
          providerRef: playlistProviderRef(playlistId),
          thumbnails: playlist.snippet?.thumbnails,
        }),
      },
      user: { id: userId },
    };
  }
}

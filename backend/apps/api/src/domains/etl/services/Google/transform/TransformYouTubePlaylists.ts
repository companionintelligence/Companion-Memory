import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';
import { ContentService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

interface YouTubePlaylist {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    channelTitle?: string;
    channelId?: string;
    publishedAt?: string;
    thumbnails?: {
      default?: { url?: string };
      medium?: { url?: string };
      high?: { url?: string };
    };
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

      await Promise.all(
        playlists.map(
          async (playlist) =>
            await this.processPlaylist({
              playlist,
              connectionId: connection.id,
              userId,
            }),
        ),
      );

      this.logger.log('YouTube Playlists transformation completed', {
        userId,
        syncJobId,
        processedCount: playlists.length,
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

  private async processPlaylist({
    playlist,
    userId,
    connectionId,
  }: {
    playlist: YouTubePlaylist;
    userId: string;
    connectionId: string;
  }): Promise<void> {
    try {
      const playlistId = playlist.id;
      if (!playlistId) {
        this.logger.debug('Skipping playlist without id', {
          userId,
          connectionId,
        });

        return;
      }

      const title = playlist.snippet?.title || 'Untitled Playlist';
      const description = playlist.snippet?.description || '';
      const channelTitle = playlist.snippet?.channelTitle || '';
      const channelId = playlist.snippet?.channelId || '';
      const url = `https://www.youtube.com/playlist?list=${playlistId}`;
      const itemCount = playlist.contentDetails?.itemCount ?? 0;

      this.logger.log('Processing YouTube playlist', {
        playlistId,
        title,
        itemCount,
      });

      await this.contentService.create(
        { userId },
        {
          type: 'youtube_playlist',
          title,
          text: description,
          url,
          external_id: playlistId,
          source_url: url,
          source_data: { connectionId, channelTitle, channelId, itemCount },
          user: { id: userId },
        },
      );

      this.logger.log('YouTube playlist saved successfully', {
        playlistId,
        title,
        itemCount,
      });
    } catch (error) {
      this.logger.error('Error processing individual YouTube playlist', {
        userId,
        connectionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Don't throw - continue processing other playlists
    }
  }
}

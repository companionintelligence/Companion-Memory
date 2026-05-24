import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import type { SpotifyPlaylist } from './types';

@Injectable()
export class SpotifyPlaylistsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SpotifyPlaylistsTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { userId, data } = syncJob;

    this.logger.log('Starting Spotify Playlists transformation', {
      userId,
      connectionId: connection.id,
    });

    try {
      const context = toServiceContext({ userId });
      const playlists = (data?.playlists as SpotifyPlaylist[]) || [];

      if (playlists.length === 0) {
        this.logger.log('No Spotify playlists found to transform', {
          userId,
          connectionId: connection.id,
        });

        return;
      }

      let createdCount = 0;
      let skippedCount = 0;
      let tracksCreatedCount = 0;
      let tracksSkippedCount = 0;

      for (const playlist of playlists) {
        try {
          // Search for existing content with same type and external_id
          const existingContent = await this.contentService.search(context, {
            type: 'Playlist',
            external_id: playlist.id,
          });

          if (existingContent.length > 0) {
            this.logger.debug('Playlist already exists, skipping', {
              playlistId: playlist.id,
              playlistName: playlist.name,
            });
            skippedCount++;
            continue;
          }

          // Process tracks first
          const tracks = playlist.tracks?.items || [];
          for (const trackItem of tracks) {
            if (!trackItem.track || !trackItem.track.id) {
              continue;
            }

            const track = trackItem.track;

            try {
              // Search for existing track with same type and external_id
              const existingTrack = await this.contentService.search(context, {
                type: 'Music',
                external_id: track.id,
              });

              if (existingTrack.length > 0) {
                this.logger.debug('Track already exists, skipping', {
                  trackId: track.id,
                  trackName: track.name,
                });
                tracksSkippedCount++;
                continue;
              }

              // Create new content entry for the track
              await this.contentService.create(context, {
                title: track.name,
                type: 'Music',
                url: track.external_urls?.spotify || '',
                external_id: track.id,
                source_url: track.external_urls?.spotify || '',
                source_data: {
                  album: track.album,
                  artists: track.artists,
                  duration_ms: track.duration_ms,
                  explicit: track.explicit,
                  popularity: track.popularity,
                  preview_url: track.preview_url,
                  uri: track.uri,
                  played_at: trackItem.played_at,
                  context: trackItem.context,
                },
              });

              tracksCreatedCount++;

              this.logger.debug('Track transformed and stored', {
                trackId: track.id,
                trackName: track.name,
              });
            } catch (error) {
              this.logger.error('Failed to transform individual track', {
                trackId: track.id,
                trackName: track.name,
                error: error instanceof Error ? error.message : 'Unknown error',
              });
              // Continue processing other tracks
            }
          }

          // Create new content entry for the playlist
          await this.contentService.create(context, {
            type: 'Playlist',
            title: playlist.name,
            text: playlist.description || '',
            url: playlist.external_urls?.spotify || '',
            external_id: playlist.id,
            source_url: playlist.external_urls?.spotify || '',
            source_data: {
              collaborative: playlist.collaborative,
              owner: playlist.owner,
              public: playlist.public,
              snapshot_id: playlist.snapshot_id,
              total_tracks: playlist.tracks?.total || 0,
              images: playlist.images,
              uri: playlist.uri,
              tracks: playlist.tracks?.items || [],
            },
          });

          createdCount++;

          this.logger.debug('Playlist transformed and stored', {
            playlistId: playlist.id,
            playlistName: playlist.name,
          });
        } catch (error) {
          this.logger.error('Failed to transform individual playlist', {
            playlistId: playlist.id,
            playlistName: playlist.name,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          // Continue processing other playlists
        }
      }

      this.logger.log('Spotify Playlists transformation completed', {
        userId,
        connectionId: connection.id,
        totalPlaylists: playlists.length,
        playlistsCreated: createdCount,
        playlistsSkipped: skippedCount,
        tracksCreated: tracksCreatedCount,
        tracksSkipped: tracksSkippedCount,
      });
    } catch (error) {
      this.logger.error('Failed to transform Spotify Playlists', {
        userId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}

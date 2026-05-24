import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, EventService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import type { SpotifyPlaylistTrackItem } from './types';

@Injectable()
export class SpotifySavedTracksTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SpotifySavedTracksTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { userId, data } = syncJob;

    this.logger.log('Starting Spotify Saved Tracks transformation', {
      userId,
      connectionId: connection.id,
    });

    try {
      const context = toServiceContext({ userId });
      const tracks = (data?.tracks as SpotifyPlaylistTrackItem[]) || [];

      if (tracks.length === 0) {
        this.logger.log('No Spotify saved tracks found to transform', {
          userId,
          connectionId: connection.id,
        });

        return;
      }

      let createdCount = 0;
      let skippedCount = 0;

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
            skippedCount++;
          } else {
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
          }

          const addedAt = trackItem.added_at!;
          await this.eventService.create(context, {
            title: `Saved track ${track.name}`,
            description: `Saved ${track.name} by ${track.artists!.map((artist) => artist.name).join(', ')} on Spotify at ${trackItem.added_at}`,
            event_type: 'favorite',
            start_time: new Date(addedAt),
            duration_minutes: 0,
            metadata: {
              track_id: track.id,
              album: track.album?.name,
              artists: track.artists?.map((artist) => artist.name),
              duration_ms: track.duration_ms,
              explicit: track.explicit,
              popularity: track.popularity,
              preview_url: track.preview_url,
              uri: track.uri,
            },
          });

          createdCount++;

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

      this.logger.log('Spotify Saved Tracks transformation completed', {
        userId,
        connectionId: connection.id,
        totalTracks: tracks.length,
        tracksCreated: createdCount,
        tracksSkipped: skippedCount,
      });
    } catch (error) {
      this.logger.error('Failed to transform Spotify Saved Tracks', {
        userId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}

import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { GraphIngestService } from '@ci/domains/graph';
import { ContentService, EventService, SOURCE_NATIVE_EXTERNAL_ID_KIND } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import { upsertContentForEvent } from './linkContentToEvent';
import type { SpotifyPlaylistTrackItem } from './types';

@Injectable()
export class SpotifyRecentlyPlayedTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly graph: GraphIngestService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SpotifyRecentlyPlayedTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { userId, data } = syncJob;

    this.logger.log('Starting Spotify Recently Played transformation', {
      userId,
      connectionId: connection.id,
    });

    try {
      const context = toServiceContext({ userId });
      const tracks = (data?.tracks as SpotifyPlaylistTrackItem[]) || [];

      if (tracks.length === 0) {
        this.logger.log('No Spotify recently played tracks found to transform', {
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
          // The play is the event; the track is content shared by every play of it.
          // Event first so the content row can point at it — see upsertContentForEvent.
          const playedAt = trackItem.played_at!;
          const [event] = await this.eventService.create(context, {
            connection_id: connection.id,
            title: `Played ${track.name}`,
            description: `Played ${track.name} by ${track.artists!.map((artist) => artist.name).join(', ')} on Spotify at ${trackItem.played_at}`,
            event_type: 'played_music',
            start_time: new Date(new Date(playedAt).getTime() - track.duration_ms),
            end_time: new Date(playedAt),
            duration_minutes: Math.round(track.duration_ms / 60000),
            // Provenance triple: EventService.createOne find-or-creates on it,
            // so re-sweeps of the rolling recently-played window (the same
            // plays come back every sync) resolve to the existing event. A
            // play is unique per (track, played_at) — Spotify's timestamp is
            // stable across sweeps.
            source_type: 'ETL',
            source_system: 'spotify',
            source_id: `play:${track.id}:${playedAt}`,
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

          const existingTrack = await this.contentService.search(context, {
            type: 'Music',
            external_id: track.id,
          });

          const { created } = await upsertContentForEvent({
            context,
            contentService: this.contentService,
            graph: this.graph,
            logger: this.logger,
            existing: existingTrack,
            eventId: event?.id,
            input: {
              connection_id: connection.id,
              title: track.name,
              type: 'Music',
              url: track.external_urls?.spotify || '',
              external_id: track.id,
              external_id_kind: SOURCE_NATIVE_EXTERNAL_ID_KIND,
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
            },
          });

          if (!created) {
            this.logger.debug('Track already exists, linked play to it', {
              trackId: track.id,
              trackName: track.name,
            });
            skippedCount++;
          }

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

      this.logger.log('Spotify Recently Played transformation completed', {
        userId,
        connectionId: connection.id,
        totalTracks: tracks.length,
        tracksCreated: createdCount,
        tracksSkipped: skippedCount,
      });
    } catch (error) {
      this.logger.error('Failed to transform Spotify Recently Played', {
        userId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}

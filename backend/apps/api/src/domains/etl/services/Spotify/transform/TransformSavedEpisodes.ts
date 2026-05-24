import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, EventService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import type { SpotifyEpisode } from './types';

@Injectable()
export class SpotifySavedEpisodesTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SpotifySavedEpisodesTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { userId, data } = syncJob;

    this.logger.log('Starting Spotify Saved Episodes transformation', {
      userId,
      connectionId: connection.id,
    });

    try {
      const context = toServiceContext({ userId });
      const episodes = (data?.episodes as SpotifyEpisode[]) || [];

      if (episodes.length === 0) {
        this.logger.log('No Spotify saved episodes found to transform', {
          userId,
          connectionId: connection.id,
        });

        return;
      }

      let createdCount = 0;
      let skippedCount = 0;

      for (const episodeItem of episodes) {
        if (!episodeItem.episode || !episodeItem.episode.id) {
          continue;
        }

        const episode = episodeItem.episode;

        try {
          // Search for existing episode with same type and external_id
          const existingEpisode = await this.contentService.search(context, {
            type: 'Episode',
            external_id: episode.id,
          });

          if (existingEpisode.length > 0) {
            this.logger.debug('Episode already exists, skipping', {
              episodeId: episode.id,
              episodeName: episode.name,
            });
            skippedCount++;
          } else {
            // Create new content entry for the episode
            await this.contentService.create(context, {
              title: episode.name,
              type: 'Episode',
              url: episode.external_urls?.spotify || '',
              source_url: episode.external_urls?.spotify || '',
              external_id: episode.id,
              source_data: {
                audio_preview_url: episode.audio_preview_url,
                description: episode.description,
                html_description: episode.html_description,
                duration_ms: episode.duration_ms,
                explicit: episode.explicit,
                href: episode.href,
                images: episode.images,
                is_externally_hosted: episode.is_externally_hosted,
                is_playable: episode.is_playable,
                language: episode.language,
                languages: episode.languages,
                release_date: episode.release_date,
                release_date_precision: episode.release_date_precision,
                resume_point: episode.resume_point,
                type: episode.type,
                uri: episode.uri,
                restrictions: episode.restrictions,
                show: episode.show,
                added_at: episodeItem.added_at,
              },
            });

            createdCount++;
          }

          // Create event for saving the episode
          if (episodeItem.added_at) {
            await this.eventService.create(context, {
              title: `Saved episode ${episode.name}`,
              description: `Saved ${episode.name} from ${episode.show?.name || 'podcast'} on Spotify at ${episodeItem.added_at}`,
              event_type: 'favorite',
              start_time: new Date(episodeItem.added_at),
              duration_minutes: Math.floor(episode.duration_ms / 60000),
              metadata: {
                episode_id: episode.id,
                show_name: episode.show?.name,
                show_id: episode.show?.id,
                publisher: episode.show?.publisher,
                release_date: episode.release_date,
                duration_ms: episode.duration_ms,
                explicit: episode.explicit,
                uri: episode.uri,
                resume_point: episode.resume_point,
              },
            });
          }

          this.logger.debug('Episode transformed and stored', {
            episodeId: episode.id,
            episodeName: episode.name,
          });
        } catch (error) {
          this.logger.error('Failed to transform individual episode', {
            episodeId: episode.id,
            episodeName: episode.name,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          // Continue processing other episodes
        }
      }

      this.logger.log('Spotify Saved Episodes transformation completed', {
        userId,
        connectionId: connection.id,
        totalEpisodes: episodes.length,
        episodesCreated: createdCount,
        episodesSkipped: skippedCount,
      });
    } catch (error) {
      this.logger.error('Failed to transform Spotify Saved Episodes', {
        userId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}

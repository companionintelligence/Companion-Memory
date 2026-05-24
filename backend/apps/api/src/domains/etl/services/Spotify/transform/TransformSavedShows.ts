import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, EventService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import type { SpotifyShow } from './types';

@Injectable()
export class SpotifySavedShowsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SpotifySavedShowsTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { userId, data } = syncJob;

    this.logger.log('Starting Spotify Saved Shows transformation', {
      userId,
      connectionId: connection.id,
    });

    try {
      const context = toServiceContext({ userId });
      const shows = (data?.shows as SpotifyShow[]) || [];

      if (shows.length === 0) {
        this.logger.log('No Spotify saved shows found to transform', {
          userId,
          connectionId: connection.id,
        });

        return;
      }

      let createdCount = 0;
      let skippedCount = 0;

      for (const showItem of shows) {
        if (!showItem.show || !showItem.show.id) {
          continue;
        }

        const show = showItem.show;

        try {
          // Search for existing show with same type and external_id
          const existingShow = await this.contentService.search(context, {
            type: 'Show',
            external_id: show.id,
          });

          //Audiobooks are technically stored as shows in the Spotify API, so they show
          //up in both Saved Shows and Saved Audiobooks. But in Saved Shows, they are
          //listed as type 'show', while the audiobooks endpoint returns them as type 'audiobook.
          //If the audiobook has already been imported from the audiobooks endpoint, then we
          //will skip it.
          const existingShowIsAudiobook = await this.contentService.search(context, {
            type: 'Audiobook',
            external_id: show.id,
          });

          if (existingShow.length > 0 || existingShowIsAudiobook.length > 0) {
            this.logger.debug('Show already exists, skipping', {
              showId: show.id,
              showName: show.name,
            });
            skippedCount++;
          } else {
            // Create new content entry for the show
            await this.contentService.create(context, {
              title: show.name,
              type: 'Show',
              url: show.external_urls?.spotify || '',
              source_url: show.external_urls?.spotify || '',
              external_id: show.id,
              source_data: {
                copyrights: show.copyrights,
                description: show.description,
                html_description: show.html_description,
                explicit: show.explicit,
                href: show.href,
                images: show.images,
                is_externally_hosted: show.is_externally_hosted,
                languages: show.languages,
                media_type: show.media_type,
                type: show.type,
                uri: show.uri,
                total_episodes: show.total_episodes,
                added_at: showItem.added_at,
              },
            });

            createdCount++;
          }

          // Create event for saving the show
          if (showItem.added_at) {
            await this.eventService.create(context, {
              title: `Saved ${existingShowIsAudiobook.length > 0 ? 'audiobook' : 'show'} ${show.name}`,
              description: `Saved ${show.name} on Spotify at ${showItem.added_at}`,
              event_type: 'favorite',
              start_time: new Date(showItem.added_at),
              duration_minutes: 0,
              metadata: {
                show_id: show.id,
                total_episodes: show.total_episodes,
                media_type: show.media_type,
                explicit: show.explicit,
                uri: show.uri,
              },
            });
          }

          this.logger.debug('Show transformed and stored', {
            showId: show.id,
            showName: show.name,
          });
        } catch (error) {
          this.logger.error('Failed to transform individual show', {
            showId: show.id,
            showName: show.name,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          // Continue processing other shows
        }
      }

      this.logger.log('Spotify Saved Shows transformation completed', {
        userId,
        connectionId: connection.id,
        totalShows: shows.length,
        showsCreated: createdCount,
        showsSkipped: skippedCount,
      });
    } catch (error) {
      this.logger.error('Failed to transform Spotify Saved Shows', {
        userId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}

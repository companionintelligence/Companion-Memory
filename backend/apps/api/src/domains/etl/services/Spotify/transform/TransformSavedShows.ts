import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { GraphIngestService } from '@ci/domains/graph';
import { ContentService, CalendarEventService, SOURCE_NATIVE_EXTERNAL_ID_KIND } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import { upsertContentForEvent } from './linkContentToEvent';
import type { SpotifyShow } from './types';

@Injectable()
export class SpotifySavedShowsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: CalendarEventService,
    private readonly graph: GraphIngestService,
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
          //If the audiobook has already been imported from the audiobooks endpoint, then
          //the save is linked to that row instead of creating a duplicate 'Show'.
          const existingShowIsAudiobook = await this.contentService.search(context, {
            type: 'Audiobook',
            external_id: show.id,
          });

          // The save is the event; the show is content shared with every other
          // save of it. Event first so the content row can point at it.
          const [event] = showItem.added_at
            ? await this.eventService.create(context, {
                connection_id: connection.id,
                title: `Saved ${existingShowIsAudiobook.length > 0 ? 'audiobook' : 'show'} ${show.name}`,
                description: `Saved ${show.name} on Spotify at ${showItem.added_at}`,
                event_type: 'favorite',
                start_time: new Date(showItem.added_at),
                duration_minutes: 0,
                // Provenance triple: CalendarEventService.createOne find-or-creates on
                // it, so a re-sweep of the saved-shows list resolves to the
                // existing event instead of minting another.
                source_type: 'ETL',
                source_system: 'spotify',
                source_id: `saved_show:${show.id}`,
                metadata: {
                  show_id: show.id,
                  total_episodes: show.total_episodes,
                  media_type: show.media_type,
                  explicit: show.explicit,
                  uri: show.uri,
                },
              })
            : [];

          const { created } = await upsertContentForEvent({
            context,
            contentService: this.contentService,
            graph: this.graph,
            logger: this.logger,
            existing: [...existingShowIsAudiobook, ...existingShow],
            eventId: event?.id,
            input: {
              connection_id: connection.id,
              title: show.name,
              type: 'Show',
              url: show.external_urls?.spotify || '',
              source_url: show.external_urls?.spotify || '',
              external_id: show.id,
              external_id_kind: SOURCE_NATIVE_EXTERNAL_ID_KIND,
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
            },
          });

          if (created) {
            createdCount++;
          } else {
            this.logger.debug('Show already exists, linked save to it', {
              showId: show.id,
              showName: show.name,
            });
            skippedCount++;
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

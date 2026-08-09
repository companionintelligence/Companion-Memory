import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, EventService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';

import type { SpotifyAudiobook } from './types';

@Injectable()
export class SpotifySavedAudiobooksTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SpotifySavedAudiobooksTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { userId, data } = syncJob;

    this.logger.log('Starting Spotify Saved Audiobooks transformation', {
      userId,
      connectionId: connection.id,
    });

    try {
      const context = toServiceContext({ userId });
      const audiobooks = (data?.audiobooks as SpotifyAudiobook[]) || [];

      if (audiobooks.length === 0) {
        this.logger.log('No Spotify saved audiobooks found to transform', {
          userId,
          connectionId: connection.id,
        });

        return;
      }

      let createdCount = 0;
      let skippedCount = 0;

      for (const audiobook of audiobooks) {
        if (!audiobook || !audiobook.id) {
          continue;
        }

        try {
          // Search for existing audiobook with same type and external_id
          const existingAudiobook = await this.contentService.search(context, {
            type: 'Audiobook',
            external_id: audiobook.id,
          });

          //Audiobooks are technically stored as shows in the Spotify API, so they show
          //up in both Saved Shows and Saved Audiobooks. But in Saved Shows, they are
          //listed as type 'show', while the audiobooks endpoint returns them as type 'audiobook.
          //If the audiobook has already been imported from the shows endpoint, then we
          //want to just change the type.
          const existingAudiobookFromShows = await this.contentService.search(context, {
            type: 'Show',
            external_id: audiobook.id,
          });

          if (existingAudiobook.length > 0) {
            this.logger.debug('Audiobook already exists, skipping', {
              audiobookId: audiobook.id,
              audiobookName: audiobook.name,
            });
            skippedCount++;
          } else if (existingAudiobookFromShows.length > 0) {
            await this.contentService.update(context, existingAudiobookFromShows[0].id, {
              type: 'Audiobook',
            });

            const events = await this.eventService.search(context, {
              eventType: 'favorite',
              title: `Saved show ${audiobook.name}`,
            });

            await Promise.all(
              events.map(async (event) => {
                await this.eventService.update(context, event.id, {
                  // title is nullable on egress (owned by the CTI base row);
                  // these rows matched the title filter above, so fall back
                  // defensively rather than crash.
                  title: (event.title ?? `Saved show ${audiobook.name}`).replace('show', 'audiobook'),
                });
              }),
            );
          } else {
            // Create new content entry for the audiobook
            await this.contentService.create(context, {
              title: audiobook.name,
              type: 'Audiobook',
              url: audiobook.external_urls?.spotify || '',
              source_url: audiobook.external_urls?.spotify || '',
              external_id: audiobook.id,
              source_data: {
                authors: audiobook.authors,
                available_markets: audiobook.available_markets,
                copyrights: audiobook.copyrights,
                description: audiobook.description,
                html_description: audiobook.html_description,
                edition: audiobook.edition,
                explicit: audiobook.explicit,
                href: audiobook.href,
                images: audiobook.images,
                languages: audiobook.languages,
                media_type: audiobook.media_type,
                narrators: audiobook.narrators,
                publisher: audiobook.publisher,
                type: audiobook.type,
                uri: audiobook.uri,
                total_chapters: audiobook.total_chapters,
              },
            });

            createdCount++;
          }

          this.logger.debug('Audiobook transformed and stored', {
            audiobookId: audiobook.id,
            audiobookName: audiobook.name,
          });
        } catch (error) {
          this.logger.error('Failed to transform individual audiobook', {
            audiobookId: audiobook.id,
            audiobookName: audiobook.name,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          // Continue processing other audiobooks
        }
      }

      this.logger.log('Spotify Saved Audiobooks transformation completed', {
        userId,
        connectionId: connection.id,
        totalAudiobooks: audiobooks.length,
        audiobooksCreated: createdCount,
        audiobooksSkipped: skippedCount,
      });
    } catch (error) {
      this.logger.error('Failed to transform Spotify Saved Audiobooks', {
        userId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}

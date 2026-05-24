import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection } from '@ci/domains/connections';
import { ContentService, GraphUtilityService } from '@ci/domains/memory';

import { ConnectionSyncJob } from '../../../types';
import { PromoteService } from '../../PromoteService';

import type { SpotifyArtist } from './types';

@Injectable()
export class SpotifyTopArtistsTransformService {
  constructor(
    private readonly contentService: ContentService,
    private readonly graphUtilityService: GraphUtilityService,
    private readonly promoteService: PromoteService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SpotifyTopArtistsTransformService.name);
  }

  async transform({
    connection,
    syncJob,
  }: {
    connection: Connection;
    syncJob: ConnectionSyncJob;
  }): Promise<void> {
    const { userId, data } = syncJob;

    this.logger.log('Starting Spotify Top Artists transformation', {
      userId,
      connectionId: connection.id,
    });

    try {
      const context = toServiceContext({ userId });
      const artists = (data?.artists as SpotifyArtist[]) || [];

      if (artists.length === 0) {
        this.logger.log('No Spotify top artists found to transform', {
          userId,
          connectionId: connection.id,
        });

        return;
      }

      // Get user's graph node for creating relationships
      const { userNode } = await this.promoteService.getUserAndEntity(context, userId);

      let artistsProcessed = 0;
      let genresCreated = 0;
      let genresSkipped = 0;
      let relationshipsCreated = 0;

      for (const artist of artists) {
        try {
          const genres = artist.genres || [];

          this.logger.debug('Processing artist genres', {
            artistId: artist.id,
            artistName: artist.name,
            genreCount: genres.length,
          });

          for (const genre of genres) {
            if (!genre || genre.trim() === '') {
              continue;
            }

            const trimmedGenre = genre.trim();

            try {
              // Search for existing genre concept nodes
              const existingNodes = await this.graphUtilityService.searchNodesByText(userId, trimmedGenre, {
                limit: 5,
              });

              // Check if any of the results are an exact match for the genre
              const exactMatch = existingNodes.find(
                (result) =>
                  result.node.entity_type === 'Concept' &&
                  result.node.name?.toLowerCase() === trimmedGenre.toLowerCase(),
              );

              let genreNode;

              if (exactMatch) {
                genreNode = exactMatch.node;
                genresSkipped++;

                this.logger.debug('Genre concept already exists', {
                  genre: trimmedGenre,
                  nodeId: genreNode.entity_id,
                });
              } else {
                // Create new genre concept node
                const { node, created } = await this.graphUtilityService.createOrUpdateNode(userId, {
                  entityType: 'Concept',
                  name: trimmedGenre,
                  description: `Music genre: ${trimmedGenre}`,
                  properties: {
                    source: 'spotify',
                    category: 'music_genre',
                  },
                });

                genreNode = node;

                if (created) {
                  genresCreated++;

                  this.logger.debug('Created new genre concept', {
                    genre: trimmedGenre,
                    nodeId: genreNode.entity_id,
                  });
                } else {
                  genresSkipped++;
                }
              }

              // Create relationship between user and genre concept
              await this.graphUtilityService.createRelationship(
                userNode.entityId,
                genreNode.entity_id,
                'PREFERS',
                {
                  source: 'spotify',
                  artist_id: artist.id,
                  artist_name: artist.name,
                  popularity: artist.popularity,
                },
                1,
                userId,
              );

              relationshipsCreated++;

              this.logger.debug('Created PREFERS relationship', {
                userId,
                genre: trimmedGenre,
                artist: artist.name,
              });
            } catch (error) {
              this.logger.error('Failed to process individual genre', {
                genre: trimmedGenre,
                artistName: artist.name,
                error: error instanceof Error ? error.message : 'Unknown error',
              });
              // Continue processing other genres
            }
          }

          artistsProcessed++;
        } catch (error) {
          this.logger.error('Failed to process artist', {
            artistId: artist.id,
            artistName: artist.name,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          // Continue processing other artists
        }
      }

      this.logger.log('Spotify Top Artists transformation completed', {
        userId,
        connectionId: connection.id,
        totalArtists: artists.length,
        artistsProcessed,
        genresCreated,
        genresSkipped,
        relationshipsCreated,
      });
    } catch (error) {
      this.logger.error('Failed to transform Spotify Top Artists', {
        userId,
        connectionId: connection.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }
}

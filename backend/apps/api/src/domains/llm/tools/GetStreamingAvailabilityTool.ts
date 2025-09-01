/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TMDBClient } from '../clients';
import type { TMDBItem, TMDBWatchProvidersResponse } from '../clients';
import { BaseTool } from './BaseTool';
import type { ToolExecutionContext } from './types';

// Input schema for the tool
const getStreamingAvailabilityInputSchema = z.object({
  genre: z.string().optional(),
  contentType: z.enum(['movie', 'tv', 'both']).optional(),
  country: z.string().default('US'),
  limit: z.number().min(1).max(50).default(20),
});

type GetStreamingAvailabilityInput = z.infer<typeof getStreamingAvailabilityInputSchema>;

// Output interfaces
interface StreamingTitle {
  id: string;
  title: string;
  type: 'movie' | 'tv';
  year?: number;
  genre: string[];
  description?: string;
  rating?: {
    imdb?: number;
    tmdb?: number;
  };
  streamingServices: {
    service: string;
    url?: string;
    monetizationType: string; // 'subscription', 'rent', 'buy', 'free'
  }[];
  posterUrl?: string;
}

interface GetStreamingAvailabilityOutput {
  titles: StreamingTitle[];
  totalCount: number;
  filters: {
    genre?: string;
    contentType?: string;
  };
  metadata: {
    queryTime: number;
    source: 'TMDB';
    country: string;
  };
}

/**
 * Tool to get current streaming availability using TMDB API
 *
 * CURRENT IMPLEMENTATION:
 * - Uses The Movie Database (TMDB) API - reliable, documented, free
 * - Real genre-based search using TMDB's discover endpoint
 * - Real streaming availability via TMDB watch providers API
 * - Real genre names and metadata
 * - No puppeteer dependencies, simple HTTP requests
 *
 * FUTURE ENHANCEMENTS:
 * - Search functionality by title
 * - User's actual streaming subscription filtering
 * - "Leaving soon" alerts from providers
 * - Cache results to reduce API calls
 * - Advanced filters (year, rating, etc.)
 */
@Injectable()
export class GetStreamingAvailabilityTool extends BaseTool<
  GetStreamingAvailabilityInput,
  GetStreamingAvailabilityOutput
> {
  private readonly tmdbClient: TMDBClient;

  readonly schema = {
    name: 'get_streaming_availability',
    description:
      'Get currently trending movies and TV shows with real streaming availability data. Can filter by genre and content type. Shows which platforms (Netflix, Hulu, Disney+, etc.) currently have each title available. Use this when users ask about what to watch, want specific genres, or need streaming recommendations.',
    category: 'external_api',
    parameters: {
      type: 'object',
      properties: {
        genre: {
          type: 'string',
          description:
            'Filter by genre (e.g., "action", "comedy", "drama", "horror", "sci-fi", "thriller", "romance", "adventure", "animation", "documentary")',
        },
        contentType: {
          type: 'string',
          enum: ['movie', 'tv', 'both'],
          description: 'Type of content to search for (default: both)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of titles to return (1-50, default: 20)',
        },
      },
      required: [],
    },
    examples: [
      {
        input: { genre: 'comedy', contentType: 'movie' },
        output: {
          titles: [
            {
              id: 'tmdb-12345',
              title: 'Funny Comedy Movie',
              type: 'movie',
              year: 2024,
              genre: ['comedy', 'romance'],
              description: 'A hilarious romantic comedy...',
              rating: { tmdb: 7.8 },
              streamingServices: [
                { service: 'netflix', monetizationType: 'subscription' },
                { service: 'hulu', monetizationType: 'subscription' },
              ],
              posterUrl: 'https://image.tmdb.org/t/p/w500/poster.jpg',
            },
          ],
          totalCount: 1,
          filters: { genre: 'comedy', contentType: 'movie' },
          metadata: { queryTime: 1200, source: 'TMDB', country: 'US' },
        },
        description: 'Get comedy movies with streaming availability',
      },
    ],
  };

  constructor(tmdbClient: TMDBClient) {
    super();
    this.tmdbClient = tmdbClient;
  }

  protected validateInput(input: unknown): GetStreamingAvailabilityInput {
    return getStreamingAvailabilityInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: GetStreamingAvailabilityInput,
  ): Promise<GetStreamingAvailabilityOutput> {
    const startTime = Date.now();

    try {
      // Use TMDB client instead of direct API calls
      const apiResponse = await this.tmdbClient.fetchContent(input);

      // Process the API response (now async to get real streaming data)
      const titles = await this.processTMDBResponse(apiResponse, input);

      return {
        titles,
        totalCount: titles.length,
        filters: {
          genre: input.genre,
          contentType: input.contentType,
        },
        metadata: {
          queryTime: Date.now() - startTime,
          source: 'TMDB',
          country: input.country,
        },
      };
    } catch (error) {
      throw new Error(
        `Failed to get streaming availability: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get watch providers for a specific title using TMDB client
   */
  private async getWatchProviders(
    tmdbId: string,
    mediaType: 'movie' | 'tv',
  ): Promise<StreamingTitle['streamingServices']> {
    try {
      const data = await this.tmdbClient.getWatchProviders(tmdbId, mediaType);
      const usProviders = data.results?.US; // in the future we should chain calls to get providers local to where the user currently is

      if (!usProviders) {
        return [];
      }

      const streamingServices: StreamingTitle['streamingServices'] = [];

      // Map TMDB provider names to our standardized names
      const providerMap: Record<string, string> = {
        Netflix: 'netflix',
        Hulu: 'hulu',
        'Disney Plus': 'disney',
        'HBO Max': 'hbo',
        'Paramount Plus': 'paramount',
        'Amazon Video': 'prime',
        'Amazon Prime Video': 'prime',
        'Apple TV Plus': 'apple',
        'Apple TV': 'apple',
      };

      // Add subscription services (flatrate)
      if (usProviders.flatrate) {
        for (const provider of usProviders.flatrate) {
          const serviceName = providerMap[provider.provider_name] || provider.provider_name.toLowerCase();
          streamingServices.push({
            service: serviceName,
            monetizationType: 'subscription',
          });
        }
      }

      // Add rental services
      if (usProviders.rent) {
        for (const provider of usProviders.rent.slice(0, 2)) {
          // Limit to first 2
          const serviceName = providerMap[provider.provider_name] || provider.provider_name.toLowerCase();
          streamingServices.push({
            service: serviceName,
            monetizationType: 'rent',
          });
        }
      }

      return streamingServices;
    } catch {
      // Return empty array on any error - don't break the main request
      return [];
    }
  }

  /**
   * Process TMDB API response into our format
   */
  private async processTMDBResponse(
    apiResponse: { results: TMDBItem[] },
    input: GetStreamingAvailabilityInput,
  ): Promise<StreamingTitle[]> {
    if (!apiResponse?.results) {
      return [];
    }

    const titles: StreamingTitle[] = [];

    // Process items concurrently but limit to avoid rate limiting
    const items = apiResponse.results.slice(0, input.limit);
    const batchSize = 5; // Process 5 at a time to avoid overwhelming TMDB

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      const batchPromises = batch.map(async (item: TMDBItem) => {
        // Determine type
        const type: 'movie' | 'tv' = item.media_type === 'movie' || item.title ? 'movie' : 'tv';

        // Get real streaming providers
        const streamingServices = await this.getWatchProviders(item.id.toString(), type);

        // Get real genre names from TMDB using client
        const genreNames =
          item.genre_ids && item.genre_ids.length > 0 
            ? await this.tmdbClient.getGenreNames(item.genre_ids, type) 
            : [];

        return {
          id: item.id.toString(),
          title: item.title || item.name || 'Unknown Title',
          type,
          year: item.release_date
            ? new Date(item.release_date).getFullYear()
            : item.first_air_date
              ? new Date(item.first_air_date).getFullYear()
              : undefined,
          genre: genreNames,
          description: item.overview,
          rating: {
            tmdb: item.vote_average,
          },
          streamingServices,
          posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
        };
      });

      const batchResults = await Promise.all(batchPromises);
      titles.push(...batchResults);
    }

    return titles;
  }

  protected sanitizeInputForLogging(input: unknown): any {
    // No sensitive data in streaming availability input
    return input;
  }
}

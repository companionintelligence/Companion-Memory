/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';

import { BaseTool } from '../../core/BaseTool';
import type { ToolExecutionContext } from '../../core/types';

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
  readonly schema = {
    name: 'getStreamingAvailability',
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

  constructor(protected readonly logger: LoggerService) {
    super();
    this.logger.setContext(GetStreamingAvailabilityTool.name);
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
      // Use TMDB API instead of JustWatch (more reliable, documented API)
      const apiResponse = await this.fetchFromTMDB(input);

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
   * Get TMDB genre ID from genre name
   */
  private async getGenreId(genreName: string, mediaType: 'movie' | 'tv'): Promise<number | null> {
    const TMDB_API_KEY = process.env.TMDB_API_KEY;

    if (!TMDB_API_KEY || TMDB_API_KEY === 'demo-key') {
      return null;
    }

    try {
      const url = `https://api.themoviedb.org/3/genre/${mediaType}/list?api_key=${TMDB_API_KEY}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'CompanionIntel/1.0',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const normalizedGenre = genreName.toLowerCase().trim();

      // Find matching genre (flexible matching)
      const matchingGenre = data.genres?.find((g: any) => {
        const genreNameLower = g.name.toLowerCase();

        return (
          genreNameLower === normalizedGenre ||
          genreNameLower.includes(normalizedGenre) ||
          normalizedGenre.includes(genreNameLower)
        );
      });

      return matchingGenre?.id || null;
    } catch {
      return null;
    }
  }

  /**
   * Get genre names from TMDB genre IDs
   */
  private async getGenreNames(genreIds: number[], mediaType: 'movie' | 'tv'): Promise<string[]> {
    const TMDB_API_KEY = process.env.TMDB_API_KEY;

    if (!TMDB_API_KEY || TMDB_API_KEY === 'demo-key') {
      return [];
    }

    try {
      const url = `https://api.themoviedb.org/3/genre/${mediaType}/list?api_key=${TMDB_API_KEY}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'CompanionIntel/1.0',
        },
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      const genreMap = new Map(data.genres?.map((g: any) => [g.id, g.name]) || []);

      return genreIds.map((id) => genreMap.get(id)).filter(Boolean) as string[];
    } catch {
      return [];
    }
  }

  /**
   * Fetch data from TMDB API (reliable, documented API)
   */
  private async fetchFromTMDB(input: GetStreamingAvailabilityInput): Promise<any> {
    const TMDB_API_KEY = process.env.TMDB_API_KEY || 'demo-key';

    if (TMDB_API_KEY === 'demo-key') {
      throw new Error('TMDB_API_KEY environment variable not set');
    }

    // If genre is specified, use discover endpoint for better filtering
    if (input.genre) {
      return this.fetchByGenre(input, TMDB_API_KEY);
    }

    // Otherwise use trending endpoint
    const contentType = input.contentType === 'movie' ? 'movie' : input.contentType === 'tv' ? 'tv' : 'all';

    const url = `https://api.themoviedb.org/3/trending/${contentType}/week?api_key=${TMDB_API_KEY}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'CompanionIntel/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`TMDB API error: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Fetch content by genre using TMDB discover endpoint
   */
  private async fetchByGenre(input: GetStreamingAvailabilityInput, apiKey: string): Promise<any> {
    const contentType = input.contentType;

    // Handle mixed content type by fetching both and combining
    if (!contentType || contentType === 'both') {
      const [movieResults, tvResults] = await Promise.all([
        this.fetchSingleTypeByGenre(input, 'movie', apiKey),
        this.fetchSingleTypeByGenre(input, 'tv', apiKey),
      ]);

      // Combine results
      const combinedResults = [...(movieResults?.results || []), ...(tvResults?.results || [])].slice(
        0,
        input.limit,
      );

      return { results: combinedResults };
    }

    // Fetch single content type
    return this.fetchSingleTypeByGenre(input, contentType, apiKey);
  }

  /**
   * Fetch single content type by genre
   */
  private async fetchSingleTypeByGenre(
    input: GetStreamingAvailabilityInput,
    mediaType: 'movie' | 'tv',
    apiKey: string,
  ): Promise<any> {
    // Get genre ID from name
    const genreId = await this.getGenreId(input.genre!, mediaType);

    if (!genreId) {
      // If genre not found, fall back to trending for this type
      const url = `https://api.themoviedb.org/3/trending/${mediaType}/week?api_key=${apiKey}`;
      const response = await fetch(url);

      return response.ok ? await response.json() : { results: [] };
    }

    // Use discover endpoint with genre filter
    const url = `https://api.themoviedb.org/3/discover/${mediaType}?api_key=${apiKey}&with_genres=${genreId}&sort_by=popularity.desc&page=1`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'CompanionIntel/1.0',
      },
    });

    if (!response.ok) {
      return { results: [] };
    }

    const data = await response.json();
    // Add media_type for consistency with trending endpoint
    if (data.results) {
      data.results.forEach((item: any) => {
        item.media_type = mediaType;
      });
    }

    return data;
  }

  /**
   * Get watch providers for a specific title from TMDB
   */
  private async getWatchProviders(
    tmdbId: string,
    mediaType: 'movie' | 'tv',
  ): Promise<StreamingTitle['streamingServices']> {
    const TMDB_API_KEY = process.env.TMDB_API_KEY;

    if (!TMDB_API_KEY || TMDB_API_KEY === 'demo-key') {
      return []; // Return empty array if no API key
    }

    try {
      const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'CompanionIntel/1.0',
        },
      });

      if (!response.ok) {
        return []; // Return empty on error
      }

      const data = await response.json();
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
    apiResponse: any,
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

      const batchPromises = batch.map(async (item: any) => {
        // Determine type
        const type: 'movie' | 'tv' = item.media_type === 'movie' || item.title ? 'movie' : 'tv';

        // Get real streaming providers
        const streamingServices = await this.getWatchProviders(item.id.toString(), type);

        // Get real genre names from TMDB
        const genreNames =
          item.genre_ids && item.genre_ids.length > 0 ? await this.getGenreNames(item.genre_ids, type) : [];

        return {
          id: item.id.toString(),
          title: item.title || item.name,
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

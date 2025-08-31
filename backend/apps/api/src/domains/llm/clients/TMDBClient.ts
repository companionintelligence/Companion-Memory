import { LoggerService } from '@ci/common/services';

/**
 * Types for TMDB API responses
 */
export interface TMDBGenre {
  id: number;
  name: string;
}

export interface TMDBGenreResponse {
  genres: TMDBGenre[];
}

export interface TMDBItem {
  id: number;
  title?: string; // For movies
  name?: string; // For TV shows
  media_type?: 'movie' | 'tv';
  overview: string;
  vote_average: number;
  release_date?: string; // For movies
  first_air_date?: string; // For TV shows
  genre_ids: number[];
  poster_path?: string;
}

export interface TMDBResponse {
  results: TMDBItem[];
  total_results?: number;
  total_pages?: number;
}

export interface TMDBWatchProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string;
}

export interface TMDBWatchProvidersResponse {
  results: {
    [countryCode: string]: {
      flatrate?: TMDBWatchProvider[];
      rent?: TMDBWatchProvider[];
      buy?: TMDBWatchProvider[];
    };
  };
}

export interface GetStreamingAvailabilityInput {
  genre?: string;
  contentType?: 'movie' | 'tv' | 'both';
  country?: string;
  limit?: number;
}

/**
 * TMDB API client for handling The Movie Database API interactions
 * 
 * This client encapsulates all TMDB API concerns and provides a clean interface
 * for streaming availability tools and other consumers.
 */
export class TMDBClient {
  private readonly logger: LoggerService;
  private readonly apiKey: string;
  private readonly baseUrl = 'https://api.themoviedb.org/3';
  private readonly userAgent = 'CompanionIntel/1.0';

  constructor() {
    this.logger = new LoggerService(this.constructor.name);
    this.apiKey = process.env.TMDB_API_KEY || 'demo-key';
    
    if (this.apiKey === 'demo-key') {
      this.logger.warn('TMDB_API_KEY environment variable not set');
    }
  }

  /**
   * Make a request to the TMDB API
   */
  private async request<T>(endpoint: string): Promise<T> {
    if (this.apiKey === 'demo-key') {
      throw new Error('TMDB_API_KEY environment variable not set');
    }

    const url = `${this.baseUrl}${endpoint}${endpoint.includes('?') ? '&' : '?'}api_key=${this.apiKey}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': this.userAgent,
      },
    });

    if (!response.ok) {
      throw new Error(`TMDB API error: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get trending content from TMDB
   */
  async getTrending(contentType: 'movie' | 'tv' | 'all' = 'all'): Promise<TMDBResponse> {
    return this.request<TMDBResponse>(`/trending/${contentType}/week`);
  }

  /**
   * Get genre list for movies or TV shows
   */
  async getGenres(mediaType: 'movie' | 'tv'): Promise<TMDBGenreResponse> {
    return this.request<TMDBGenreResponse>(`/genre/${mediaType}/list`);
  }

  /**
   * Get genre ID from genre name
   */
  async getGenreId(genreName: string, mediaType: 'movie' | 'tv'): Promise<number | null> {
    try {
      const response = await this.getGenres(mediaType);
      const normalizedGenre = genreName.toLowerCase().trim();

      // Find matching genre (flexible matching)
      const matchingGenre = response.genres?.find((g: TMDBGenre) => {
        const genreNameLower = g.name.toLowerCase();
        return (
          genreNameLower === normalizedGenre ||
          genreNameLower.includes(normalizedGenre) ||
          normalizedGenre.includes(genreNameLower)
        );
      });

      return matchingGenre?.id || null;
    } catch (error) {
      this.logger.error('Failed to get genre ID', { genreName, mediaType, error });
      return null;
    }
  }

  /**
   * Get genre names from TMDB genre IDs
   */
  async getGenreNames(genreIds: number[], mediaType: 'movie' | 'tv'): Promise<string[]> {
    try {
      const response = await this.getGenres(mediaType);
      const genreMap = new Map(response.genres?.map((g: TMDBGenre) => [g.id, g.name]) || []);
      
      return genreIds.map((id) => genreMap.get(id)).filter(Boolean) as string[];
    } catch (error) {
      this.logger.error('Failed to get genre names', { genreIds, mediaType, error });
      return [];
    }
  }

  /**
   * Discover content by genre using TMDB discover endpoint
   */
  async discoverByGenre(genreId: number, mediaType: 'movie' | 'tv'): Promise<TMDBResponse> {
    return this.request<TMDBResponse>(`/discover/${mediaType}?with_genres=${genreId}&sort_by=popularity.desc&page=1`);
  }

  /**
   * Get watch providers for a specific title
   */
  async getWatchProviders(tmdbId: string, mediaType: 'movie' | 'tv'): Promise<TMDBWatchProvidersResponse> {
    try {
      return await this.request<TMDBWatchProvidersResponse>(`/${mediaType}/${tmdbId}/watch/providers`);
    } catch (error) {
      this.logger.error('Failed to get watch providers', { tmdbId, mediaType, error });
      return { results: {} };
    }
  }

  /**
   * Fetch content based on input parameters
   */
  async fetchContent(input: GetStreamingAvailabilityInput): Promise<TMDBResponse> {
    // If genre is specified, use discover endpoint for better filtering
    if (input.genre) {
      return this.fetchByGenre(input);
    }

    // Otherwise use trending endpoint
    const contentType = input.contentType === 'movie' ? 'movie' : input.contentType === 'tv' ? 'tv' : 'all';
    return this.getTrending(contentType);
  }

  /**
   * Fetch content by genre using TMDB discover endpoint
   */
  private async fetchByGenre(input: GetStreamingAvailabilityInput): Promise<TMDBResponse> {
    const contentType = input.contentType;

    // Handle mixed content type by fetching both and combining
    if (!contentType || contentType === 'both') {
      const [movieResults, tvResults] = await Promise.all([
        this.fetchSingleTypeByGenre(input, 'movie'),
        this.fetchSingleTypeByGenre(input, 'tv'),
      ]);

      // Combine results
      const combinedResults = [...(movieResults?.results || []), ...(tvResults?.results || [])].slice(
        0,
        input.limit || 20,
      );

      return { results: combinedResults };
    }

    // Fetch single content type
    return this.fetchSingleTypeByGenre(input, contentType);
  }

  /**
   * Fetch single content type by genre
   */
  private async fetchSingleTypeByGenre(
    input: GetStreamingAvailabilityInput,
    mediaType: 'movie' | 'tv',
  ): Promise<TMDBResponse> {
    // Get genre ID from name
    const genreId = await this.getGenreId(input.genre!, mediaType);

    if (!genreId) {
      // If genre not found, fall back to trending for this type
      return this.getTrending(mediaType);
    }

    const response = await this.discoverByGenre(genreId, mediaType);
    
    // Add media_type for consistency with trending endpoint
    if (response.results) {
      response.results.forEach((item: TMDBItem) => {
        item.media_type = mediaType;
      });
    }

    return response;
  }
}
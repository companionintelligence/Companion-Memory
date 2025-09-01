import { Injectable } from '@nestjs/common';

import { EmbeddingService } from '../../search/services/EmbeddingService';
import { UserService } from '../../user/services/UserService';
import { ConnectionService } from '../../connections/services/ConnectionService';

import { BaseTool } from './BaseTool';
import type { ToolSchema, ToolExecutionContext } from './types';

interface SearchInput {
  query: string;
  category: 'people' | 'places' | 'things' | 'events' | 'locations' | 'actions' | 'jobs' | 'all';
  limit: number;
}

interface SearchResult {
  category: string;
  results: Array<{
    id?: string;
    text: string;
    relevanceScore: number;
    type?: string;
    metadata?: Record<string, any>;
  }>;
  totalFound: number;
  searchTime: number;
}

interface CombinedSearchResult {
  query: string;
  categories: SearchResult[];
  totalResults: number;
  executionTime: number;
  suggestions?: string[];
}

/**
 * Tool for searching across CI Server data including people, places, things, events, locations, actions, and jobs
 * Integrates with the embedding service for semantic search and various domain services for structured data
 */
@Injectable()
export class CIServerSearchTool extends BaseTool<SearchInput, CombinedSearchResult> {
  readonly schema: ToolSchema = {
    name: 'ci_server_search',
    description: 'Search across CI Server data including people, places, things, events, locations, actions, and jobs using natural language queries',
    category: 'search',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query in natural language (e.g., "find John", "show me lights in living room", "what automations are running")',
        },
        category: {
          type: 'string',
          enum: ['people', 'places', 'things', 'events', 'locations', 'actions', 'jobs', 'all'],
          description: 'Optional: restrict search to specific category. Use "all" for comprehensive search across all categories.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results per category',
        },
      },
      required: ['query'],
    },
  };

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly userService: UserService,
    private readonly connectionService: ConnectionService,
  ) {
    super();
  }

  protected validateInput(input: unknown): SearchInput {
    const validated = input as SearchInput;
    
    if (!validated.query || typeof validated.query !== 'string') {
      throw new Error('Query is required and must be a string');
    }
    
    if (validated.query.trim().length === 0) {
      throw new Error('Query cannot be empty');
    }

    return {
      query: validated.query.trim(),
      category: validated.category || 'all',
      limit: Math.min(Math.max(validated.limit || 10, 1), 50),
    };
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: SearchInput,
  ): Promise<CombinedSearchResult> {
    const startTime = Date.now();
    const results: SearchResult[] = [];
    let totalResults = 0;

    this.logger.log('Executing CI Server search', {
      query: input.query,
      category: input.category,
      limit: input.limit,
      userId: context.userId,
    });

    try {
      // If specific category requested, search only that category
      if (input.category && input.category !== 'all') {
        const categoryResult = await this.searchCategory(context, input.query, input.category, input.limit);
        results.push(categoryResult);
        totalResults += categoryResult.totalFound;
      } else {
        // Search all categories
        const categories: Array<Exclude<SearchInput['category'], 'all'>> = [
          'people', 'places', 'things', 'events', 'actions', 'jobs'
        ];

        const searchPromises = categories.map(async (category) => {
          return this.searchCategory(context, input.query, category, Math.ceil(input.limit / categories.length));
        });

        const categoryResults = await Promise.allSettled(searchPromises);
        
        categoryResults.forEach((result, index) => {
          if (result.status === 'fulfilled' && result.value) {
            results.push(result.value);
            totalResults += result.value.totalFound;
          } else if (result.status === 'rejected') {
            this.logger.warn(`Category search failed: ${categories[index]}`, {
              error: result.reason,
              query: input.query,
            });
          }
        });
      }

      const executionTime = Date.now() - startTime;

      // Generate search suggestions based on results
      const suggestions = this.generateSearchSuggestions(input.query, results);

      return {
        query: input.query,
        categories: results.sort((a, b) => b.totalFound - a.totalFound), // Sort by relevance
        totalResults,
        executionTime,
        suggestions,
      };

    } catch (error) {
      this.logger.error('CI Server search failed', {
        query: input.query,
        category: input.category,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async searchCategory(
    context: ToolExecutionContext,
    query: string,
    category: string,
    limit: number,
  ): Promise<SearchResult> {
    const categoryStartTime = Date.now();
    let results: Array<{
      id?: string;
      text: string;
      relevanceScore: number;
      type?: string;
      metadata?: Record<string, any>;
    }> = [];

    try {
      switch (category) {
        case 'people':
          results = await this.searchPeople(context, query, limit);
          break;
        case 'places':
        case 'locations':
          results = await this.searchPlaces(context, query, limit);
          break;
        case 'things':
          results = await this.searchThings(context, query, limit);
          break;
        case 'events':
          results = await this.searchEvents(context, query, limit);
          break;
        case 'actions':
          results = await this.searchActions(context, query, limit);
          break;
        case 'jobs':
          results = await this.searchJobs(context, query, limit);
          break;
        default:
          this.logger.warn(`Unknown search category: ${category}`);
          break;
      }
    } catch (error) {
      this.logger.error(`Search failed for category ${category}`, {
        query,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      category,
      results: results.slice(0, limit),
      totalFound: results.length,
      searchTime: Date.now() - categoryStartTime,
    };
  }

  private async searchPeople(
    context: ToolExecutionContext,
    query: string,
    limit: number,
  ): Promise<Array<{ id?: string; text: string; relevanceScore: number; type?: string; metadata?: Record<string, any> }>> {
    const results = [];

    try {
      // Search users in the system
      // Note: This would need to be implemented in UserService to search users
      // For now, we'll use embedding search with 'user' type
      const embeddingResults = await this.embeddingService.findNearest(context, query, 'user', limit);
      
      results.push(...embeddingResults.map((result: any) => ({
        id: result.id,
        text: result.text,
        relevanceScore: 1 - (result.distance || 0), // Convert distance to relevance score
        type: 'user',
        metadata: { path: result.path, entityType: result.type },
      })));

      // Search family members from LLM tools data
      const familyResults = await this.embeddingService.findNearest(context, query + ' family member person', 'family', Math.ceil(limit / 2));
      
      results.push(...familyResults.map((result: any) => ({
        id: result.id,
        text: result.text,
        relevanceScore: 1 - (result.distance || 0),
        type: 'family',
        metadata: { path: result.path, entityType: result.type },
      })));

    } catch (error) {
      this.logger.error('People search failed', { query, error });
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
  }

  private async searchPlaces(
    context: ToolExecutionContext,
    query: string,
    limit: number,
  ): Promise<Array<{ id?: string; text: string; relevanceScore: number; type?: string; metadata?: Record<string, any> }>> {
    const results = [];

    try {
      // Search locations and places
      const locationQueries = [
        query + ' location place zone area',
        query + ' room house building address',
      ];

      for (const locationQuery of locationQueries) {
        const embeddingResults = await this.embeddingService.findNearest(
          context, 
          locationQuery, 
          undefined, // Search all types
          Math.ceil(limit / locationQueries.length)
        );
        
        results.push(...embeddingResults.map((result: any) => ({
          id: result.id,
          text: result.text,
          relevanceScore: 1 - (result.distance || 0),
          type: 'location',
          metadata: { path: result.path, entityType: result.type },
        })));
      }

    } catch (error) {
      this.logger.error('Places search failed', { query, error });
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
  }

  private async searchThings(
    context: ToolExecutionContext,
    query: string,
    limit: number,
  ): Promise<Array<{ id?: string; text: string; relevanceScore: number; type?: string; metadata?: Record<string, any> }>> {
    const results = [];

    try {
      // Search devices, entities, and physical things
      const deviceQueries = [
        query + ' device entity thing object',
        query + ' light camera sensor switch',
        query + ' smart home automation device',
      ];

      for (const deviceQuery of deviceQueries) {
        const embeddingResults = await this.embeddingService.findNearest(
          context, 
          deviceQuery, 
          undefined,
          Math.ceil(limit / deviceQueries.length)
        );
        
        results.push(...embeddingResults.map((result: any) => ({
          id: result.id,
          text: result.text,
          relevanceScore: 1 - (result.distance || 0),
          type: 'device',
          metadata: { path: result.path, entityType: result.type },
        })));
      }

    } catch (error) {
      this.logger.error('Things search failed', { query, error });
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
  }

  private async searchEvents(
    context: ToolExecutionContext,
    query: string,
    limit: number,
  ): Promise<Array<{ id?: string; text: string; relevanceScore: number; type?: string; metadata?: Record<string, any> }>> {
    const results = [];

    try {
      // Search events, triggers, automations
      const eventQueries = [
        query + ' event trigger automation occurred',
        query + ' notification alert alarm',
        query + ' schedule routine',
      ];

      for (const eventQuery of eventQueries) {
        const embeddingResults = await this.embeddingService.findNearest(
          context, 
          eventQuery, 
          undefined,
          Math.ceil(limit / eventQueries.length)
        );
        
        results.push(...embeddingResults.map((result: any) => ({
          id: result.id,
          text: result.text,
          relevanceScore: 1 - (result.distance || 0),
          type: 'event',
          metadata: { path: result.path, entityType: result.type },
        })));
      }

    } catch (error) {
      this.logger.error('Events search failed', { query, error });
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
  }

  private async searchActions(
    context: ToolExecutionContext,
    query: string,
    limit: number,
  ): Promise<Array<{ id?: string; text: string; relevanceScore: number; type?: string; metadata?: Record<string, any> }>> {
    const results = [];

    try {
      // Search actions, services, automations
      const actionQueries = [
        query + ' action service automation run',
        query + ' turn control activate trigger',
        query + ' execute perform do',
      ];

      for (const actionQuery of actionQueries) {
        const embeddingResults = await this.embeddingService.findNearest(
          context, 
          actionQuery, 
          undefined,
          Math.ceil(limit / actionQueries.length)
        );
        
        results.push(...embeddingResults.map((result: any) => ({
          id: result.id,
          text: result.text,
          relevanceScore: 1 - (result.distance || 0),
          type: 'action',
          metadata: { path: result.path, entityType: result.type },
        })));
      }

    } catch (error) {
      this.logger.error('Actions search failed', { query, error });
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
  }

  private async searchJobs(
    context: ToolExecutionContext,
    query: string,
    limit: number,
  ): Promise<Array<{ id?: string; text: string; relevanceScore: number; type?: string; metadata?: Record<string, any> }>> {
    const results = [];

    try {
      // Search background jobs and tasks
      // Note: This would need to be implemented to get actual job data
      // For now, search embeddings for job-related content
      const jobQueries = [
        query + ' job task background process',
        query + ' queue running completed failed',
        query + ' sync automation scheduled',
      ];

      for (const jobQuery of jobQueries) {
        const embeddingResults = await this.embeddingService.findNearest(
          context, 
          jobQuery, 
          undefined,
          Math.ceil(limit / jobQueries.length)
        );
        
        results.push(...embeddingResults.map((result: any) => ({
          id: result.id,
          text: result.text,
          relevanceScore: 1 - (result.distance || 0),
          type: 'job',
          metadata: { path: result.path, entityType: result.type },
        })));
      }

    } catch (error) {
      this.logger.error('Jobs search failed', { query, error });
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
  }

  private generateSearchSuggestions(query: string, results: SearchResult[]): string[] {
    const suggestions: string[] = [];
    
    // Analyze results to generate helpful suggestions
    const topCategories = results
      .filter(r => r.totalFound > 0)
      .sort((a, b) => b.totalFound - a.totalFound)
      .slice(0, 3);

    if (topCategories.length > 0) {
      topCategories.forEach(category => {
        if (category.results.length > 0) {
          const topResult = category.results[0];
          suggestions.push(`Try: "${query} in ${category.category}"`);
          if (topResult.type) {
            suggestions.push(`Try: "${query} ${topResult.type}"`);
          }
        }
      });
    }

    // Add generic suggestions based on query
    if (query.length < 3) {
      suggestions.push('Try a more specific search term');
    }
    
    if (!query.includes(' ')) {
      suggestions.push('Try adding descriptive words to your search');
    }

    return suggestions.slice(0, 5); // Limit to 5 suggestions
  }
}
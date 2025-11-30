import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { SearchService, type DatabaseSearchResults } from '@ci/domains/memory';

import { BaseTool } from '../../core/BaseTool';
import type { ToolExecutionContext } from '../../core/types';

const DatabaseSearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  searchMode: z.enum(['semantic', 'keyword', 'hybrid', 'auto']).optional(),
  scopes: z.array(z.enum(['entities', 'facts', 'documents', 'messages'])).optional(),
  entityTypes: z.array(z.string()).optional(),
  includeRelationships: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
});

export type DatabaseSearchInput = z.infer<typeof DatabaseSearchInputSchema>;

@Injectable()
export class DatabaseSearchTool extends BaseTool<DatabaseSearchInput, DatabaseSearchResults> {
  readonly schema = {
    name: 'databaseSearch',
    description:
      'Search across all your personal data using natural language or keywords. ' +
      'Searches entities (people, places, concepts), facts, documents, and conversation messages. ' +
      'Use this for broad searches like "find everything about coffee" or "when did I last visit Paris". ' +
      'For specific graph queries like "my family members", use readKnowledge instead. ' +
      'For precise entity lookups, use readKnowledge with filters.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query or keywords to search for',
          minLength: 1,
          maxLength: 500,
        },
        searchMode: {
          type: 'string',
          enum: ['semantic', 'keyword', 'hybrid', 'auto'],
          description:
            'Search strategy: ' +
            'semantic (meaning-based, uses AI embeddings), ' +
            'keyword (exact text matches, good for names/IDs), ' +
            'hybrid (combines both for best results), ' +
            'or auto (automatically choose based on query). Default: auto',
        },
        scopes: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['entities', 'facts', 'documents', 'messages'],
          },
          description:
            'Which data types to search. Options: entities (people/places/concepts), ' +
            'facts (archived knowledge), documents (PDFs/files), messages (conversation history). ' +
            'Omit this parameter or provide empty array to search all data types. ' +
            'Examples: ["entities", "documents"] or ["messages"]',
        },
        entityTypes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'When searching entities, filter to specific types: Person, Concept, Location, Object, etc.',
        },
        includeRelationships: {
          type: 'boolean',
          description: 'Include relationship context for entity results (default: false)',
        },
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of results to return (default: 25)',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    examples: [
      {
        input: {
          query: 'coffee shops I visited',
          searchMode: 'auto',
          maxResults: 10,
        },
        output: {
          items: [
            {
              id: 'uuid-entity-1',
              type: 'entity',
              score: 0.92,
              name: 'Blue Bottle Coffee',
              content: 'Coffee shop in downtown',
              metadata: { entityType: 'Location' },
            },
            {
              id: 'uuid-msg-1',
              type: 'message',
              score: 0.85,
              content: 'I went to that new coffee shop on Main Street...',
              metadata: { threadTitle: 'Weekend Plans', role: 'user' },
            },
          ],
          totalResults: 2,
          searchMode: 'hybrid',
          executionTimeMs: 45,
        },
        description: 'Natural language search across all data types (default behavior)',
      },
      {
        input: {
          query: 'john.smith@example.com',
          searchMode: 'keyword',
          scopes: ['entities'],
          entityTypes: ['Person'],
        },
        output: {
          items: [
            {
              id: 'uuid-person-1',
              type: 'entity',
              score: 0.98,
              name: 'John Smith',
              properties: { email: 'john.smith@example.com' },
              metadata: { entityType: 'Person' },
            },
          ],
          totalResults: 1,
          searchMode: 'keyword',
          executionTimeMs: 12,
        },
        description: 'Precise keyword search for email address',
      },
      {
        input: {
          query: 'machine learning papers I read',
          searchMode: 'semantic',
          scopes: ['documents', 'messages'],
          maxResults: 15,
        },
        output: {
          items: [
            {
              id: 'uuid-chunk-1',
              type: 'document_chunk',
              score: 0.89,
              content: 'Abstract: This paper presents a novel approach to...',
              metadata: { documentTitle: 'Attention Is All You Need', sectionTitle: 'Abstract' },
            },
          ],
          totalResults: 1,
          searchMode: 'semantic',
          executionTimeMs: 67,
        },
        description: 'Semantic search across documents and messages only',
      },
    ],
  };

  constructor(private readonly searchService: SearchService) {
    super();
  }

  protected validateInput(input: unknown): DatabaseSearchInput {
    return DatabaseSearchInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: DatabaseSearchInput,
  ): Promise<DatabaseSearchResults> {
    if (!context.userId) {
      throw new Error('User context required for database search');
    }

    return await this.searchService.search(context.userId, {
      query: input.query,
      searchMode: input.searchMode,
      scopes: input.scopes,
      entityTypes: input.entityTypes,
      includeRelationships: input.includeRelationships,
      maxResults: input.maxResults,
    });
  }
}

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { GraphQueryService, GraphNodeEntity } from '@ci/domains/graph';
import { EmbeddingService } from '@ci/domains/search';

import { BaseTool } from '../../core/BaseTool';
import type { ToolExecutionContext } from '../../core/types';

const searchKnowledgeInputSchema = z.object({
  term: z.string().min(2, 'Search term must be at least 2 characters long'),
  limit: z.number().int().min(1).max(20).default(5),
  types: z.array(z.string().min(1)).optional(),
});

type SearchKnowledgeInput = z.infer<typeof searchKnowledgeInputSchema>;

interface GraphEntitySummary {
  id: string;
  type: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  outgoingRelationshipIds: string[];
  linkedTable: string | null;
  linkedId: string | null;
  metadata: {
    createdAt?: string;
    updatedAt?: string;
    lastAccessed?: string;
  };
}

interface SearchKnowledgeResultItem {
  rank: number;
  id: string;
  type: string;
  distance: number;
  confidence: number;
  textSnippet: string | null;
  entity?: GraphEntitySummary;
}

interface SearchKnowledgeOutput {
  query: string;
  limit: number;
  results: SearchKnowledgeResultItem[];
  stats: {
    totalResults: number;
    entityResults: number;
  };
  warnings?: string[];
}

@Injectable()
export class SearchKnowledgeTool extends BaseTool<SearchKnowledgeInput, SearchKnowledgeOutput> {
  readonly schema = {
    name: 'searchKnowledge',
    description:
      'Perform semantic search across the personal knowledge base. Supply the plain-text query as `term` to get entity-centric results including graph metadata and IDs for follow-up traversal. ' +
      'You can adjust `limit` (default 5) or optionally narrow `types` to other indexed domains.',
    category: 'search',
    parameters: {
      type: 'object',
      properties: {
        term: {
          type: 'string',
          description:
            'Required natural-language query matched against embeddings (for example: "favorite coffees" or "documents about taxes").',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          default: 5,
          description: 'Maximum number of results to return (default: 5).',
        },
        types: {
          type: 'array',
          description:
            'Optional override to include additional index types (entity, question, answer). Omit to search entities only.',
          items: { type: 'string' },
        },
      },
      required: ['term'],
      additionalProperties: false,
    },
    examples: [
      {
        input: { term: 'favorite coffees', limit: 5 },
        output: {
          query: 'favorite coffees',
          limit: 5,
          results: [
            {
              rank: 1,
              id: '11111111-1111-1111-1111-111111111111',
              type: 'entity',
              distance: 0.12,
              confidence: 0.89,
              textSnippet: 'User prefers medium roast coffee with notes of citrus.',
              entity: {
                id: '11111111-1111-1111-1111-111111111111',
                type: 'Concept',
                name: 'Coffee Preferences',
                description: 'Detailed profile of coffee tastes.',
                properties: { brew_method: 'Pour over', roast: 'Medium', caffeine: 'High' },
                outgoingRelationshipIds: ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
                linkedTable: null,
                linkedId: null,
                metadata: {
                  createdAt: '2024-01-01T12:00:00.000Z',
                  updatedAt: '2024-03-01T08:30:00.000Z',
                  lastAccessed: '2024-03-12T09:15:00.000Z',
                },
              },
            },
          ],
          stats: {
            totalResults: 1,
            entityResults: 1,
          },
        },
        description:
          'Finds the most relevant knowledge about coffee preferences and returns the entity with full context.',
      },
    ],
  };

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly graphQueryService: GraphQueryService,
  ) {
    super();
  }

  protected validateInput(input: unknown): SearchKnowledgeInput {
    return searchKnowledgeInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: SearchKnowledgeInput,
  ): Promise<SearchKnowledgeOutput> {
    if (!context.userId) {
      throw new Error('User context is required to execute search');
    }

    const resolvedTypes = this.resolveSearchTypes(input.types);
    const results = await this.embeddingService.findNearest(context, input.term, resolvedTypes, input.limit);

    if (results.length === 0) {
      return {
        query: input.term,
        limit: input.limit,
        results: [],
        stats: {
          totalResults: 0,
          entityResults: 0,
        },
      };
    }

    const entityIds = Array.from(
      new Set(results.filter((result) => result.type === 'entity').map((result) => result.id)),
    );
    const entityMap = await this.loadEntities(context.userId, entityIds);
    const formattedResults: SearchKnowledgeResultItem[] = results.map((result, index) => ({
      rank: index + 1,
      id: result.id,
      type: result.type,
      distance: result.distance,
      confidence: this.distanceToConfidence(result.distance),
      textSnippet: result.text,
      entity: result.type === 'entity' ? entityMap.get(result.id) : undefined,
    }));

    const missingEntities = entityIds.filter((entityId) => !entityMap.has(entityId));

    return {
      query: input.term,
      limit: input.limit,
      results: formattedResults,
      stats: {
        totalResults: results.length,
        entityResults: entityMap.size,
      },
      warnings:
        missingEntities.length > 0
          ? [
              `${missingEntities.length} entity results were omitted because the entities could not be loaded.`,
            ]
          : undefined,
    };
  }

  private resolveSearchTypes(types: string[] | undefined): string[] {
    if (!types || types.length === 0) {
      return ['entity'];
    }

    const trimmed = types.map((type) => type.trim()).filter((type) => type.length > 0);

    return trimmed.length > 0 ? trimmed : ['entity'];
  }

  private async loadEntities(ownerId: string, entityIds: string[]): Promise<Map<string, GraphEntitySummary>> {
    if (entityIds.length === 0) {
      return new Map();
    }

    const nodes = await this.graphQueryService.getNodesByIds(ownerId, entityIds);

    return new Map(nodes.map((node) => [node.entity_id, this.toGraphEntitySummary(node)]));
  }

  private toGraphEntitySummary(node: GraphNodeEntity): GraphEntitySummary {
    return {
      id: node.entity_id,
      type: node.entity_type,
      name: node.name,
      description: node.description,
      properties: node.properties ?? {},
      outgoingRelationshipIds: Array.isArray(node.outgoing_relationships) ? node.outgoing_relationships : [],
      linkedTable: node.linked_table,
      linkedId: node.linked_id,
      metadata: {
        createdAt: this.toIsoString(node.created_at),
        updatedAt: this.toIsoString(node.updated_at),
        lastAccessed: this.toIsoString(node.last_accessed),
      },
    };
  }

  private distanceToConfidence(distance: number): number {
    if (!Number.isFinite(distance) || distance < 0) {
      return 0;
    }

    const confidence = 1 / (1 + distance);

    return Math.max(0, Math.min(1, Number(confidence.toFixed(4))));
  }

  private toIsoString(value: Date | string | null | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
}

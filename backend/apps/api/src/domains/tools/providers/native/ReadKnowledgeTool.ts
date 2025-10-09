import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { GraphUtilityService } from '@ci/domains/memory';
import { GraphNodeEntity } from '@ci/domains/memory/entities/GraphNodeEntity';
import { RelationshipEntity } from '@ci/domains/memory/entities/RelationshipEntity';

import { BaseTool } from '../../core/BaseTool';
import type { ToolExecutionContext } from '../../core/types';

const ReadKnowledgeInputBaseSchema = z.object({
  entityId: z.string().uuid().optional(),
  entityIds: z.array(z.string().uuid()).nonempty().optional(),
  filters: z
    .object({
      entityType: z.string().min(1).optional(),
      nameContains: z.string().min(2).optional(),
      propertyEquals: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .optional(),
  relationshipTypes: z.array(z.string().min(1)).nonempty().optional(),
  traversal: z
    .object({
      direction: z.enum(['outbound', 'inbound', 'both']).default('both'),
      maxDepth: z.number().int().min(0).max(3).default(1),
      maxNodes: z.number().int().min(1).max(200).default(25),
      maxEdges: z.number().int().min(1).max(500).default(50),
    })
    .default({ direction: 'both', maxDepth: 1, maxNodes: 25, maxEdges: 50 }),
  include: z
    .object({
      properties: z.boolean().default(false),
      relationships: z.boolean().default(true),
      metadata: z.boolean().default(true),
    })
    .default({ properties: false, relationships: true, metadata: true }),
});

const ReadKnowledgeInputSchema = ReadKnowledgeInputBaseSchema.refine(
  (value) => value.entityId || value.entityIds || value.filters,
  'Provide an entity identifier or filters to seed the knowledge query',
);

export type ReadKnowledgeInput = z.infer<typeof ReadKnowledgeInputSchema>;

export interface KnowledgeNodeSummary {
  id: string;
  type: string;
  name: string | null;
  description?: string | null;
  properties?: Record<string, unknown>;
  metadata?: {
    createdAt?: string;
    updatedAt?: string;
    linkedTable?: string | null;
    linkedId?: string | null;
  };
}

export interface KnowledgeEdgeSummary {
  id: string;
  type: string;
  from: { id: string; name?: string | null };
  to: { id: string; name?: string | null };
  properties?: Record<string, unknown>;
  strength?: number;
  bidirectional?: boolean;
}

export interface ReadKnowledgeOutput {
  seedEntityIds: string[];
  nodes: KnowledgeNodeSummary[];
  edges: KnowledgeEdgeSummary[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    truncatedNodes: boolean;
    truncatedEdges: boolean;
  };
  warnings?: string[];
}

@Injectable()
export class ReadKnowledgeTool extends BaseTool<ReadKnowledgeInput, ReadKnowledgeOutput> {
  readonly schema = {
    name: 'readKnowledge',
    description:
      'Traverse the personal knowledge graph to retrieve entities and relationships, summarised for reasoning.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        entityId: { type: 'string', format: 'uuid' },
        entityIds: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          description: 'Seed entity identifiers for traversal',
        },
        filters: {
          type: 'object',
          properties: {
            entityType: { type: 'string' },
            nameContains: { type: 'string' },
            propertyEquals: {
              type: 'object',
              additionalProperties: {
                anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
              },
            },
            limit: { type: 'integer', minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
        relationshipTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict traversal to specific relationship types',
        },
        traversal: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: ['outbound', 'inbound', 'both'], default: 'both' },
            maxDepth: { type: 'integer', minimum: 0, maximum: 3, default: 1 },
            maxNodes: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
            maxEdges: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          },
          additionalProperties: false,
        },
        include: {
          type: 'object',
          properties: {
            properties: { type: 'boolean', default: false },
            relationships: { type: 'boolean', default: true },
            metadata: { type: 'boolean', default: true },
          },
          additionalProperties: false,
        },
      },
      required: [],
      additionalProperties: false,
    },
    examples: [
      {
        input: {
          entityId: '11111111-1111-1111-1111-111111111111',
          traversal: { maxDepth: 1 },
          include: { properties: true },
        },
        output: {
          seedEntityIds: ['11111111-1111-1111-1111-111111111111'],
          nodes: [{ id: '11111111-1111-1111-1111-111111111111', type: 'Person', name: 'John Smith' }],
          edges: [],
          stats: {
            nodeCount: 1,
            edgeCount: 0,
            truncatedNodes: false,
            truncatedEdges: false,
          },
        },
        description: 'Fetch a single entity and its immediate connections',
      },
    ],
  };

  constructor(private readonly graphUtility: GraphUtilityService) {
    super();
  }

  protected validateInput(input: unknown): ReadKnowledgeInput {
    return ReadKnowledgeInputSchema.parse(input);
  }

  protected async executeInternal(
    context: ToolExecutionContext,
    input: ReadKnowledgeInput,
  ): Promise<ReadKnowledgeOutput> {
    if (!context.userId) {
      throw new Error('User context is required to read knowledge');
    }

    const ownerId = context.userId;
    const traversalOptions = input.traversal;
    const seedIds = new Set<string>();

    if (input.entityId) {
      seedIds.add(input.entityId);
    }

    if (input.entityIds) {
      input.entityIds.forEach((id) => seedIds.add(id));
    }

    let seedNodes: string[] = Array.from(seedIds);

    if (seedNodes.length === 0 && input.filters) {
      const filterLimit = input.filters.limit ?? traversalOptions.maxNodes;
      const candidates = await this.graphUtility.queryNodes(
        ownerId,
        {
          entityType: input.filters.entityType,
          nameContains: input.filters.nameContains,
          propertyEquals: input.filters.propertyEquals,
        },
        { limit: filterLimit },
      );

      seedNodes = candidates.map((node) => node.entity_id);
      candidates.forEach((node) => seedIds.add(node.entity_id));
    }

    if (seedNodes.length === 0) {
      return {
        seedEntityIds: [],
        nodes: [],
        edges: [],
        stats: {
          nodeCount: 0,
          edgeCount: 0,
          truncatedNodes: false,
          truncatedEdges: false,
        },
        warnings: ['No matching entities were found for the provided filters'],
      };
    }

    const { nodes, edges } = await this.graphUtility.traverseGraph(ownerId, seedNodes, {
      relationshipTypes: input.relationshipTypes,
      direction: traversalOptions.direction,
      maxDepth: traversalOptions.maxDepth,
      maxNodes: traversalOptions.maxNodes,
      maxEdges: traversalOptions.maxEdges,
    });

    const includeProperties = input.include.properties;
    const includeRelationships = input.include.relationships;

    // Ensure the explicit seed nodes are present in the response when possible
    const ensuredSeedNodes = await this.graphUtility.getNodesByIds(seedNodes, ownerId);
    ensuredSeedNodes.forEach((node) => nodes.set(node.entity_id, node));

    const nodeSummaries: KnowledgeNodeSummary[] = Array.from(nodes.values()).map((node) =>
      this.buildNodeSummary(node, includeProperties, input.include.metadata),
    );

    const edgeSummaries: KnowledgeEdgeSummary[] = includeRelationships
      ? edges.map((edge) => this.buildEdgeSummary(edge, nodes))
      : [];

    return {
      seedEntityIds: Array.from(seedIds),
      nodes: nodeSummaries,
      edges: edgeSummaries,
      stats: {
        nodeCount: nodeSummaries.length,
        edgeCount: edgeSummaries.length,
        truncatedNodes: nodeSummaries.length >= traversalOptions.maxNodes,
        truncatedEdges: edgeSummaries.length >= traversalOptions.maxEdges,
      },
    };
  }

  private buildNodeSummary(
    node: GraphNodeEntity,
    includeProperties: boolean,
    includeMetadata: boolean,
  ): KnowledgeNodeSummary {
    const summary: KnowledgeNodeSummary = {
      id: node.entity_id,
      type: node.entity_type,
      name: node.name ?? null,
    };

    if (node.description) {
      summary.description = node.description;
    }

    if (includeProperties && node.properties) {
      summary.properties = this.pickRepresentativeProperties(node.properties);
    }

    if (includeMetadata) {
      summary.metadata = {
        createdAt: node.created_at?.toISOString?.() ?? undefined,
        updatedAt: node.updated_at?.toISOString?.() ?? undefined,
        linkedTable: node.linked_table ?? null,
        linkedId: node.linked_id ?? null,
      };
    }

    return summary;
  }

  private buildEdgeSummary(
    edge: RelationshipEntity,
    nodes: Map<string, GraphNodeEntity>,
  ): KnowledgeEdgeSummary {
    const fromNode = nodes.get(edge.from_entity_id);
    const toNode = nodes.get(edge.to_entity_id);

    return {
      id: edge.relationship_id,
      type: edge.relationship_type,
      from: {
        id: edge.from_entity_id,
        name: fromNode?.name ?? null,
      },
      to: {
        id: edge.to_entity_id,
        name: toNode?.name ?? null,
      },
      properties: this.pickRepresentativeProperties(edge.properties ?? {}),
      strength: edge.strength,
      bidirectional: edge.is_bidirectional,
    };
  }

  private pickRepresentativeProperties(properties: Record<string, unknown>): Record<string, unknown> {
    const entries = Object.entries(properties).filter(([, value]) => value != null);
    const limited = entries.slice(0, 8);

    return Object.fromEntries(limited);
  }
}

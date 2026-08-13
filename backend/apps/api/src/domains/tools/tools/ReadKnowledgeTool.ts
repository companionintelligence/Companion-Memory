import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { LoggerService } from '@ci/common/logging';
import { GraphQueryService, GraphNodeEntity, RelationshipEntity } from '@ci/domains/memory';

import { BaseTool } from '../core/BaseTool';
import type { IntentDefinition, ToolExecutionContext } from '../core/types';

const ReadKnowledgeInputBaseSchema = z.object({
  // Semantic entity references (preferred for LLM usage)
  useCurrentUser: z.boolean().optional().default(true),
  personName: z.string().optional(),

  // Direct entity references (for advanced usage)
  entityId: z.string().uuid().optional(),
  entityIds: z.array(z.string().uuid()).nonempty().optional(),

  // Filter-based entity lookup
  filters: z
    .object({
      entityType: z.string().min(1).optional(),
      nameContains: z.string().min(2).optional(),
      propertyEquals: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .optional(),

  // Relationship filtering
  relationshipTypes: z.array(z.string().min(1)).nonempty().optional(),

  // Traversal options
  traversal: z
    .object({
      direction: z.enum(['outbound', 'inbound', 'both']).default('both'),
      maxDepth: z.number().int().min(0).max(3).default(1),
      maxNodes: z.number().int().min(1).max(200).default(25),
      maxEdges: z.number().int().min(1).max(500).default(50),
    })
    .default({ direction: 'both', maxDepth: 1, maxNodes: 25, maxEdges: 50 }),

  // Output options
  include: z
    .object({
      properties: z.boolean().default(false),
      relationships: z.boolean().default(true),
      metadata: z.boolean().default(true),
    })
    .default({ properties: false, relationships: true, metadata: true }),
});

const ReadKnowledgeInputSchema = ReadKnowledgeInputBaseSchema.refine(
  (value) => value.useCurrentUser || value.personName || value.entityId || value.entityIds || value.filters,
  'Provide a way to identify entities: useCurrentUser, personName, entityId/entityIds, or filters',
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
  readonly schema: IntentDefinition = {
    name: 'memory.recall',
    domain: 'memory',
    title: 'Recall knowledge',
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: false },
    // Graph traversal over the user's own entities/relationships — the mirror can serve it.
    localCapable: true,
    produces: ['concept', 'person'],
    phrases: ['What do you know about $person', 'Recall my $topic'],
    description:
      'General-purpose tool to query the personal knowledge graph. Use this to explore entities (people, places, concepts) and their relationships. ' +
      'Supports filtering by entity type, names, properties, and relationship types (PREFERS, DISLIKES, KNOWS, WORKS_WITH, etc.). ' +
      "This is the most flexible knowledge retrieval tool - use it when specialized tools like getEntertainmentPreferences don't fit your needs. " +
      'Common use cases: finding user preferences, exploring social connections, discovering hobbies and interests, querying locations, and understanding relationships between entities.',
    category: 'database',
    parameters: {
      type: 'object',
      properties: {
        useCurrentUser: {
          type: 'boolean',
          description:
            'Start from the current user\'s entity (default: true). Use this for queries like "my family", "my preferences", etc.',
          default: true,
        },
        personName: {
          type: 'string',
          description:
            'Name or relationship of a person to query (e.g., "my wife", "John Smith", "my brother"). Resolves to their entity automatically.',
        },
        entityId: {
          type: 'string',
          format: 'uuid',
          description: 'Direct entity UUID (advanced usage only)',
        },
        entityIds: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          description: 'Multiple entity UUIDs for batch queries (advanced usage only)',
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
          useCurrentUser: true,
          relationshipTypes: ['SPOUSE', 'PARENT_OF', 'CHILD_OF', 'SIBLING_OF'],
          traversal: { direction: 'both', maxDepth: 1 },
          include: { properties: true, relationships: true },
        },
        output: {
          seedEntityIds: ['11111111-1111-1111-1111-111111111111'],
          nodes: [
            { id: '11111111-1111-1111-1111-111111111111', type: 'Person', name: 'Current User' },
            {
              id: '55555555-5555-5555-5555-555555555555',
              type: 'Person',
              name: 'Jane Smith',
              properties: { family_role: 'spouse' },
            },
            {
              id: '66666666-6666-6666-6666-666666666666',
              type: 'Person',
              name: 'Tommy Smith',
              properties: { family_role: 'son', age: 8 },
            },
          ],
          edges: [
            {
              id: 'rel-spouse',
              type: 'SPOUSE',
              from: { id: '11111111-1111-1111-1111-111111111111', name: 'Current User' },
              to: { id: '55555555-5555-5555-5555-555555555555', name: 'Jane Smith' },
              bidirectional: true,
            },
            {
              id: 'rel-child',
              type: 'PARENT_OF',
              from: { id: '11111111-1111-1111-1111-111111111111', name: 'Current User' },
              to: { id: '66666666-6666-6666-6666-666666666666', name: 'Tommy Smith' },
              strength: 1.0,
            },
          ],
          stats: { nodeCount: 3, edgeCount: 2, truncatedNodes: false, truncatedEdges: false },
        },
        description:
          'Query "Who are my family members?" - Uses useCurrentUser with family relationship types',
      },
      {
        input: {
          useCurrentUser: true,
          relationshipTypes: ['PREFERS'],
          traversal: { direction: 'outbound', maxDepth: 1 },
          include: { properties: true },
        },
        output: {
          seedEntityIds: ['11111111-1111-1111-1111-111111111111'],
          nodes: [
            { id: '11111111-1111-1111-1111-111111111111', type: 'Person', name: 'Current User' },
            {
              id: '22222222-2222-2222-2222-222222222222',
              type: 'Concept',
              name: 'Italian Cuisine',
              properties: { type: 'cuisine' },
            },
            {
              id: '33333333-3333-3333-3333-333333333333',
              type: 'Concept',
              name: 'Cycling',
              properties: { type: 'activity' },
            },
          ],
          edges: [
            {
              id: 'rel-123',
              type: 'PREFERS',
              from: { id: '11111111-1111-1111-1111-111111111111', name: 'Current User' },
              to: { id: '22222222-2222-2222-2222-222222222222', name: 'Italian Cuisine' },
              strength: 0.9,
            },
            {
              id: 'rel-456',
              type: 'PREFERS',
              from: { id: '11111111-1111-1111-1111-111111111111', name: 'Current User' },
              to: { id: '33333333-3333-3333-3333-333333333333', name: 'Cycling' },
              strength: 0.85,
            },
          ],
          stats: { nodeCount: 3, edgeCount: 2, truncatedNodes: false, truncatedEdges: false },
        },
        description: 'Query "What do I like?" - Uses useCurrentUser with PREFERS relationships',
      },
      {
        input: {
          personName: 'my wife',
          relationshipTypes: ['PREFERS', 'DISLIKES'],
          traversal: { maxDepth: 1 },
          include: { properties: true },
        },
        output: {
          seedEntityIds: ['55555555-5555-5555-5555-555555555555'],
          nodes: [
            { id: '55555555-5555-5555-5555-555555555555', type: 'Person', name: 'Jane Smith' },
            {
              id: '77777777-7777-7777-7777-777777777777',
              type: 'Concept',
              name: 'Yoga',
              properties: { type: 'activity' },
            },
          ],
          edges: [
            {
              id: 'rel-yoga',
              type: 'PREFERS',
              from: { id: '55555555-5555-5555-5555-555555555555', name: 'Jane Smith' },
              to: { id: '77777777-7777-7777-7777-777777777777', name: 'Yoga' },
              strength: 0.95,
            },
          ],
          stats: { nodeCount: 2, edgeCount: 1, truncatedNodes: false, truncatedEdges: false },
        },
        description: 'Query "What does my wife like?" - Uses personName to resolve family member',
      },
      {
        input: {
          useCurrentUser: true,
          relationshipTypes: ['DISLIKES'],
          traversal: { maxDepth: 1 },
          include: { properties: true },
        },
        output: {
          seedEntityIds: ['11111111-1111-1111-1111-111111111111'],
          nodes: [
            { id: '11111111-1111-1111-1111-111111111111', type: 'Person', name: 'Current User' },
            {
              id: '88888888-8888-8888-8888-888888888888',
              type: 'Concept',
              name: 'Horror',
              properties: { type: 'movie_genre' },
            },
          ],
          edges: [
            {
              id: 'rel-horror',
              type: 'DISLIKES',
              from: { id: '11111111-1111-1111-1111-111111111111', name: 'Current User' },
              to: { id: '88888888-8888-8888-8888-888888888888', name: 'Horror' },
              strength: 0.8,
            },
          ],
          stats: { nodeCount: 2, edgeCount: 1, truncatedNodes: false, truncatedEdges: false },
        },
        description: 'Query "What don\'t I like?" - Uses useCurrentUser with DISLIKES',
      },
      {
        input: {
          filters: { entityType: 'Concept', propertyEquals: { type: 'activity' } },
          relationshipTypes: ['PREFERS'],
          traversal: { direction: 'inbound', maxDepth: 1 },
          include: { properties: true },
        },
        output: {
          seedEntityIds: ['44444444-4444-4444-4444-444444444444'],
          nodes: [
            {
              id: '44444444-4444-4444-4444-444444444444',
              type: 'Concept',
              name: 'Cycling',
              properties: { type: 'activity' },
            },
            { id: '11111111-1111-1111-1111-111111111111', type: 'Person', name: 'John Smith' },
          ],
          edges: [
            {
              id: 'rel-789',
              type: 'PREFERS',
              from: { id: '11111111-1111-1111-1111-111111111111', name: 'John Smith' },
              to: { id: '44444444-4444-4444-4444-444444444444', name: 'Cycling' },
              strength: 0.85,
            },
          ],
          stats: { nodeCount: 2, edgeCount: 1, truncatedNodes: false, truncatedEdges: false },
        },
        description:
          'Find who likes specific activities using filters (advanced usage for when you need to find entities, not start from a person)',
      },
    ],
  };

  constructor(
    private readonly graphQuery: GraphQueryService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ReadKnowledgeTool.name);
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

    // Handle semantic entity references (preferred approach)
    if (input.useCurrentUser) {
      const currentUserEntityId = await this.resolveCurrentUserEntity(ownerId);
      if (currentUserEntityId) {
        seedIds.add(currentUserEntityId);
      }
    }

    if (input.personName) {
      const personEntityId = await this.resolvePersonByName(ownerId, input.personName);
      if (personEntityId) {
        seedIds.add(personEntityId);
      } else {
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
          warnings: [
            `Could not find person: "${input.personName}". They may not be in your knowledge graph yet.`,
          ],
        };
      }
    }

    // Handle direct entity references (advanced usage)
    if (input.entityId) {
      seedIds.add(input.entityId);
    }

    if (input.entityIds) {
      input.entityIds.forEach((id) => seedIds.add(id));
    }

    let seedNodes: string[] = Array.from(seedIds);

    // Handle filter-based entity lookup
    if (seedNodes.length === 0 && input.filters) {
      const filterLimit = input.filters.limit ?? traversalOptions.maxNodes;
      const candidates = await this.graphQuery.getNodes(ownerId, {
        entityType: input.filters.entityType,
        nameContains: input.filters.nameContains,
        propertyEquals: input.filters.propertyEquals,
        limit: filterLimit,
      });

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
        warnings: [
          'No matching entities were found. This could mean:',
          '- The user entity is not yet created in the knowledge graph',
          '- The specified filters did not match any entities',
          '- The person you are looking for is not in the knowledge graph yet',
        ],
      };
    }

    const { nodes, edges } = await this.graphQuery.traverseGraph(ownerId, seedNodes, {
      relationshipTypes: input.relationshipTypes,
      direction: traversalOptions.direction,
      maxDepth: traversalOptions.maxDepth,
      maxNodes: traversalOptions.maxNodes,
      maxEdges: traversalOptions.maxEdges,
    });

    const includeProperties = input.include.properties;
    const includeRelationships = input.include.relationships;

    // Ensure the explicit seed nodes are present in the response when possible
    const ensuredSeedNodes = await this.graphQuery.getNodesByIds(ownerId, seedNodes);
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

  /**
   * Resolve the current user's entity ID from their user ID
   */
  private async resolveCurrentUserEntity(userId: string): Promise<string | null> {
    try {
      // First try to get entity_id directly from users table
      const userQuery = `
        SELECT entity_id
        FROM ci.users
        WHERE id = $1
      `;
      const userResult = await this.dataSource.query(userQuery, [userId]);

      if (userResult.length > 0 && userResult[0].entity_id) {
        return userResult[0].entity_id;
      }

      // If user doesn't have entity_id set, try to find their Person entity via linked_table
      const entityQuery = `
        SELECT entity_id
        FROM ci.entities
        WHERE linked_table = 'users'
          AND linked_id = $1
          AND is_active = TRUE
          AND owner_user_id = $2
        LIMIT 1
      `;
      const entityResult = await this.dataSource.query(entityQuery, [userId, userId]);

      if (entityResult.length > 0) {
        return entityResult[0].entity_id;
      }

      return null;
    } catch (error) {
      console.error('Failed to resolve current user entity:', error);

      return null;
    }
  }

  /**
   * Resolve a person name to an entity ID
   * Supports both relationship descriptors ("my wife") and direct names ("John Smith")
   */
  private async resolvePersonByName(userId: string, personName: string): Promise<string | null> {
    try {
      const currentUserEntityId = await this.resolveCurrentUserEntity(userId);
      if (!currentUserEntityId) {
        return null;
      }

      const lowerName = personName.toLowerCase().trim();

      // Check for relationship descriptors
      const relationshipPatterns: Array<{ patterns: string[]; relationshipTypes: string[] }> = [
        {
          patterns: ['wife', 'husband', 'spouse', 'partner', 'significant other'],
          relationshipTypes: ['SPOUSE'],
        },
        {
          patterns: ['mother', 'mom', 'father', 'dad', 'parent'],
          relationshipTypes: ['PARENT_OF', 'CHILD_OF'],
        },
        {
          patterns: ['son', 'daughter', 'child', 'kid'],
          relationshipTypes: ['PARENT_OF', 'CHILD_OF'],
        },
        {
          patterns: ['brother', 'sister', 'sibling'],
          relationshipTypes: ['SIBLING_OF'],
        },
        {
          patterns: ['friend', 'best friend', 'buddy'],
          relationshipTypes: ['FRIEND', 'KNOWS'],
        },
      ];

      // Try relationship-based resolution first
      for (const { patterns, relationshipTypes } of relationshipPatterns) {
        if (patterns.some((pattern) => lowerName.includes(pattern))) {
          const relatedEntity = await this.findRelatedEntityByRelationship(
            currentUserEntityId,
            userId,
            relationshipTypes,
          );
          if (relatedEntity) {
            return relatedEntity;
          }
        }
      }

      // Fall back to name-based search
      const nodes = await this.graphQuery.getNodes(userId, {
        entityType: 'Person',
        nameContains: lowerName,
        limit: 1,
      });

      if (nodes.length > 0) {
        return nodes[0].entity_id;
      }

      return null;
    } catch (error) {
      console.error('Failed to resolve person by name:', error);

      return null;
    }
  }

  /**
   * Find related entity through specific relationship types
   */
  private async findRelatedEntityByRelationship(
    fromEntityId: string,
    userId: string,
    relationshipTypes: string[],
  ): Promise<string | null> {
    try {
      // Query relationships to find connected entities
      const { nodes } = await this.graphQuery.traverseGraph(userId, [fromEntityId], {
        relationshipTypes,
        direction: 'both',
        maxDepth: 1,
        maxNodes: 10,
        maxEdges: 10,
      });

      // Filter to find the first Person entity that isn't the starting entity
      for (const [entityId, node] of nodes.entries()) {
        if (entityId !== fromEntityId && node.entity_type === 'Person') {
          return entityId;
        }
      }

      return null;
    } catch (error) {
      console.error('Failed to find related entity:', error);

      return null;
    }
  }
}

import { Controller, Get, NotFoundException, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { GraphNodeEntity } from '../entities/GraphNodeEntity';
import { graphTypesToExclude } from '../graph.types';
import { GraphEventService } from '../services/GraphEventService';
import { GraphQueryService } from '../services/GraphQueryService';
import { GraphUtilityService } from '../services/GraphUtilityService';
import { UserContextService } from '../services/UserContextService';

const getNodeDetailsSchema = z.object({
  entityId: z.string(),
  maxDepth: z.coerce.number().int().min(1).max(5).optional(),
  maxNodes: z.coerce.number().int().min(1).max(250).optional(),
  maxEdges: z.coerce.number().int().min(1).max(500).optional(),
});

// CSV of explorer entity types the user currently has selected (e.g. "person,place").
// Absent => no entity-type filter (show all). Present (even empty "") => filter active; an
// empty selection excludes every mappable type. See graphTypesToExclude.
const explorerTypesParam = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined
      ? undefined
      : value
          .split(',')
          .map((type) => type.trim())
          .filter(Boolean),
  );

const graphDataSchema = z.object({
  includeTypes: explorerTypesParam,
});
const graphSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.coerce.number().int().positive().max(50).optional(),
  includeTypes: explorerTypesParam,
});

type GetNodeDetailsDto = z.infer<typeof getNodeDetailsSchema>;
type GraphDataDto = z.infer<typeof graphDataSchema>;
type GraphSearchDto = z.infer<typeof graphSearchSchema>;

@Controller('graph')
@UseGuards(JwtOrApiKeyAuthGuard)
export class GraphController {
  constructor(
    private readonly graphEvents: GraphEventService,
    private readonly graphQuery: GraphQueryService,
    private readonly graphUtility: GraphUtilityService,
    private readonly userContext: UserContextService,
  ) {}

  private ensureUserId(ctx: RequestContext): string {
    if (!ctx.userId) {
      throw new Error('User ID is required');
    }

    return ctx.userId;
  }

  @Get('context')
  async getUserContext(@Context() ctx: RequestContext) {
    const ownerId = this.ensureUserId(ctx);
    const context = await this.userContext.getUserContextForLLM(ownerId);

    return {
      success: true,
      context,
    };
  }

  @Get('data')
  async getGraphData(
    @Context() ctx: RequestContext,
    @Query(new ValidationPipe(graphDataSchema)) query: GraphDataDto,
  ) {
    const ownerId = this.ensureUserId(ctx);

    // Translate the explorer's entity-type selection into graph entity_type values to exclude.
    // Connective NER types (Concept/Goal/Tag) are never excluded so the graph stays connected.
    const excludeEntityTypes =
      query.includeTypes === undefined ? [] : graphTypesToExclude(query.includeTypes);
    const isFiltered = excludeEntityTypes.length > 0;

    const nodes = await this.graphQuery.getNodes(ownerId, { limit: 200, excludeEntityTypes });
    const relationships = await this.graphQuery.getRelationships(ownerId, {});

    // The frontend seeds its subgraph from the owner's entity node. A type filter can exclude it
    // (e.g. the user is a Person and Person is deselected), which would collapse the graph to
    // empty — so always keep the anchor node regardless of the filter.
    const nodeMap = new Map(nodes.map((node) => [node.entity_id, node]));
    if (isFiltered) {
      const userEntity = await this.graphQuery.getUserEntity(ownerId);
      if (userEntity && !nodeMap.has(userEntity.entity_id)) {
        nodeMap.set(userEntity.entity_id, userEntity);
      }
    }

    const survivingNodes = Array.from(nodeMap.values());
    const survivingIds = new Set(survivingNodes.map((node) => node.entity_id));

    // Drop links dangling against excluded nodes when filtering; otherwise preserve prior behavior.
    const links = isFiltered
      ? relationships.filter(
          (rel) => survivingIds.has(rel.from_entity_id) && survivingIds.has(rel.to_entity_id),
        )
      : relationships;

    return {
      success: true,
      data: {
        nodes: survivingNodes.map((node) => ({
          id: node.entity_id,
          entity_id: node.entity_id,
          entity_type: node.entity_type,
          name: node.name,
          description: node.description,
          properties: node.properties || {},
        })),
        links: links.map((rel) => ({
          id: rel.relationship_id,
          relationship_id: rel.relationship_id,
          source: rel.from_entity_id,
          target: rel.to_entity_id,
          relationship_type: rel.relationship_type,
          strength: rel.strength || 0.5,
          properties: rel.properties || {},
        })),
      },
    };
  }

  @Get('search')
  async searchGraph(
    @Context() ctx: RequestContext,
    @Query(new ValidationPipe(graphSearchSchema)) query: GraphSearchDto,
  ) {
    const ownerId = this.ensureUserId(ctx);
    const limit = query.limit ?? 10;

    const trimmedQuery = query.query.trim();
    if (!trimmedQuery) {
      return { success: true, nodes: [] };
    }

    // Same entity-type filter as /data: skip nodes whose graph type maps to a deselected
    // explorer type, while keeping connective NER types.
    const excludeEntityTypes = new Set(
      query.includeTypes === undefined ? [] : graphTypesToExclude(query.includeTypes),
    );

    const textMatches = await this.graphQuery.searchNodesByText(ownerId, trimmedQuery, { limit });
    const prefixMatches = await this.graphQuery.searchNodesByPrefix(ownerId, trimmedQuery, { limit });

    const merged: Array<{ node: GraphNodeEntity; score: number | null }> = [];
    const seen = new Set<string>();

    for (const candidate of prefixMatches) {
      if (seen.has(candidate.entity_id) || excludeEntityTypes.has(candidate.entity_type)) {
        continue;
      }

      seen.add(candidate.entity_id);
      merged.push({ node: candidate, score: null });
      if (merged.length >= limit) {
        break;
      }
    }

    for (const candidate of textMatches) {
      if (seen.has(candidate.node.entity_id) || excludeEntityTypes.has(candidate.node.entity_type)) {
        continue;
      }

      seen.add(candidate.node.entity_id);
      merged.push({ node: candidate.node, score: candidate.score });
      if (merged.length >= limit) {
        break;
      }
    }

    const nodeIds = merged.map((match) => match.node.entity_id);

    if (nodeIds.length === 0) {
      return {
        success: true,
        nodes: [],
      };
    }

    const relationships = await this.graphQuery.getRelationships(ownerId, {
      entityIds: nodeIds,
      direction: 'both',
      includeInactive: false,
    });
    const filteredRelationships = relationships.filter(
      (rel) => nodeIds.includes(rel.from_entity_id) && nodeIds.includes(rel.to_entity_id),
    );

    const responseNodes = merged.map((match) => ({
      id: match.node.entity_id,
      entity_id: match.node.entity_id,
      entity_type: match.node.entity_type,
      name: match.node.name,
      description: match.node.description,
      properties: match.node.properties ?? {},
      score: match.score,
    }));

    return {
      success: true,
      nodes: responseNodes,
      links: filteredRelationships.map((rel) => ({
        id: rel.relationship_id,
        relationship_id: rel.relationship_id,
        source: rel.from_entity_id,
        target: rel.to_entity_id,
        relationship_type: rel.relationship_type,
        strength: rel.strength ?? 0.5,
        properties: rel.properties ?? {},
      })),
    };
  }

  @Get('node')
  async getNodeDetails(
    @Context() ctx: RequestContext,
    @Query(new ValidationPipe(getNodeDetailsSchema)) query: GetNodeDetailsDto,
  ) {
    const ownerId = this.ensureUserId(ctx);

    const node = await this.graphQuery.getNode(ownerId, query.entityId);
    if (!node) {
      throw new NotFoundException(`Node ${query.entityId} not found`);
    }

    const maxDepth = query.maxDepth ?? 1;
    const maxNodes = query.maxNodes ?? 100;
    const maxEdges = query.maxEdges ?? 250;

    const traversal = await this.graphQuery.traverseGraph(ownerId, [node.entity_id], {
      direction: 'both',
      maxDepth,
      maxNodes,
      maxEdges,
    });

    const traversalNodes = Array.from(traversal.nodes.values());
    const relationships = traversal.edges;

    const neighborIds = new Set<string>();
    for (const rel of relationships) {
      if (rel.from_entity_id !== node.entity_id && rel.to_entity_id !== node.entity_id) {
        continue;
      }

      const otherId = rel.from_entity_id === node.entity_id ? rel.to_entity_id : rel.from_entity_id;
      neighborIds.add(otherId);
    }

    const neighborMap = new Map(traversalNodes.map((n) => [n.entity_id, n]));

    const subgraph = {
      nodes: traversalNodes.map((graphNode) => ({
        id: graphNode.entity_id,
        entity_id: graphNode.entity_id,
        entity_type: graphNode.entity_type,
        name: graphNode.name,
        description: graphNode.description,
        properties: graphNode.properties ?? {},
      })),
      links: relationships.map((rel) => ({
        id: rel.relationship_id,
        relationship_id: rel.relationship_id,
        source: rel.from_entity_id,
        target: rel.to_entity_id,
        relationship_type: rel.relationship_type,
        strength: rel.strength ?? 0.5,
        properties: rel.properties ?? {},
      })),
    };

    return {
      success: true,
      node: {
        entityId: node.entity_id,
        entityType: node.entity_type,
        name: node.name,
        description: node.description,
        properties: node.properties ?? {},
        createdAt: node.created_at,
        updatedAt: node.updated_at,
      },
      relationships: relationships
        .map((rel) => {
          if (rel.from_entity_id !== node.entity_id && rel.to_entity_id !== node.entity_id) {
            return null;
          }

          const isOutbound = rel.from_entity_id === node.entity_id;
          const otherId = isOutbound ? rel.to_entity_id : rel.from_entity_id;
          const otherNode = neighborMap.get(otherId) ?? null;

          return {
            relationshipId: rel.relationship_id,
            relationshipType: rel.relationship_type,
            direction: isOutbound ? 'outbound' : 'inbound',
            strength: rel.strength,
            isBidirectional: rel.is_bidirectional,
            properties: rel.properties ?? {},
            otherEntity: otherNode
              ? {
                  entityId: otherNode.entity_id,
                  entityType: otherNode.entity_type,
                  name: otherNode.name,
                  description: otherNode.description,
                  properties: otherNode.properties ?? {},
                }
              : null,
          };
        })
        .filter((rel): rel is NonNullable<typeof rel> => rel !== null),
      subgraph,
    };
  }
}

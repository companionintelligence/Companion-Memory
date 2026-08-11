import { Args, Int, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { GraphQueryService } from '@ci/domains/memory';

import { GraphEdgeType, GraphNodeType, GraphType } from '../types/GraphType';

/**
 * GraphQL entry for the knowledge graph (#1941). Reads the same spine as the
 * REST graph controller (`ci.entities` / `ci.relationships`) so ForceGraph can
 * cut over without a second data path.
 */
@Resolver(() => GraphType)
export class GraphResolver {
  constructor(private readonly graphQuery: GraphQueryService) {}

  @Query(() => GraphType, {
    description: 'User knowledge graph (entities + relationships). Preferred over REST /api/graph/*.',
  })
  async graph(
    @Context() context: RequestContext,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 200 }) limit: number,
    @Args('entityType', { type: () => String, nullable: true }) entityType?: string,
  ): Promise<GraphType> {
    const { userId } = toServiceContext(context);

    const nodes = await this.graphQuery.getNodes(userId, {
      entityType,
      limit: Math.min(Math.max(limit, 1), 1000),
    });

    const nodeIds = nodes.map((node) => node.entity_id);
    const relationships =
      nodeIds.length === 0 ? [] : await this.graphQuery.getRelationships(userId, { entityIds: nodeIds });

    // Only edges whose both ends are in the payload (same contract as REST overview).
    const idSet = new Set(nodeIds);
    const edges = relationships.filter((rel) => idSet.has(rel.from_entity_id) && idSet.has(rel.to_entity_id));

    return {
      nodes: nodes.map(
        (node): GraphNodeType => ({
          id: node.entity_id,
          entityType: node.entity_type,
          name: node.name,
          description: node.description,
          linkedTable: node.linked_table,
          linkedId: node.linked_id,
          properties: node.properties ?? null,
        }),
      ),
      edges: edges.map(
        (rel): GraphEdgeType => ({
          id: rel.relationship_id,
          type: rel.relationship_type,
          fromEntityId: rel.from_entity_id,
          toEntityId: rel.to_entity_id,
          strength: rel.strength ?? null,
          isActive: rel.is_active,
          properties: rel.properties ?? null,
        }),
      ),
    };
  }
}

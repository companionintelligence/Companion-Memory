import { Injectable } from '@nestjs/common';

import { toServiceContext } from '@ci/common/context';
import { UserService } from '@ci/domains/user';

import { GraphNodeEntity } from '../entities/GraphNodeEntity';
import { RelationshipEntity } from '../entities/RelationshipEntity';

import { GraphUtilityService } from './GraphUtilityService';

export interface GraphNodeQueryOptions {
  entityType?: string;
  excludeEntityTypes?: string[];
  nameContains?: string;
  propertyEquals?: Record<string, string | number | boolean>;
  limit?: number;
  offset?: number;
}

@Injectable()
export class GraphQueryService {
  constructor(
    private readonly userService: UserService,
    private readonly graphUtility: GraphUtilityService,
  ) {}

  getNode(ownerId: string, entityId: string): Promise<GraphNodeEntity | null> {
    return this.graphUtility.getNodeById(entityId, ownerId);
  }

  getNodes(ownerId: string, options: GraphNodeQueryOptions = {}): Promise<GraphNodeEntity[]> {
    const { limit, offset, ...filters } = options;

    return this.graphUtility.queryNodes(
      ownerId,
      {
        entityType: filters.entityType,
        excludeEntityTypes: filters.excludeEntityTypes,
        nameContains: filters.nameContains,
        propertyEquals: filters.propertyEquals,
      },
      { limit, offset },
    );
  }

  getNodesByIds(ownerId: string, entityIds: string[]): Promise<GraphNodeEntity[]> {
    return this.graphUtility.getNodesByIds(entityIds, ownerId);
  }

  getNodeByLinkedRecord(ownerId: string, linkedTable: string, linkedId: string) {
    return this.graphUtility.getNodeByLinkedRecord(ownerId, linkedTable, linkedId);
  }

  async getUserEntity(ownerId: string) {
    const context = toServiceContext({ userId: ownerId });

    const user = await this.userService.findById(context, ownerId);

    if (user == null) {
      return null;
    }

    if (user.entityId == null) {
      return null;
    }

    return this.getNode(ownerId, user.entityId);
  }

  getRelationships(
    ownerId: string,
    options: {
      entityIds?: string[];
      relationshipIds?: string[];
      relationshipTypes?: string[];
      direction?: 'outbound' | 'inbound' | 'both';
      includeInactive?: boolean;
    } = {},
  ): Promise<RelationshipEntity[]> {
    return this.graphUtility.getRelationships(ownerId, options);
  }

  findConceptByName(ownerId: string, conceptName: string): Promise<GraphNodeEntity | null> {
    return this.graphUtility
      .queryNodes(
        ownerId,
        {
          entityType: 'Concept',
          nameContains: conceptName,
        },
        { limit: 1 },
      )
      .then((concepts) => {
        if (concepts.length === 0) {
          return null;
        }

        const concept = concepts[0];
        if (concept.name?.toLowerCase() === conceptName.toLowerCase()) {
          return concept;
        }

        return null;
      });
  }

  findConnectedEntities(
    ownerId: string,
    entityId: string,
    relationshipTypes: string[],
    direction: 'outbound' | 'inbound' | 'both',
  ) {
    return this.graphUtility.findConnectedEntities(entityId, relationshipTypes, direction, ownerId);
  }

  async searchNodesByText(
    ownerId: string,
    query: string,
    options: { limit?: number } = {},
  ): Promise<Array<{ node: GraphNodeEntity; score: number }>> {
    const results = await this.graphUtility.searchNodesByText(ownerId, query, options);

    return results.map((result) => ({
      node: result.node,
      score: result.rank,
    }));
  }

  searchNodesByPrefix(ownerId: string, query: string, options: { limit?: number } = {}) {
    return this.graphUtility.searchNodesByPrefix(ownerId, query, options);
  }

  collectEntitySnapshot(entityId: string, ownerId: string, options: { includeRelationships?: boolean } = {}) {
    return this.graphUtility.collectEntitySnapshot(entityId, ownerId, options);
  }

  traverseGraph(
    ownerId: string,
    seedEntityIds: string[],
    options: {
      relationshipTypes?: string[];
      direction?: 'outbound' | 'inbound' | 'both';
      maxDepth?: number;
      maxNodes?: number;
      maxEdges?: number;
    } = {},
  ) {
    return this.graphUtility.traverseGraph(ownerId, seedEntityIds, options);
  }
}

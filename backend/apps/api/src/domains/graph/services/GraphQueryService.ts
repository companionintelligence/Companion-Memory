import { Injectable } from '@nestjs/common';

import { GraphNodeEntity } from '@ci/domains/graph/entities/GraphNodeEntity';
import { RelationshipEntity } from '@ci/domains/graph/entities/RelationshipEntity';

import { GraphUtilityService } from './GraphUtilityService';

export interface GraphNodeQueryOptions {
  entityType?: string;
  nameContains?: string;
  propertyEquals?: Record<string, string | number | boolean>;
  limit?: number;
  offset?: number;
}

@Injectable()
export class GraphQueryService {
  constructor(private readonly graphUtility: GraphUtilityService) {}

  getNode(ownerId: string, entityId: string): Promise<GraphNodeEntity | null> {
    return this.graphUtility.getNodeById(entityId, ownerId);
  }

  getNodes(ownerId: string, options: GraphNodeQueryOptions = {}): Promise<GraphNodeEntity[]> {
    const { limit, offset, ...filters } = options;

    return this.graphUtility.queryNodes(
      ownerId,
      {
        entityType: filters.entityType,
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

  getUserEntity(ownerId: string) {
    return this.getNodeByLinkedRecord(ownerId, 'users', ownerId);
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

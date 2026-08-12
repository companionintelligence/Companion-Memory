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

  /** Active-node counts per entity type — see {@link GraphUtilityService.getEntityTypeCounts}. */
  getEntityTypeCounts(ownerId: string): Promise<Array<{ entityType: string; count: number }>> {
    return this.graphUtility.getEntityTypeCounts(ownerId);
  }

  /** One lean per-type page for the dots overview — see {@link GraphUtilityService.getDotNodes}. */
  getDotNodes(
    ownerId: string,
    options: { entityType: string; limit: number; offset?: number; eventTypes?: string[] },
  ): Promise<
    Array<{ entity_id: string; entity_type: string; name: string; event_type: string | null; degree: number }>
  > {
    return this.graphUtility.getDotNodes(ownerId, options);
  }

  /** Ranked hubs per type (one degrees CTE) — see {@link GraphUtilityService.getRankedDotNodes}. */
  getRankedDotNodes(
    ownerId: string,
    options: {
      entityTypes: string[];
      perTypeLimit: number;
      offset?: number;
      eventTypes?: string[];
    },
  ): Promise<
    Array<{ entity_id: string; entity_type: string; name: string; event_type: string | null; degree: number }>
  > {
    return this.graphUtility.getRankedDotNodes(ownerId, options);
  }

  /** Edge counts for a set of entities — see {@link GraphUtilityService.getDegreeCounts}. */
  getDegreeCounts(ownerId: string, entityIds: string[]): Promise<Map<string, number>> {
    return this.graphUtility.getDegreeCounts(ownerId, entityIds);
  }

  /** Related vs isolated entity counts — see {@link GraphUtilityService.getConnectivitySummary}. */
  getConnectivitySummary(
    ownerId: string,
    excludedEntityTypes: string[] = [],
  ): Promise<{ total: number; related: number; isolated: number; relatedRatio: number }> {
    return this.graphUtility.getConnectivitySummary(ownerId, excludedEntityTypes);
  }

  /** Capped edges with BOTH endpoints inside the id set — see
   * {@link GraphUtilityService.getRelationshipsAmong}. */
  getRelationshipsAmong(ownerId: string, entityIds: string[], limit: number): Promise<RelationshipEntity[]> {
    return this.graphUtility.getRelationshipsAmong(ownerId, entityIds, limit);
  }

  /**
   * Resolve the graph-node `entity_id`s for a set of source-record ids,
   * matching either the node's own `entity_id` or its `linked_id`. Source
   * records map onto graph nodes by `entity_id` (Person/Concept/Place/File) or
   * `linked_id` (Content/Event/Item/…). See
   * {@link GraphUtilityService.getEntityIdsByLinkedOrEntityIds}.
   */
  getEntityIdsBySourceRecordIds(ownerId: string, sourceIds: string[]): Promise<string[]> {
    return this.graphUtility.getEntityIdsByLinkedOrEntityIds(ownerId, sourceIds);
  }

  /**
   * Resolve the graph-node `entity_id`s for a set of tag source-record ids.
   * Thin alias over {@link getEntityIdsBySourceRecordIds} kept for the tag-filter
   * call site's readability.
   */
  getEntityIdsByTagSources(ownerId: string, sourceIds: string[]): Promise<string[]> {
    return this.getEntityIdsBySourceRecordIds(ownerId, sourceIds);
  }

  getNodeByLinkedRecord(ownerId: string, linkedTable: string, linkedId: string) {
    return this.graphUtility.getNodeByLinkedRecord(ownerId, linkedTable, linkedId);
  }

  /**
   * Person↔communication ties carried by `ci.communications`' participant
   * columns rather than `ci.relationships` rows. See
   * {@link GraphUtilityService.getCommunicationTiesForPerson}.
   */
  getCommunicationTiesForPerson(ownerId: string, personEntityId: string, limit: number) {
    return this.graphUtility.getCommunicationTiesForPerson(ownerId, personEntityId, limit);
  }

  getPersonTiesForCommunication(ownerId: string, communicationId: string) {
    return this.graphUtility.getPersonTiesForCommunication(ownerId, communicationId);
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

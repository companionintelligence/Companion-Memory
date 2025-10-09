import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/services';

import { FactEntity } from '../entities/FactEntity';
import { GraphNodeEntity } from '../entities/GraphNodeEntity';
import { RelationshipEntity } from '../entities/RelationshipEntity';

/**
 * GraphUtilityService - Helper service for common graph operations
 *
 * This service provides reusable graph traversal and entity management utilities
 * that can be used across different domains. It's designed to be extended
 * in Phase 2 with a proper graph query builder.
 */
@Injectable()
export class GraphUtilityService {
  private logger = new LoggerService(GraphUtilityService.name);

  constructor(
    @InjectRepository(GraphNodeEntity)
    private readonly entityRepo: Repository<GraphNodeEntity>,
    @InjectRepository(RelationshipEntity)
    private readonly relationshipRepo: Repository<RelationshipEntity>,
    @InjectRepository(FactEntity)
    private readonly factRepo: Repository<FactEntity>,
  ) {}

  async getNodeById(entityId: string, ownerUserId: string): Promise<GraphNodeEntity | null> {
    return this.entityRepo.findOne({
      where: {
        entity_id: entityId,
        owner_user_id: ownerUserId,
        is_active: true,
      },
    });
  }

  async getNodesByIds(entityIds: string[], ownerUserId: string): Promise<GraphNodeEntity[]> {
    if (entityIds.length === 0) {
      return [];
    }

    return this.entityRepo.find({
      where: {
        entity_id: In(entityIds),
        owner_user_id: ownerUserId,
        is_active: true,
      },
    });
  }

  async queryNodes(
    ownerUserId: string,
    filters: {
      entityType?: string;
      nameContains?: string;
      propertyEquals?: Record<string, string | number | boolean>;
    } = {},
    options: { limit?: number; offset?: number } = {},
  ): Promise<GraphNodeEntity[]> {
    const limit = Math.min(options.limit ?? 25, 200);
    const offset = options.offset ?? 0;

    let query = this.entityRepo
      .createQueryBuilder('entity')
      .where('entity.owner_user_id = :ownerUserId', { ownerUserId })
      .andWhere('entity.is_active = true')
      .limit(limit)
      .offset(offset);

    if (filters.entityType) {
      query = query.andWhere('entity.entity_type = :entityType', { entityType: filters.entityType });
    }

    if (filters.nameContains) {
      query = query.andWhere('entity.name ILIKE :name', { name: `%${filters.nameContains}%` });
    }

    if (filters.propertyEquals) {
      Object.entries(filters.propertyEquals).forEach(([key, value], index) => {
        const paramKey = `propValue${index}`;
        query = query.andWhere(`entity.properties->>:propKey${index} = :${paramKey}`, {
          [`propKey${index}`]: key,
          [paramKey]: String(value),
        });
      });
    }

    return query.getMany();
  }

  async getRelationships(
    ownerUserId: string,
    options: {
      entityIds?: string[];
      relationshipIds?: string[];
      relationshipTypes?: string[];
      direction?: 'outbound' | 'inbound' | 'both';
      includeInactive?: boolean;
    } = {},
  ): Promise<RelationshipEntity[]> {
    let query = this.relationshipRepo
      .createQueryBuilder('rel')
      .where('rel.owner_user_id = :ownerUserId', { ownerUserId });

    if (!options.includeInactive) {
      query = query.andWhere('rel.is_active = true');
    }

    if (options.relationshipIds?.length) {
      query = query.andWhere('rel.relationship_id IN (:...relationshipIds)', {
        relationshipIds: options.relationshipIds,
      });
    }

    if (options.relationshipTypes?.length) {
      query = query.andWhere('rel.relationship_type IN (:...relationshipTypes)', {
        relationshipTypes: options.relationshipTypes,
      });
    }

    if (options.entityIds?.length) {
      const direction = options.direction ?? 'both';
      if (direction === 'outbound') {
        query = query.andWhere('rel.from_entity_id IN (:...entityIds)', {
          entityIds: options.entityIds,
        });
      } else if (direction === 'inbound') {
        query = query.andWhere('rel.to_entity_id IN (:...entityIds)', {
          entityIds: options.entityIds,
        });
      } else {
        query = query.andWhere(
          '(rel.from_entity_id IN (:...entityIds) OR rel.to_entity_id IN (:...entityIds))',
          { entityIds: options.entityIds },
        );
      }
    }

    return query.getMany();
  }

  async traverseGraph(
    ownerUserId: string,
    seedEntityIds: string[],
    options: {
      relationshipTypes?: string[];
      direction?: 'outbound' | 'inbound' | 'both';
      maxDepth?: number;
      maxNodes?: number;
      maxEdges?: number;
    } = {},
  ): Promise<{ nodes: Map<string, GraphNodeEntity>; edges: RelationshipEntity[] }> {
    const maxDepth = Math.max(0, options.maxDepth ?? 1);
    const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 25, 250));
    const maxEdges = Math.max(0, Math.min(options.maxEdges ?? 50, 500));
    const direction = options.direction ?? 'both';

    const visitedNodes = new Map<string, GraphNodeEntity>();
    const collectedEdges: RelationshipEntity[] = [];

    let currentLayer = new Set(seedEntityIds);
    let depth = 0;

    while (currentLayer.size > 0 && depth <= maxDepth && visitedNodes.size < maxNodes) {
      const layerIds = Array.from(currentLayer).filter((id) => !visitedNodes.has(id));
      if (layerIds.length === 0) {
        break;
      }

      const nodes = await this.getNodesByIds(layerIds, ownerUserId);
      nodes.forEach((node) => {
        if (!visitedNodes.has(node.entity_id) && visitedNodes.size < maxNodes) {
          visitedNodes.set(node.entity_id, node);
        }
      });

      if (depth === maxDepth || visitedNodes.size >= maxNodes || collectedEdges.length >= maxEdges) {
        break;
      }

      const relationships = await this.getRelationships(ownerUserId, {
        entityIds: layerIds,
        relationshipTypes: options.relationshipTypes,
        direction,
      });

      const nextLayer = new Set<string>();

      for (const rel of relationships) {
        if (collectedEdges.length >= maxEdges) {
          break;
        }

        collectedEdges.push(rel);

        if (direction === 'outbound' || direction === 'both') {
          if (layerIds.includes(rel.from_entity_id) && !visitedNodes.has(rel.to_entity_id)) {
            nextLayer.add(rel.to_entity_id);
          }
        }

        if (direction === 'inbound' || direction === 'both') {
          if (layerIds.includes(rel.to_entity_id) && !visitedNodes.has(rel.from_entity_id)) {
            nextLayer.add(rel.from_entity_id);
          }
        }
      }

      currentLayer = nextLayer;
      depth += 1;
    }

    return { nodes: visitedNodes, edges: collectedEdges.slice(0, maxEdges) };
  }

  async createOrUpdateNode(
    ownerUserId: string,
    payload: {
      entityId?: string;
      entityType?: string;
      name?: string | null;
      description?: string | null;
      properties?: Record<string, unknown>;
      searchContent?: string | null;
      linkedTable?: string | null;
      linkedId?: string | null;
      mergeProperties?: boolean;
    },
  ): Promise<{ node: GraphNodeEntity; created: boolean }> {
    const entityId = payload.entityId ?? uuidv7();
    let node = await this.entityRepo.findOne({
      where: { entity_id: entityId, owner_user_id: ownerUserId },
    });

    const created = !node;
    if (!node) {
      if (!payload.entityType) {
        throw new Error('entityType is required when creating a graph node');
      }

      node = this.entityRepo.create({
        entity_id: entityId,
        owner_user_id: ownerUserId,
        entity_type: payload.entityType,
        name: payload.name ?? null,
        description: payload.description ?? payload.name ?? null,
        properties: payload.properties ?? {},
        search_content: payload.searchContent ?? payload.name ?? null,
        linked_table: payload.linkedTable ?? null,
        linked_id: payload.linkedId ?? null,
        is_active: true,
        is_archived: false,
      });
    } else {
      if (payload.entityType) {
        node.entity_type = payload.entityType;
      }

      if (payload.name !== undefined) {
        node.name = payload.name;
      }

      if (payload.description !== undefined) {
        node.description = payload.description;
      }

      if (payload.searchContent !== undefined) {
        node.search_content = payload.searchContent;
      }

      if (payload.linkedTable !== undefined) {
        node.linked_table = payload.linkedTable;
      }

      if (payload.linkedId !== undefined) {
        node.linked_id = payload.linkedId;
      }

      if (payload.properties) {
        node.properties =
          payload.mergeProperties === false
            ? payload.properties
            : { ...(node.properties ?? {}), ...payload.properties };
      }

      node.is_active = true;
      node.is_archived = false;
    }

    const saved = await this.entityRepo.save(node);

    return { node: saved, created };
  }

  async createOrUpdateRelationship(
    ownerUserId: string,
    payload: {
      relationshipId?: string;
      fromEntityId: string;
      toEntityId: string;
      relationshipType: string;
      properties?: Record<string, unknown>;
      strength?: number;
      isBidirectional?: boolean;
      mergeProperties?: boolean;
    },
  ): Promise<{ relationship: RelationshipEntity; created: boolean }> {
    const relationshipId = payload.relationshipId ?? uuidv7();
    let relationship = await this.relationshipRepo.findOne({
      where: { relationship_id: relationshipId, owner_user_id: ownerUserId },
    });

    const created = !relationship;
    if (!relationship) {
      relationship = this.relationshipRepo.create({
        relationship_id: relationshipId,
        owner_user_id: ownerUserId,
        from_entity_id: payload.fromEntityId,
        to_entity_id: payload.toEntityId,
        relationship_type: payload.relationshipType,
        properties: payload.properties ?? {},
        strength: payload.strength ?? 1,
        is_bidirectional: payload.isBidirectional ?? false,
        is_active: true,
      });
    } else {
      relationship.from_entity_id = payload.fromEntityId ?? relationship.from_entity_id;
      relationship.to_entity_id = payload.toEntityId ?? relationship.to_entity_id;
      relationship.relationship_type = payload.relationshipType ?? relationship.relationship_type;

      if (payload.properties) {
        relationship.properties =
          payload.mergeProperties === false
            ? payload.properties
            : { ...(relationship.properties ?? {}), ...payload.properties };
      }

      if (payload.strength !== undefined) {
        relationship.strength = payload.strength;
      }

      if (payload.isBidirectional !== undefined) {
        relationship.is_bidirectional = payload.isBidirectional;
      }

      relationship.is_active = true;
    }

    const saved = await this.relationshipRepo.save(relationship);

    return { relationship: saved, created };
  }

  async deactivateEntities(entityIds: string[], ownerUserId: string, hardDelete = false): Promise<number> {
    if (entityIds.length === 0) {
      return 0;
    }

    if (hardDelete) {
      const result = await this.entityRepo.delete({ entity_id: In(entityIds), owner_user_id: ownerUserId });

      return result.affected ?? 0;
    }

    const result = await this.entityRepo.update(
      { entity_id: In(entityIds), owner_user_id: ownerUserId },
      { is_active: false },
    );

    return result.affected ?? 0;
  }

  async deactivateRelationships(
    relationshipIds: string[],
    ownerUserId: string,
    hardDelete = false,
  ): Promise<number> {
    if (relationshipIds.length === 0) {
      return 0;
    }

    if (hardDelete) {
      const result = await this.relationshipRepo.delete({
        relationship_id: In(relationshipIds),
        owner_user_id: ownerUserId,
      });

      return result.affected ?? 0;
    }

    const result = await this.relationshipRepo.update(
      { relationship_id: In(relationshipIds), owner_user_id: ownerUserId },
      { is_active: false },
    );

    return result.affected ?? 0;
  }

  async collectEntitySnapshot(
    entityId: string,
    ownerUserId: string,
    options: { includeRelationships?: boolean } = {},
  ): Promise<{
    node: GraphNodeEntity | null;
    relationships: RelationshipEntity[];
  }> {
    const node = await this.getNodeById(entityId, ownerUserId);
    if (!node) {
      return { node: null, relationships: [] };
    }

    if (!options.includeRelationships) {
      return { node, relationships: [] };
    }

    const relationships = await this.getRelationships(ownerUserId, {
      entityIds: [entityId],
      direction: 'outbound',
      includeInactive: true,
    });

    return { node, relationships };
  }

  async getRelationshipStats(ownerUserId?: string): Promise<{
    totalRelationships: number;
    relationshipsByType: Array<{ type: string; count: number }>;
    entitiesByType: Array<{ type: string; count: number }>;
  }> {
    const relationshipQuery = this.relationshipRepo
      .createQueryBuilder('rel')
      .select('rel.relationship_type as type, COUNT(*) as count')
      .where('rel.is_active = true');

    const entityQuery = this.entityRepo
      .createQueryBuilder('entity')
      .select('entity.entity_type as type, COUNT(*) as count')
      .where('entity.is_active = true');

    if (ownerUserId) {
      relationshipQuery.andWhere('rel.owner_user_id = :ownerUserId', { ownerUserId });
      entityQuery.andWhere('entity.owner_user_id = :ownerUserId', { ownerUserId });
    }

    const [relationshipStats, entityStats, totalRelationships] = await Promise.all([
      relationshipQuery.groupBy('rel.relationship_type').getRawMany(),
      entityQuery.groupBy('entity.entity_type').getRawMany(),
      this.relationshipRepo.count({
        where: ownerUserId ? { owner_user_id: ownerUserId, is_active: true } : { is_active: true },
      }),
    ]);

    return {
      totalRelationships,
      relationshipsByType: relationshipStats.map((stat) => ({
        type: stat.type,
        count: parseInt(stat.count, 10),
      })),
      entitiesByType: entityStats.map((stat) => ({
        type: stat.type,
        count: parseInt(stat.count, 10),
      })),
    };
  }

  /**
   * Backwards compatibility helper
   */
  async findConnectedEntities(
    entityId: string,
    relationshipTypes: string[],
    direction: 'outbound' | 'inbound' | 'both' = 'both',
    ownerUserId?: string,
  ): Promise<GraphNodeEntity[]> {
    if (!ownerUserId) {
      this.logger.warn('findConnectedEntities called without ownerUserId; returning empty result');

      return [];
    }

    const traversal = await this.traverseGraph(ownerUserId, [entityId], {
      relationshipTypes,
      direction,
      maxDepth: 1,
      maxNodes: 25,
      maxEdges: 50,
    });

    traversal.nodes.delete(entityId);

    return Array.from(traversal.nodes.values());
  }

  async createGraphNode(data: {
    entityId: string;
    entityType: string;
    name: string;
    description?: string;
    properties?: Record<string, unknown>;
    searchContent?: string;
    linkedTable?: string;
    linkedId?: string;
    ownerUserId?: string;
  }): Promise<GraphNodeEntity> {
    if (!data.ownerUserId) {
      throw new Error('ownerUserId is required when creating graph nodes');
    }

    const { node } = await this.createOrUpdateNode(data.ownerUserId, {
      entityId: data.entityId,
      entityType: data.entityType,
      name: data.name,
      description: data.description,
      properties: data.properties,
      searchContent: data.searchContent,
      linkedId: data.linkedId,
      linkedTable: data.linkedTable,
      mergeProperties: false,
    });

    return node;
  }

  async createRelationship(
    fromEntityId: string,
    toEntityId: string,
    relationshipType: string,
    properties: Record<string, unknown> = {},
    strength = 1.0,
    ownerUserId?: string,
  ): Promise<RelationshipEntity> {
    if (!ownerUserId) {
      throw new Error('ownerUserId is required when creating relationships');
    }

    const { relationship } = await this.createOrUpdateRelationship(ownerUserId ?? '', {
      fromEntityId,
      toEntityId,
      relationshipType,
      properties,
      strength,
      mergeProperties: false,
    });

    return relationship;
  }

  async findEntitiesByType(
    entityType: string,
    propertyFilters: Record<string, unknown> = {},
    limit = 100,
    ownerUserId?: string,
  ): Promise<GraphNodeEntity[]> {
    if (!ownerUserId) {
      return [];
    }

    return this.queryNodes(
      ownerUserId,
      {
        entityType,
        propertyEquals: propertyFilters as Record<string, string>,
      },
      { limit },
    );
  }

  private serializeNodeForArchive(node: GraphNodeEntity): Record<string, unknown> {
    const {
      entity_id,
      entity_type,
      name,
      description,
      properties,
      search_content,
      linked_table,
      linked_id,
      is_active,
      is_archived,
      created_at,
      updated_at,
      owner_user_id,
    } = node;

    return {
      entity_id,
      entity_type,
      name,
      description,
      properties,
      search_content,
      linked_table,
      linked_id,
      is_active,
      is_archived,
      created_at,
      updated_at,
      owner_user_id,
    };
  }

  private serializeRelationshipForArchive(rel: RelationshipEntity): Record<string, unknown> {
    const {
      relationship_id,
      from_entity_id,
      to_entity_id,
      relationship_type,
      strength,
      properties,
      is_bidirectional,
      is_active,
      start_date,
      end_date,
      created_at,
      updated_at,
      owner_user_id,
    } = rel;

    return {
      relationship_id,
      from_entity_id,
      to_entity_id,
      relationship_type,
      strength,
      properties,
      is_bidirectional,
      is_active,
      start_date,
      end_date,
      created_at,
      updated_at,
      owner_user_id,
    };
  }

  async archiveEntities(
    ownerUserId: string,
    entries: Array<{
      node: GraphNodeEntity;
      relationships: RelationshipEntity[];
      reason?: string;
    }>,
  ): Promise<string[]> {
    if (entries.length === 0) {
      return [];
    }

    const now = new Date();
    const facts = entries.map((entry) =>
      this.factRepo.create({
        fact_id: uuidv7(),
        fact_owner_id: ownerUserId,
        fact_type: 'entity',
        fact_statement: {
          entity: this.serializeNodeForArchive(entry.node),
          relationships: entry.relationships.map((rel) => this.serializeRelationshipForArchive(rel)),
        },
        original_entity_id: entry.node.entity_id,
        preserved_relationships: {
          relationships: entry.relationships.map((rel) => rel.relationship_id),
        },
        source: entry.reason ?? 'knowledge.graph',
        confidence_score: 1,
        archived_at: now,
      }),
    );

    const saved = await this.factRepo.save(facts);

    return saved.map((fact) => fact.fact_id);
  }

  async archiveRelationships(
    ownerUserId: string,
    relationships: RelationshipEntity[],
    reason = 'knowledge.graph',
  ): Promise<string[]> {
    if (relationships.length === 0) {
      return [];
    }

    const now = new Date();
    const facts = relationships.map((relationship) =>
      this.factRepo.create({
        fact_id: uuidv7(),
        fact_owner_id: ownerUserId,
        fact_type: 'relationship',
        fact_statement: this.serializeRelationshipForArchive(relationship),
        original_entity_id: null,
        preserved_relationships: {},
        source: reason,
        confidence_score: 1,
        archived_at: now,
      }),
    );

    const saved = await this.factRepo.save(facts);

    return saved.map((fact) => fact.fact_id);
  }
}

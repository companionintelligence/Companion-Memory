import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { GraphNodeEntity } from '../entities/GraphNodeEntity';
import { RelationshipEntity } from '../entities/RelationshipEntity';

/**
 * GraphUtilityService - Core graph operations service
 *
 * This service provides low-level, generic operations for working with the knowledge graph.
 * It handles:
 * - Generic node (entity) CRUD
 * - Generic edge (relationship) CRUD
 * - Graph traversal and querying
 * - Archival and soft deletion
 *
 * For entity-specific operations (Person, Concept, etc.), use the specialized services
 * in the /graph subdirectory.
 */
/**
 * Hourly UTC per-owner entity count. Declared locally so this domain carries
 * no dependency on aggregating consumers; they enforce the shape structurally
 * where they consume it.
 */
export interface HourlyEntityCount {
  userId: string;
  bucketStart: Date;
  count: number;
}

/**
 * Which class of provenance a stats bucket represents. Lets the UI separate
 * "came from somewhere else" from "this appliance worked it out", which the
 * raw source string cannot express — `import:communications:participant` reads
 * as an import but is derived locally.
 */
export type EntitySourceKind = 'self' | 'imported' | 'derived' | 'unknown';

export interface EntitySourceCount {
  /**
   * Resolved provenance key. Either a source name supplied by an importer
   * ("linkedin", "LinkedIn") or an internal key ({@link DERIVED_IMPORT_KEYS},
   * a bare linked_table); callers are expected to map it for display rather
   * than show it raw.
   */
  source: string;
  kind: EntitySourceKind;
  count: number;
}

/** Sentinel for the owner's own node — see {@link GraphUtilityService.getEntityCountsBySource}. */
const SELF_SOURCE_KEY = 'self';

/** Sentinel for entities carrying no provenance signal at all. */
const UNKNOWN_SOURCE_KEY = 'Unknown';

/**
 * `import:`-prefixed linked_table values CI-Server writes for entities it
 * derives from data the appliance already holds. On these the prefix is a
 * storage convention (the linked-key upsert namespaces on it), not evidence of
 * an external source, so the prefix rule below would misclassify them as
 * imports. Bare linked_table values need no listing: a bare table is a
 * first-party record by construction and classifies as derived on its own.
 */
const DERIVED_IMPORT_KEYS = ['import:communications:participant', 'import:graph_llm', 'import:self'];

/**
 * `linked_table` values that name no origin. `import:importer` is what lands
 * when an importer posts `sourceSystem: "importer"` — true of every row
 * CI-Import-Tools has written so far. Rejecting them lets a lower-priority key
 * answer instead of showing the user a tautology.
 */
const GENERIC_SOURCE_KEYS = ['import:importer', 'importer', 'import:'];

@Injectable()
export class GraphUtilityService {
  constructor(
    @InjectRepository(GraphNodeEntity)
    private readonly entityRepo: Repository<GraphNodeEntity>,
    @InjectRepository(RelationshipEntity)
    private readonly relationshipRepo: Repository<RelationshipEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphUtilityService.name);
  }

  /**
   * ========================================================================
   * GENERIC NODE (ENTITY) OPERATIONS
   * ========================================================================
   */

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

  async getNodeByLinkedRecord(
    ownerUserId: string,
    linkedTable: string,
    linkedId: string,
  ): Promise<GraphNodeEntity | null> {
    return this.entityRepo.findOne({
      where: {
        owner_user_id: ownerUserId,
        linked_table: linkedTable,
        linked_id: linkedId,
        is_active: true,
      },
    });
  }

  /**
   * Resolve the set of graph-node `entity_id`s that correspond to a set of
   * source-record ids (as carried by the tag system).
   *
   * Taggable entities live in two id spaces:
   * - Person/Concept/Place/File records ARE graph nodes, so their tag id is the
   *   node's own `entity_id`.
   * - Content/Event/Item/… records live in their own tables, so their tag id is
   *   the node's `linked_id` (the back-link to the source record).
   *
   * Matching on `(entity_id IN ids OR linked_id IN ids)` covers both, returning
   * the graph `entity_id`s the caller can filter on. Callers must pass uuid ids
   * — both columns are uuid, so non-uuid source ids never match a node anyway.
   */
  async getEntityIdsByLinkedOrEntityIds(ownerUserId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.entityRepo
      .createQueryBuilder('entity')
      .select('entity.entity_id', 'entity_id')
      .where('entity.owner_user_id = :ownerUserId', { ownerUserId })
      .andWhere('entity.is_active = true')
      .andWhere('(entity.entity_id IN (:...ids) OR entity.linked_id IN (:...ids))', { ids })
      .limit(2000)
      .getRawMany<{ entity_id: string }>();

    return rows.map((row) => row.entity_id);
  }

  async queryNodes(
    ownerUserId: string,
    filters: {
      entityType?: string;
      excludeEntityTypes?: string[];
      nameContains?: string;
      propertyEquals?: Record<string, string | number | boolean>;
    } = {},
    options: { limit?: number; offset?: number } = {},
  ): Promise<GraphNodeEntity[]> {
    const limit = Math.min(options.limit ?? 25, 200);
    const offset = options.offset ?? 0;

    // Deterministic order so the capped page (and any offset paging) is stable
    // across requests; `entity_id` breaks ties on identical timestamps.
    let query = this.entityRepo
      .createQueryBuilder('entity')
      .where('entity.owner_user_id = :ownerUserId', { ownerUserId })
      .andWhere('entity.is_active = true')
      .orderBy('entity.created_at', 'DESC')
      .addOrderBy('entity.entity_id', 'ASC')
      .limit(limit)
      .offset(offset);

    if (filters.entityType) {
      query = query.andWhere('entity.entity_type = :entityType', { entityType: filters.entityType });
    }

    if (filters.excludeEntityTypes && filters.excludeEntityTypes.length > 0) {
      query = query.andWhere('entity.entity_type NOT IN (:...excludeEntityTypes)', {
        excludeEntityTypes: filters.excludeEntityTypes,
      });
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

  async searchNodesByText(
    ownerUserId: string,
    queryText: string,
    options: { limit?: number } = {},
  ): Promise<Array<{ node: GraphNodeEntity; rank: number }>> {
    const limit = Math.min(options.limit ?? 10, 50);
    if (!queryText.trim()) {
      return [];
    }

    const tsquery = `plainto_tsquery('english', :search)`;

    const qb = this.entityRepo
      .createQueryBuilder('entity')
      .where('entity.owner_user_id = :ownerUserId', { ownerUserId })
      .andWhere('entity.is_active = true')
      .andWhere(`entity.search_vector @@ ${tsquery}`, { search: queryText })
      .addSelect(`ts_rank_cd(entity.search_vector, ${tsquery})`, 'rank')
      .orderBy('rank', 'DESC')
      .addOrderBy('entity.updated_at', 'DESC')
      .limit(limit);

    const result = await qb.getRawAndEntities();

    return result.entities.map((node, index) => ({
      node,
      rank: Number(result.raw[index]?.rank ?? 0),
    }));
  }

  async searchNodesByPrefix(
    ownerUserId: string,
    queryText: string,
    options: { limit?: number } = {},
  ): Promise<GraphNodeEntity[]> {
    const limit = Math.min(options.limit ?? 10, 50);
    if (!queryText.trim()) {
      return [];
    }

    const like = `${queryText.trim().replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

    return this.entityRepo
      .createQueryBuilder('entity')
      .where('entity.owner_user_id = :ownerUserId', { ownerUserId })
      .andWhere('entity.is_active = true')
      .andWhere(
        `(entity.name ILIKE :like OR entity.entity_type ILIKE :like OR entity.entity_id::text ILIKE :like)`,
        { like },
      )
      .orderBy('entity.name', 'ASC')
      .limit(limit)
      .getMany();
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

  async softDeleteNode(entityId: string, ownerUserId: string): Promise<void> {
    await this.entityRepo.update({ entity_id: entityId, owner_user_id: ownerUserId }, { is_active: false });
  }

  /**
   * ========================================================================
   * GENERIC EDGE (RELATIONSHIP) OPERATIONS
   * ========================================================================
   */

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
      startDate?: Date;
      endDate?: Date;
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
        start_date: payload.startDate ?? null,
        end_date: payload.endDate ?? null,
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

      if (payload.startDate !== undefined) {
        relationship.start_date = payload.startDate;
      }

      if (payload.endDate !== undefined) {
        relationship.end_date = payload.endDate;
      }

      relationship.is_active = true;
    }

    const saved = await this.relationshipRepo.save(relationship);

    return { relationship: saved, created };
  }

  async softDeleteRelationship(relationshipId: string, ownerUserId: string): Promise<void> {
    await this.relationshipRepo.update(
      { relationship_id: relationshipId, owner_user_id: ownerUserId },
      { is_active: false },
    );
  }

  /**
   * ========================================================================
   * GRAPH TRAVERSAL
   * ========================================================================
   */

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

  /**
   * Backwards compatibility helper for finding connected entities
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

  /**
   * ========================================================================
   * BULK OPERATIONS
   * ========================================================================
   */

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

  /**
   * ========================================================================
   * STATISTICS
   * ========================================================================
   */

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
   * Count active entities per data source.
   *
   * Provenance is resolved in priority order, because no single key is set on
   * every entity and the keys that *are* set do not all mean the same thing:
   *
   *  1. `properties.is_self`      — the owner's own node. Not a source at all;
   *                                 short-circuits so it never lands in `Unknown`.
   *  2. `properties.data_source`  — the canonical source system stamped by the
   *                                 importer's graph-sync. The contract field:
   *                                 when present it is authoritative.
   *  3. `properties.Source`       — the display-ish origin some datasources put
   *                                 in record metadata ("LinkedIn", "vCard").
   *                                 Convention, not contract — it covers rows
   *                                 from importer versions predating the stamp.
   *  4. `linked_table`            — the origin table / import route, minus the
   *                                 content-free values in {@link GENERIC_SOURCE_KEYS}.
   *  5. `properties.importerType` — the *record shape* ("contact"), not an
   *                                 origin. Last resort: better than nothing,
   *                                 but it answers a different question.
   *
   * Ranking `data_source`/`Source` above `importerType` matters: the previous
   * order labelled 2,360 LinkedIn connections "contact" while `Source:
   * "LinkedIn"` sat unread on every one of them.
   *
   * `kind` reports which class of provenance won, so callers can group instead
   * of mixing importer names, internal route keys and synthetic buckets on one
   * axis. It is tracked per branch (each candidate column is computed once and
   * the winner identified by IS NOT NULL), not classified from the resolved
   * string — so an importer whose source name collides with an internal key
   * (`files`) still classifies as imported. For the linked_table branch, a
   * bare table name is a first-party record and therefore derived; an
   * `import:`-prefixed route is an external import unless it is one of the
   * {@link DERIVED_IMPORT_KEYS} CI-Server itself writes under that prefix.
   *
   * Grouping is on `(source, kind)`, so one name reached through two different
   * branches — an importer literally called `files` alongside the `files`
   * linked_table — reports as two rows rather than silently merging entities
   * of different provenance. The UI separates them by section.
   *
   * `NULLIF(..., '')` keeps empty-string properties from masking a usable
   * lower-priority source.
   */
  async getEntityCountsBySource(ownerUserId: string): Promise<EntitySourceCount[]> {
    const rows: Array<{ source: string; kind: EntitySourceKind; count: number }> =
      await this.entityRepo.manager.query(
        `
        WITH candidates AS (
          SELECT CASE WHEN properties ->> 'is_self' = 'true' THEN $2 END AS self_src,
                 COALESCE(
                   NULLIF(properties ->> 'data_source', ''),
                   NULLIF(properties ->> 'Source', '')
                 ) AS prop_src,
                 CASE
                   WHEN linked_table = ANY($4::text[]) THEN NULL
                   ELSE NULLIF(linked_table, '')
                 END AS linked_src,
                 NULLIF(properties ->> 'importerType', '') AS shape_src
          FROM ci.entities
          WHERE is_active = true
            AND owner_user_id = $1
        ),
        resolved AS (
          SELECT COALESCE(self_src, prop_src, linked_src, shape_src, $3) AS source,
                 CASE
                   WHEN self_src IS NOT NULL THEN 'self'
                   WHEN prop_src IS NOT NULL THEN 'imported'
                   WHEN linked_src IS NOT NULL THEN
                     CASE
                       WHEN linked_src = ANY($5::text[]) THEN 'derived'
                       WHEN linked_src LIKE 'import:%' THEN 'imported'
                       ELSE 'derived'
                     END
                   WHEN shape_src IS NOT NULL THEN 'imported'
                   ELSE 'unknown'
                 END AS kind
          FROM candidates
        )
        SELECT source, kind, COUNT(*)::int AS count
        FROM resolved
        GROUP BY source, kind
        ORDER BY count DESC, source ASC, kind ASC
        `,
        [ownerUserId, SELF_SOURCE_KEY, UNKNOWN_SOURCE_KEY, GENERIC_SOURCE_KEYS, DERIVED_IMPORT_KEYS],
      );

    return rows;
  }

  /**
   * ========================================================================
   * SNAPSHOT & ARCHIVAL
   * ========================================================================
   */

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

  /**
   * Backwards compatibility - create a graph node with old interface
   * @deprecated Use createOrUpdateNode instead
   */
  async createGraphNode(data: {
    entityId: string;
    entityType: string;
    ownerUserId: string;
    name?: string | null;
    description?: string | null;
    properties?: Record<string, unknown>;
    searchContent?: string | null;
    linkedTable?: string | null;
    linkedId?: string | null;
  }): Promise<GraphNodeEntity> {
    const { node } = await this.createOrUpdateNode(data.ownerUserId, {
      entityId: data.entityId,
      entityType: data.entityType,
      name: data.name,
      description: data.description,
      properties: data.properties,
      searchContent: data.searchContent,
      linkedTable: data.linkedTable,
      linkedId: data.linkedId,
    });

    return node;
  }

  async createRelationship(
    fromEntityId: string,
    toEntityId: string,
    relationshipType: string,
    properties: Record<string, unknown> = {},
    strength = 1,
    ownerUserId: string,
    options: { isBidirectional?: boolean; startDate?: Date; endDate?: Date } = {},
  ): Promise<RelationshipEntity> {
    const { relationship } = await this.createOrUpdateRelationship(ownerUserId, {
      fromEntityId,
      toEntityId,
      relationshipType,
      properties,
      strength,
      isBidirectional: options.isBidirectional,
      startDate: options.startDate,
      endDate: options.endDate,
    });

    return relationship;
  }

  /**
   * Hourly UTC activity buckets for the activity rollup: graph entities
   * counted by creation time, per owner. Follows this domain's counting
   * convention (see getEntityCountsBySource): only active entities count.
   */
  async aggregateHourlyActivity(): Promise<HourlyEntityCount[]> {
    const rows: Array<{ user_id: string; bucket_start: Date; count: number }> = await this.entityRepo
      .createQueryBuilder('entity')
      .select('entity.owner_user_id', 'user_id')
      .addSelect(`date_trunc('hour', entity.created_at, 'UTC')`, 'bucket_start')
      .addSelect('COUNT(*)::int', 'count')
      .where('entity.is_active = true')
      .andWhere('entity.owner_user_id IS NOT NULL')
      .andWhere('entity.created_at IS NOT NULL')
      .groupBy('user_id')
      .addGroupBy('bucket_start')
      .getRawMany();

    return rows.map((row) => ({ userId: row.user_id, bucketStart: row.bucket_start, count: row.count }));
  }
}

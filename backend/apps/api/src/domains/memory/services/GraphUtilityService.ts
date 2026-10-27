import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { GraphNodeEntity } from '../entities/GraphNodeEntity';
import { RelationshipEntity } from '../entities/RelationshipEntity';
import { canonicalEntityType, sameEntityType } from '../graph.types';
import { OWNER_MANAGED_PROPERTY_KEYS } from '../ownerManagedProperties';

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

/**
 * Safety ceiling on one lexical node-search page. Callers pick the real limit (the graph view
 * asks for a canvas-sized page and over-fetches to detect truncation); this only stops a caller
 * from asking for an unbounded scan.
 */
const NODE_SEARCH_MAX_LIMIT = 500;

/**
 * A node's place in `entities_linked_uniq`, less the owner: the index is on
 * `(owner_user_id, entity_type, linked_table, linked_id)`.
 */
export interface LinkedKey {
  entityType: string;
  linkedTable: string | null;
  linkedId: string | null;
}

function linkedKeyOf(node: GraphNodeEntity): LinkedKey {
  return { entityType: node.entity_type, linkedTable: node.linked_table, linkedId: node.linked_id };
}

/**
 * The properties bag a node or relationship write leaves behind: `properties`
 * merged over `stored` (or replacing it when `mergeProperties === false`), then
 * each `removeProperties` key deleted. With no `properties` at all there is
 * nothing to merge or replace with, so `stored` survives and only the removals
 * apply — `mergeProperties: false` alone never empties a bag.
 *
 * `keep` names keys a replace or a removal must leave as they are stored. A
 * node write passes {@link OWNER_MANAGED_PROPERTY_KEYS}: the only caller that
 * replaces or removes is `memory.remember`, and a replace there used to drop the
 * owner's settings and self claim along with everything else without naming
 * them. Applied here rather than in the tool because this is where the stored
 * row is read, so a key another writer committed after the tool looked is kept
 * too. A merge still writes what it is given; the tool refuses these keys
 * before a write is queued.
 */
export function nextProperties(
  stored: Record<string, unknown> | null | undefined,
  write: { properties?: Record<string, unknown>; mergeProperties?: boolean; removeProperties?: string[] },
  keep: readonly string[] = [],
): Record<string, unknown> {
  const replacing = Boolean(write.properties) && write.mergeProperties === false;
  const next = replacing ? { ...write.properties } : { ...(stored ?? {}), ...(write.properties ?? {}) };

  if (replacing) {
    for (const key of keep) {
      if (stored != null && Object.prototype.hasOwnProperty.call(stored, key)) {
        next[key] = stored[key];
      } else {
        delete next[key];
      }
    }
  }

  for (const key of write.removeProperties ?? []) {
    if (!keep.includes(key)) {
      delete next[key];
    }
  }

  return next;
}

/**
 * The `ci.pipeline_state` stages that index a Person; their ledger rows are
 * recorded under entity type `person`. Literals rather than `STAGE_IDS`: the
 * pipeline domain imports this one, so importing it back is a cycle.
 * `GraphUtilityService.dropStalePersonIndex.test.ts` pins them to the declared
 * stage ids.
 */
export const PERSON_INDEX_LEDGER_STAGES = ['index.embed_person', 'index.vector_person'] as const;

/** What {@link GraphUtilityService.dropStalePersonIndex} removed, per table. */
export interface DroppedPersonIndex {
  vectors: number;
  embeddings: number;
  indexSkips: number;
  ledger: number;
}

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

  async getNodeById(
    entityId: string,
    ownerUserId: string,
    options: { includeInactive?: boolean } = {},
  ): Promise<GraphNodeEntity | null> {
    return this.entityRepo.findOne({
      where: {
        entity_id: entityId,
        owner_user_id: ownerUserId,
        ...(options.includeInactive ? {} : { is_active: true }),
      },
    });
  }

  /**
   * Active-node counts per `entity_type`, largest first. Cheap (one GROUP BY
   * over the user's entities) and the input the overview's per-type budget
   * split needs: which data types exist in this account, and how many of each.
   */
  async getEntityTypeCounts(ownerUserId: string): Promise<Array<{ entityType: string; count: number }>> {
    const rows: Array<{ entity_type: string; count: string }> = await this.entityRepo
      .createQueryBuilder('entity')
      .select('entity.entity_type', 'entity_type')
      .addSelect('COUNT(*)', 'count')
      .where('entity.owner_user_id = :ownerUserId', { ownerUserId })
      .andWhere('entity.is_active = true')
      .groupBy('entity.entity_type')
      .orderBy('count', 'DESC')
      .getRawMany();

    return rows.map((row) => ({ entityType: row.entity_type, count: Number(row.count) }));
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
   * The owner's row holding this linked key, active or not. `entities_linked_uniq`
   * allows one row per `(owner_user_id, entity_type, linked_table, linked_id)` and
   * is partial on `linked_table IS NOT NULL` alone, so a forgotten or merged-away
   * row still holds its key. Unlike {@link getNodeByLinkedRecord} the type is part
   * of the match: a row of another type on the same linked record is on a key of
   * its own.
   *
   * Nothing holds a key the index does not: one with no `linked_table` is outside
   * its predicate, and one with no `linked_id` never equals another, since a
   * unique index treats NULLs as distinct.
   */
  async findLinkedKeyHolder(ownerUserId: string, key: LinkedKey): Promise<GraphNodeEntity | null> {
    if (key.linkedTable == null || key.linkedId == null) {
      return null;
    }

    return this.entityRepo.findOne({
      where: {
        owner_user_id: ownerUserId,
        entity_type: key.entityType,
        linked_table: key.linkedTable,
        linked_id: key.linkedId,
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

  /**
   * Communications tied to a person through `ci.communications`'
   * `from_entity_id`/`to_entity_ids` columns, as graph nodes.
   *
   * Participant linking (PersonLinkStage, CommunicationParticipantLinkListener,
   * the backfill services) writes those columns and never inserts
   * `ci.relationships` rows, so a relationship traversal alone can never reach
   * a person's emails or messages. Communication CTI rows share their uuid with
   * their `ci.entities` node, which is what the join rides on.
   *
   * Most recent first, capped by `limit` — a busy correspondent has thousands.
   */
  async getCommunicationTiesForPerson(
    ownerUserId: string,
    personEntityId: string,
    limit: number,
  ): Promise<Array<{ node: GraphNodeEntity; isSender: boolean }>> {
    const rows: Array<GraphNodeEntity & { is_sender: boolean }> = await this.entityRepo.manager.query(
      `SELECT e.*, (c.from_entity_id = $2) AS is_sender
         FROM ci.communications c
         JOIN ci.entities e
           ON e.entity_id = c.id
          AND e.owner_user_id = $1
          AND e.is_active = true
        WHERE c.user_id = $1
          AND (c.from_entity_id = $2 OR c.to_entity_ids @> ARRAY[$2]::uuid[])
        ORDER BY c.time DESC
        LIMIT $3`,
      [ownerUserId, personEntityId, limit],
    );

    return rows.map((row) => ({ node: row, isSender: row.is_sender === true }));
  }

  /**
   * The persons a communication links through its participant columns, as
   * graph nodes — the inverse of {@link getCommunicationTiesForPerson}, so
   * focusing a Communication node shows who it connects.
   */
  async getPersonTiesForCommunication(
    ownerUserId: string,
    communicationId: string,
  ): Promise<Array<{ node: GraphNodeEntity; isSender: boolean }>> {
    const rows: Array<GraphNodeEntity & { is_sender: boolean }> = await this.entityRepo.manager.query(
      `SELECT DISTINCT ON (e.entity_id) e.*, (c.from_entity_id = e.entity_id) AS is_sender
         FROM ci.communications c
         JOIN ci.entities e
           ON e.entity_id = ANY (ARRAY[c.from_entity_id] || COALESCE(c.to_entity_ids, '{}'))
          AND e.owner_user_id = $1
          AND e.is_active = true
        WHERE c.user_id = $1
          AND c.id = $2
        ORDER BY e.entity_id, is_sender DESC
        LIMIT 100`,
      [ownerUserId, communicationId],
    );

    return rows.map((row) => ({ node: row, isSender: row.is_sender === true }));
  }

  /**
   * One recency-ordered page of a single entity type, in the MINIMAL shape the
   * dots overview ships: id, type, name — no properties/description blobs,
   * which at thousands of nodes dominate the payload without being rendered
   * (a dot has no tooltip until it's focused, and focus does its own fetch).
   *
   * Event rows also carry `event_type` (joined off the same-id CTI mirror) so
   * the client can color/filter events by kind; `eventTypes` narrows the page
   * to those kinds. Both are meaningless for other entity types and ignored.
   *
   * `offset` exists for future tiling — a canvas layer paging one type at a
   * time uses (offset, limit) per type without a new endpoint shape.
   */
  async getDotNodes(
    ownerUserId: string,
    options: { entityType: string; limit: number; offset?: number; eventTypes?: string[] },
  ): Promise<
    Array<{ entity_id: string; entity_type: string; name: string; event_type: string | null; degree: number }>
  > {
    // Single-type path delegates to the ranked multi-type helper (one degrees CTE).
    return this.getRankedDotNodes(ownerUserId, {
      entityTypes: [options.entityType],
      perTypeLimit: options.limit,
      offset: options.offset,
      eventTypes: options.eventTypes,
    });
  }

  /**
   * Top hubs per entity type for the dots overview — one degrees CTE, then
   * `ROW_NUMBER() PARTITION BY entity_type` so the waterfill can take
   * highest-degree nodes of each kind without re-scanning relationships.
   */
  async getRankedDotNodes(
    ownerUserId: string,
    options: {
      entityTypes: string[];
      perTypeLimit: number;
      offset?: number;
      eventTypes?: string[];
    },
  ): Promise<
    Array<{ entity_id: string; entity_type: string; name: string; event_type: string | null; degree: number }>
  > {
    if (options.entityTypes.length === 0 || options.perTypeLimit <= 0) {
      return [];
    }

    const params: unknown[] = [ownerUserId, options.entityTypes];
    const eventTypeFilter = options.eventTypes && options.eventTypes.length > 0;
    const eventTypeSelect = `CASE WHEN e.entity_type = 'Event' THEN ev.event_type ELSE NULL END AS event_type`;
    let eventJoin = `LEFT JOIN ci.events ev ON ev.event_id = e.entity_id`;

    if (eventTypeFilter) {
      params.push(options.eventTypes);
      // Events not in the How filter are dropped; other types keep the left join.
      eventJoin = `LEFT JOIN ci.events ev ON ev.event_id = e.entity_id`;
    }

    params.push(options.perTypeLimit, options.offset ?? 0);
    const limitParam = params.length - 1;
    const offsetParam = params.length;

    const eventWhere = eventTypeFilter
      ? `AND (e.entity_type <> 'Event' OR ev.event_type = ANY($3::text[]))`
      : '';

    const rows: Array<{
      entity_id: string;
      entity_type: string;
      name: string;
      event_type: string | null;
      degree: string;
    }> = await this.entityRepo.manager.query(
      `WITH degrees AS (
         SELECT entity_id, COUNT(*)::int AS degree
           FROM (
             SELECT from_entity_id AS entity_id
               FROM ci.relationships
              WHERE owner_user_id = $1 AND is_active = TRUE
             UNION ALL
             SELECT to_entity_id
               FROM ci.relationships
              WHERE owner_user_id = $1 AND is_active = TRUE
           ) touching
          GROUP BY entity_id
       ),
       ranked AS (
         SELECT e.entity_id, e.entity_type, e.name, ${eventTypeSelect},
                COALESCE(d.degree, 0) AS degree,
                ROW_NUMBER() OVER (
                  PARTITION BY e.entity_type
                  ORDER BY COALESCE(d.degree, 0) DESC, e.created_at DESC
                ) AS rn
           FROM ci.entities e
           ${eventJoin}
           LEFT JOIN degrees d ON d.entity_id = e.entity_id
          WHERE e.owner_user_id = $1
            AND e.is_active = TRUE
            AND e.entity_type = ANY($2::text[])
            ${eventWhere}
       )
       SELECT entity_id, entity_type, name, event_type, degree
         FROM ranked
        WHERE rn > $${offsetParam}
          AND rn <= $${offsetParam} + $${limitParam}
        ORDER BY entity_type, degree DESC`,
      params,
    );

    return rows.map((row) => ({
      entity_id: row.entity_id,
      entity_type: row.entity_type,
      name: row.name,
      event_type: row.event_type,
      degree: Number(row.degree),
    }));
  }

  /**
   * Account-wide relatedness: how many active entities touch at least one
   * relationship vs how many sit alone. The key overview metric —
   * `relatedRatio = related / total` (0 when the graph is empty).
   */
  async getConnectivitySummary(
    ownerUserId: string,
    excludedEntityTypes: string[] = [],
  ): Promise<{ total: number; related: number; isolated: number; relatedRatio: number }> {
    const params: unknown[] = [ownerUserId];
    let typeFilter = '';
    if (excludedEntityTypes.length > 0) {
      params.push(excludedEntityTypes);
      typeFilter = `AND NOT (entity_type = ANY($${params.length}::text[]))`;
    }

    const rows: Array<{ total: string; related: string }> = await this.entityRepo.manager.query(
      `WITH active AS (
         SELECT entity_id
           FROM ci.entities
          WHERE owner_user_id = $1
            AND is_active = TRUE
            ${typeFilter}
       ),
       touched AS (
         SELECT DISTINCT entity_id
           FROM (
             SELECT from_entity_id AS entity_id
               FROM ci.relationships
              WHERE owner_user_id = $1 AND is_active = TRUE
             UNION
             SELECT to_entity_id
               FROM ci.relationships
              WHERE owner_user_id = $1 AND is_active = TRUE
           ) endpoints
          WHERE entity_id IN (SELECT entity_id FROM active)
       )
       SELECT (SELECT COUNT(*)::int FROM active) AS total,
              (SELECT COUNT(*)::int FROM touched) AS related`,
      params,
    );

    const total = Number(rows[0]?.total ?? 0);
    const related = Number(rows[0]?.related ?? 0);
    const isolated = Math.max(0, total - related);

    return {
      total,
      related,
      isolated,
      relatedRatio: total > 0 ? related / total : 0,
    };
  }

  /**
   * Edge count per entity over the given ids — one UNION ALL + GROUP BY over
   * `ci.relationships`, both directions. Feeds the dots overview's node sizing
   * and label priority. Ids absent from the result have degree 0.
   */
  async getDegreeCounts(ownerUserId: string, entityIds: string[]): Promise<Map<string, number>> {
    if (entityIds.length === 0) {
      return new Map();
    }

    const rows: Array<{ entity_id: string; degree: string }> = await this.relationshipRepo.manager.query(
      `SELECT entity_id, COUNT(*) AS degree
         FROM (
           SELECT from_entity_id AS entity_id
             FROM ci.relationships
            WHERE owner_user_id = $1 AND is_active = true AND from_entity_id = ANY($2::uuid[])
           UNION ALL
           SELECT to_entity_id
             FROM ci.relationships
            WHERE owner_user_id = $1 AND is_active = true AND to_entity_id = ANY($2::uuid[])
         ) touching
        GROUP BY entity_id`,
      [ownerUserId, entityIds],
    );

    return new Map(rows.map((row) => [row.entity_id, Number(row.degree)]));
  }

  /**
   * Relationships whose BOTH endpoints are inside the given id set, capped —
   * the zoomed-in "section" edge fetch. Unlike {@link getRelationships} with
   * `entityIds` (which returns every edge TOUCHING the set, most of them
   * dangling against nodes the client hasn't loaded), this constrains both
   * sides in SQL so a hub node in the set can't pull in its thousands of
   * off-screen edges.
   */
  async getRelationshipsAmong(
    ownerUserId: string,
    entityIds: string[],
    limit: number,
  ): Promise<RelationshipEntity[]> {
    if (entityIds.length === 0) {
      return [];
    }

    return this.relationshipRepo.manager.query(
      `SELECT *
         FROM ci.relationships
        WHERE owner_user_id = $1
          AND is_active = true
          AND from_entity_id = ANY($2::uuid[])
          AND to_entity_id = ANY($2::uuid[])
        ORDER BY strength DESC NULLS LAST
        LIMIT $3`,
      [ownerUserId, entityIds, limit],
    );
  }

  async queryNodes(
    ownerUserId: string,
    filters: {
      entityType?: string;
      excludeEntityTypes?: string[];
      nameContains?: string;
      /** The whole name, ignoring case and surrounding space. */
      nameEquals?: string;
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

    if (filters.nameEquals) {
      query = query.andWhere('lower(btrim(entity.name)) = lower(btrim(:nameEquals))', {
        nameEquals: filters.nameEquals,
      });
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
    const limit = Math.min(options.limit ?? 10, NODE_SEARCH_MAX_LIMIT);
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
    const limit = Math.min(options.limit ?? 10, NODE_SEARCH_MAX_LIMIT);
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

  /**
   * Insert a node, or update the one `entityId` already names.
   *
   * On update, a field left `undefined` keeps its stored value and `null`
   * clears it — so a caller relaying a partial write must pass omitted fields
   * through as `undefined`, never `?? null`. That matters most for
   * `linkedTable`/`linkedId`: an importer upserts on
   * `(owner, entity_type, linked_table, linked_id)`, so clearing either one (or
   * changing `entityType`) detaches the row, and the next import of the same
   * source mints a duplicate beside it.
   *
   * `properties` merges over the stored bag unless `mergeProperties === false`,
   * which replaces it; `removeProperties` keys are deleted afterwards. Both are
   * applied to the row as read here, not to a copy a caller read earlier.
   *
   * A write that would put the row on a linked key another row already holds —
   * by retyping it, re-keying it, or inserting it there — fails before anything
   * is written. See {@link assertLinkedKeyFree}.
   *
   * `entityType` is written in its canonical spelling (`person` lands as
   * `Person`), and a type that names the stored one in another case or by
   * another name (`contact` for a Person) keeps the stored type; see
   * {@link canonicalEntityType} and {@link sameEntityType}. `memory.remember`
   * already sends it that way. This is for a payload queued before it did: a
   * dead letter replayed from the jobs page is re-sent verbatim.
   */
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
      removeProperties?: string[];
    },
  ): Promise<{ node: GraphNodeEntity; created: boolean }> {
    const entityId = payload.entityId ?? uuidv7();
    let node = await this.findNodeToWrite(ownerUserId, entityId);

    const created = !node;
    const heldKey = node && linkedKeyOf(node);
    if (!node) {
      if (!payload.entityType) {
        throw new Error('entityType is required when creating a graph node');
      }

      node = this.entityRepo.create({
        entity_id: entityId,
        owner_user_id: ownerUserId,
        entity_type: canonicalEntityType(payload.entityType),
        name: payload.name ?? null,
        description: payload.description ?? payload.name ?? null,
        properties: nextProperties({}, payload),
        search_content: payload.searchContent ?? payload.name ?? null,
        linked_table: payload.linkedTable ?? null,
        linked_id: payload.linkedId ?? null,
        is_active: true,
        is_archived: false,
      });
    } else {
      if (payload.entityType && !sameEntityType(node.entity_type, payload.entityType)) {
        node.entity_type = canonicalEntityType(payload.entityType);
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

      if (payload.properties || payload.removeProperties?.length) {
        node.properties = nextProperties(node.properties, payload, OWNER_MANAGED_PROPERTY_KEYS);
      }

      node.is_active = true;
      node.is_archived = false;
    }

    await this.assertLinkedKeyFree(ownerUserId, node, heldKey);

    // Only a row this call found and checked may go through save(); see insertNode.
    const saved = created ? await this.insertNode(node) : await this.entityRepo.save(node);

    return { node: saved, created };
  }

  /**
   * Throw when saving `node` would put it on a linked key another row holds.
   * Retyping a row, re-keying it or inserting one moves it onto a
   * `(entity_type, linked_table, linked_id)` it does not hold yet, and
   * `entities_linked_uniq` allows one of an owner's rows there: the statement
   * used to violate it, GraphEventListener threw, and the job dead-lettered —
   * after `memory.remember` had reported the entity updated or created. Checking
   * first names the row in the way and fails no statement, so a surrounding
   * transaction survives it. A writer that lands on the key between this read
   * and the save still meets the index.
   *
   * The two rows are not merged instead. That would retire one of them — what
   * `memory.forget` does, behind its own confirmation — and pick between two
   * rows' names and properties with nobody to ask. WriteKnowledgeTool refuses a
   * write onto a held key before queueing it; this is for a row that lands there
   * after the tool looked, and for any other writer.
   *
   * `heldKey` is the key the row held before this write, or `null` for an
   * insert. A row that keeps its key needs no check, active or not: the index is
   * not partial on `is_active`, so no other row can be on it, and bringing a
   * forgotten row back moves it nowhere.
   */
  private async assertLinkedKeyFree(
    ownerUserId: string,
    node: GraphNodeEntity,
    heldKey: LinkedKey | null,
  ): Promise<void> {
    const target = linkedKeyOf(node);
    const staysPut =
      heldKey !== null &&
      heldKey.entityType === target.entityType &&
      heldKey.linkedTable === target.linkedTable &&
      heldKey.linkedId === target.linkedId;

    if (staysPut) {
      return;
    }

    const holder = await this.findLinkedKeyHolder(ownerUserId, target);

    if (!holder) {
      return;
    }

    throw new Error(
      `Entity ${node.entity_id} cannot become the ${target.entityType} linked to ${target.linkedTable} record ` +
        `${target.linkedId}: entity ${holder.entity_id} already is` +
        (holder.is_active ? '' : ', although it is no longer active'),
    );
  }

  /**
   * The row a node write for `ownerUserId` lands on, or `null` when no row
   * holds `entityId`.
   *
   * Looked up by primary key alone, because `entity_id` is the whole key: a
   * row holding the id is the row the write would reach, whoever owns it, so
   * an owner filter here only hid it — the write went on as an insert and
   * TypeORM's save() turned that into an UPDATE of the other owner's row. A row
   * that belongs to anyone else — another user, or no one once its owner was
   * deleted — is refused, forgotten or not.
   */
  private async findNodeToWrite(ownerUserId: string, entityId: string): Promise<GraphNodeEntity | null> {
    const node = await this.entityRepo.findOne({ where: { entity_id: entityId } });

    if (node && node.owner_user_id !== ownerUserId) {
      throw new Error(`Graph node ${entityId} is not owned by ${ownerUserId}; refusing to write it`);
    }

    return node;
  }

  /**
   * INSERT a node {@link findNodeToWrite} found no row for, and return it with
   * the defaults Postgres filled in. Not save(): that loads the primary key
   * alone and UPDATEs whatever row it finds, so a row that took the id after
   * the lookup — another owner's included — would be overwritten. A plain
   * INSERT fails on `entities_pkey` instead.
   */
  private async insertNode(node: GraphNodeEntity): Promise<GraphNodeEntity> {
    await this.entityRepo
      .createQueryBuilder()
      .insert()
      // `metadata.target`, as in PlaceService: the entity class would narrow
      // `.values()` to `_QueryDeepPartialEntity`, which rejects jsonb `properties`.
      .into(this.entityRepo.metadata.target)
      .values(node)
      .execute();

    return node;
  }

  /**
   * Remove the person-search state of a node that is not a Person.
   *
   * An entity retyped out of `Person` (`memory.remember` `entity.update` with
   * another `entityType`) falls out of everything that indexes people:
   * `INDEX_EMBED_PERSON_SOURCE` selects `entity_type = 'Person'`, and the
   * staleness sweep is an anti-join inside that predicate, so a row that leaves
   * it is neither refreshed nor cleaned. What the person stages wrote while it
   * was one stays: the `ci_search.vectors` row (the search CANDIDATE source), the
   * embedding, a skip marker, and the two `ci.pipeline_state` rows the person
   * stages recorded, whatever their status (a ledger-only reader such as
   * `hasOverdueRetry` would keep seeing a stale `failed` one). This deletes all of
   * them, in one statement.
   *
   * `OrphanCleanupCron` reaps the three `ci_search` tables nightly (a person row
   * whose entity is no longer `Person` is an orphan by its source map), so what
   * this adds is the wait until 02:50 and the ledger, which no sweep touches.
   *
   * The deletes are conditioned on the row's CURRENT type, read inside the
   * statement, not on a type the caller saw. It is a no-op for a Person, so it
   * can never take a live person out of the index, and it can follow any write,
   * a retried one included: a second attempt finds the row already retyped, so
   * a caller that gated this on "the type just changed" would skip, for good,
   * the cleanup the failed attempt never reached.
   *
   * Left alone on purpose: the other ledger rows an entity carries (identifier
   * normalisation still applies to the node; the Person-only claim and duplicate
   * stages are inert for it), dead letters (a record of what failed) and
   * `ci_search.entity_tag` (the user's own tags). No re-index is scheduled: what
   * the node became is indexed by the event the caller emits for its new type.
   *
   * Raw SQL because this domain cannot import the pipeline or search-ingress
   * domains (both import this one), as `PersonMergeService` deletes its
   * `ci_search` rows.
   */
  async dropStalePersonIndex(ownerUserId: string, entityId: string): Promise<DroppedPersonIndex> {
    // The outer SELECT is what makes TypeORM hand back rows: a bare DELETE
    // resolves to `[rows, rowCount]`.
    const [row] = (await this.entityRepo.query(
      `WITH not_a_person AS (
         SELECT entity_id
           FROM ci.entities
          WHERE entity_id = $1::uuid
            AND owner_user_id = $2::uuid
            AND entity_type <> 'Person'
       ),
       dropped_vectors AS (
         DELETE FROM ci_search.vectors v USING not_a_person n
          WHERE v.entity_type = 'person' AND v.entity_id = n.entity_id
         RETURNING 1
       ),
       dropped_embeddings AS (
         DELETE FROM ci_search.embeddings e USING not_a_person n
          WHERE e.entity_type = 'person' AND e.entity_id = n.entity_id
         RETURNING 1
       ),
       dropped_skips AS (
         DELETE FROM ci_search.index_skips s USING not_a_person n
          WHERE s.entity_type = 'person' AND s.entity_id = n.entity_id
         RETURNING 1
       ),
       dropped_ledger AS (
         DELETE FROM ci.pipeline_state p USING not_a_person n
          WHERE p.entity_type = 'person' AND p.entity_id = n.entity_id
            AND p.stage = ANY($3::text[])
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM dropped_vectors)::int    AS vectors,
              (SELECT count(*) FROM dropped_embeddings)::int AS embeddings,
              (SELECT count(*) FROM dropped_skips)::int      AS index_skips,
              (SELECT count(*) FROM dropped_ledger)::int     AS ledger`,
      [entityId, ownerUserId, [...PERSON_INDEX_LEDGER_STAGES]],
    )) as Array<{ vectors: number; embeddings: number; index_skips: number; ledger: number }>;

    return {
      vectors: Number(row?.vectors ?? 0),
      embeddings: Number(row?.embeddings ?? 0),
      indexSkips: Number(row?.index_skips ?? 0),
      ledger: Number(row?.ledger ?? 0),
    };
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

  /**
   * The active relationship a write of this edge lands on when no row is named
   * by id: the one on its `(from, to, type)` coordinate — the columns of
   * `relationships_unique_directed_idx`, which allows one active edge there —
   * or, failing that, a bidirectional edge stored the other way round, which
   * states the same fact. `isBidirectional: false` asks for this orientation
   * only: a one-way B→A is not the A↔B already stored, and merging it in would
   * make that edge one-way A→B.
   *
   * Only the owner's own edges match. Every edge writer stamps `owner_user_id`
   * with the owner of both endpoints, so an edge between the owner's entities
   * that belongs to someone else is not something to write onto.
   */
  async findActiveRelationship(
    ownerUserId: string,
    edge: { fromEntityId: string; toEntityId: string; relationshipType: string; isBidirectional?: boolean },
  ): Promise<RelationshipEntity | null> {
    const directed = await this.findActiveDirectedRelationship(
      ownerUserId,
      edge.fromEntityId,
      edge.toEntityId,
      edge.relationshipType,
    );

    if (directed || edge.isBidirectional === false) {
      return directed;
    }

    return this.relationshipRepo.findOne({
      where: {
        owner_user_id: ownerUserId,
        from_entity_id: edge.toEntityId,
        to_entity_id: edge.fromEntityId,
        relationship_type: edge.relationshipType,
        is_bidirectional: true,
        is_active: true,
      },
    });
  }

  /**
   * Insert a relationship, or update the one it already is: the row
   * `relationshipId` names, or — when it names none, or none is given — the
   * active edge {@link findActiveRelationship} finds on the write's coordinate.
   *
   * The coordinate is the half that used to be missing. A producer re-asserting
   * an edge that already exists (an agent restating what an import wrote, a
   * retried write, a sync pass) sends no id, or a fresh one, and a plain INSERT
   * of that violates `relationships_unique_directed_idx`: GraphEventListener
   * threw, the job dead-lettered, and every property the write carried was lost
   * — after `memory.remember` had already reported the relationship created.
   *
   * On update an `undefined` field keeps its stored value, and `properties` /
   * `mergeProperties` / `removeProperties` behave as in {@link createOrUpdateNode}.
   * An edge found by its coordinate also keeps its stored endpoints and type
   * spelling; only a row named by id is moved or retyped by a write that says so.
   * That write fails, before anything is written, when another active edge
   * already holds the coordinate it is moving the row to — see
   * {@link assertCoordinateFree}.
   */
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
      removeProperties?: string[];
    },
  ): Promise<{ relationship: RelationshipEntity; created: boolean }> {
    const byId = payload.relationshipId
      ? await this.relationshipRepo.findOne({
          where: { relationship_id: payload.relationshipId, owner_user_id: ownerUserId },
        })
      : null;

    let relationship = byId ?? (await this.findActiveRelationship(ownerUserId, payload));

    if (!relationship) {
      const inserted = await this.insertRelationshipUnlessActive(
        ownerUserId,
        payload.relationshipId ?? uuidv7(),
        payload,
      );

      if (inserted) {
        return { relationship: inserted, created: true };
      }

      // The insert yielded: another writer put an active edge on exactly this
      // coordinate between the read above and the INSERT. Merge into that one.
      relationship = await this.findActiveDirectedRelationship(
        ownerUserId,
        payload.fromEntityId,
        payload.toEntityId,
        payload.relationshipType,
      );

      if (!relationship) {
        throw new Error(
          `An active ${payload.relationshipType} relationship from ${payload.fromEntityId} to ` +
            `${payload.toEntityId} exists but does not belong to owner ${ownerUserId}`,
        );
      }
    }

    if (byId) {
      const target = {
        fromEntityId: payload.fromEntityId ?? byId.from_entity_id,
        toEntityId: payload.toEntityId ?? byId.to_entity_id,
        relationshipType: payload.relationshipType ?? byId.relationship_type,
      };

      await this.assertCoordinateFree(ownerUserId, byId, target);

      relationship.from_entity_id = target.fromEntityId;
      relationship.to_entity_id = target.toEntityId;
      relationship.relationship_type = target.relationshipType;
    }

    if (payload.properties || payload.removeProperties?.length) {
      relationship.properties = nextProperties(relationship.properties, payload);
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

    const saved = await this.relationshipRepo.save(relationship);

    return { relationship: saved, created: false };
  }

  private findActiveDirectedRelationship(
    ownerUserId: string,
    fromEntityId: string,
    toEntityId: string,
    relationshipType: string,
  ): Promise<RelationshipEntity | null> {
    return this.relationshipRepo.findOne({
      where: {
        owner_user_id: ownerUserId,
        from_entity_id: fromEntityId,
        to_entity_id: toEntityId,
        relationship_type: relationshipType,
        is_active: true,
      },
    });
  }

  /**
   * Throw when a write by id would put `row` on a coordinate another active
   * edge already holds. Moving the row, retyping it, or bringing a forgotten
   * one back puts it on a `(from, to, type)` coordinate it does not hold yet,
   * and `relationships_unique_directed_idx` allows one active edge there: the
   * UPDATE used to violate it, GraphEventListener threw, and the job
   * dead-lettered — after `memory.remember` had reported the relationship
   * updated. Checking first names the edge in the way and fails no statement,
   * so a surrounding transaction survives it. A writer that lands on the
   * coordinate between this read and the save still meets the index.
   *
   * The two edges are not merged instead. That would retire the row the write
   * names — what `memory.forget` does, behind its own confirmation — and pick
   * between two edges' properties with nobody to ask. WriteKnowledgeTool
   * refuses a retype onto a held coordinate before queueing it; this is for an
   * edge that lands there after the tool looked, and for any other writer.
   *
   * Every owner's edges count: the index is not scoped to an owner.
   */
  private async assertCoordinateFree(
    ownerUserId: string,
    row: RelationshipEntity,
    target: { fromEntityId: string; toEntityId: string; relationshipType: string },
  ): Promise<void> {
    // An active row already holds its own coordinate, so no other row can.
    const staysPut =
      row.is_active &&
      row.from_entity_id === target.fromEntityId &&
      row.to_entity_id === target.toEntityId &&
      row.relationship_type === target.relationshipType;

    if (staysPut) {
      return;
    }

    const holder = await this.relationshipRepo.findOne({
      where: {
        from_entity_id: target.fromEntityId,
        to_entity_id: target.toEntityId,
        relationship_type: target.relationshipType,
        is_active: true,
      },
    });

    if (!holder) {
      return;
    }

    throw new Error(
      `Relationship ${row.relationship_id} cannot become ${target.fromEntityId} ` +
        `-[${target.relationshipType}]-> ${target.toEntityId}: ` +
        (holder.owner_user_id === ownerUserId
          ? `relationship ${holder.relationship_id} is already the active edge there`
          : `the active edge there does not belong to owner ${ownerUserId}`),
    );
  }

  /**
   * INSERT the edge unless an active one already holds its coordinate; returns
   * the new row, or `null` when the insert yielded. The conflict target names
   * the columns of `relationships_unique_directed_idx` and repeats its
   * predicate (the shape GraphIngestService and KnownPlacesService use), so it
   * absorbs a clash on that index and nothing else: a `relationship_id` that is
   * already taken still raises. Not raising matters beyond the log line — a
   * failed statement would abort a surrounding transaction.
   */
  private async insertRelationshipUnlessActive(
    ownerUserId: string,
    relationshipId: string,
    payload: Parameters<GraphUtilityService['createOrUpdateRelationship']>[1],
  ): Promise<RelationshipEntity | null> {
    const relationship = this.relationshipRepo.create({
      relationship_id: relationshipId,
      owner_user_id: ownerUserId,
      from_entity_id: payload.fromEntityId,
      to_entity_id: payload.toEntityId,
      relationship_type: payload.relationshipType,
      properties: nextProperties({}, payload),
      strength: payload.strength ?? 1,
      is_bidirectional: payload.isBidirectional ?? false,
      start_date: payload.startDate ?? null,
      end_date: payload.endDate ?? null,
      is_active: true,
    });

    const result = await this.relationshipRepo
      .createQueryBuilder()
      .insert()
      // `metadata.target`, as in PlaceService: the entity class would narrow
      // `.values()` to `_QueryDeepPartialEntity`, which rejects jsonb `properties`.
      .into(this.relationshipRepo.metadata.target)
      .values(relationship)
      .onConflict('(from_entity_id, to_entity_id, relationship_type) WHERE is_active = TRUE DO NOTHING')
      .returning(['relationship_id'])
      .execute();

    // Postgres hands back the RETURNING rows, and a yielded insert returns none.
    return (result.raw as unknown[]).length > 0 ? relationship : null;
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
    // Each BFS layer re-fetches the relationships touching its frontier, and an edge between two
    // visited layers matches BOTH fetches — without this set the edge list contained every
    // relationship once per layer it touched, and clients rendered the duplicates on top of each
    // other (a second, never-updated line under each real one).
    const collectedEdgeIds = new Set<string>();

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

        if (!collectedEdgeIds.has(rel.relationship_id)) {
          collectedEdgeIds.add(rel.relationship_id);
          collectedEdges.push(rel);
        }

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

  /**
   * Archives entities (`is_active = false`), or with `hardDelete` deletes them.
   *
   * A hard delete takes every edge that touches the node with it, in BOTH directions, in the same
   * transaction. `ci.relationships` has no foreign key to `ci.entities`, so nothing else would: the
   * node's outbound edges used to be deleted in a second step and its inbound ones not at all, which
   * left ghosts pointing at a node that no longer exists. If the delete is refused (a foreign key still
   * references the node) nothing changes, edges included.
   *
   * Only nodes the caller owns are touched, edges included.
   */
  async deactivateEntities(entityIds: string[], ownerUserId: string, hardDelete = false): Promise<number> {
    if (entityIds.length === 0) {
      return 0;
    }

    if (hardDelete) {
      return this.entityRepo.manager.transaction(async (manager) => {
        const repository = manager.getRepository(GraphNodeEntity);
        const owned = await repository.find({
          select: ['entity_id'],
          where: { entity_id: In(entityIds), owner_user_id: ownerUserId },
        });

        if (owned.length === 0) {
          return 0;
        }

        const ownedIds = owned.map((node) => node.entity_id);

        await manager.query(
          `DELETE FROM ci.relationships
            WHERE owner_user_id = $1
              AND (from_entity_id = ANY($2::uuid[]) OR to_entity_id = ANY($2::uuid[]))`,
          [ownerUserId, ownedIds],
        );

        const result = await repository.delete({ entity_id: In(ownedIds), owner_user_id: ownerUserId });

        return result.affected ?? 0;
      });
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
   *  4. `ci.record_sources`       — the provenance ledger. Imported events,
   *                                 content, items and messages carry neither
   *                                 property, only a bare `linked_table`, so
   *                                 without this they all read as derived ("Worked
   *                                 out on this device"). The record's earliest
   *                                 arrival names its platform (or source
   *                                 system); a File entity reads it through the
   *                                 content row or the message that names the
   *                                 file.
   *  5. `linked_table`            — the origin table / import route, minus the
   *                                 content-free values in {@link GENERIC_SOURCE_KEYS}.
   *  6. `properties.importerType` — the *record shape* ("contact"), not an
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
        WITH file_arrivals AS (
          -- A stored photo or document is a ci.files row. Two records can name
          -- it: the content row an import made for it (external_id), and the
          -- message that carries it (communications.attachments). A tweet's or
          -- DM's media gets no content row when X no longer serves its URL (and
          -- an MMS part is stored as a file alone), so the message is the only
          -- record that says where the file came from.
          SELECT c.external_id AS file_id, rs.platform, rs.source_system, rs.first_seen
          FROM ci.content c
          JOIN ci.record_sources rs
            ON rs.user_id = c.user_id AND rs.record_table = 'content' AND rs.record_id = c.id
          WHERE c.user_id = $1
            AND c.external_id_kind = 'file'
          UNION ALL
          SELECT a ->> 'id', rs.platform, rs.source_system, rs.first_seen
          FROM ci.communications m
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(m.attachments) = 'array' THEN m.attachments ELSE '[]'::jsonb END
          ) a
          JOIN ci.record_sources rs
            ON rs.user_id = m.user_id AND rs.record_table = 'communications' AND rs.record_id = m.id
          WHERE m.user_id = $1
            AND a ->> 'type' = 'file'
        ),
        file_sources AS (
          -- One source per file, the earliest arrival.
          SELECT DISTINCT ON (file_id)
                 file_id,
                 COALESCE(NULLIF(platform, ''), NULLIF(source_system, '')) AS src
          FROM file_arrivals
          ORDER BY file_id, first_seen ASC
        ),
        candidates AS (
          SELECT CASE WHEN properties ->> 'is_self' = 'true' THEN $2 END AS self_src,
                 COALESCE(
                   NULLIF(properties ->> 'data_source', ''),
                   NULLIF(properties ->> 'Source', '')
                 ) AS prop_src,
                 -- Spelled as the import route the people from the same import
                 -- are filed under (linked_table 'import:venmo'), so a Venmo
                 -- payment and the Venmo contact it names count as one source.
                 'import:' || COALESCE(ledger.src, fs.src) AS ledger_src,
                 CASE
                   WHEN linked_table = ANY($4::text[]) THEN NULL
                   ELSE NULLIF(linked_table, '')
                 END AS linked_src,
                 NULLIF(properties ->> 'importerType', '') AS shape_src
          FROM ci.entities e
          LEFT JOIN LATERAL (
            -- The provenance ledger every import and sync writes. An entity
            -- that mirrors a record (linked_table = the record's table, same
            -- id) arrived the way that record did.
            SELECT COALESCE(NULLIF(rs.platform, ''), NULLIF(rs.source_system, '')) AS src
            FROM ci.record_sources rs
            WHERE rs.user_id = e.owner_user_id
              AND rs.record_table = e.linked_table
              AND rs.record_id = e.entity_id
            ORDER BY rs.first_seen ASC
            LIMIT 1
          ) ledger ON true
          LEFT JOIN file_sources fs
            ON e.linked_table = 'files' AND fs.file_id = e.linked_id::text
          WHERE is_active = true
            AND owner_user_id = $1
        ),
        resolved AS (
          SELECT COALESCE(self_src, prop_src, ledger_src, linked_src, shape_src, $3) AS source,
                 CASE
                   WHEN self_src IS NOT NULL THEN 'self'
                   WHEN prop_src IS NOT NULL THEN 'imported'
                   WHEN ledger_src IS NOT NULL THEN 'imported'
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
    options: { includeRelationships?: boolean; includeInactive?: boolean } = {},
  ): Promise<{
    node: GraphNodeEntity | null;
    relationships: RelationshipEntity[];
  }> {
    const node = await this.getNodeById(entityId, ownerUserId, { includeInactive: options.includeInactive });
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

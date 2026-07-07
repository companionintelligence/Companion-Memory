import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, type WhereExpressionBuilder } from 'typeorm';
import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { computeChunkSize } from '@ci/common/persistence';

import { NodeEntity } from '../entities/NodeEntity';
import { RelationshipEntity } from '../entities/RelationshipEntity';

import { type EntityIdentifierBatchEntry, EntityIdentifierService } from './EntityIdentifierService';

// Stable namespace so the importer and the server derive identical linked_id
// UUIDs from the same natural key. Do not change — it is the idempotency anchor.
const IMPORT_NAMESPACE = '6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b';

// Sentinel key the importer uses to anchor an edge on the signed-in user's own
// entity (resolved server-side; the importer never knows the owner's entity_id).
const SELF_KEY = 'self';
const USER_ENTITY_TYPE = 'User';
// A provisioned self entity is a `Person` (the owner's display name), NOT an
// entity_type='User' row — see resolveSelfEntity. linked_table `import:self` +
// linked_id uuidv5(`self:user:<id>`) make it stable and idempotent so re-runs
// and concurrent ingests resolve to the same row.
const SELF_ENTITY_TYPE = 'Person';
const SELF_SOURCE_SYSTEM = 'self';

export interface GraphEntityInputDto {
  /** Importer-stable natural key, e.g. `apple_contacts:contact:John Doe`. */
  key: string;
  entityType: string;
  name?: string | null;
  description?: string | null;
  sourceSystem: string;
  properties?: Record<string, unknown> | null;
}

export interface GraphRelationshipInputDto {
  /** An entity `key` from this batch, or the `self` sentinel. */
  fromKey: string;
  toKey: string;
  type: string;
  properties?: Record<string, unknown> | null;
  /**
   * Optional pre-resolved graph node ids for the endpoints. When set they take
   * precedence over `fromKey` / `toKey` resolution, letting a caller attach an
   * edge to an entity that already exists in the graph (and is NOT part of this
   * batch) without re-ingesting it — used by GraphEnrichmentService to wire
   * family edges between Person nodes the importer already created. The
   * importer / GraphQL path never sets these, so its behaviour is unchanged.
   */
  fromEntityId?: string;
  fromEntityType?: string;
  toEntityId?: string;
  toEntityType?: string;
}

/** A relationship whose endpoints have been resolved to concrete node ids. */
interface ResolvedEdge {
  r: GraphRelationshipInputDto;
  fromId: string;
  fromType: string;
  toId: string;
  toType: string;
}

export interface GraphEntityMappingDto {
  /** The caller's entity `key`, echoed back verbatim. */
  key: string;
  /** The server-side ci.entities UUID the key resolved to or was created as. */
  entityId: string;
}

export interface GraphIngestResult {
  entitiesProcessed: number;
  relationshipsProcessed: number;
  errors: string[];
  /**
   * key → ci.entities UUID for every input entity that upserted, covering both
   * freshly created rows and keys that resolved to existing ones. Callers (the
   * importer) cache this to attach later edges without re-sending entities.
   * Entities that failed to upsert are absent here and reported in `errors`.
   */
  entities: GraphEntityMappingDto[];
}

/**
 * Idempotent bulk ingest of an external knowledge graph (the CI-Import-Tools
 * timeline) into `ci.entities` / `ci.relationships`.
 *
 * - Entities upsert on (owner_user_id, entity_type, linked_table, linked_id),
 *   where linked_table = `import:<sourceSystem>` and linked_id = uuidv5(key).
 * - Relationships reference entities by their batch `key` (resolved to entity_id
 *   here, so the importer needs no server round-trips) and upsert on the
 *   directed (from, to, type) unique index. The `self` sentinel resolves to the
 *   owner's User entity.
 *
 * Re-runs are safe: existing rows are resolved, not duplicated.
 */
@Injectable()
export class GraphIngestService {
  constructor(
    @InjectRepository(NodeEntity)
    private readonly nodeRepository: Repository<NodeEntity>,
    @InjectRepository(RelationshipEntity)
    private readonly relationshipRepository: Repository<RelationshipEntity>,
    private readonly entityIdentifierService: EntityIdentifierService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(GraphIngestService.name);
  }

  static linkedIdFor(key: string): string {
    return uuidv5(key, IMPORT_NAMESPACE);
  }

  async ingest(
    context: UserServiceContext,
    input: { entities: GraphEntityInputDto[]; relationships: GraphRelationshipInputDto[] },
  ): Promise<GraphIngestResult> {
    const ownerId = context.userId;
    const errors: string[] = [];

    // key -> resolved entity_id / entity_type, so relationships in the same
    // request can be wired without extra lookups.
    const keyToId = new Map<string, string>();
    const keyToType = new Map<string, string>();

    // Echoed back to the caller so it can cache key -> UUID (resolved-existing
    // rows included) and reference these entities in later batches.
    const entities: GraphEntityMappingDto[] = [];

    // Set-based entity upsert: resolve every input key to its ci.entities UUID
    // with a bounded number of statements (one existence SELECT + one batched
    // INSERT + one re-resolve SELECT for race losers), instead of the former
    // per-entity findOne+save round-trip. Resolution semantics are unchanged —
    // the (owner, entity_type, import:<sourceSystem>, uuidv5(key)) idempotency
    // key still maps a re-ingested key to its existing row.
    let entitiesProcessed = 0;
    const resolvedById = await this.upsertEntities(ownerId, input.entities, errors);
    // People-linking: collect every resolved entity's email/phone/name
    // identifiers and index them AFTER the loop in one set-based, chunked
    // INSERT (see indexIdentifiers) — this was the last per-row write on the
    // bulk ingest path (one statement per identifier-bearing entity).
    const identifierBatch: EntityIdentifierBatchEntry[] = [];
    for (const e of input.entities) {
      const id = resolvedById.get(e);
      if (id === undefined) {
        // Its failure was already recorded in `errors` by upsertEntities.
        continue;
      }

      keyToId.set(e.key, id);
      keyToType.set(e.key, e.entityType);
      entities.push({ key: e.key, entityId: id });

      const raw = rawIdentifiersOf(e);
      if (raw != null) {
        identifierBatch.push({ entityId: id, raw });
      }

      entitiesProcessed += 1;
    }

    // Idempotent (ON CONFLICT DO NOTHING); only entities carrying
    // emails/phones/names contribute rows. Failure to index must not fail the
    // ingest of the entities themselves — indexIdentifiers logs and swallows
    // its own errors.
    await this.indexIdentifiers(ownerId, identifierBatch);

    let relationshipsProcessed = 0;
    if (input.relationships.length > 0) {
      // Self-anchored edges (the `self` sentinel) need the owner's self entity.
      // On a from-scratch ingest — or after any wipe that NULLs
      // ci.users.entity_id — the owner has none, so provision one before wiring
      // the edges; otherwise every `self->…` edge fails "endpoint not found in
      // batch". Batches without a self edge (e.g. the family path's pre-resolved
      // Person-to-Person edges) skip this entirely.
      const needsSelf = input.relationships.some((r) => r.fromKey === SELF_KEY || r.toKey === SELF_KEY);
      const self = needsSelf ? await this.ensureSelfEntity(ownerId) : null;

      // Resolve every edge's endpoints in memory (no per-edge round-trip): a
      // pre-resolved endpoint id (an existing graph node) wins over key
      // resolution; otherwise fall back to the `self` sentinel or a batch key.
      // Unresolvable endpoints are reported and dropped, matching the prior loop.
      const resolved: ResolvedEdge[] = [];
      for (const r of input.relationships) {
        const fromId = r.fromEntityId ?? (r.fromKey === SELF_KEY ? self?.id : keyToId.get(r.fromKey));
        const toId = r.toEntityId ?? (r.toKey === SELF_KEY ? self?.id : keyToId.get(r.toKey));

        if (!fromId || !toId) {
          errors.push(`relationship ${r.fromKey}->${r.toKey}: endpoint not found in batch`);
          continue;
        }

        const fromType =
          r.fromEntityType ??
          (r.fromKey === SELF_KEY ? (self?.type ?? USER_ENTITY_TYPE) : keyToType.get(r.fromKey)!);
        const toType =
          r.toEntityType ??
          (r.toKey === SELF_KEY ? (self?.type ?? USER_ENTITY_TYPE) : keyToType.get(r.toKey)!);

        resolved.push({ r, fromId, fromType, toId, toType });
      }

      // Set-based relationship upsert over the resolved edges (one existence
      // SELECT + one batched INSERT ... ON CONFLICT DO NOTHING), replacing the
      // former per-edge findOne+save. Idempotency is unchanged: the directed
      // (from, to, type) unique index still collapses a re-ingested edge.
      relationshipsProcessed = await this.upsertRelationships(ownerId, resolved, errors);
    }

    return { entitiesProcessed, relationshipsProcessed, errors, entities };
  }

  /**
   * Set-based upsert of a batch of entities. Returns a map from each input DTO to
   * the ci.entities UUID it resolved to (existing) or was created as. DTOs whose
   * resolution failed are absent from the map and reported in `errors` (in input
   * order), preserving the prior per-entity error isolation for the observable
   * result.
   *
   * Statement budget per call: one existence SELECT, one batched INSERT (new
   * rows only), and — only if a concurrent writer won a race — one re-resolve
   * SELECT. This replaces the former N×(findOne+save) round-trips while keeping
   * the (owner, entity_type, import:<sourceSystem>, uuidv5(key)) idempotency key.
   */
  private async upsertEntities(
    ownerId: string,
    inputs: GraphEntityInputDto[],
    errors: string[],
  ): Promise<Map<GraphEntityInputDto, string>> {
    const resolved = new Map<GraphEntityInputDto, string>();
    if (inputs.length === 0) {
      return resolved;
    }

    // Build a row per input and its idempotency coordinates. Intra-batch
    // duplicates on (entityType, linkedTable, linkedId) collapse to the first
    // occurrence's row, exactly as the prior create-cache would (two DTOs with
    // the same linked key resolve to one ci.entities row).
    interface Prepared {
      input: GraphEntityInputDto;
      entityType: string;
      linkedTable: string;
      linkedId: string;
      row: NodeEntity;
    }
    const coordKey = (entityType: string, linkedTable: string, linkedId: string): string =>
      `${entityType}||${linkedTable}||${linkedId}`;

    const prepared: Prepared[] = [];
    const firstByCoord = new Map<string, Prepared>();
    for (const input of inputs) {
      const linkedTable = `import:${input.sourceSystem}`;
      const linkedId = GraphIngestService.linkedIdFor(input.key);
      const ck = coordKey(input.entityType, linkedTable, linkedId);

      const existingPrep = firstByCoord.get(ck);
      if (existingPrep) {
        // Same linked key as an earlier row — reuse its (to-be-resolved) id.
        prepared.push({ ...existingPrep, input });
        continue;
      }

      const row = this.nodeRepository.create({
        entityId: uuidv7(),
        entityType: input.entityType,
        name: input.name ?? null,
        description: input.description ?? null,
        properties: input.properties ?? {},
        linkedTable,
        linkedId,
        userId: ownerId,
      });
      const prep: Prepared = { input, entityType: input.entityType, linkedTable, linkedId, row };
      prepared.push(prep);
      firstByCoord.set(ck, prep);
    }

    // coordKey -> resolved entity_id (existing, freshly inserted, or race winner).
    const idByCoord = new Map<string, string>();

    try {
      // 1. Existence pre-check over the distinct linked-key coordinates.
      const distinct = [...firstByCoord.values()];
      const existing = await this.findExistingNodes(ownerId, distinct);
      for (const row of existing) {
        idByCoord.set(coordKey(row.entityType, row.linkedTable!, row.linkedId!), row.entityId);
      }

      // 2. Batched INSERT of the rows that weren't already present. ON CONFLICT
      // DO NOTHING absorbs a lost race (the 23505 the old catch handled) without
      // throwing; RETURNING yields the rows THIS statement inserted.
      const toInsert = distinct.filter(
        (p) => !idByCoord.has(coordKey(p.entityType, p.linkedTable, p.linkedId)),
      );
      if (toInsert.length > 0) {
        // Split into param-budget-bounded chunks so a large batch never exceeds
        // Postgres' 65535 bind-param limit (computeChunkSize is the same helper
        // bulkInsertIdempotent uses). ON CONFLICT idempotency + RETURNING-based
        // resolution are unchanged; the returned rows are accumulated across
        // chunks.
        const rows = toInsert.map((p) => p.row);
        const chunkSize = computeChunkSize(this.nodeRepository.metadata.columns.length);
        for (let offset = 0; offset < rows.length; offset += chunkSize) {
          const insertResult = await this.nodeRepository
            .createQueryBuilder()
            .insert()
            .into(this.nodeRepository.metadata.target)
            .values(rows.slice(offset, offset + chunkSize))
            .onConflict(
              '(owner_user_id, entity_type, linked_table, linked_id) WHERE linked_table IS NOT NULL DO NOTHING',
            )
            .returning(['entityId', 'entityType', 'linkedTable', 'linkedId'])
            .execute();

          for (const raw of (insertResult.raw as Array<Record<string, unknown>>) ?? []) {
            idByCoord.set(
              coordKey(String(raw.entity_type), String(raw.linked_table), String(raw.linked_id)),
              String(raw.entity_id),
            );
          }
        }
      }

      // 3. Re-resolve any coordinate still unmapped: a concurrent writer won the
      // ON CONFLICT race, so the row exists but wasn't returned to us. One SELECT.
      const unresolved = distinct.filter(
        (p) => !idByCoord.has(coordKey(p.entityType, p.linkedTable, p.linkedId)),
      );
      if (unresolved.length > 0) {
        const winners = await this.findExistingNodes(ownerId, unresolved);
        for (const row of winners) {
          idByCoord.set(coordKey(row.entityType, row.linkedTable!, row.linkedId!), row.entityId);
        }
      }
    } catch (err) {
      // A batch-level failure (e.g. the DB is unavailable) can't be attributed to
      // one row, so — matching the prior loop's per-entity catch — report it
      // against every unresolved input and resolve none of them.
      const message = (err as Error).message;
      for (const input of inputs) {
        errors.push(`entity ${input.key}: ${message}`);
      }

      return resolved;
    }

    // Map each input DTO (including intra-batch duplicates) to its resolved id.
    for (const p of prepared) {
      const id = idByCoord.get(coordKey(p.entityType, p.linkedTable, p.linkedId));
      if (id === undefined) {
        errors.push(`entity ${p.input.key}: could not resolve entity id after upsert`);
        continue;
      }

      resolved.set(p.input, id);
    }

    return resolved;
  }

  /** One SELECT resolving the given linked-key coordinates to existing rows. */
  private async findExistingNodes(
    ownerId: string,
    coords: Array<{ entityType: string; linkedTable: string; linkedId: string }>,
  ): Promise<NodeEntity[]> {
    if (coords.length === 0) {
      return [];
    }

    const qb = this.nodeRepository
      .createQueryBuilder('e')
      .where('e.userId = :ownerId', { ownerId })
      .andWhere(
        new Brackets((outer: WhereExpressionBuilder) => {
          coords.forEach((c, i) => {
            outer.orWhere(
              `(e.entityType = :et_${i} AND e.linkedTable = :lt_${i} AND e.linkedId = :li_${i})`,
              { [`et_${i}`]: c.entityType, [`lt_${i}`]: c.linkedTable, [`li_${i}`]: c.linkedId },
            );
          });
        }),
      );

    return qb.getMany();
  }

  /**
   * Register the batch's contact identifiers (each entity's properties.emails /
   * properties.phones / properties.names — display-name identifiers for chat
   * networks that export no email/phone) in ci.entity_identifiers for
   * people-linking, via ONE set-based chunked INSERT for the whole ingest call
   * (formerly one statement per entity). No-op on an empty batch. Defensive:
   * even though the importer pre-normalizes, the service re-applies the
   * canonical rule. Swallows + logs its own errors so a bad identifier write
   * never aborts the entity ingest.
   */
  private async indexIdentifiers(ownerId: string, batch: EntityIdentifierBatchEntry[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }

    try {
      await this.entityIdentifierService.upsertForEntities(ownerId, batch);
    } catch (err) {
      this.logger.warn('Failed to index entity identifiers', {
        entities: batch.length,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Set-based upsert of a batch of already-endpoint-resolved edges. Returns the
   * count that landed (existing + freshly inserted). Rows that violate a table
   * CHECK (a self-reference: from == to) are dropped with a per-edge error,
   * mirroring the prior loop where such a save() threw and was caught per edge.
   *
   * Statement budget per call: one existence SELECT + one batched INSERT ... ON
   * CONFLICT DO NOTHING, replacing the former N×(findOne+save). Idempotency is
   * unchanged — the directed (from, to, type) unique index collapses re-sends.
   */
  private async upsertRelationships(
    ownerId: string,
    edges: ResolvedEdge[],
    errors: string[],
  ): Promise<number> {
    if (edges.length === 0) {
      return 0;
    }

    const edgeKey = (fromId: string, toId: string, type: string): string => `${fromId}||${toId}||${type}`;

    // Drop self-references up front (the no_self_references CHECK would reject the
    // whole INSERT otherwise); report each, exactly as the prior per-edge catch.
    // Collapse intra-batch duplicate (from, to, type) edges to one row.
    interface Prepared {
      edge: ResolvedEdge;
      key: string;
      row: RelationshipEntity;
    }
    const prepared: Prepared[] = [];
    const seen = new Set<string>();
    for (const e of edges) {
      if (e.fromId === e.toId) {
        errors.push(`relationship ${e.r.fromKey}->${e.r.toKey}: self-reference not allowed`);
        continue;
      }

      const key = edgeKey(e.fromId, e.toId, e.r.type);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      const row = this.relationshipRepository.create({
        id: uuidv7(),
        fromNodeId: e.fromId,
        fromNodeType: e.fromType,
        toNodeId: e.toId,
        toNodeType: e.toType,
        type: e.r.type,
        strength: 1,
        isBidirectional: false,
        userId: ownerId,
        properties: e.r.properties ?? {},
      });
      prepared.push({ edge: e, key, row });
    }

    if (prepared.length === 0) {
      return 0;
    }

    try {
      // 1. Existence pre-check over the distinct (from, to, type) edges.
      const existingKeys = new Set<string>();
      const existing = await this.relationshipRepository
        .createQueryBuilder('r')
        .where('r.userId = :ownerId', { ownerId })
        .andWhere(
          new Brackets((outer: WhereExpressionBuilder) => {
            prepared.forEach((p, i) => {
              outer.orWhere(`(r.fromNodeId = :rf_${i} AND r.toNodeId = :rt_${i} AND r.type = :rtype_${i})`, {
                [`rf_${i}`]: p.row.fromNodeId,
                [`rt_${i}`]: p.row.toNodeId,
                [`rtype_${i}`]: p.row.type,
              });
            });
          }),
        )
        .getMany();
      for (const row of existing) {
        existingKeys.add(edgeKey(row.fromNodeId, row.toNodeId, row.type));
      }

      // 2. Batched INSERT of the not-yet-present edges. ON CONFLICT DO NOTHING
      // targets the directed-uniqueness partial index and absorbs any concurrent
      // race, so an edge inserted between our SELECT and INSERT is a no-op here.
      const toInsert = prepared.filter((p) => !existingKeys.has(p.key));
      if (toInsert.length > 0) {
        // Split into param-budget-bounded chunks so a large batch never exceeds
        // Postgres' 65535 bind-param limit (computeChunkSize is the same helper
        // bulkInsertIdempotent uses). ON CONFLICT idempotency is unchanged.
        const rows = toInsert.map((p) => p.row);
        const chunkSize = computeChunkSize(this.relationshipRepository.metadata.columns.length);
        for (let offset = 0; offset < rows.length; offset += chunkSize) {
          await this.relationshipRepository
            .createQueryBuilder()
            .insert()
            .into(this.relationshipRepository.metadata.target)
            .values(rows.slice(offset, offset + chunkSize))
            .onConflict('(from_entity_id, to_entity_id, relationship_type) WHERE is_active = TRUE DO NOTHING')
            .execute();
        }
      }
    } catch (err) {
      // A batch-level failure can't be pinned to one edge — report it against
      // every prepared edge and count none as processed, matching how the prior
      // loop would have surfaced a non-race save() failure per edge.
      const message = (err as Error).message;
      for (const p of prepared) {
        errors.push(`relationship ${p.edge.r.fromKey}->${p.edge.r.toKey}: ${message}`);
      }

      return 0;
    }

    // Every prepared edge is now present (existing or inserted). Duplicates that
    // shared a triple were folded into one row above but each input edge counted;
    // report the count of input edges that resolved to a landed row.
    return edges.filter((e) => e.fromId !== e.toId).length;
  }

  /**
   * Resolve the owner's self entity, provisioning it when absent. The self
   * entity anchors every `self->…` edge (preferences from extract-graph, the
   * importer's own self-links). Its canonical pointer is ci.users.entity_id,
   * which a from-scratch ingest — or any data wipe — leaves NULL, so the owner
   * has no self and every self-anchored edge was silently dropped
   * ("endpoint not found in batch", preferenceEdgesWritten=0). Here we create a
   * stable `Person` for the owner (named from ci.users.name) and link
   * ci.users.entity_id to it, so a fresh import yields a complete graph with
   * preferences actually attached to the user.
   *
   * Idempotent and concurrency-safe: the Person upserts on its linked key, the
   * pointer is only set while still NULL, and we re-resolve afterwards so a
   * pointer a concurrent writer won is honoured over the row we created. Returns
   * null only when there is no ci.users row to anchor (a non-user context).
   */
  private async ensureSelfEntity(ownerId: string): Promise<{ id: string; type: string } | null> {
    const existing = await this.resolveSelfEntity(ownerId);
    if (existing) {
      return existing;
    }

    const users: Array<{ name: string | null; email: string | null }> =
      await this.nodeRepository.manager.query(`SELECT name, email FROM ci.users WHERE id = $1`, [ownerId]);
    if (users.length === 0) {
      this.logger.warn('Cannot provision self entity: no ci.users row for owner', { ownerId });

      return null;
    }

    const displayName = users[0].name?.trim() || users[0].email?.trim() || 'Me';

    // Provision the self Person through the same set-based upsert (a batch of
    // one), so its idempotency/race handling matches every other ingested entity.
    const selfDto: GraphEntityInputDto = {
      key: `self:user:${ownerId}`,
      entityType: SELF_ENTITY_TYPE,
      name: displayName,
      sourceSystem: SELF_SOURCE_SYSTEM,
      properties: { is_self: true },
    };
    const selfErrors: string[] = [];
    const selfResolved = await this.upsertEntities(ownerId, [selfDto], selfErrors);
    const selfEntityId = selfResolved.get(selfDto);
    if (selfEntityId === undefined) {
      throw new Error(selfErrors[0] ?? 'failed to provision self entity');
    }

    // Link the owner to it, but never clobber a pointer set concurrently.
    await this.nodeRepository.manager.query(
      `UPDATE ci.users SET entity_id = $2 WHERE id = $1 AND entity_id IS NULL`,
      [ownerId, selfEntityId],
    );

    this.logger.log('Provisioned self entity for owner', { ownerId, selfEntityId, displayName });

    // Honour whatever pointer actually won; fall back to the row we created.
    return (await this.resolveSelfEntity(ownerId)) ?? { id: selfEntityId, type: SELF_ENTITY_TYPE };
  }

  /**
   * The owner's own entity, used to anchor `self` edges. The canonical source is
   * `ci.users.entity_id` — a user's self entity is provisioned as a `Person`
   * (their display name), NOT an `entity_type = 'User'` row, so the previous
   * lookup by entityType found nothing and every `self->…` edge was dropped.
   * Returns the resolved id + its actual entity_type, or null if the user has no
   * self entity. The User entity_type is kept only as a fallback label.
   */
  private async resolveSelfEntity(ownerId: string): Promise<{ id: string; type: string } | null> {
    const rows: Array<{ entity_id: string; entity_type: string }> = await this.nodeRepository.manager.query(
      `SELECT e.entity_id, e.entity_type
         FROM ci.users u
         JOIN ci.entities e ON e.entity_id = u.entity_id
        WHERE u.id = $1`,
      [ownerId],
    );

    return rows[0] ? { id: rows[0].entity_id, type: rows[0].entity_type } : null;
  }
}

/**
 * An ingested entity's raw identifier payload (properties.emails / .phones /
 * .names), or null when it carries none — the same "has anything to index"
 * gate the former per-entity path applied, so identifier-less entities never
 * enter the batch.
 */
function rawIdentifiersOf(e: GraphEntityInputDto): EntityIdentifierBatchEntry['raw'] | null {
  const props = e.properties;
  if (props == null) {
    return null;
  }

  const { emails, phones, names } = props;
  if (emails == null && phones == null && names == null) {
    return null;
  }

  return { emails, phones, names };
}

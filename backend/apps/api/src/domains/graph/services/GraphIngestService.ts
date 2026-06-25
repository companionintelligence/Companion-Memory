import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v5 as uuidv5, v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { NodeEntity } from '../entities/NodeEntity';
import { RelationshipEntity } from '../entities/RelationshipEntity';

import { EntityIdentifierService } from './EntityIdentifierService';

const PG_UNIQUE_VIOLATION = '23505';

// Stable namespace so the importer and the server derive identical linked_id
// UUIDs from the same natural key. Do not change — it is the idempotency anchor.
const IMPORT_NAMESPACE = '6f4b3f9e-1c2a-5d8e-9a7b-0c1d2e3f4a5b';

// Sentinel key the importer uses to anchor an edge on the signed-in user's own
// entity (resolved server-side; the importer never knows the owner's entity_id).
const SELF_KEY = 'self';
const USER_ENTITY_TYPE = 'User';

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
}

export interface GraphIngestResult {
  entitiesProcessed: number;
  relationshipsProcessed: number;
  errors: string[];
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

    let entitiesProcessed = 0;
    for (const e of input.entities) {
      try {
        const id = await this.upsertEntity(ownerId, e);
        keyToId.set(e.key, id);
        keyToType.set(e.key, e.entityType);

        // People-linking: index this entity's email/phone identifiers so the
        // communications backfill can resolve raw participants to it. Idempotent
        // (ON CONFLICT DO NOTHING); only entities carrying emails/phones touch
        // the table. Failure to index must not fail the ingest of the entity
        // itself — log and continue.
        await this.indexIdentifiers(ownerId, id, e);

        entitiesProcessed += 1;
      } catch (err) {
        errors.push(`entity ${e.key}: ${(err as Error).message}`);
      }
    }

    let relationshipsProcessed = 0;
    if (input.relationships.length > 0) {
      const self = await this.resolveSelfEntity(ownerId);

      for (const r of input.relationships) {
        try {
          const fromId = r.fromKey === SELF_KEY ? self?.id : keyToId.get(r.fromKey);
          const toId = r.toKey === SELF_KEY ? self?.id : keyToId.get(r.toKey);

          if (!fromId || !toId) {
            errors.push(`relationship ${r.fromKey}->${r.toKey}: endpoint not found in batch`);
            continue;
          }

          const fromType =
            r.fromKey === SELF_KEY ? (self?.type ?? USER_ENTITY_TYPE) : keyToType.get(r.fromKey)!;
          const toType = r.toKey === SELF_KEY ? (self?.type ?? USER_ENTITY_TYPE) : keyToType.get(r.toKey)!;

          await this.upsertRelationship(ownerId, {
            fromId,
            fromType,
            toId,
            toType,
            type: r.type,
            properties: r.properties ?? {},
          });
          relationshipsProcessed += 1;
        } catch (err) {
          errors.push(`relationship ${r.fromKey}->${r.toKey}: ${(err as Error).message}`);
        }
      }
    }

    return { entitiesProcessed, relationshipsProcessed, errors };
  }

  private async upsertEntity(ownerId: string, e: GraphEntityInputDto): Promise<string> {
    const linkedTable = `import:${e.sourceSystem}`;
    const linkedId = GraphIngestService.linkedIdFor(e.key);

    const where = {
      userId: ownerId,
      entityType: e.entityType,
      linkedTable,
      linkedId,
    } as const;

    const existing = await this.nodeRepository.findOne({ where });
    if (existing) {
      return existing.entityId;
    }

    const row = this.nodeRepository.create({
      entityId: uuidv7(),
      entityType: e.entityType,
      name: e.name ?? null,
      description: e.description ?? null,
      properties: e.properties ?? {},
      linkedTable,
      linkedId,
      userId: ownerId,
    });

    try {
      const saved = await this.nodeRepository.save(row);

      return saved.entityId;
    } catch (err) {
      // Lost a race to a concurrent insert of the same linked key — return the
      // winner.
      if ((err as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
        const winner = await this.nodeRepository.findOne({ where });
        if (winner) {
          return winner.entityId;
        }
      }

      throw err;
    }
  }

  /**
   * Register an ingested entity's contact identifiers (properties.emails /
   * properties.phones) in ci.entity_identifiers for people-linking. No-op when
   * neither is present. Defensive: even though the importer pre-normalizes, the
   * service re-applies the canonical rule. Swallows + logs its own errors so a
   * bad identifier never aborts the entity ingest.
   */
  private async indexIdentifiers(ownerId: string, entityId: string, e: GraphEntityInputDto): Promise<void> {
    const props = e.properties;
    if (props == null) {
      return;
    }

    const emails = props.emails;
    const phones = props.phones;
    if (emails == null && phones == null) {
      return;
    }

    try {
      await this.entityIdentifierService.upsertForEntity(ownerId, entityId, { emails, phones });
    } catch (err) {
      this.logger.warn('Failed to index entity identifiers', {
        entityId,
        key: e.key,
        error: (err as Error).message,
      });
    }
  }

  private async upsertRelationship(
    ownerId: string,
    data: {
      fromId: string;
      fromType: string;
      toId: string;
      toType: string;
      type: string;
      properties: Record<string, unknown>;
    },
  ): Promise<void> {
    const where = {
      fromNodeId: data.fromId,
      toNodeId: data.toId,
      type: data.type,
      userId: ownerId,
    } as const;

    const existing = await this.relationshipRepository.findOne({ where });
    if (existing) {
      return;
    }

    const row = this.relationshipRepository.create({
      id: uuidv7(),
      fromNodeId: data.fromId,
      fromNodeType: data.fromType,
      toNodeId: data.toId,
      toNodeType: data.toType,
      type: data.type,
      strength: 1,
      isBidirectional: false,
      userId: ownerId,
      properties: data.properties,
    });

    try {
      await this.relationshipRepository.save(row);
    } catch (err) {
      // Directed-uniqueness race (from, to, type) — the row exists now, which is
      // all we need.
      if ((err as { code?: string })?.code === PG_UNIQUE_VIOLATION) {
        return;
      }

      throw err;
    }
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

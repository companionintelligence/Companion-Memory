import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { chunkedConflictInsert } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { type Concept, ConceptEntity } from '../entities/ConceptEntity';
import { ConceptCreatedEvent, ConceptRemovedEvent, ConceptUpdatedEvent } from '../events';
import { CreateConceptDto, UpdateConceptDto } from '../types';

import { EntityService } from './EntityService';

@Injectable()
export class ConceptService extends EntityService<ConceptEntity, Concept> {
  constructor(
    @InjectRepository(ConceptEntity)
    conceptRepository: Repository<ConceptEntity>,
    private readonly logger: LoggerService,
    private readonly eventService: EventService,
  ) {
    super(conceptRepository, ConceptEntity);
    this.logger.setContext(ConceptService.name);
  }

  /**
   * @param options.emitCreated When true (default) a ConceptCreatedEvent is sent so
   *   the row indexes/enriches live. The bulk path passes false: emitting a per-row
   *   pgboss event for every ingested row is the dominant cost at import volume, so
   *   bulk-loaded rows are instead swept by the post-load search-index backfill.
   */
  async create(
    context: UserServiceContext,
    data: CreateConceptDto,
    options: { emitCreated?: boolean } = {},
  ): Promise<Concept> {
    const { emitCreated = true } = options;

    // Idempotency on the stable external key (see PersonService.create) — a
    // re-synced concept (email thread, book, topic) must not duplicate. The
    // `entity_type = 'Concept'` half is enforced automatically by the STI child
    // repository, so it is not restated here.
    const linkedWhere =
      data.linkedTable && data.linkedId
        ? {
            linkedTable: data.linkedTable,
            linkedId: data.linkedId,
            userId: context.userId,
          }
        : null;

    if (linkedWhere) {
      const existing = await this.repository.findOne({ where: linkedWhere });
      if (existing) {
        return ConceptEntity.toEgressType(existing);
      }
    }

    // Insert in a transaction (persistCreate is the seam where mutation
    // recording will land). Reaching past the catch means a genuine insert
    // happened (an idempotent race winner returns early), so the created event
    // always fires here.
    let entity: ConceptEntity;
    try {
      entity = await this.repository.manager.transaction((manager) => {
        const instance = this.repository.create({
          id: data.id ?? uuid7(),
          name: data.name ?? null,
          description: data.description ?? null,
          linkedTable: data.linkedTable ?? null,
          linkedId: data.linkedId ?? null,
          searchContent: data.searchContent ?? null,
          lastAccessed: data.lastAccessed,
          userId: context.userId,
          properties: data.properties ?? {},
        });

        return this.persistCreate(manager, instance);
      });
    } catch (err) {
      // Lost a race to a concurrent insert of the same linked key (23505) —
      // return the winner. The recovery query must run outside the failed
      // transaction: the unique violation aborts it, so any further query on
      // that manager would fail with 25P02 instead.
      if (linkedWhere && (err as { code?: string })?.code === '23505') {
        const winner = await this.repository.findOne({ where: linkedWhere });
        if (winner) {
          return ConceptEntity.toEgressType(winner);
        }
      }

      throw err;
    }

    if (emitCreated) {
      await this.eventService.send(ConceptCreatedEvent, {
        conceptId: entity.id,
      });
    }

    // Reload so @AfterLoad projects the jsonb helpers (type/category/aliases)
    // and DB-side defaults (e.g. last_accessed) are present. `save` runs
    // neither, so the saved instance alone would egress them empty.
    const created = await this.repository.findOne({ where: { id: entity.id } });

    return ConceptEntity.toEgressType(created ?? entity);
  }

  /**
   * Batch, idempotent concept ingest for the importer. Replaces the per-row
   * findOne + save + ConceptCreatedEvent loop with one set-based
   * INSERT ... ON CONFLICT DO NOTHING (dedup on the (owner_user_id, entity_type,
   * linked_table, linked_id) provenance key via the existing entities_linked_uniq
   * partial unique index, which also absorbs a lost insert race) plus one
   * hydration SELECT. Re-syncing the same linked key returns the existing row
   * instead of duplicating it. Returns the created-or-existing concepts in input
   * order.
   *
   * Bulk ingest does NOT emit a per-row ConceptCreatedEvent: the per-row pgboss
   * fan-out was the dominant cost at import volume. Search indexing for
   * bulk-loaded rows is deferred to the post-load batch embed
   * (POST /api/maintenance/search-index/backfill). Single-row create() still
   * emits, so interactive creates index live.
   */
  async createMany(context: UserServiceContext, data: CreateConceptDto[]): Promise<Concept[]> {
    if (data.length === 0) {
      return [];
    }

    // `entity_type` is not set here: the STI child metadata carries the
    // discriminator and TypeORM's insert builder emits it for every row.
    const entities = data.map((item) =>
      this.repository.create({
        id: item.id ?? uuid7(),
        name: item.name ?? null,
        description: item.description ?? null,
        linkedTable: item.linkedTable ?? null,
        linkedId: item.linkedId ?? null,
        searchContent: item.searchContent ?? null,
        lastAccessed: item.lastAccessed,
        userId: context.userId,
        properties: item.properties ?? {},
      }),
    );

    // One set-based INSERT keyed on the linked provenance index, split into
    // param-budget-bounded chunks by chunkedConflictInsert so a large batch
    // never exceeds Postgres' 65535 bind-param limit. The conflict clause
    // targets entities_linked_uniq exactly (partial on linked_table IS NOT
    // NULL) so a re-synced linked row is a no-op and a lost insert race is
    // absorbed without throwing. Unlinked rows (no linked_table/linked_id)
    // fall outside the partial index and always insert, matching create()'s
    // behaviour.
    await chunkedConflictInsert(
      this.repository,
      entities,
      '(owner_user_id, entity_type, linked_table, linked_id) WHERE linked_table IS NOT NULL DO NOTHING',
    );

    return this.hydrateInInputOrder(context, entities);
  }

  /**
   * Resolve each built entity to its canonical persisted row (freshly inserted or
   * pre-existing under the same linked key), in input order. One SELECT.
   */
  private async hydrateInInputOrder(
    context: UserServiceContext,
    entities: ConceptEntity[],
  ): Promise<Concept[]> {
    const ids = entities.map((entity) => entity.id);

    const qb = this.repository
      .createQueryBuilder('concept')
      // The STI child repository scopes the query to `entity_type = 'Concept'`.
      .where('concept.owner_user_id = :userId', { userId: context.userId })
      .andWhere(
        new Brackets((outer) => {
          outer.where('concept.entity_id IN (:...ids)', { ids });

          const linked = entities.filter((entity) => entity.linkedTable && entity.linkedId);
          linked.forEach((entity, i) => {
            outer.orWhere(`(concept.linked_table = :lt_${i} AND concept.linked_id = :li_${i})`, {
              [`lt_${i}`]: entity.linkedTable,
              [`li_${i}`]: entity.linkedId,
            });
          });
        }),
      );

    const rows = await qb.getMany();

    const byId = new Map(rows.map((row) => [row.id, row]));
    const byLinked = new Map(
      rows
        .filter((row) => row.linkedTable && row.linkedId)
        .map((row) => [`${row.linkedTable} ${row.linkedId}`, row]),
    );

    return entities.map((entity) => {
      const linkedKey =
        entity.linkedTable && entity.linkedId ? `${entity.linkedTable} ${entity.linkedId}` : null;
      const row = byId.get(entity.id) ?? (linkedKey ? byLinked.get(linkedKey) : undefined) ?? entity;

      return ConceptEntity.toEgressType(row);
    });
  }

  /**
   * Lightweight identifiers for the most-recent concepts, for the unified
   * search/explorer feed. Full entities are batch-resolved downstream.
   */
  async getEntitiesForConcepts(
    context: ServiceContext,
    options: { limit?: number; startTime?: Date; endTime?: Date; order?: 'ASC' | 'DESC' } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.repository
      .createQueryBuilder('concept')
      .select('concept.id', 'id')
      // The STI child repository scopes the query to `entity_type = 'Concept'`.
      .where('concept.owner_user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('concept.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('concept.created_at <= :endTime', { endTime: options.endTime });
    }

    query = query.orderBy('concept.created_at', options.order ?? 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'concept' as IndexableEntity }));
  }

  async update(context: ServiceContext, id: string, data: UpdateConceptDto): Promise<Concept | null> {
    const { properties, ...rest } = data;

    const after = await this.applyUpdate(context, id, {
      ...rest,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      properties: properties as any, // TypeORM will handle JSON serialization
    });

    if (!after) {
      return null;
    }

    await this.eventService.send(ConceptUpdatedEvent, {
      conceptId: id,
    });

    return ConceptEntity.toEgressType(after);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const removed = await this.delete(context, id);

    if (!removed) {
      return false;
    }

    await this.eventService.send(ConceptRemovedEvent, {
      conceptId: id,
    });

    return true;
  }

  async search(context: ServiceContext, query: UpdateConceptDto): Promise<Concept[]> {
    // The STI child repository scopes the query to `entity_type = 'Concept'`.
    let executable = this.repository.createQueryBuilder('entity');

    if (context.userId !== SYSTEM_USER) {
      executable = executable.andWhere('entity.owner_user_id = :userId', { userId: context.userId });
    }

    if (query.name) {
      executable = executable.andWhere('entity.name = :name', { name: query.name });
    }

    if (query.description) {
      executable = executable.andWhere('entity.description = :description', {
        description: query.description,
      });
    }

    if (query.linkedId) {
      executable = executable.andWhere('entity.linked_id = :linkedId', { linkedId: query.linkedId });
    }

    if (query.linkedTable) {
      executable = executable.andWhere('entity.linked_table = :linkedTable', {
        linkedTable: query.linkedTable,
      });
    }

    if (query.properties) {
      for (const [key, value] of Object.entries(query.properties)) {
        executable = executable.andWhere(`entity.properties->>'${key}' = :${key}`, { [key]: value });
      }
    }

    const entities = await executable.getMany();

    return entities.map((entity) => ConceptEntity.toEgressType(entity));
  }
}

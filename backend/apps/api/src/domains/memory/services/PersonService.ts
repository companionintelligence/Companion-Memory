import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { computeChunkSize } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { PersonCreatedEvent, PersonUpdatedEvent, PersonRemovedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { type Person, PersonEntity } from '../entities/PersonEntity';
import { CreatePersonDto, UpdatePersonDto } from '../types';

@Injectable()
export class PersonService {
  constructor(
    @InjectRepository(PersonEntity)
    private readonly personRepository: Repository<PersonEntity>,
    private readonly logger: LoggerService,
    private readonly eventService: EventService,
  ) {
    this.logger.setContext(PersonService.name);
  }

  /**
   * @param options.emitCreated When true (default) a PersonCreatedEvent is sent so
   *   the row indexes/enriches live. The bulk path passes false: emitting a per-row
   *   pgboss event for every ingested row is the dominant cost at import volume, so
   *   bulk-loaded rows are instead swept by the post-load search-index backfill.
   */
  async create(
    context: UserServiceContext,
    data: CreatePersonDto,
    options: { emitCreated?: boolean } = {},
  ): Promise<Person> {
    const { emitCreated = true } = options;

    // Idempotency: (owner_user_id, entity_type, linked_table, linked_id) is the
    // stable external key a capture source carries. Resolving-or-creating the
    // same linked person (a re-sync, a retry) must NOT duplicate it.
    const linkedWhere =
      data.linkedTable && data.linkedId
        ? {
            entityType: 'Person',
            linkedTable: data.linkedTable,
            linkedId: data.linkedId,
            user: { id: context.userId },
          }
        : null;

    if (linkedWhere) {
      const existing = await this.personRepository.findOne({ where: linkedWhere });
      if (existing) {
        return PersonEntity.toEgressType(existing);
      }
    }

    const instance = this.personRepository.create({
      id: data.id || uuid7(),
      name: data.name,
      description: data.description,
      linkedTable: data.linkedTable,
      linkedId: data.linkedId,
      entityType: 'Person',
      searchContent: data.searchContent,
      lastAccessed: data.lastAccessed,
      user: {
        id: context.userId,
      },
      properties: data.properties || {},
    });

    let entity: PersonEntity;
    try {
      entity = await this.personRepository.save(instance);
    } catch (err) {
      // Lost a race to a concurrent insert of the same linked key (23505) —
      // return the winner.
      if (linkedWhere && (err as { code?: string })?.code === '23505') {
        const existing = await this.personRepository.findOne({ where: linkedWhere });
        if (existing) {
          return PersonEntity.toEgressType(existing);
        }
      }

      throw err;
    }

    if (emitCreated) {
      await this.eventService.send(PersonCreatedEvent, {
        personId: entity.id,
      });
    }

    return PersonEntity.toEgressType(entity);
  }

  /**
   * Batch, idempotent people ingest for the importer. Replaces the per-row
   * findOne + save + PersonCreatedEvent loop with one set-based
   * INSERT ... ON CONFLICT DO NOTHING (dedup on the (owner_user_id, entity_type,
   * linked_table, linked_id) provenance key via the existing entities_linked_uniq
   * partial unique index, which also absorbs a lost insert race) plus one
   * hydration SELECT. Re-syncing the same linked key returns the existing row
   * instead of duplicating it. Returns the created-or-existing people in input
   * order.
   *
   * Bulk ingest does NOT emit a per-row PersonCreatedEvent: the per-row pgboss
   * fan-out was the dominant cost at import volume. Search indexing for
   * bulk-loaded rows is deferred to the post-load batch embed
   * (POST /api/maintenance/search-index/backfill). Single-row create() still
   * emits, so interactive creates index live.
   */
  async createMany(context: UserServiceContext, data: CreatePersonDto[]): Promise<Person[]> {
    if (data.length === 0) {
      return [];
    }

    const entities = data.map((item) =>
      this.personRepository.create({
        id: item.id || uuid7(),
        name: item.name,
        description: item.description,
        linkedTable: item.linkedTable,
        linkedId: item.linkedId,
        entityType: 'Person',
        searchContent: item.searchContent,
        lastAccessed: item.lastAccessed,
        user: {
          id: context.userId,
        },
        properties: item.properties || {},
      }),
    );

    // One set-based INSERT keyed on the linked provenance index, split into
    // param-budget-bounded chunks so a large batch never exceeds Postgres'
    // 65535 bind-param limit (computeChunkSize is the same helper
    // bulkInsertIdempotent uses). onConflict targets entities_linked_uniq
    // exactly (partial on linked_table IS NOT NULL) so a re-synced linked row is
    // a no-op and a lost insert race is absorbed without throwing. Unlinked rows
    // (no linked_table/linked_id) fall outside the partial index and always
    // insert, matching create()'s behaviour.
    const chunkSize = computeChunkSize(this.personRepository.metadata.columns.length);
    for (let offset = 0; offset < entities.length; offset += chunkSize) {
      await this.personRepository
        .createQueryBuilder()
        .insert()
        // Route through `metadata.target` so TS picks the `ObjectLiteral` overload
        // of `.values()`; passing the entity class narrows to
        // `_QueryDeepPartialEntity`, which rejects the jsonb `properties` column.
        .into(this.personRepository.metadata.target)
        .values(entities.slice(offset, offset + chunkSize))
        .onConflict(
          '(owner_user_id, entity_type, linked_table, linked_id) WHERE linked_table IS NOT NULL DO NOTHING',
        )
        .execute();
    }

    // Hydrate the created-or-existing rows in input order: by id for the ones we
    // (may have) inserted, plus by linked key for any that a concurrent/prior
    // ingest already owned under a different id.
    return this.hydrateInInputOrder(context, entities);
  }

  /**
   * Resolve each built entity to its canonical persisted row (freshly inserted or
   * pre-existing under the same linked key), in input order. One SELECT.
   */
  private async hydrateInInputOrder(
    context: UserServiceContext,
    entities: PersonEntity[],
  ): Promise<Person[]> {
    const ids = entities.map((entity) => entity.id);

    const qb = this.personRepository
      .createQueryBuilder('person')
      .where('person.entity_type = :entityType', { entityType: 'Person' })
      .andWhere('person.owner_user_id = :userId', { userId: context.userId })
      .andWhere(
        new Brackets((outer) => {
          outer.where('person.entity_id IN (:...ids)', { ids });

          const linked = entities.filter((entity) => entity.linkedTable && entity.linkedId);
          linked.forEach((entity, i) => {
            outer.orWhere(`(person.linked_table = :lt_${i} AND person.linked_id = :li_${i})`, {
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

      return PersonEntity.toEgressType(row);
    });
  }

  async findAll(context: ServiceContext): Promise<Person[]> {
    const entities = await this.personRepository.find({
      where: {
        entityType: 'Person',
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    return entities.map((entity) => PersonEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Person | null)[]> {
    const entities = await this.personRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    const map = new Map(entities.map((entity) => [entity.id, PersonEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  /**
   * Lightweight identifiers for the most-recent people, for the unified
   * search/explorer feed. Full entities are batch-resolved downstream.
   */
  async getEntitiesForPeople(
    context: ServiceContext,
    options: { limit?: number; startTime?: Date; endTime?: Date; order?: 'ASC' | 'DESC' } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.personRepository
      .createQueryBuilder('person')
      .select('person.id', 'id')
      .where('person.entity_type = :entityType', { entityType: 'Person' })
      .andWhere('person.owner_user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('person.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('person.created_at <= :endTime', { endTime: options.endTime });
    }

    query = query.orderBy('person.created_at', options.order ?? 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'person' as IndexableEntity }));
  }

  async findById(context: ServiceContext, id: string): Promise<Person | null> {
    const entity = await this.personRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    return entity ? PersonEntity.toEgressType(entity) : null;
  }

  async update(context: ServiceContext, id: string, data: UpdatePersonDto): Promise<Person | null> {
    const { properties, ...rest } = data;

    const result = await this.personRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      {
        ...rest,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        properties: properties as any, // TypeORM will handle JSON serialization
      },
    );

    if (result.affected === 0) {
      return null;
    }

    await this.eventService.send(PersonUpdatedEvent, {
      personId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.personRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        user: {
          id: context.userId,
        },
      }),
    });

    if (result.affected === 0) {
      return false;
    }

    await this.eventService.send(PersonRemovedEvent, {
      personId: id,
    });

    return true;
  }

  async search(context: ServiceContext, query: UpdatePersonDto): Promise<PersonEntity[]> {
    let executable = this.personRepository
      .createQueryBuilder('entity')
      .where('owner_user_id = :userId', { userId: context.userId });

    if (query.name) {
      executable = executable.andWhere('name = :name', { name: query.name });
    }

    if (query.description) {
      executable = executable.andWhere('description = :description', { description: query.description });
    }

    if (query.linkedId) {
      executable = executable.andWhere('linked_id = :linkedId', { linkedId: query.linkedId });
    }

    if (query.linkedTable) {
      executable = executable.andWhere('linked_table = :linkedTable', { linkedTable: query.linkedTable });
    }

    if (query.properties) {
      for (const [key, val] of Object.entries(query.properties)) {
        executable = executable.andWhere(`entity.properties->>'${key}' = :${key}`, { [key]: val });
      }
    }

    return executable.getMany();
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
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

  async create(context: UserServiceContext, data: CreatePersonDto): Promise<Person> {
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

    await this.eventService.send(PersonCreatedEvent, {
      personId: entity.id,
    });

    return PersonEntity.toEgressType(entity);
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

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { type Concept, ConceptEntity } from '../entities/ConceptEntity';
import { ConceptCreatedEvent, ConceptRemovedEvent, ConceptUpdatedEvent } from '../events';
import { CreateConceptDto, UpdateConceptDto } from '../types';

@Injectable()
export class ConceptService {
  constructor(
    @InjectRepository(ConceptEntity)
    private readonly conceptRepository: Repository<ConceptEntity>,
    private readonly logger: LoggerService,
    private readonly eventService: EventService,
  ) {
    this.logger.setContext(ConceptService.name);
  }

  async create(context: UserServiceContext, data: CreateConceptDto): Promise<Concept> {
    // Idempotency on the stable external key (see PersonService.create) — a
    // re-synced concept (email thread, book, topic) must not duplicate.
    const linkedWhere =
      data.linkedTable && data.linkedId
        ? {
            entityType: 'Concept',
            linkedTable: data.linkedTable,
            linkedId: data.linkedId,
            user: { id: context.userId },
          }
        : null;

    if (linkedWhere) {
      const existing = await this.conceptRepository.findOne({ where: linkedWhere });
      if (existing) {
        return ConceptEntity.toEgressType(existing);
      }
    }

    const instance = this.conceptRepository.create({
      id: data.id ?? uuid7(),
      name: data.name ?? null,
      description: data.description ?? null,
      linkedTable: data.linkedTable ?? null,
      linkedId: data.linkedId ?? null,
      entityType: 'Concept',
      searchContent: data.searchContent ?? null,
      lastAccessed: data.lastAccessed,
      user: {
        id: context.userId,
      },
      properties: data.properties ?? {},
    });

    let entity: ConceptEntity;
    try {
      entity = await this.conceptRepository.save(instance);
    } catch (err) {
      if (linkedWhere && (err as { code?: string })?.code === '23505') {
        const existing = await this.conceptRepository.findOne({ where: linkedWhere });
        if (existing) {
          return ConceptEntity.toEgressType(existing);
        }
      }

      throw err;
    }

    await this.eventService.send(ConceptCreatedEvent, {
      conceptId: entity.id,
    });

    return ConceptEntity.toEgressType(entity);
  }

  async findAll(context: ServiceContext): Promise<Concept[]> {
    const entities = await this.conceptRepository.find({
      where: {
        entityType: 'Concept',
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    return entities.map((entity) => ConceptEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Concept | null)[]> {
    if (ids.length === 0) {
      return [];
    }

    const entities = await this.conceptRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    const map = new Map(entities.map((entity) => [entity.id, ConceptEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  /**
   * Lightweight identifiers for the most-recent concepts, for the unified
   * search/explorer feed. Full entities are batch-resolved downstream.
   */
  async getEntitiesForConcepts(
    context: ServiceContext,
    options: { limit?: number; startTime?: Date; endTime?: Date; order?: 'ASC' | 'DESC' } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.conceptRepository
      .createQueryBuilder('concept')
      .select('concept.id', 'id')
      .where('concept.entity_type = :entityType', { entityType: 'Concept' })
      .andWhere('concept.owner_user_id = :userId', { userId: context.userId });

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

  async findById(context: ServiceContext, id: string): Promise<Concept | null> {
    const entity = await this.conceptRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    return entity ? ConceptEntity.toEgressType(entity) : null;
  }

  async update(context: ServiceContext, id: string, data: UpdateConceptDto): Promise<Concept | null> {
    const { properties, ...rest } = data;

    const result = await this.conceptRepository.update(
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
        properties: properties as any,
      },
    );

    if (result.affected === 0) {
      return null;
    }

    await this.eventService.send(ConceptUpdatedEvent, {
      conceptId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.conceptRepository.delete({
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

    await this.eventService.send(ConceptRemovedEvent, {
      conceptId: id,
    });

    return true;
  }

  async search(context: ServiceContext, query: UpdateConceptDto): Promise<ConceptEntity[]> {
    let executable = this.conceptRepository
      .createQueryBuilder('entity')
      .where('entity.entity_type = :entityType', { entityType: 'Concept' });

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

    return executable.getMany();
  }
}

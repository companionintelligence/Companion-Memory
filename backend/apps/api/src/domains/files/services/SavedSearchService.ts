import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';

import { SavedSearch, SavedSearchEntity } from '../entities/SavedSearchEntity';
import { SavedSearchCreatedEvent, SavedSearchUpdatedEvent, SavedSearchDeletedEvent } from '../events';
import type { CreateSavedSearchDto, UpdateSavedSearchDto } from '../types';

@Injectable()
export class SavedSearchService {
  constructor(
    @InjectRepository(SavedSearchEntity)
    private readonly savedSearchRepository: Repository<SavedSearchEntity>,
    private readonly eventService: EventService,
  ) {}

  async create(context: UserServiceContext, data: CreateSavedSearchDto): Promise<SavedSearch> {
    const id = data.id ?? uuidv7();

    const instance = await this.savedSearchRepository.create({
      id,
      name: data.name,
      description: data.description,
      query: data.query,
      entityTypes: data.entityTypes,
      tags: data.tags,
      userId: context.userId,
    });

    const entity = await this.savedSearchRepository.save(instance);

    await this.eventService.send(SavedSearchCreatedEvent, {
      savedSearchId: id,
    });

    return SavedSearchEntity.toEgressType(entity);
  }

  async findAll(context: ServiceContext): Promise<SavedSearch[]> {
    const results = await this.savedSearchRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return results.map((entity) => SavedSearchEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(SavedSearch | null)[]> {
    const results = await this.savedSearchRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const map = new Map(results.map((entity) => [entity.id, SavedSearchEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<SavedSearch | null> {
    return this.savedSearchRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });
  }

  async update(context: ServiceContext, id: string, data: UpdateSavedSearchDto): Promise<SavedSearch | null> {
    const result = await this.savedSearchRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      data,
    );

    if (result.affected === 0) {
      return null;
    }

    await this.eventService.send(SavedSearchUpdatedEvent, {
      savedSearchId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.savedSearchRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    });

    if (result.affected === 0) {
      return false;
    }

    await this.eventService.send(SavedSearchDeletedEvent, {
      savedSearchId: id,
    });

    return true;
  }
}

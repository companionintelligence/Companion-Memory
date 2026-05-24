import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { SYSTEM_USER, type UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import { ItemCreatedEvent, ItemUpdatedEvent, ItemRemovedEvent } from '@ci/domains/memory/events';

import { type Item, ItemEntity } from '../entities/ItemEntity';
import type { CreateItemDto, UpdateItemDto } from '../types';

@Injectable()
export class ItemService {
  constructor(
    @InjectRepository(ItemEntity)
    private readonly itemRepository: Repository<ItemEntity>,
    private readonly logger: LoggerService,
    private readonly eventService: EventService,
  ) {
    this.logger.setContext(ItemService.name);
  }

  async create(context: UserServiceContext, data: CreateItemDto): Promise<Item> {
    const id = data.id ?? uuid7();

    const entity = this.itemRepository.create({
      id,
      userId: context.userId,
      name: data.name,
      description: data.description ?? null,
      category: data.category ?? null,
      subcategory: data.subcategory ?? null,
      brand: data.brand ?? null,
      model: data.model ?? null,
      currentValue: data.currentValue ?? null,
      currency: data.currency ?? 'USD',
      condition: data.condition ?? null,
      metadata: data.metadata ?? {},
    });

    await this.itemRepository.save(entity);

    await this.eventService.send(ItemCreatedEvent, {
      itemId: entity.id,
    });

    return ItemEntity.toEgressType(entity);
  }

  async findAll(context: ServiceContext): Promise<Item[]> {
    const entities = await this.itemRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return entities.map((entity) => ItemEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Item | null)[]> {
    const entities = await this.itemRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const map = new Map(entities.map((entity) => [entity.id, ItemEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<Item | null> {
    const entity = await this.itemRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (entity == null) {
      return null;
    }

    return ItemEntity.toEgressType(entity);
  }

  /**
   * Yields an collection of Items each associated with a given File id.
   *
   * This method assumes the context user has access to the corresponding Files.
   * This access must be ensured before safely calling this method.
   */
  async findByFileIds(context: ServiceContext, fileIds: string[]): Promise<Item[][]> {
    if (fileIds.length === 0) {
      return [];
    }

    const queryBuilder = this.itemRepository.createQueryBuilder('inventory');

    queryBuilder.where("inventory.metadata->>'source_file_id' IN (:...fileIds)", { fileIds });

    if (context.userId !== SYSTEM_USER) {
      queryBuilder.andWhere('inventory.userId = :userId', { userId: context.userId });
    }

    const entities = await queryBuilder.getMany();

    const itemsMap = new Map<string, Item[]>();

    for (const entity of entities) {
      const item = ItemEntity.toEgressType(entity);
      const fileId = item.sourceFileId;

      if (fileId) {
        if (!itemsMap.has(fileId)) {
          itemsMap.set(fileId, []);
        }

        itemsMap.get(fileId)!.push(item);
      }
    }

    return fileIds.map((id) => itemsMap.get(id) ?? []);
  }

  async update(context: ServiceContext, id: string, data: UpdateItemDto): Promise<Item | null> {
    const updateData: Partial<ItemEntity> = {};

    if (data.name !== undefined) {
      updateData.name = data.name;
    }

    if (data.description !== undefined) {
      updateData.description = data.description;
    }

    if (data.category !== undefined) {
      updateData.category = data.category;
    }

    if (data.subcategory !== undefined) {
      updateData.subcategory = data.subcategory;
    }

    if (data.brand !== undefined) {
      updateData.brand = data.brand;
    }

    if (data.model !== undefined) {
      updateData.model = data.model;
    }

    if (data.currentValue !== undefined) {
      updateData.currentValue = data.currentValue;
    }

    if (data.currency !== undefined) {
      updateData.currency = data.currency;
    }

    if (data.condition !== undefined) {
      updateData.condition = data.condition;
    }

    if (data.metadata !== undefined) {
      updateData.metadata = data.metadata;
    }

    const item = await this.itemRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (item) {
      Object.assign(item, updateData);
      await this.itemRepository.save(item);
    } else {
      return null;
    }

    await this.eventService.send(ItemUpdatedEvent, {
      itemId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.itemRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    });

    if (result.affected === 0) {
      return false;
    }

    await this.eventService.send(ItemRemovedEvent, {
      itemId: id,
    });

    return true;
  }

  async search(context: ServiceContext, query: UpdateItemDto): Promise<ItemEntity[]> {
    let executable = this.itemRepository
      .createQueryBuilder('item')
      .where('user_id = :userId', { userId: context.userId });

    if (query.name) {
      executable = executable.andWhere('name = :name', { name: query.name });
    }

    if (query.description) {
      executable = executable.andWhere('description = :description', { description: query.description });
    }

    if (query.category) {
      executable = executable.andWhere('category = :category', { category: query.category });
    }

    if (query.subcategory) {
      executable = executable.andWhere('subcategory = :subcategory', { subcategory: query.subcategory });
    }

    if (query.brand) {
      executable = executable.andWhere('brand = :brand', { brand: query.brand });
    }

    if (query.model) {
      executable = executable.andWhere('model = :model', { model: query.model });
    }

    if (query.condition) {
      executable = executable.andWhere('condition = :condition', { condition: query.condition });
    }

    if (query.metadata) {
      for (const [key, val] of Object.entries(query.metadata)) {
        executable = executable.andWhere(`item.metadata->>'${key}' = :${key}`, { [key]: val });
      }
    }

    return executable.getMany();
  }
}

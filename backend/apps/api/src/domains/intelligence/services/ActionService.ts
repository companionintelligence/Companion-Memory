import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';

import { type Action, ActionEntity } from '../entities/ActionEntity';
import type { CreateActionDto } from '../types';

@Injectable()
export class ActionService {
  constructor(
    @InjectRepository(ActionEntity)
    private readonly actionRepository: Repository<ActionEntity>,
  ) {}

  async create(context: UserServiceContext, data: CreateActionDto): Promise<Action> {
    const id = data.id ?? uuidv7();

    const instance = await this.actionRepository.create({
      id,
      title: data.title,
      text: data.text,
      imageUrl: data.imageUrl,
      priority: data.priority,
      thread: {
        id: data.threadId,
      },
      user: {
        id: context.userId,
      },
    });

    const entity = await this.actionRepository.save(instance);

    return ActionEntity.toEgressType(entity);
  }

  async findAll(context: ServiceContext): Promise<Action[]> {
    const entities = await this.actionRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      order: {
        priority: 'asc',
      },
      relations: ['tags'],
    });

    return entities.map((entity) => ActionEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Action | null)[]> {
    const entities = await this.actionRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        id: In(ids),
      },
      relations: ['tags'],
    });

    const map = new Map(entities.map((entity) => [entity.id, ActionEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<Action | null> {
    const entity = await this.actionRepository.findOne({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        id,
      },
      relations: ['tags'],
    });

    if (entity == null) {
      return null;
    }

    return ActionEntity.toEgressType(entity);
  }

  async findByThreadId(context: ServiceContext, threadId: string): Promise<Action | null> {
    const entity = await this.actionRepository.findOne({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        threadId,
      },
      relations: ['tags'],
    });

    if (entity == null) {
      return null;
    }

    return ActionEntity.toEgressType(entity);
  }

  /**
   * Find actions for the feed display.
   * Returns up to `limit` actions, prioritizing unseen ones.
   * If there are fewer unseen actions than the limit, fills with random seen actions.
   */
  async findForFeed(context: ServiceContext, limit: number = 5): Promise<Action[]> {
    // First, get unseen actions (metadata->>'seen' = 'false' or metadata is null/empty)
    const unseenEntities = await this.actionRepository
      .createQueryBuilder('action')
      .leftJoinAndSelect('action.tags', 'tags')
      .where(context.userId !== SYSTEM_USER ? 'action.user_id = :userId' : '1=1', { userId: context.userId })
      .andWhere("(action.metadata->>'seen' = 'false' OR action.metadata->>'seen' IS NULL)")
      .orderBy('action.created_at', 'DESC')
      .take(limit)
      .getMany();

    const results = unseenEntities.map((entity) => ActionEntity.toEgressType(entity));

    // If we have enough unseen actions, return them
    if (results.length >= limit) {
      return results;
    }

    // Otherwise, fill with random seen actions
    const remaining = limit - results.length;
    const unseenIds = results.map((a) => a.id);

    const seenQuery = this.actionRepository
      .createQueryBuilder('action')
      .leftJoinAndSelect('action.tags', 'tags')
      .where(context.userId !== SYSTEM_USER ? 'action.user_id = :userId' : '1=1', { userId: context.userId })
      .andWhere("action.metadata->>'seen' = 'true'");

    if (unseenIds.length > 0) {
      seenQuery.andWhere('action.id NOT IN (:...unseenIds)', { unseenIds });
    }

    const seenEntities = await seenQuery.orderBy('RANDOM()').take(remaining).getMany();

    const seenActions = seenEntities.map((entity) => ActionEntity.toEgressType(entity));

    return [...results, ...seenActions];
  }

  /**
   * Mark an action as seen.
   */
  async markAsSeen(context: ServiceContext, id: string): Promise<Action | null> {
    const entity = await this.actionRepository.findOne({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        id,
      },
      relations: ['tags'],
    });

    if (entity == null) {
      return null;
    }

    // Update metadata to mark as seen
    entity.metadata = {
      ...entity.metadata,
      seen: true,
    };

    const updated = await this.actionRepository.save(entity);

    return ActionEntity.toEgressType(updated);
  }
}

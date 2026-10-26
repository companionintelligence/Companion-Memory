import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';

import { type Action, ActionEntity } from '../entities/ActionEntity';
import { ActionCreatedEvent } from '../events';
import type { CreateActionDto } from '../types';

@Injectable()
export class ActionService {
  constructor(
    @InjectRepository(ActionEntity)
    private readonly actionRepository: Repository<ActionEntity>,
    private readonly eventService: EventService,
  ) {}

  async create(context: UserServiceContext, data: CreateActionDto): Promise<Action> {
    const id = data.id ?? uuidv7();

    const instance = await this.actionRepository.create({
      id,
      title: data.title,
      text: data.text,
      imageUrl: data.imageUrl,
      priority: data.priority,
      seen: data.seen ?? false,
      dismissed: data.dismissed ?? false,
      source: data.source ?? 'legacy',
      metadata: data.metadata ?? {},
      ...(data.threadId ? { thread: { id: data.threadId } } : {}),
      user: {
        id: context.userId,
      },
    });

    const entity = await this.actionRepository.save(instance);

    await this.eventService.send(ActionCreatedEvent, {
      actionId: entity.id,
      userId: context.userId,
    });

    return ActionEntity.toEgressType(entity);
  }

  /**
   * Anomaly + suggestion actions created on the caller's local calendar day.
   * Shared Brief producer cap — engines refuse enqueue at 3.
   */
  async countDerivedOnLocalDay(
    context: UserServiceContext,
    localDayIso: string,
    timezone: string,
  ): Promise<number> {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const entities = await this.actionRepository.find({
      where: {
        user: { id: context.userId },
        source: In(['anomaly', 'suggestion']),
        createdAt: MoreThanOrEqual(since),
      },
    });

    return entities.filter((row) => localCalendarDay(row.createdAt, timezone) === localDayIso).length;
  }

  async findAll(context: ServiceContext, options: { source?: string | string[] } = {}): Promise<Action[]> {
    const sources =
      options.source === undefined
        ? undefined
        : Array.isArray(options.source)
          ? options.source
          : [options.source];

    const entities = await this.actionRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        ...(sources ? { source: In(sources) } : {}),
      },
      order: {
        priority: 'asc',
      },
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
    });

    if (entity == null) {
      return null;
    }

    return ActionEntity.toEgressType(entity);
  }

  /**
   * Find actions for the feed display.
   * Returns up to `limit` actions, prioritizing unseen ones.
   * If there are fewer unseen actions than the limit, fills with seen actions.
   */
  async findForFeed(context: ServiceContext, limit: number = 5): Promise<Action[]> {
    // First, get unseen actions that are not dismissed.
    const unseenEntities = await this.actionRepository
      .createQueryBuilder('action')
      .where(context.userId !== SYSTEM_USER ? 'action.user_id = :userId' : '1=1', { userId: context.userId })
      .andWhere('action.dismissed = false')
      .andWhere('action.seen = false')
      .orderBy('action.created_at', 'DESC')
      .take(limit)
      .getMany();

    const results = unseenEntities.map((entity) => ActionEntity.toEgressType(entity));

    // If we have enough unseen actions, return them
    if (results.length >= limit) {
      return results;
    }

    // Otherwise, fill with seen actions that are not dismissed.
    const remaining = limit - results.length;
    const unseenIds = results.map((a) => a.id);

    const seenQuery = this.actionRepository
      .createQueryBuilder('action')
      .where(context.userId !== SYSTEM_USER ? 'action.user_id = :userId' : '1=1', { userId: context.userId })
      .andWhere('action.dismissed = false')
      .andWhere('action.seen = true');

    if (unseenIds.length > 0) {
      seenQuery.andWhere('action.id NOT IN (:...unseenIds)', { unseenIds });
    }

    const seenEntities = await seenQuery.orderBy('action.created_at', 'DESC').take(remaining).getMany();

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
    });

    if (entity == null) {
      return null;
    }

    // Update metadata to mark as seen for compatibility with existing consumers.
    entity.metadata = {
      ...entity.metadata,
      seen: true,
    };
    entity.seen = true;

    const updated = await this.actionRepository.save(entity);

    return ActionEntity.toEgressType(updated);
  }

  /**
   * Point an action at the chat thread opened about it, when it has none.
   *
   * The Today window chats about an action by continuing `action.threadId`.
   * Actions the engines derive (Confirm home, metric suggestions) are created
   * without a thread, so the first turn about one starts a new thread; linking
   * it here is what makes the next visit continue that conversation. An action
   * that already has a thread keeps it.
   */
  async attachThread(context: UserServiceContext, id: string, threadId: string): Promise<boolean> {
    const result = await this.actionRepository
      .createQueryBuilder()
      .update(ActionEntity)
      .set({ threadId })
      .where('id = :id', { id })
      .andWhere('user_id = :userId', { userId: context.userId })
      .andWhere('thread_id IS NULL')
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /**
   * Mark an action as dismissed.
   */
  async markAsDismissed(context: ServiceContext, id: string): Promise<Action | null> {
    const entity = await this.actionRepository.findOne({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        id,
      },
    });

    if (entity == null) {
      return null;
    }

    entity.dismissed = true;

    const updated = await this.actionRepository.save(entity);

    return ActionEntity.toEgressType(updated);
  }
}

function localCalendarDay(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

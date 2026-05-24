import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { SYSTEM_USER, type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';

import { ThreadEntity, type Thread } from '../entities/ThreadEntity';
import { ThreadCreatedEvent, ThreadUpdatedEvent, ThreadRemovedEvent } from '../events';
import type { CreateThreadDto, UpdateThreadDto } from '../types';

import { MessageService } from './MessageService';

@Injectable()
export class ThreadService {
  constructor(
    @InjectRepository(ThreadEntity)
    private readonly threadRepository: Repository<ThreadEntity>,
    private readonly messageService: MessageService,
    private readonly eventService: EventService,
  ) {}

  async create(context: UserServiceContext, data: CreateThreadDto): Promise<Thread> {
    const id = data.id ?? uuid7();

    const instance = this.threadRepository.create({
      ...data,
      id,
      user: {
        id: context.userId,
      },
    });

    const entity = await this.threadRepository.save(instance);

    await this.eventService.send(ThreadCreatedEvent, {
      threadId: entity.id,
    });

    return ThreadEntity.toEgressType(entity);
  }

  async findAll(context: ServiceContext): Promise<Thread[]> {
    const entities = await this.threadRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        isArchived: false,
      },
      order: {
        updatedAt: 'DESC',
      },
      relations: ['user'],
    });

    return entities.map((entity) => ThreadEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Thread | null)[]> {
    const entities = await this.threadRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        isArchived: false,
      },
      relations: ['user'],
    });

    const map = new Map(entities.map((entity) => [entity.id, ThreadEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<Thread | null> {
    const result = await this.threadRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        isArchived: false,
      },
      relations: ['user'],
    });

    if (result == null) {
      return null;
    }

    return ThreadEntity.toEgressType(result);
  }

  exists(context: ServiceContext, id: string): Promise<boolean> {
    return this.threadRepository.exists({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        isArchived: false,
      },
    });
  }

  async update(context: ServiceContext, id: string, data: UpdateThreadDto): Promise<Thread | null> {
    const result = await this.threadRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        isArchived: false,
      },
      data,
    );

    if (result.affected === 0) {
      return null;
    }

    await this.eventService.send(ThreadUpdatedEvent, {
      threadId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.threadRepository.delete({
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

    await this.eventService.send(ThreadRemovedEvent, {
      threadId: id,
    });

    return true;
  }

  async softRemove(context: ServiceContext, id: string): Promise<boolean> {
    // Update is_archived instead of using TypeORM's softDelete
    const result = await this.threadRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      {
        isArchived: true,
      },
    );

    if (result.affected === 0) {
      return false;
    }

    await this.eventService.send(ThreadRemovedEvent, {
      threadId: id,
    });

    // We should not be doing this here, this is a MessageService concern.
    // Consider this an anti-pattern, hence why the thread deleted event is
    // emitted before this happens. We can circle back to fix this.
    const messages = await this.messageService.findByThreadId(context, id);

    await Promise.all(messages.map((message) => this.messageService.softRemove(context, message.id)));

    return true;
  }
}

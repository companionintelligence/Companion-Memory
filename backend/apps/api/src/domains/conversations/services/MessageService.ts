import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type ServiceContext, type UserServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EventService } from '@ci/domains/events';
import { FileService } from '@ci/domains/files';

import { MessageEntity, type Message } from '../entities/MessageEntity';
import { MessageCreatedEvent, MessageUpdatedEvent, MessageDeletedEvent } from '../events';
import type { CreateMessageDto, UpdateMessageDto } from '../types';

@Injectable()
export class MessageService {
  constructor(
    @InjectRepository(MessageEntity)
    private readonly messageRepository: Repository<MessageEntity>,
    private readonly fileService: FileService,
    private readonly eventService: EventService,
  ) {}

  async create(context: UserServiceContext, data: CreateMessageDto): Promise<Message> {
    const { threadId, content, toolCalls, promptMessageId, fileIds, ...rest } = data;

    const id = data.id ?? uuid7();

    const instance = this.messageRepository.create({
      ...rest,
      id,
      content,
      toolCalls: toolCalls,
      user: {
        id: context.userId,
      },
      thread: {
        id: threadId,
      },
      promptMessage: {
        id: promptMessageId,
      },
    });

    const entity = await this.messageRepository.save(instance);

    // Link files to this message if provided
    if (fileIds && fileIds.length > 0) {
      const files = (await this.fileService.findByIds(context, fileIds)).filter((entity) => entity != null);

      if (files.length > 0) {
        await this.messageRepository
          .createQueryBuilder()
          .relation(MessageEntity, 'files')
          .of(entity.id)
          .add(files.map((file) => file.id));
      }
    }

    await this.eventService.send(MessageCreatedEvent, {
      messageId: entity.id,
    });

    return MessageEntity.toEgressType(entity);
  }

  async findAll(context: ServiceContext): Promise<Message[]> {
    const entities = await this.messageRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        canceled: false,
      },
      relations: ['files'],
    });

    return entities.map((entity) => MessageEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Message | null)[]> {
    const entities = await this.messageRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        canceled: false,
      },
      relations: ['files'],
    });

    const map = new Map(entities.map((entity) => [entity.id, MessageEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<Message | null> {
    const entity = await this.messageRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        canceled: false,
      },
      relations: ['files'],
    });

    if (entity == null) {
      return null;
    }

    return MessageEntity.toEgressType(entity);
  }

  exists(context: ServiceContext, id: string): Promise<boolean> {
    return this.messageRepository.exists({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        canceled: false,
      },
    });
  }

  /**
   * Yields a collection of Messages associated with a given Thread id.
   *
   * This method assumes the context user has access to the corresponding
   * Thread. This access must be ensured before safely calling this method.
   */
  async findByThreadId(context: ServiceContext, threadId: string): Promise<Message[]> {
    const entities = await this.messageRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        thread: {
          id: threadId,
        },
        canceled: false,
      },
      relations: ['files'],
      order: {
        id: 'asc',
      },
    });

    return entities.map((entity) => MessageEntity.toEgressType(entity));
  }

  /**
   * Yields a collection of Message arrays each associated with a provided
   * Thread id.
   *
   * This method assumes the context user has access to the corresponding
   * Threads. This access must be ensured before safely calling this method.
   */
  async findByThreadIds(context: ServiceContext, threadIds: string[]): Promise<Map<string, Message[]>> {
    if (threadIds.length === 0) {
      return new Map();
    }

    const entities = await this.messageRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        thread: {
          id: In(threadIds),
        },
        canceled: false,
      },
    });

    const messagesByThread = new Map<string, Message[]>();

    threadIds.forEach((threadId) => {
      messagesByThread.set(threadId, []);
    });

    entities.forEach((entity) => {
      const threadId = entity.threadId;

      if (threadId) {
        const messages = messagesByThread.get(threadId) || [];

        messages.push(MessageEntity.toEgressType(entity));

        messagesByThread.set(threadId, messages);
      }
    });

    return messagesByThread;
  }

  async update(context: ServiceContext, id: string, data: UpdateMessageDto): Promise<Message | null> {
    const result = await this.messageRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
        canceled: false,
      },
      data,
    );

    if (result.affected === 0) {
      return null;
    }

    this.eventService.send(MessageUpdatedEvent, {
      messageId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.messageRepository.delete({
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

    this.eventService.send(MessageDeletedEvent, {
      messageId: id,
    });

    return true;
  }

  async softRemove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.messageRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      {
        canceled: true,
      },
    );

    if (result.affected === 0) {
      return false;
    }

    this.eventService.send(MessageDeletedEvent, {
      messageId: id,
    });

    return true;
  }
}

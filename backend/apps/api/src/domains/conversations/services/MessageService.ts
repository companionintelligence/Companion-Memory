import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { RequestContext } from '@ci/common/types';

import { MessageEntity } from '../entities/MessageEntity';
import type { CreateMessageDto, Message, UpdateMessageDto } from '../types';

@Injectable()
export class MessageService {
  constructor(
    @InjectRepository(MessageEntity)
    private readonly messsageRepository: Repository<MessageEntity>,
  ) {}

  async create(context: RequestContext, data: CreateMessageDto): Promise<Message> {
    const { threadId, content, toolCalls, promptMessageId, ...rest } = data;

    const instance = this.messsageRepository.create({
      ...rest,
      id: uuid7(),
      text: content,
      tool_calls: toolCalls,
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

    const entity = await this.messsageRepository.save(instance);

    return entity.toMessage();
  }

  exists(context: RequestContext, id: string): Promise<boolean> {
    return this.messsageRepository.exists({
      where: {
        id,
        user: {
          id: context.userId,
        },
      },
    });
  }

  async findAll(context: RequestContext): Promise<Message[]> {
    const entities = await this.messsageRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
    });

    return entities.map((entity) => entity.toMessage());
  }

  async findByThread(context: RequestContext, threadId: string): Promise<Message[]> {
    const entities = await this.messsageRepository.find({
      where: {
        user: {
          id: context.userId,
        },
        thread: {
          id: threadId,
        },
      },
      order: {
        id: 'asc',
      },
    });

    return entities.map((entity) => entity.toMessage());
  }

  async findOne(context: RequestContext, id: string): Promise<Message> {
    const entity = await this.messsageRepository.findOne({
      where: {
        id,
        user: {
          id: context.userId,
        },
      },
    });

    if (entity == null) {
      throw new NotFoundException();
    }

    return entity.toMessage();
  }

  async update(context: RequestContext, id: string, data: UpdateMessageDto): Promise<boolean> {
    const result = await this.messsageRepository.update(
      {
        id,
        user: {
          id: context.userId,
        },
      },
      data,
    );

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return true;
  }

  async softDelete(context: RequestContext, id: string): Promise<boolean> {
    const exists = await this.exists(context, id);

    if (!exists) {
      throw new NotFoundException();
    }

    const result = await this.messsageRepository.softDelete({
      id,
      user: {
        id: context.userId,
      },
    });

    // The likelihood of this triggering is essentially 0%,
    // but we're still coding defensively.
    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return true;
  }

  async delete(context: RequestContext, id: string): Promise<boolean> {
    const result = await this.messsageRepository.delete({
      id,
      user: {
        id: context.userId,
      },
    });

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return true;
  }
}

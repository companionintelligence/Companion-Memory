import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { RequestContext } from '@ci/common/types';

import { MessageEntity } from '../entities/MessageEntity';
import { ThreadEntity } from '../entities/ThreadEntity';
import type { CreateThreadDto, Thread, UpdateThreadDto } from '../types';

@Injectable()
export class ThreadService {
  constructor(
    @InjectRepository(MessageEntity)
    private readonly messageRepository: Repository<MessageEntity>,
    @InjectRepository(ThreadEntity)
    private readonly threadRepository: Repository<ThreadEntity>,
  ) {}

  async create(context: RequestContext, data: CreateThreadDto): Promise<Thread> {
    const instance = this.threadRepository.create({
      ...data,
      id: uuid7(),
      user: {
        id: context.userId,
      },
    });

    const entity = await this.threadRepository.save(instance);

    return entity.toThread();
  }

  exists(context: RequestContext, id: string): Promise<boolean> {
    return this.threadRepository.exists({
      where: {
        id,
        user: {
          id: context.userId,
        },
      },
    });
  }

  async findAll(context: RequestContext): Promise<Thread[]> {
    const entities = await this.threadRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
    });

    return entities.map((entity) => entity.toThread());
  }

  async findOne(context: RequestContext, id: string): Promise<Thread> {
    const result = await this.threadRepository.findOne({
      where: {
        id,
        user: {
          id: context.userId,
        },
      },
    });

    if (result == null) {
      throw new NotFoundException();
    }

    return result.toThread();
  }

  async update(context: RequestContext, id: string, data: UpdateThreadDto): Promise<boolean> {
    const result = await this.threadRepository.update(
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

    const result = await this.threadRepository.softDelete({
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

    await this.messageRepository.softDelete({
      user: {
        id: context.userId,
      },
      thread: {
        id,
      },
    });

    return true;
  }

  async delete(context: RequestContext, id: string): Promise<boolean> {
    const result = await this.threadRepository.delete({
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

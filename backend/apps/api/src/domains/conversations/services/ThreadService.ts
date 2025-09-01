import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { RequestContext } from '@ci/common/types';
import { FileEntity } from '@ci/domains/files';

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
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
  ) {}

  async create(context: RequestContext, data: CreateThreadDto): Promise<Thread> {
    const { files: fileIds, ...threadData } = data;

    const instance = this.threadRepository.create({
      ...threadData,
      id: uuid7(),
      user: {
        id: context.userId,
      },
    });

    if (fileIds && fileIds.length > 0) {
      // Load the file entities to establish the relationship
      const files = await this.fileRepository.find({
        where: fileIds.map((file) => ({ id: file.id })),
      });
      instance.files = files;
    }

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
      relations: ['files'],
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
      relations: ['files'],
    });

    if (result == null) {
      throw new NotFoundException();
    }

    return result.toThread();
  }

  async update(context: RequestContext, id: string, data: UpdateThreadDto): Promise<boolean> {
    const { files: fileIds, ...updateData } = data;

    // First, update the basic thread properties
    if (Object.keys(updateData).length > 0) {
      const result = await this.threadRepository.update(
        {
          id,
          user: {
            id: context.userId,
          },
        },
        updateData,
      );

      if (result.affected === 0) {
        throw new NotFoundException();
      }
    }

    // If files are being updated, handle the relationship
    if (fileIds !== undefined) {
      const thread = await this.threadRepository.findOne({
        where: {
          id,
          user: {
            id: context.userId,
          },
        },
        relations: ['files'],
      });

      if (!thread) {
        throw new NotFoundException();
      }

      if (fileIds.length > 0) {
        const files = await this.fileRepository.find({
          where: fileIds.map((file) => ({ id: file.id })),
        });
        thread.files = files;
      } else {
        thread.files = [];
      }

      await this.threadRepository.save(thread);
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

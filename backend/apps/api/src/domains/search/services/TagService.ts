import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/types';

import { TagEntity } from '../entities/TagEntity';
import { CreateTagDto, Tag, UpdateTagDto } from '../types';

@Injectable()
export class TagService {
  constructor(
    @InjectRepository(TagEntity)
    private readonly tagRepository: Repository<TagEntity>,
  ) {}

  async create(context: RequestContext, data: CreateTagDto): Promise<Tag> {
    // Check if tag already exists for this user
    if (context.userId) {
      const existingTag = await this.tagRepository.findOne({
        where: {
          label: data.label.toLowerCase(),
          user: { id: context.userId },
        },
      });

      if (existingTag) {
        return this.toTag(existingTag);
      }
    }

    const tag = this.tagRepository.create({
      id: uuidv7(),
      label: data.label,
      user: context.userId ? { id: context.userId } : undefined,
    });

    const result = await this.tagRepository.save(tag);

    return this.toTag(result);
  }

  async findAll(context: RequestContext): Promise<Tag[]> {
    const where = context.userId ? { user: { id: context.userId } } : {};

    const result = await this.tagRepository.find({
      where,
      relations: ['user'],
      order: { created_at: 'DESC' },
    });

    return result.map((entity) => this.toTag(entity));
  }

  async findOne(context: RequestContext, id: string): Promise<Tag | null> {
    const where = context.userId ? { id, user: { id: context.userId } } : { id };

    const result = await this.tagRepository.findOne({
      where,
      relations: ['user'],
    });

    return result ? this.toTag(result) : null;
  }

  async update(context: RequestContext, id: string, data: UpdateTagDto): Promise<Tag | null> {
    const existing = await this.findOne(context, id);
    if (!existing) {
      return null;
    }

    await this.tagRepository.update(id, {
      label: data.label,
    });

    const updated = await this.findOne(context, id);

    return updated;
  }

  async remove(context: RequestContext, id: string): Promise<boolean> {
    const existing = await this.findOne(context, id);
    if (!existing) {
      return false;
    }

    await this.tagRepository.delete(id);

    return true;
  }

  private toTag(entity: TagEntity): Tag {
    return {
      id: entity.id,
      label: entity.label,
      user_id: entity.user?.id || null,
      created_at: entity.created_at,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeleteResult, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { RequestContext } from '@ci/common/types';
import { ContentEntity } from '@ci/domains/memory';

import { CreateContentDto, UpdateContentDto, Content } from '../types';

@Injectable()
export class ContentService {
  constructor(
    @InjectRepository(ContentEntity)
    private readonly contentRepository: Repository<ContentEntity>,
  ) {}

  async create(data: CreateContentDto): Promise<Content> {
    const content = this.contentRepository.create({
      ...data,
      id: uuidv7(),
    });

    const contentResult = await this.contentRepository.save(content);

    await this.contentRepository.update(contentResult.id, {
      external_id: `content_${contentResult.id}`,
    });

    return (await this.contentRepository.findOne({
      where: {
        id: contentResult.id,
      },
    }))!.toContent();
  }

  async findAll(context: RequestContext): Promise<Content[]> {
    const result = await this.contentRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
    });

    return result.map((entity) => entity.toContent());
  }

  async findOne(context: RequestContext, id: string): Promise<Content | null> {
    const result = await this.contentRepository.findOne({
      where: {
        id,
        user: {
          id: context.userId,
        },
      },
    });

    return result?.toContent() ?? null;
  }

  async update(context: RequestContext, id: string, data: UpdateContentDto): Promise<Content | null> {
    await this.contentRepository.update(id, data);

    return this.findOne(context, id);
  }

  remove(id: string): Promise<DeleteResult> {
    return this.contentRepository.delete(id);
  }
}

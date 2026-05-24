import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';
import { ContentCreatedEvent, ContentRemovedEvent, ContentUpdatedEvent } from '@ci/domains/memory/events';

import { Content, ContentEntity } from '../entities/ContentEntity';
import { CreateContentDto, SearchContentDto, UpdateContentDto } from '../types';

@Injectable()
export class ContentService {
  constructor(
    @InjectRepository(ContentEntity)
    private readonly contentRepository: Repository<ContentEntity>,
    private readonly eventService: EventService,
  ) {}

  async create(context: UserServiceContext, data: CreateContentDto | CreateContentDto[]): Promise<Content[]> {
    const isSingle = !Array.isArray(data);
    const dataArray: CreateContentDto[] = isSingle ? [data] : data;

    // TODO: Some of these can fail, we need to return partial success here?
    return Promise.all(
      dataArray.map(async (item) => {
        const id = item.id ?? uuidv7();

        const content = await this.contentRepository.create({
          ...item,
          id,
          externalId: item.external_id ?? undefined,
          sourceUrl: item.source_url ?? undefined,
          sourceData: item.source_data ?? undefined,
          user: {
            id: context.userId,
          },
        });

        const contentResult = await this.contentRepository.save(content);

        await this.eventService.send(ContentCreatedEvent, {
          contentId: contentResult.id,
        });

        return ContentEntity.toEgressType(contentResult);
      }),
    );
  }

  async findAll(context: UserServiceContext): Promise<Content[]> {
    const result = await this.contentRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
      relations: ['user'],
    });

    return result.map((entity) => ContentEntity.toEgressType(entity));
  }

  async findById(context: ServiceContext, id: string): Promise<Content | null> {
    const result = await this.contentRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      relations: ['user'],
    });

    return result ? ContentEntity.toEgressType(result) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Content | null)[]> {
    const result = await this.contentRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
      relations: ['user'],
    });

    const map = new Map(result.map((content) => [content.id, ContentEntity.toEgressType(content)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async update(context: ServiceContext, id: string, data: UpdateContentDto): Promise<Content | null> {
    const updateData: Partial<ContentEntity> = {};

    if (data.type !== undefined) {
      updateData.type = data.type;
    }

    if (data.title !== undefined) {
      updateData.title = data.title;
    }

    if (data.text !== undefined) {
      updateData.text = data.text;
    }

    if (data.url !== undefined) {
      updateData.url = data.url;
    }

    if (data.mimetype !== undefined) {
      updateData.mimetype = data.mimetype;
    }

    if (data.external_id !== undefined) {
      updateData.externalId = data.external_id;
    }

    if (data.source_url !== undefined) {
      updateData.sourceUrl = data.source_url;
    }

    const content = await this.contentRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          user: {
            id: context.userId,
          },
        }),
      },
    });

    if (content) {
      Object.assign(content, updateData);
      await this.contentRepository.save(content);
    } else {
      return null;
    }

    await this.eventService.send(ContentUpdatedEvent, {
      contentId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const content = await this.contentRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      },
    });

    if (!content) {
      return false;
    }

    await this.contentRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        user: { id: context.userId },
      }),
    });

    await this.eventService.send(ContentRemovedEvent, {
      contentId: id,
    });

    return true;
  }

  async search(context: ServiceContext, filters: SearchContentDto): Promise<Content[]> {
    const whereClause: Record<string, unknown> = {
      ...(context.userId !== SYSTEM_USER && {
        user: {
          id: context.userId,
        },
      }),
    };

    if (filters.type !== undefined) {
      whereClause.type = filters.type;
    }

    if (filters.title !== undefined) {
      whereClause.title = filters.title;
    }

    if (filters.text !== undefined) {
      whereClause.text = filters.text;
    }

    if (filters.url !== undefined) {
      whereClause.url = filters.url;
    }

    if (filters.mimetype !== undefined) {
      whereClause.mimetype = filters.mimetype;
    }

    if (filters.external_id !== undefined) {
      whereClause.externalId = filters.external_id;
    }

    if (filters.source_url !== undefined) {
      whereClause.sourceUrl = filters.source_url;
    }

    const entities = await this.contentRepository.find({
      where: whereClause,
      relations: ['user'],
    });

    return entities.map((entity) => ContentEntity.toEgressType(entity));
  }
}

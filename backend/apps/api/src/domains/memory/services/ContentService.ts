import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository, type FindOptionsWhere } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { isUniqueViolation } from '@ci/common/constants';
import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';
import { EventService } from '@ci/domains/events';
import { ContentCreatedEvent, ContentRemovedEvent, ContentUpdatedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { Content, ContentEntity } from '../entities/ContentEntity';
import { EventEntity } from '../entities/EventEntity';
import { CreateContentDto, SearchContentDto, UpdateContentDto } from '../types';

@Injectable()
export class ContentService {
  constructor(
    @InjectRepository(ContentEntity)
    private readonly contentRepository: Repository<ContentEntity>,
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
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
          sourceType: item.source_type ?? undefined,
          sourceSystem: item.source_system ?? undefined,
          sourceId: item.source_id ?? undefined,
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

  /**
   * Batch, idempotent content ingest for the importer. Each item dedupes on the
   * provenance triple (user_id, source_type, source_system, source_id) — like
   * EventService.create / ItemService.createMany — so a re-sync returns the
   * existing row instead of inserting a duplicate. Paired with the
   * content_source_triple_uniq partial unique index, which also catches a lost
   * insert race (23505).
   *
   * Event link: an explicit `event.id` (e.g. the id returned by createEvent)
   * wins. Otherwise, when the item carries a source triple, the matching event in
   * ci.events with the SAME (user_id, source_type, source_system, source_id) is
   * found and content.event_id is set to it, so a content row pushed with the same
   * provenance as its event auto-links. If nothing matches, event_id stays null.
   *
   * Returns the created-or-existing rows in input order.
   */
  async createMany(context: UserServiceContext, data: CreateContentDto[]): Promise<Content[]> {
    return Promise.all(
      data.map(async (item) => {
        // Idempotency: when the triple is present, return the existing row.
        const sourceWhere: FindOptionsWhere<ContentEntity> | null =
          item.source_type && item.source_id
            ? {
                userId: context.userId,
                sourceType: item.source_type,
                sourceSystem: item.source_system ?? IsNull(),
                sourceId: item.source_id,
              }
            : null;

        if (sourceWhere) {
          const existing = await this.contentRepository.findOne({ where: sourceWhere });
          if (existing) {
            return ContentEntity.toEgressType(existing);
          }
        }

        // Resolve the event link: explicit event wins; otherwise auto-link by the
        // shared provenance triple.
        const event = item.event ?? (await this.resolveEventByTriple(context, item));

        try {
          const [created] = await this.create(context, {
            ...item,
            event,
          });

          return created;
        } catch (err) {
          // Lost a race to a concurrent insert of the same triple (the partial-
          // unique index raised 23505) — fetch and return the winner.
          if (sourceWhere && isUniqueViolation(err)) {
            const existing = await this.contentRepository.findOne({ where: sourceWhere });
            if (existing) {
              return ContentEntity.toEgressType(existing);
            }
          }

          throw err;
        }
      }),
    );
  }

  /**
   * Find the event sharing this content's provenance triple, scoped to the same
   * user. Returns the `{ id }` relation shape ContentService.create expects, or
   * undefined when no triple is present or no event matches.
   */
  private async resolveEventByTriple(
    context: UserServiceContext,
    item: CreateContentDto,
  ): Promise<{ id: string } | undefined> {
    if (!item.source_type || !item.source_id) {
      return undefined;
    }

    const event = await this.eventRepository.findOne({
      where: {
        userId: context.userId,
        sourceType: item.source_type,
        sourceSystem: item.source_system ?? IsNull(),
        sourceId: item.source_id,
      },
      select: { id: true },
    });

    return event ? { id: event.id } : undefined;
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

  /**
   * Lightweight identifiers for the most-recent content, for the unified
   * search/explorer feed. Full entities are batch-resolved downstream.
   */
  async getEntitiesForContents(
    context: ServiceContext,
    options: { limit?: number; startTime?: Date; endTime?: Date; order?: 'ASC' | 'DESC' } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.contentRepository
      .createQueryBuilder('content')
      .select('content.id', 'id')
      .where('content.user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('content.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('content.created_at <= :endTime', { endTime: options.endTime });
    }

    query = query.orderBy('content.created_at', options.order ?? 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'content' as IndexableEntity }));
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

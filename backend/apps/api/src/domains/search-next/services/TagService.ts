import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, type DeleteResult, type UpdateResult } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';

import { type EntityTag, EntityTagEntity } from '../entities/EntityTagEntity';
import { type Tag, TagEntity, TimestampedTag } from '../entities/TagEntity';
import type { CreateTagDto, EntityIdentifier, TaggableEntity, TagEntitiesDto, UpdateTagDto } from '../types';

type RemovalOpts = {
  soft?: boolean;
};

type FindOpts = {
  includeEntities?: boolean;
};

@Injectable()
export class TagService {
  constructor(
    @InjectRepository(TagEntity)
    private readonly tagRepository: Repository<TagEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async create(context: ServiceContext, data: CreateTagDto): Promise<Tag> {
    const id = data.id ?? uuid7();

    const label = this.validateLabel(data.label);

    if (context.userId === SYSTEM_USER && data.forUserId == null) {
      throw new Error('System user cannot create a tag without a forUserId specified');
    }

    if (context.userId !== SYSTEM_USER && data.forUserId != null && data.forUserId !== context.userId) {
      throw new Error('Cannot create a tag for another user');
    }

    const userId = context.userId === SYSTEM_USER ? data.forUserId : context.userId;

    const instance = this.tagRepository.create({
      id,
      label,
      description: data.description,
      userId,
    });

    const entity = await this.tagRepository.save(instance);

    return TagEntity.toEgressType(entity);
  }

  async findAll(context: ServiceContext): Promise<Tag[]> {
    const entities = await this.tagRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return entities.map((entity) => TagEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Tag | null)[]> {
    const entities = await this.tagRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const map = new Map(entities.map((entity) => [entity.id, TagEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string, opts: FindOpts = {}): Promise<Tag | null> {
    const { includeEntities = false } = opts;

    const entity = await this.tagRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      relations: includeEntities ? ['entities'] : [],
    });

    return entity ? TagEntity.toEgressType(entity) : null;
  }

  async findByLabel(context: UserServiceContext, label: string, opts: FindOpts = {}): Promise<Tag | null> {
    const { includeEntities = false } = opts;

    // Tags are unique by (label, userId). Searching for label as the system
    // user would change the contract of this method, so we're enforcing that a
    // non-system user context is used.

    const entity = await this.tagRepository.findOne({
      where: {
        label,
        userId: context.userId,
      },
      relations: includeEntities ? ['entities'] : [],
    });

    return entity ? TagEntity.toEgressType(entity) : null;
  }

  /**
   * Substring-match the user's tag labels for search suggestions. Prefix
   * matches rank ahead of mid-label matches, ties break alphabetically. Like
   * findByLabel, this is a per-user vocabulary lookup so a non-system context
   * is required.
   */
  async searchByLabel(context: UserServiceContext, query: string, limit = 5): Promise<Tag[]> {
    const trimmed = query.trim().toLowerCase();

    if (trimmed.length === 0) {
      return [];
    }

    // Escape LIKE metacharacters so a literal % or _ in the query can't widen the match.
    const escaped = trimmed.replace(/[\\%_]/g, '\\$&');

    const entities = await this.tagRepository
      .createQueryBuilder('t')
      .where('t.user_id = :userId', { userId: context.userId })
      .andWhere('t.deleted_at IS NULL')
      .andWhere('t.label ILIKE :contains', { contains: `%${escaped}%` })
      .orderBy('t.label ILIKE :prefix', 'DESC')
      .addOrderBy('t.label', 'ASC')
      .setParameter('prefix', `${escaped}%`)
      .limit(limit)
      .getMany();

    return entities.map((entity) => TagEntity.toEgressType(entity));
  }

  async update(context: ServiceContext, id: string, data: UpdateTagDto): Promise<Tag | null> {
    const label = this.validateLabel(data.label);

    const result = await this.tagRepository.update(
      {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      {
        ...data,
        label,
      },
    );

    if (result.affected === 0) {
      return null;
    }

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string, opts: RemovalOpts = {}): Promise<boolean> {
    const { soft = true } = opts;

    let result: DeleteResult | UpdateResult;

    const args = {
      id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    };

    if (soft) {
      result = await this.tagRepository.softDelete(args);
    } else {
      result = await this.tagRepository.delete(args);
    }

    if (result.affected === 0) {
      return false;
    }

    return true;
  }

  async tagEntities(context: ServiceContext, data: TagEntitiesDto): Promise<boolean> {
    const labels = data.labels.map((label) => this.validateLabel(label));

    if (context.userId === SYSTEM_USER && data.forUserId == null) {
      throw new Error('System user cannot tag entities without a forUserId specified');
    }

    if (context.userId !== SYSTEM_USER && data.forUserId != null && data.forUserId !== context.userId) {
      throw new Error('Cannot tag entities for another user');
    }

    const userId = context.userId === SYSTEM_USER ? data.forUserId : context.userId;

    return this.dataSource.transaction(async (manager) => {
      const tagRepository = manager.getRepository(TagEntity);
      const entityTagRepository = manager.getRepository(EntityTagEntity);

      for (const label of labels) {
        let tagEntity = await tagRepository.findOne({
          where: {
            label,
            userId: userId,
          },
        });

        if (tagEntity == null) {
          const instance = tagRepository.create({
            id: uuid7(),
            label,
            userId,
          });

          tagEntity = await tagRepository.save(instance);
        }

        for (const entity of data.entities) {
          await entityTagRepository
            .createQueryBuilder()
            .insert()
            .values({
              tagId: tagEntity.id,
              entityType: entity.type,
              entityId: entity.id,
            })
            .orIgnore()
            .execute();
        }
      }

      return true;
    });
  }

  async untagEntities(context: ServiceContext, data: TagEntitiesDto): Promise<boolean> {
    const labels = data.labels.map((label) => this.validateLabel(label));

    if (context.userId === SYSTEM_USER && data.forUserId == null) {
      throw new Error('System user cannot untag entities without a forUserId specified');
    }

    if (context.userId !== SYSTEM_USER && data.forUserId != null && data.forUserId !== context.userId) {
      throw new Error('Cannot untag entities for another user');
    }

    const userId = context.userId === SYSTEM_USER ? data.forUserId : context.userId;

    return this.dataSource.transaction(async (manager) => {
      const tagRepository = manager.getRepository(TagEntity);
      const entityTagRepository = manager.getRepository(EntityTagEntity);

      for (const label of labels) {
        const tagEntity = await tagRepository.findOne({
          where: {
            label,
            userId: userId,
          },
        });

        if (tagEntity == null) {
          continue;
        }

        for (const entity of data.entities) {
          await entityTagRepository.delete({
            tagId: tagEntity.id,
            entityId: entity.id,
            entityType: entity.type,
          });
        }
      }

      return true;
    });
  }

  async getTagsForEntity(
    context: ServiceContext,
    entityId: EntityIdentifier<TaggableEntity>,
  ): Promise<TimestampedTag[]> {
    const { type, id } = entityId;

    const entityTagRepository = this.dataSource.getRepository(EntityTagEntity);

    const query = entityTagRepository
      .createQueryBuilder('et')
      .innerJoinAndSelect('et.tag', 'tag')
      .where('et.entityId = :entityId', { entityId: id })
      .andWhere('et.entityType = :entityType', { entityType: type });

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('tag.userId = :userId', { userId: context.userId });
    }

    const entityTags = await query.getMany();

    return entityTags.map((et) => ({
      id: et.tag!.id,
      label: et.tag!.label,
      taggedAt: et.createdAt,
    }));
  }

  async getTagsForEntities(
    context: ServiceContext,
    entityIds: EntityIdentifier<TaggableEntity>[],
  ): Promise<Map<EntityIdentifier<TaggableEntity>, TimestampedTag[]>> {
    if (entityIds.length === 0) {
      return new Map();
    }

    const entityTagRepository = this.dataSource.getRepository(EntityTagEntity);
    const results = new Map<EntityIdentifier<TaggableEntity>, TimestampedTag[]>();

    const refMap = new Map<string, EntityIdentifier<TaggableEntity>>();
    const byType: Record<string, string[]> = {};

    for (const identifier of entityIds) {
      results.set(identifier, []);

      const compositeKey = `${identifier.type}:${identifier.id}`;

      refMap.set(compositeKey, identifier);

      if (byType[identifier.type] == null) {
        byType[identifier.type] = [];
      }

      byType[identifier.type].push(identifier.id);
    }

    await Promise.all(
      Object.entries(byType).map(async ([rawType, ids]) => {
        const entityType = rawType as TaggableEntity;

        const query = entityTagRepository
          .createQueryBuilder('et')
          .innerJoinAndSelect('et.tag', 'tag')
          .where('et.entityId IN (:...ids)', { ids })
          .andWhere('et.entityType = :entityType', { entityType });

        if (context.userId !== SYSTEM_USER) {
          query.andWhere('tag.userId = :userId', { userId: context.userId });
        }

        const entityTags = await query.getMany();

        for (const et of entityTags) {
          const compositeKey = `${et.entityType}:${et.entityId}`;
          const originalIdentifier = refMap.get(compositeKey);

          if (originalIdentifier) {
            results.get(originalIdentifier)?.push({
              id: et.tag!.id,
              label: et.tag!.label,
              taggedAt: et.createdAt,
            });
          }
        }
      }),
    );

    return results;
  }

  async getEntitiesForTag(context: UserServiceContext, label: string): Promise<EntityTag[]> {
    const tag = await this.findByLabel(context, label, {
      includeEntities: true,
    });

    if (tag == null || tag.entities == null) {
      return [];
    }

    return tag.entities;
  }

  async getEntitiesForTags(
    context: UserServiceContext,
    labels: string[],
  ): Promise<EntityIdentifier<TaggableEntity>[]> {
    const validatedLabels = labels.map((label) => this.validateLabel(label));
    const uniqueLabels = [...new Set(validatedLabels)];

    if (uniqueLabels.length === 0) {
      return [];
    }

    const query = this.dataSource
      .getRepository(EntityTagEntity)
      .createQueryBuilder('et')
      .select(['et.entity_id', 'et.entity_type'])
      .innerJoin(TagEntity, 't', 't.id = et.tag_id')
      .where('t.user_id = :userId', { userId: context.userId })
      .andWhere('t.label IN (:...labels)', { labels: uniqueLabels })
      .groupBy('et.entity_id')
      .addGroupBy('et.entity_type')
      .having('COUNT(DISTINCT t.label) = :count', { count: uniqueLabels.length });

    const results = await query.getRawMany();

    const mappedResults = results.map((row: { entity_id: string; entity_type: TaggableEntity }) => ({
      id: row.entity_id,
      type: row.entity_type,
    }));

    return mappedResults;
  }

  /**
   * The user's most-used tags: each live tag with how many entities carry it,
   * heaviest first. `entity_tag` is unique on (entity_type, entity_id, tag_id),
   * so COUNT(*) per tag is exactly the number of distinct tagged entities.
   * Ties break alphabetically so the ordering is stable across refreshes.
   * Powers the stats page's "Entities by tag" breakdown.
   */
  async getTagUsageCounts(
    context: UserServiceContext,
    limit: number,
  ): Promise<Array<{ label: string; count: number }>> {
    const rows: Array<{ label: string; count: string }> = await this.dataSource
      .getRepository(EntityTagEntity)
      .createQueryBuilder('et')
      .select('t.label', 'label')
      .addSelect('COUNT(*)', 'count')
      .innerJoin(TagEntity, 't', 't.id = et.tag_id')
      .where('t.user_id = :userId', { userId: context.userId })
      .andWhere('t.deleted_at IS NULL')
      .groupBy('t.label')
      .orderBy('count', 'DESC')
      .addOrderBy('t.label', 'ASC')
      .limit(limit)
      .getRawMany();

    return rows.map((row) => ({
      label: row.label,
      count: parseInt(row.count, 10),
    }));
  }

  private validateLabel(label?: string): string {
    const validatedLabel = (label?.trim() || '').toLowerCase();

    if (validatedLabel.length === 0) {
      throw new Error('Tag label cannot be empty');
    }

    return validatedLabel;
  }
}

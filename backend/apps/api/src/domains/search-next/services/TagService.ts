import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, type EntityManager } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER, type UserServiceContext } from '@ci/common/context';

import { CategoryDirectionOptoutEntity } from '../entities/CategoryDirectionOptoutEntity';
import { EntityCategoryEntity } from '../entities/EntityCategoryEntity';
import { type EntityTag, EntityTagEntity } from '../entities/EntityTagEntity';
import { TagCategoryEntity } from '../entities/TagCategoryEntity';
import { TagDirectionEntity } from '../entities/TagDirectionEntity';
import { type Tag, TagEntity, TimestampedTag } from '../entities/TagEntity';
import { TAGGABLE_ENTITY_OWNERSHIP_QUERIES } from '../taggableEntityOwnership';
import {
  TAG_KINDS,
  type CreateTagDto,
  type EntityIdentifier,
  type TagKind,
  type TaggableEntity,
  type TagEntitiesDto,
  type UpdateTagDto,
} from '../types';

type FindOpts = {
  includeEntities?: boolean;
};

/**
 * The most categories a single entity may carry (CI-Planning's `entity_categories`
 * caps this at 3 in the service layer, not in SQL — `setEntityCategories`
 * mirrors that rather than adding a DB constraint nothing else here has).
 */
const ENTITY_CATEGORY_CAP = 3;

/**
 * Shape check only, run before an entity id reaches a `uuid` column: a value
 * that fails it can name no entity, and letting Postgres reject the cast would
 * answer "not yours" with an error instead of a refusal.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UpdateTagResult = {
  /** The surviving tag. On a merge this is the pre-existing target, not the edited one. */
  tag: Tag;
  /** The new label collided with another of the user's tags, so the two were collapsed into one. */
  merged: boolean;
  /** Assignments re-pointed onto the surviving tag. Zero unless `merged`. */
  movedAssignments: number;
  /** The label before the edit, so callers can re-point label-keyed rows (saved searches). */
  previousLabel: string;
};

export type RemoveTagResult = {
  label: string;
  /** `entity_tag` rows dropped with the tag — the number of memories that lose it. */
  removedAssignments: number;
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

  /**
   * Rename a tag and/or re-describe it.
   *
   * Labels are unique per user (`tags_label_user_key`), so renaming onto a
   * label the user already owns cannot be a plain UPDATE — it would come back
   * as a raw unique violation. Instead the two tags are **merged**: the edited
   * tag's assignments are re-pointed onto the tag that already carries the
   * target label, duplicates are dropped, and the now-empty source row is
   * deleted. The surviving tag is the pre-existing target (its id and
   * description are kept), which is what "rename `holiday` to `vacation` when
   * I already have a `vacation`" means in practice.
   *
   * `entity_tag` is keyed on tag id, so a rename that does *not* collide needs
   * no cascade at all. Callers still have to re-point label-keyed rows — saved
   * searches store tag labels, not ids — which is why `previousLabel` comes
   * back in the result.
   *
   * Returns null when the tag does not exist or belongs to another user.
   */
  async update(context: ServiceContext, id: string, data: UpdateTagDto): Promise<UpdateTagResult | null> {
    const scope = this.userScope(context);

    const existing = await this.tagRepository.findOne({ where: { id, ...scope } });

    if (existing == null) {
      return null;
    }

    const previousLabel = existing.label;
    const label = data.label === undefined ? previousLabel : this.validateLabel(data.label);
    const description = data.description === undefined ? existing.description : (data.description ?? null);

    if (label === previousLabel) {
      const tag = await this.applyTagFields(this.tagRepository.manager, id, { label, description });

      return { tag, merged: false, movedAssignments: 0, previousLabel };
    }

    return this.dataSource.transaction(async (manager) => {
      const tagRepository = manager.getRepository(TagEntity);

      // `withDeleted` on purpose: the unique constraint is not partial, so a
      // soft-deleted row still owns its label and would block the rename with
      // a constraint error the caller could do nothing about.
      const collision = await tagRepository.findOne({
        where: { label, userId: existing.userId },
        withDeleted: true,
      });

      if (collision != null && collision.deletedAt != null) {
        // Invisible to every read path and un-restorable through any UI — it
        // is only squatting on the label. Clear it out and rename normally.
        await this.purge(manager, collision.id);
      }

      if (collision != null && collision.deletedAt == null) {
        const movedAssignments = await this.mergeInto(manager, existing.id, collision.id);

        const tag = await this.applyTagFields(
          manager,
          collision.id,
          data.description === undefined ? {} : { description: data.description ?? null },
        );

        return { tag, merged: true, movedAssignments, previousLabel };
      }

      const tag = await this.applyTagFields(manager, id, { label, description });

      return { tag, merged: false, movedAssignments: 0, previousLabel };
    });
  }

  /**
   * Delete a tag and every assignment of it, for good.
   *
   * Deliberately a hard delete rather than the soft delete `TagEntity`'s
   * `deleted_at` column allows, for three reasons:
   *
   *   1. `entity_tag_tag_id_fkey` carries no ON DELETE rule, so the
   *      assignments have to go regardless — soft-deleting the parent would
   *      just leave them dangling behind a tag nothing can read.
   *   2. `tags_label_user_key` is not a partial index, so a soft-deleted tag
   *      keeps owning its label forever: re-tagging anything with that label
   *      would fail on a constraint the user cannot see or clear. Re-tagging
   *      is the most likely thing to follow a delete.
   *   3. A tag holds no history — just a label, a description and its
   *      assignments. The memories it was attached to are untouched, so the
   *      blast radius is small and nothing is recoverable-in-principle anyway.
   *
   * Returns null when the tag does not exist or belongs to another user.
   * Throws when the tag is a base direction (`is_base`) — those are
   * documented as undeletable by design (brand-set Home/Work/Community).
   * Nothing in this codebase can mark a tag `is_base` yet (base-direction
   * creation is deliberately out of scope here — see the migration header),
   * so this guard cannot change behaviour for any tag that exists today; it
   * only makes the column's own stated meaning true once something does.
   */
  async remove(context: ServiceContext, id: string): Promise<RemoveTagResult | null> {
    const existing = await this.tagRepository.findOne({
      where: { id, ...this.userScope(context) },
    });

    if (existing == null) {
      return null;
    }

    if (existing.isBase) {
      throw new Error('Cannot delete a base tag');
    }

    return this.dataSource.transaction(async (manager) => {
      const removedAssignments = await this.purge(manager, id);

      return { label: existing.label, removedAssignments };
    });
  }

  /**
   * How many entities carry each of the given tags, batched for
   * `TagType.entityCount`. Tags with no assignments are absent from the map.
   */
  async getAssignmentCounts(context: ServiceContext, tagIds: string[]): Promise<Map<string, number>> {
    if (tagIds.length === 0) {
      return new Map();
    }

    const query = this.dataSource
      .getRepository(EntityTagEntity)
      .createQueryBuilder('et')
      .select('et.tag_id', 'tag_id')
      .addSelect('COUNT(*)', 'count')
      .innerJoin(TagEntity, 't', 't.id = et.tag_id')
      .where('et.tag_id IN (:...tagIds)', { tagIds })
      .groupBy('et.tag_id');

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('t.user_id = :userId', { userId: context.userId });
    }

    const rows: Array<{ tag_id: string; count: string }> = await query.getRawMany();

    return new Map(rows.map((row) => [row.tag_id, parseInt(row.count, 10)]));
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

  // ── Tag taxonomy (20260916025313_planning_tag_taxonomy) ──────────────────
  //
  // `kind`, `tag_directions`, `tag_categories`, `category_direction_optouts`
  // and `entity_categories` port CI-Planning's taxonomy CRUD
  // (`server/src/services/tags.ts`, the "Tag taxonomy" sections). Every write
  // below is owner-scoped through the SAME `userScope`/ownership pattern the
  // rest of this file already uses, and every DELETE against these five
  // tables lives here — nowhere else may grow its own. `setEntityCategories`
  // is the one write keyed on a caller-named ENTITY rather than on a tag, so
  // it owner-checks the entity too (`ownsEntity`); scoping the tags alone left
  // its DELETE open to any entity id.
  //
  // `entity_tag.level` deliberately gets no setter here: this milestone adds
  // the column (default 1, so nothing that predates it changes) but nothing
  // yet needs to write a level other than the default, and inventing an API
  // for it ahead of a real caller would be a guess at that caller's shape.

  /**
   * Set a tag's taxonomy level (`direction` | `intention` | `category`).
   * Returns null when the tag does not exist or belongs to another user.
   */
  async setKind(context: ServiceContext, id: string, kind: TagKind): Promise<Tag | null> {
    if (!TAG_KINDS.includes(kind)) {
      throw new Error(`Invalid tag kind: ${kind}`);
    }

    const existing = await this.tagRepository.findOne({ where: { id, ...this.userScope(context) } });

    if (existing == null) {
      return null;
    }

    await this.tagRepository.update({ id }, { kind });

    const entity = await this.tagRepository.findOneOrFail({ where: { id } });

    return TagEntity.toEgressType(entity);
  }

  /** The direction tags an intention tag belongs to (empty = Unsorted). */
  async getTagDirections(context: ServiceContext, intentionTagId: string): Promise<Tag[]> {
    const query = this.dataSource
      .getRepository(TagEntity)
      .createQueryBuilder('t')
      .innerJoin(TagDirectionEntity, 'td', 'td.direction_tag_id = t.id')
      .where('td.intention_tag_id = :intentionTagId', { intentionTagId })
      .orderBy('t.label', 'ASC');

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('t.user_id = :userId', { userId: context.userId });
    }

    const entities = await query.getMany();

    return entities.map((entity) => TagEntity.toEgressType(entity));
  }

  /**
   * Replace an intention tag's direction membership. Silently drops any id
   * that is not one of the caller's own `kind = 'direction'` tags, the same
   * forgiving-on-targets behaviour CI-Planning's `directionIds` helper has.
   *
   * Returns the resulting direction tags, or null when `intentionTagId`
   * does not exist / belongs to another user. Throws if it exists but is not
   * itself a `kind = 'intention'` tag — unlike an invalid target id, calling
   * this on the wrong KIND of tag is a caller bug, not a stale reference.
   */
  async setTagDirections(
    context: ServiceContext,
    intentionTagId: string,
    directionTagIds: string[],
  ): Promise<Tag[] | null> {
    const scope = this.userScope(context);

    const intention = await this.tagRepository.findOne({ where: { id: intentionTagId, ...scope } });

    if (intention == null) {
      return null;
    }

    if (intention.kind !== 'intention') {
      throw new Error('Only intention tags can belong to a direction');
    }

    const uniqueIds = [...new Set(directionTagIds)];

    const directions =
      uniqueIds.length === 0
        ? []
        : await this.tagRepository.find({ where: { id: In(uniqueIds), kind: 'direction', ...scope } });

    return this.dataSource.transaction(async (manager) => {
      await manager.getRepository(TagDirectionEntity).delete({ intentionTagId });

      for (const direction of directions) {
        await manager
          .getRepository(TagDirectionEntity)
          .createQueryBuilder()
          .insert()
          .values({ intentionTagId, directionTagId: direction.id })
          .orIgnore()
          .execute();
      }

      return directions.map((entity) => TagEntity.toEgressType(entity));
    });
  }

  /** The category tags an intention tag belongs to (empty = Unsorted). */
  async getTagCategories(context: ServiceContext, intentionTagId: string): Promise<Tag[]> {
    const query = this.dataSource
      .getRepository(TagEntity)
      .createQueryBuilder('t')
      .innerJoin(TagCategoryEntity, 'tc', 'tc.category_tag_id = t.id')
      .where('tc.intention_tag_id = :intentionTagId', { intentionTagId })
      .orderBy('t.label', 'ASC');

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('t.user_id = :userId', { userId: context.userId });
    }

    const entities = await query.getMany();

    return entities.map((entity) => TagEntity.toEgressType(entity));
  }

  /**
   * Replace an intention tag's category membership. Same contract as
   * {@link setTagDirections} on the second, orthogonal grouping axis.
   */
  async setTagCategories(
    context: ServiceContext,
    intentionTagId: string,
    categoryTagIds: string[],
  ): Promise<Tag[] | null> {
    const scope = this.userScope(context);

    const intention = await this.tagRepository.findOne({ where: { id: intentionTagId, ...scope } });

    if (intention == null) {
      return null;
    }

    if (intention.kind !== 'intention') {
      throw new Error('Only intention tags can belong to a category');
    }

    const uniqueIds = [...new Set(categoryTagIds)];

    const categories =
      uniqueIds.length === 0
        ? []
        : await this.tagRepository.find({ where: { id: In(uniqueIds), kind: 'category', ...scope } });

    return this.dataSource.transaction(async (manager) => {
      await manager.getRepository(TagCategoryEntity).delete({ intentionTagId });

      for (const category of categories) {
        await manager
          .getRepository(TagCategoryEntity)
          .createQueryBuilder()
          .insert()
          .values({ intentionTagId, categoryTagId: category.id })
          .orIgnore()
          .execute();
      }

      return categories.map((entity) => TagEntity.toEgressType(entity));
    });
  }

  /**
   * The direction tags turned OFF for a category tag (empty = every
   * direction applies — see the opt-out polarity note on
   * `category_direction_optouts`).
   */
  async getCategoryDirectionOptouts(context: ServiceContext, categoryTagId: string): Promise<Tag[]> {
    const query = this.dataSource
      .getRepository(TagEntity)
      .createQueryBuilder('t')
      .innerJoin(CategoryDirectionOptoutEntity, 'cdo', 'cdo.direction_tag_id = t.id')
      .where('cdo.category_tag_id = :categoryTagId', { categoryTagId })
      .orderBy('t.label', 'ASC');

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('t.user_id = :userId', { userId: context.userId });
    }

    const entities = await query.getMany();

    return entities.map((entity) => TagEntity.toEgressType(entity));
  }

  /**
   * Toggle a direction on/off for a category: `enabled: false` inserts an
   * opt-out row, `enabled: true` removes one (a no-op if it was already
   * enabled). Both tags must exist, belong to the caller, and carry the kind
   * their role requires — returns false rather than throwing, since toggling
   * a stale or mistyped id from a UI is an expected outcome, not a bug.
   */
  async setCategoryDirectionEnabled(
    context: ServiceContext,
    categoryTagId: string,
    directionTagId: string,
    enabled: boolean,
  ): Promise<boolean> {
    const scope = this.userScope(context);

    const category = await this.tagRepository.findOne({
      where: { id: categoryTagId, kind: 'category', ...scope },
    });

    if (category == null) {
      return false;
    }

    const direction = await this.tagRepository.findOne({
      where: { id: directionTagId, kind: 'direction', ...scope },
    });

    if (direction == null) {
      return false;
    }

    const optoutRepository = this.dataSource.getRepository(CategoryDirectionOptoutEntity);

    if (enabled) {
      await optoutRepository.delete({ categoryTagId, directionTagId });
    } else {
      await optoutRepository
        .createQueryBuilder()
        .insert()
        .values({ categoryTagId, directionTagId })
        .orIgnore()
        .execute();
    }

    return true;
  }

  /**
   * An entity's categories, in position order (empty = none). Deliberately
   * separate from `getTagsForEntity` / `entity_tag` — see
   * `20260916025313_planning_tag_taxonomy.sql`'s header for why a category
   * can never leak into that read.
   */
  async getEntityCategories(
    context: ServiceContext,
    entityId: EntityIdentifier<TaggableEntity>,
  ): Promise<Tag[]> {
    const { type, id } = entityId;

    const query = this.dataSource
      .getRepository(TagEntity)
      .createQueryBuilder('t')
      .innerJoin(EntityCategoryEntity, 'ec', 'ec.category_tag_id = t.id')
      .where('ec.entity_id = :id', { id })
      .andWhere('ec.entity_type = :type', { type })
      .orderBy('ec.position', 'ASC');

    if (context.userId !== SYSTEM_USER) {
      query.andWhere('t.user_id = :userId', { userId: context.userId });
    }

    const entities = await query.getMany();

    return entities.map((entity) => TagEntity.toEgressType(entity));
  }

  /**
   * Replace an entity's category set, in the order given. De-duplicated and
   * capped at {@link ENTITY_CATEGORY_CAP} (CI-Planning's "1-3 categories,
   * positional" rule — enforced here, not as a DB constraint, matching how
   * `entity_tag`'s own shape is app- rather than FK-enforced). Any id that is
   * not one of the caller's own `kind = 'category'` tags is silently dropped.
   * An empty array clears the entity's categories.
   *
   * Returns null when the entity does not exist or belongs to another user. It
   * is the same answer for both, so a refusal says nothing about someone else's
   * ids. `entity_categories` has no FK to the entity, so this check is the only
   * thing standing between a caller and any uuid they name. Without it, one
   * user's call deleted another user's assignments on that entity and attached
   * the caller's own categories in their place.
   *
   * User context only, because the check needs a concrete owner to compare
   * against. A system caller would have to name one, the way `tagEntities`
   * makes it pass `forUserId`, and nothing needs that yet.
   */
  async setEntityCategories(
    context: UserServiceContext,
    entityId: EntityIdentifier<TaggableEntity>,
    categoryTagIds: string[],
  ): Promise<Tag[] | null> {
    const { type, id } = entityId;

    if (!UUID_SHAPE.test(id)) {
      return null;
    }

    const uniqueIds = [...new Set(categoryTagIds)].slice(0, ENTITY_CATEGORY_CAP);

    const candidates =
      uniqueIds.length === 0
        ? []
        : await this.tagRepository.find({
            where: { id: In(uniqueIds), kind: 'category', ...this.userScope(context) },
          });

    // Preserve the CALLER's order (that is what `position` records), not
    // whatever order the IN-list query happened to return.
    const ordered = uniqueIds
      .map((candidateId) => candidates.find((candidate) => candidate.id === candidateId))
      .filter((candidate): candidate is TagEntity => candidate != null);

    return this.dataSource.transaction(async (manager) => {
      if (!(await this.ownsEntity(manager, context.userId, entityId))) {
        return null;
      }

      // Only rows pointing at the caller's own category tags. The ownership
      // check above is the fix. This bounds the damage of a mistake in it (a
      // wrong owner column for one type) to the caller's own rows.
      await manager.query(
        `DELETE FROM ci_search.entity_categories ec
          WHERE ec.entity_type = $1
            AND ec.entity_id = $2
            AND ec.category_tag_id IN (SELECT t.id FROM ci_search.tags t WHERE t.user_id = $3)`,
        [type, id, context.userId],
      );

      for (const [position, category] of ordered.entries()) {
        await manager
          .getRepository(EntityCategoryEntity)
          .createQueryBuilder()
          .insert()
          .values({ entityType: type, entityId: id, categoryTagId: category.id, position })
          .orIgnore()
          .execute();
      }

      return ordered.map((entity) => TagEntity.toEgressType(entity));
    });
  }

  /** User-scoping fragment shared by the owner-checked reads and writes. */
  private userScope(context: ServiceContext): { userId?: string } {
    return context.userId === SYSTEM_USER ? {} : { userId: context.userId };
  }

  /**
   * Whether `entity` names a row `userId` owns (see `taggableEntityOwnership.ts`
   * for which rows, per type). Takes the write's own manager so the check runs
   * inside its transaction, ahead of its first statement.
   */
  private async ownsEntity(
    manager: EntityManager,
    userId: string,
    entity: EntityIdentifier<TaggableEntity>,
  ): Promise<boolean> {
    const query = TAGGABLE_ENTITY_OWNERSHIP_QUERIES.get(entity.type);

    if (query == null) {
      throw new Error(`Invalid entity type: ${entity.type}`);
    }

    const [row]: Array<{ owned: boolean }> = await manager.query(query.sql, [
      entity.id,
      userId,
      ...query.discriminatorParams,
    ]);

    return row?.owned === true;
  }

  /**
   * Write label/description onto a tag and read it back. The id is resolved by
   * the caller, which has already owner-checked it.
   */
  private async applyTagFields(
    manager: EntityManager,
    id: string,
    fields: { label?: string; description?: string | null },
  ): Promise<Tag> {
    const tagRepository = manager.getRepository(TagEntity);

    if (Object.keys(fields).length > 0) {
      await tagRepository.update({ id }, fields);
    }

    const entity = await tagRepository.findOneOrFail({ where: { id } });

    return TagEntity.toEgressType(entity);
  }

  /**
   * Re-point `sourceId`'s assignments onto `targetId`, then drop what is left
   * of the source. Assignments the target already holds are skipped rather
   * than moved — `entity_tag_unique_entry` would reject them — and then
   * deleted along with the source tag.
   *
   * @returns the number of assignments actually moved
   */
  private async mergeInto(manager: EntityManager, sourceId: string, targetId: string): Promise<number> {
    const moved: [unknown[], number] = await manager.query(
      `UPDATE ci_search.entity_tag t
          SET tag_id = $2
        WHERE t.tag_id = $1
          AND NOT EXISTS (
            SELECT 1
              FROM ci_search.entity_tag d
             WHERE d.tag_id = $2
               AND d.entity_type = t.entity_type
               AND d.entity_id = t.entity_id)`,
      [sourceId, targetId],
    );

    await this.purge(manager, sourceId);

    return moved[1] ?? 0;
  }

  /**
   * Delete a tag and its assignments, in that dependency order. Callers own
   * the ownership check and the surrounding transaction.
   *
   * @returns the number of assignments deleted with it
   */
  private async purge(manager: EntityManager, id: string): Promise<number> {
    const assignments = await manager.getRepository(EntityTagEntity).delete({ tagId: id });

    await manager.getRepository(TagEntity).delete({ id });

    return assignments.affected ?? 0;
  }

  private validateLabel(label?: string): string {
    const validatedLabel = (label?.trim() || '').toLowerCase();

    if (validatedLabel.length === 0) {
      throw new Error('Tag label cannot be empty');
    }

    return validatedLabel;
  }
}

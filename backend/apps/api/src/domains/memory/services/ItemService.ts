import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { SYSTEM_USER, type UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { bulkInsertIdempotent, INGEST_REFRESH_COLUMNS } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { ItemCreatedEvent, ItemUpdatedEvent, ItemRemovedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { ItemBaseEntity } from '../entities/ItemBaseEntity';
import { type Item, ItemEntity } from '../entities/ItemEntity';
import type { CreateItemDto, UpdateItemDto } from '../types';

import { CtiAggregate } from './CtiAggregate';
import { GraphDeltaWriter } from './GraphDeltaWriter';

/**
 * Spanning-aggregate service for the inventory CTI split: an item is ONE
 * logical entity persisted as a `ci.entities` base row (discriminated 'Item',
 * see {@link ItemBaseEntity}) plus a `ci.inventory` detail row sharing the same
 * uuid. The base row is the SOLE owner of `name`/`description`; the detail row
 * carries only item-specific data. This service hides the split — the shared
 * {@link CtiAggregate} machinery writes both rows in one transaction (also
 * where mutation tracking will plug in), and reads compose the egress
 * {@link Item} from the pair with one batched base-row fetch.
 */
@Injectable()
export class ItemService {
  private readonly aggregate: CtiAggregate<ItemEntity, ItemBaseEntity>;

  constructor(
    @InjectRepository(ItemEntity)
    private readonly itemRepository: Repository<ItemEntity>,
    @InjectRepository(ItemBaseEntity)
    private readonly itemBaseRepository: Repository<ItemBaseEntity>,
    private readonly logger: LoggerService,
    private readonly eventService: EventService,
    private readonly graphDeltaWriter: GraphDeltaWriter,
  ) {
    this.logger.setContext(ItemService.name);
    this.aggregate = new CtiAggregate({
      detailRepository: this.itemRepository,
      detailEntity: ItemEntity,
      baseEntity: ItemBaseEntity,
      baseRepository: this.itemBaseRepository,
      linkedTable: 'inventory',
      scopedWhere: (context, id) => ({
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      }),
    });
  }

  /**
   * Composes egress items from detail rows plus one batched fetch of their
   * base rows (the owners of name/description), preserving input order.
   */
  private composeMany(entities: ItemEntity[]): Promise<Item[]> {
    return this.aggregate.composeMany(entities, (entity, base) => ItemEntity.toEgressType(entity, base));
  }

  async create(context: UserServiceContext, data: CreateItemDto): Promise<Item> {
    const id = data.id ?? uuid7();

    const entity = await this.itemRepository.manager.transaction(async (manager) => {
      const detail = manager.getRepository(ItemEntity).create({
        id,
        userId: context.userId,
        ownerUserId: context.userId,
        category: data.category ?? null,
        subcategory: data.subcategory ?? null,
        brand: data.brand ?? null,
        model: data.model ?? null,
        purchasePrice: data.purchasePrice ?? null,
        currentValue: data.currentValue ?? null,
        currency: data.currency ?? 'USD',
        acquiredAt: data.acquiredAt ?? null,
        identifierCodes: data.identifierCodes ?? {},
        condition: data.condition ?? null,
        metadata: data.metadata ?? {},
        sourceType: data.sourceType ?? null,
        sourceSystem: data.sourceSystem ?? null,
        sourceId: data.sourceId ?? null,
      });

      // Base row first (natural FK order, though the constraint is deferred),
      // then the detail — one logical create, one transaction.
      await manager.getRepository(ItemBaseEntity).save(
        this.aggregate.createBaseRow(manager, {
          id,
          userId: context.userId,
          name: data.name,
          description: data.description ?? null,
        }),
      );

      const saved = await manager.getRepository(ItemEntity).save(detail);
      await this.graphDeltaWriter.entityCreated({
        entityId: id,
        entityType: 'Item',
        name: data.name,
        description: data.description ?? null,
        ownerUserId: context.userId,
        changeSource: 'ItemService.create',
        changedByUserId: typeof context.userId === 'string' ? context.userId : null,
        manager,
      });

      return saved;
    });

    await this.eventService.send(ItemCreatedEvent, {
      itemId: entity.id,
    });

    return ItemEntity.toEgressType(entity, {
      name: data.name,
      description: data.description ?? null,
    });
  }

  /**
   * Batch, idempotent inventory ingest for the importer. Dedupes on the provenance
   * triple (source_type, source_system, source_id), scoped to owner_user_id, via
   * one set-based INSERT ... ON CONFLICT DO NOTHING instead of a per-row findOne +
   * save loop. Re-syncing the same triple returns the existing row instead of
   * inserting a duplicate. Paired with the inventory_source_triple_uniq partial
   * unique index, which also absorbs a lost insert race.
   */
  async createMany(context: UserServiceContext, data: CreateItemDto[]): Promise<Item[]> {
    if (data.length === 0) {
      return [];
    }

    const withIds = data.map((item) => ({ ...item, id: item.id ?? uuid7() }));

    const entities = withIds.map((item) =>
      this.itemRepository.create({
        id: item.id,
        userId: context.userId,
        ownerUserId: context.userId,
        category: item.category ?? null,
        subcategory: item.subcategory ?? null,
        brand: item.brand ?? null,
        model: item.model ?? null,
        purchasePrice: item.purchasePrice ?? null,
        currentValue: item.currentValue ?? null,
        currency: item.currency ?? 'USD',
        acquiredAt: item.acquiredAt ?? null,
        identifierCodes: item.identifierCodes ?? {},
        condition: item.condition ?? null,
        metadata: item.metadata ?? {},
        sourceType: item.sourceType ?? null,
        sourceSystem: item.sourceSystem ?? null,
        sourceId: item.sourceId ?? null,
      }),
    );

    // name/description come from the DTOs — they are base-row data and never
    // touch the detail table.
    const ingressById = new Map(
      withIds.map((item) => [item.id, { name: item.name, description: item.description ?? null }]),
    );

    // One transaction spans both halves of the CTI aggregate: the detail rows
    // land first (the triple arbiter decides which actually insert), then a
    // base row is written for exactly the inserted set. The deferred FK
    // (inventory_object_id_entities_fk) tolerates the detail-before-base order.
    const { detailResults, bases } = await this.itemRepository.manager.transaction(async (manager) => {
      const results = await bulkInsertIdempotent({
        repository: this.itemRepository,
        manager,
        entities,
        primaryKey: 'id',
        getTriple: (entity) => ({
          sourceType: entity.sourceType,
          sourceSystem: entity.sourceSystem,
          sourceId: entity.sourceId,
        }),
        scope: { ownerUserId: context.userId },
        conflictTarget: '(owner_user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL',
        tripleColumns: ['source_type', 'source_system', 'source_id'],
        // Centralized refresh contract — currently empty, so conflicts stay
        // DO NOTHING find-or-return.
        conflictUpdateColumns: INGEST_REFRESH_COLUMNS.item,
      });

      const baseRows = results
        .filter(({ inserted }) => inserted)
        .map(({ entity }) => {
          const ingress = ingressById.get(entity.id);
          if (!ingress) {
            // Every inserted id came from withIds — the exact array ingressById
            // was built from — so a miss means the id mapping broke. Fail
            // loudly rather than writing a null-labeled base row.
            throw new Error(`No ingress row for inserted item ${entity.id}`);
          }

          return this.aggregate.createBaseRow(manager, {
            id: entity.id,
            userId: context.userId,
            ...ingress,
          });
        });

      // ON CONFLICT (entity_id) DO NOTHING guards the theoretical case of a
      // base row already present for this uuid.
      await this.aggregate.insertBaseRows(manager, baseRows, '(entity_id) DO NOTHING');

      await this.graphDeltaWriter.recordMany(
        results
          .filter(({ inserted }) => inserted)
          .map(({ entity }) => {
            const ingress = ingressById.get(entity.id);

            return {
              nodeType: 'entity' as const,
              changeType: 'created' as const,
              entityId: entity.id,
              entityType: 'Item',
              ownerUserId: context.userId,
              changeSource: 'ItemService.createMany',
              changedByUserId: typeof context.userId === 'string' ? context.userId : null,
              changedFields: {
                name: { new: ingress?.name ?? null },
                description: { new: ingress?.description ?? null },
                entity_type: { new: 'Item' },
                properties: { new: {} },
              },
            };
          }),
        manager,
      );

      // One read covers egress composition for inserted AND pre-existing rows
      // (a deduped triple resolves to a row whose base values this batch never
      // carried).
      const baseEntities = await this.aggregate.fetchBaseMap(
        results.map(({ entity }) => entity.id),
        manager,
      );

      return { detailResults: results, bases: baseEntities };
    });

    // Bulk ingest does NOT emit a per-row ItemCreatedEvent: the per-row pgboss
    // fan-out was the dominant cost at import volume. Search indexing for
    // bulk-loaded rows is deferred to the post-load batch embed
    // (POST /api/maintenance/search-index/backfill).
    return detailResults.map(({ entity }) => ItemEntity.toEgressType(entity, bases.get(entity.id)));
  }

  async findAll(context: ServiceContext): Promise<Item[]> {
    const entities = await this.itemRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return this.composeMany(entities);
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Item | null)[]> {
    const entities = await this.itemRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const items = await this.composeMany(entities);
    const map = new Map(items.map((item) => [item.id, item]));

    return ids.map((id) => map.get(id) ?? null);
  }

  /**
   * Lightweight identifiers for the most-recent inventory items, for the
   * unified search/explorer feed. Full entities are batch-resolved downstream.
   */
  async getEntitiesForItems(
    context: ServiceContext,
    options: { limit?: number; startTime?: Date; endTime?: Date; order?: 'ASC' | 'DESC' } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.itemRepository
      .createQueryBuilder('item')
      .select('item.id', 'id')
      .where('item.user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('item.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('item.created_at <= :endTime', { endTime: options.endTime });
    }

    query = query.orderBy('item.created_at', options.order ?? 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'item' as IndexableEntity }));
  }

  async findById(context: ServiceContext, id: string): Promise<Item | null> {
    const entity = await this.itemRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (entity == null) {
      return null;
    }

    const [item] = await this.composeMany([entity]);

    return item;
  }

  /**
   * Yields an collection of Items each associated with a given File id.
   *
   * This method assumes the context user has access to the corresponding Files.
   * This access must be ensured before safely calling this method.
   */
  async findByFileIds(context: ServiceContext, fileIds: string[]): Promise<Item[][]> {
    if (fileIds.length === 0) {
      return [];
    }

    const queryBuilder = this.itemRepository.createQueryBuilder('inventory');

    queryBuilder.where("inventory.metadata->>'source_file_id' IN (:...fileIds)", { fileIds });

    if (context.userId !== SYSTEM_USER) {
      queryBuilder.andWhere('inventory.userId = :userId', { userId: context.userId });
    }

    const entities = await queryBuilder.getMany();
    const items = await this.composeMany(entities);

    const itemsMap = new Map<string, Item[]>();

    for (const item of items) {
      const fileId = item.sourceFileId;

      if (fileId) {
        if (!itemsMap.has(fileId)) {
          itemsMap.set(fileId, []);
        }

        itemsMap.get(fileId)!.push(item);
      }
    }

    return fileIds.map((id) => itemsMap.get(id) ?? []);
  }

  async update(context: ServiceContext, id: string, data: UpdateItemDto): Promise<Item | null> {
    const updateData: Partial<ItemEntity> = {};

    if (data.category !== undefined) {
      updateData.category = data.category;
    }

    if (data.subcategory !== undefined) {
      updateData.subcategory = data.subcategory;
    }

    if (data.brand !== undefined) {
      updateData.brand = data.brand;
    }

    if (data.model !== undefined) {
      updateData.model = data.model;
    }

    if (data.currentValue !== undefined) {
      updateData.currentValue = data.currentValue;
    }

    if (data.currency !== undefined) {
      updateData.currency = data.currency;
    }

    if (data.condition !== undefined) {
      updateData.condition = data.condition;
    }

    if (data.metadata !== undefined) {
      updateData.metadata = data.metadata;
    }

    // name/description are base-row data; patch only the provided halves.
    const basePatch: Partial<Pick<ItemBaseEntity, 'name' | 'description'>> = {};
    if (data.name !== undefined) {
      basePatch.name = data.name;
    }

    if (data.description !== undefined) {
      basePatch.description = data.description;
    }

    // One transaction across both halves of the aggregate (see CtiAggregate).
    const after = await this.aggregate.applyUpdate(
      context,
      id,
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        detail: updateData as any, // TypeORM will handle JSON serialization
        base: basePatch,
      },
      {
        withinTx: async ({ manager }) => {
          const base = await manager.getRepository(ItemBaseEntity).findOne({ where: { id } });
          await this.graphDeltaWriter.entityUpdated({
            entityId: id,
            entityType: 'Item',
            name: base?.name ?? null,
            changedFields: {
              ...(basePatch.name !== undefined ? { name: { new: basePatch.name } } : {}),
              ...(basePatch.description !== undefined ? { description: { new: basePatch.description } } : {}),
              ...(Object.keys(updateData).length > 0 ? { detail_updated: { new: true } } : {}),
            },
            ownerUserId: typeof context.userId === 'string' ? context.userId : null,
            changeSource: 'ItemService.update',
            changedByUserId: typeof context.userId === 'string' ? context.userId : null,
            manager,
          });
        },
      },
    );

    if (!after) {
      return null;
    }

    await this.eventService.send(ItemUpdatedEvent, {
      itemId: id,
    });

    // The transaction already reloaded the detail row; one base fetch
    // completes the egress composition.
    const [item] = await this.composeMany([after]);

    return item;
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    // Authorized load + base-row delete (the FK cascade removes the detail);
    // see CtiAggregate.remove.
    const removed = await this.aggregate.remove(context, id, {
      withinTx: async ({ manager }) => {
        const base = await manager.getRepository(ItemBaseEntity).findOne({ where: { id } });
        await this.graphDeltaWriter.entityDeleted({
          entityId: id,
          entityType: 'Item',
          name: base?.name ?? null,
          ownerUserId: typeof context.userId === 'string' ? context.userId : null,
          changeSource: 'ItemService.remove',
          changedByUserId: typeof context.userId === 'string' ? context.userId : null,
          manager,
        });
      },
    });

    if (!removed) {
      return false;
    }

    await this.eventService.send(ItemRemovedEvent, {
      itemId: id,
    });

    return true;
  }

  async search(context: ServiceContext, query: UpdateItemDto): Promise<Item[]> {
    // name/description live on the CTI base row; the FK guarantees every
    // detail row has one, so the base is joined unconditionally and its
    // columns are hydrated in the SAME query — no second composition fetch.
    let executable = this.itemRepository
      .createQueryBuilder('item')
      .innerJoin('ci.entities', 'base', 'base.entity_id = item.object_id')
      .addSelect('base.name', 'base_name')
      .addSelect('base.description', 'base_description')
      .where('item.user_id = :userId', { userId: context.userId });

    if (query.name) {
      executable = executable.andWhere('base.name = :name', { name: query.name });
    }

    if (query.description) {
      executable = executable.andWhere('base.description = :description', {
        description: query.description,
      });
    }

    if (query.category) {
      executable = executable.andWhere('item.category = :category', { category: query.category });
    }

    if (query.subcategory) {
      executable = executable.andWhere('item.subcategory = :subcategory', {
        subcategory: query.subcategory,
      });
    }

    if (query.brand) {
      executable = executable.andWhere('item.brand = :brand', { brand: query.brand });
    }

    if (query.model) {
      executable = executable.andWhere('item.model = :model', { model: query.model });
    }

    if (query.condition) {
      executable = executable.andWhere('item.condition = :condition', { condition: query.condition });
    }

    if (query.metadata) {
      for (const [key, val] of Object.entries(query.metadata)) {
        executable = executable.andWhere(`item.metadata->>'${key}' = :${key}`, { [key]: val });
      }
    }

    // The 1:1 join yields exactly one raw row per entity, in the same order,
    // so the base columns compose positionally.
    const { entities, raw } = await executable.getRawAndEntities<{
      base_name: string | null;
      base_description: string | null;
    }>();

    return entities.map((entity, index) =>
      ItemEntity.toEgressType(entity, {
        name: raw[index]?.base_name ?? null,
        description: raw[index]?.base_description ?? null,
      }),
    );
  }
}

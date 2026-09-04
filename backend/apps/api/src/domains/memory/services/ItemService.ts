import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { SYSTEM_USER, type UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type BulkInsertResult, bulkInsertIdempotent, INGEST_REFRESH_COLUMNS } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { ItemCreatedEvent, ItemUpdatedEvent, ItemRemovedEvent } from '@ci/domains/memory/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { ItemBaseEntity } from '../entities/ItemBaseEntity';
import { type Item, ItemEntity } from '../entities/ItemEntity';
import { PhysicalPropertyError, normalizePhysicalProperties } from '../physicalProperties';
import type {
  CreateItemDto,
  FindItemsFilter,
  ItemKeyset,
  ItemPage,
  PhysicalItemPropertiesDto,
  UpdateItemDto,
} from '../types';

import { CtiAggregate } from './CtiAggregate';
import { GraphDeltaWriter } from './GraphDeltaWriter';

/** Page size {@link ItemService.findPage} uses when the caller names none. */
const DEFAULT_ITEM_PAGE_SIZE = 50;

/** Hard ceiling on a page, so `limit: 100000` still costs one page. */
const MAX_ITEM_PAGE_SIZE = 200;

/**
 * Spanning-aggregate service for the object CTI split: an item is ONE
 * logical entity persisted as a `ci.entities` base row (discriminated 'Item',
 * see {@link ItemBaseEntity}) plus a `ci.objects` detail row sharing the same
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
      linkedTable: 'objects',
      scopedWhere: (context, id) => ({
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
        // A tombstone lost a merge and its data is already folded into the
        // survivor. Updating or deleting one writes to a row nothing reads.
        mergedIntoObjectId: IsNull(),
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

  /**
   * The physical columns of a write, canonicalized — the ONLY path by which
   * they reach the table, on every one of create / createMany / update.
   *
   * Callers may hand these fields in any unit and any spelling (see
   * {@link PhysicalItemPropertiesDto}); what lands is millimetres, grams,
   * millilitres and lowercased term arrays. Keys the caller did not mention are
   * absent from the result, so a partial update leaves them alone while an
   * explicit `null` clears them.
   *
   * Unreadable input is a client error, not a server one: an unknown unit or a
   * composition adding to 160% becomes a 400 naming the field, rather than a
   * constraint violation surfacing as a 500 from inside the transaction.
   */
  private physicalPatch(data: PhysicalItemPropertiesDto): Partial<ItemEntity> {
    let normalized;

    try {
      normalized = normalizePhysicalProperties(data);
    } catch (error) {
      if (error instanceof PhysicalPropertyError) {
        throw new BadRequestException(error.message);
      }

      throw error;
    }

    const patch: Partial<ItemEntity> = { ...normalized };

    // Free-text and reference fields need no canonicalization, only the same
    // mentioned-vs-cleared discipline.
    if (data.acquiredFrom !== undefined) {
      patch.acquiredFrom = data.acquiredFrom?.trim() || null;
    }

    if (data.acquiredFromEntityId !== undefined) {
      patch.acquiredFromEntityId = data.acquiredFromEntityId ?? null;
    }

    if (data.manufacturedAt !== undefined) {
      patch.manufacturedAt = data.manufacturedAt ?? null;
    }

    if (data.expiresAt !== undefined) {
      patch.expiresAt = data.expiresAt ?? null;
    }

    if (data.isDigital !== undefined) {
      patch.isDigital = data.isDigital;
    }

    return patch;
  }

  /**
   * The object-identity columns of a write (migration 20260803223025).
   *
   * EVERY key is optional and every one is omitted unless the caller named it,
   * so a write that mentions none of them produces exactly the row the
   * pre-object-identity code produced — the schema defaults (`lifecycle_state`
   * 'active', everything else NULL) are what fill in, not this method. That
   * property is what makes it safe to add the columns to the importer's hot
   * path without re-testing every existing caller.
   */
  private objectIdentityPatch(data: CreateItemDto | UpdateItemDto): Partial<ItemEntity> {
    const patch: Partial<ItemEntity> = {};

    if (data.productId !== undefined) {
      patch.productId = data.productId;
    }

    if (data.acquisitionReceiptId !== undefined) {
      patch.acquisitionReceiptId = data.acquisitionReceiptId;
    }

    if (data.acquisitionLineItemId !== undefined) {
      patch.acquisitionLineItemId = data.acquisitionLineItemId;
    }

    if (data.lifecycleState !== undefined) {
      patch.lifecycleState = data.lifecycleState;
    }

    if (data.lastSeenAt !== undefined) {
      patch.lastSeenAt = data.lastSeenAt;
    }

    if (data.lastSeenPlaceEntityId !== undefined) {
      patch.lastSeenPlaceEntityId = data.lastSeenPlaceEntityId;
    }

    return patch;
  }

  /**
   * The identity claim of a write. `identity_confidence` defaults to 1.0, which
   * downstream reads as ground truth — so a caller that INFERRED the item (a
   * vision guess, a receipt line) must be able to say so, and a confidence
   * outside (0,1] must not reach the CHECK constraint as a 500.
   */
  private identityPatch(data: CreateItemDto): Partial<ItemEntity> {
    const patch: Partial<ItemEntity> = {};

    if (data.identityMethod !== undefined) {
      patch.identityMethod = data.identityMethod;
    }

    if (data.identityConfidence !== undefined) {
      if (!(data.identityConfidence > 0 && data.identityConfidence <= 1)) {
        throw new BadRequestException(
          `identityConfidence must be greater than 0 and at most 1 (got ${data.identityConfidence})`,
        );
      }

      patch.identityConfidence = data.identityConfidence;
    }

    return patch;
  }

  /**
   * Refuses to mark an item digital while a measurement — stored or incoming —
   * still gives it a body. The caller is told which fields to clear.
   */
  private async assertNoStoredBody(context: ServiceContext, id: string, data: UpdateItemDto): Promise<void> {
    const stored = await this.itemRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && { userId: context.userId }),
        mergedIntoObjectId: IsNull(),
      },
    });

    if (stored == null) {
      return;
    }

    const corporeal = (['lengthMm', 'widthMm', 'heightMm', 'massG', 'volumeMl'] as const).filter((key) =>
      // An explicit null in the same patch clears the column, so it no longer
      // counts against the item; anything else leaves the stored value in place.
      data[key] === undefined ? stored[key] != null : data[key] != null,
    );

    if (corporeal.length > 0) {
      throw new BadRequestException(
        `This item cannot be marked digital while it still has ${corporeal.join(', ')}. ` +
          'Clear those measurements in the same update, or leave it physical.',
      );
    }
  }

  /**
   * `quantity` is a count of identical units, so the schema CHECKs it > 0.
   * Rejecting a fractional or zero count here turns what would be a constraint
   * violation from inside a transaction into a 400 the caller can act on.
   */
  private validQuantity(quantity: number): number {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new BadRequestException(`quantity must be a whole number of at least 1 (got ${quantity})`);
    }

    return quantity;
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
        ...(data.quantity !== undefined && { quantity: this.validQuantity(data.quantity) }),
        ...this.identityPatch(data),
        ...this.objectIdentityPatch(data),
        ...this.physicalPatch(data),
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
   * Batch, idempotent things ingest for the importer. Dedupes on the provenance
   * triple (source_type, source_system, source_id), scoped to owner_user_id, via
   * one set-based INSERT ... ON CONFLICT DO NOTHING instead of a per-row findOne +
   * save loop. Re-syncing the same triple returns the existing row instead of
   * inserting a duplicate. Paired with the objects_source_identity_uniq partial
   * unique index, which also absorbs a lost insert race.
   */
  async createMany(context: UserServiceContext, data: CreateItemDto[]): Promise<Item[]> {
    return (await this.createManyDetailed(context, data)).map(({ entity }) => entity);
  }

  /**
   * Same ingest as {@link createMany}, reporting which rows this call actually
   * INSERTED rather than found already present.
   *
   * The batch paths upsert, so a re-sent row resolves silently and is
   * indistinguishable in the returned entities from one written for the first
   * time. The importer needs the difference: without it a push of 7,339 content
   * records that collapsed onto 2,354 rows reports 7,339 writes, and its
   * "already saved" count reads zero on an import that was almost entirely
   * repeats.
   */
  async createManyDetailed(
    context: UserServiceContext,
    data: CreateItemDto[],
  ): Promise<Array<BulkInsertResult<Item>>> {
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
        ...(item.quantity !== undefined && { quantity: this.validQuantity(item.quantity) }),
        ...this.identityPatch(item),
        ...this.objectIdentityPatch(item),
        // Bulk ingest canonicalizes exactly like the single-row path: a batch
        // that would violate a measurement CHECK is rejected as a 400 naming
        // the field, before the set-based INSERT is built.
        ...this.physicalPatch(item),
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
    // (objects_object_id_entities_fk) tolerates the detail-before-base order.
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
        conflictTarget: '(owner_user_id, source_system, source_id) WHERE source_id IS NOT NULL',
        identityColumns: ['source_system', 'source_id'],
        sourceLedger: { table: 'objects', userId: context.userId, importRunId: context.importRunId ?? null },
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
    return detailResults.map(({ entity, inserted }) => ({
      entity: ItemEntity.toEgressType(entity, bases.get(entity.id)),
      inserted,
    }));
  }

  /**
   * Every live unit for the user.
   *
   * Unbounded, and kept only for the callers that genuinely want the whole set
   * (exports, small fixtures). Anything user-facing should use
   * {@link findPage}, which pages in SQL instead of loading the table.
   */
  async findAll(context: ServiceContext): Promise<Item[]> {
    const entities = await this.itemRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
        mergedIntoObjectId: IsNull(),
      },
    });

    return this.composeMany(entities);
  }

  /**
   * One page of live units, newest first, paged in SQL.
   *
   * Walks `objects_live_keyset_idx` — `(user_id, created_at DESC, object_id
   * DESC) WHERE merged_into_object_id IS NULL` — the index the migration added
   * for exactly this query. The `merged_into_object_id IS NULL` predicate is
   * therefore not just correctness, it is what makes the index applicable: drop
   * it and the planner falls back to `objects_user_idx` plus a filter.
   *
   * Replaces the load-everything-then-slice shape {@link findAll} has: cost is
   * bounded by the page size regardless of how many things the user owns, and
   * one sentinel row past the page answers `hasMore` without a second COUNT.
   */
  async findPage(
    context: ServiceContext,
    filter: FindItemsFilter = {},
    keyset: ItemKeyset = {},
  ): Promise<ItemPage> {
    const limit = Math.min(Math.max(keyset.limit ?? DEFAULT_ITEM_PAGE_SIZE, 1), MAX_ITEM_PAGE_SIZE);

    const qb = this.itemRepository
      .createQueryBuilder('item')
      .where('item.merged_into_object_id IS NULL')
      .orderBy('item.created_at', 'DESC')
      .addOrderBy('item.object_id', 'DESC')
      .limit(limit + 1);

    if (context.userId !== SYSTEM_USER) {
      qb.andWhere('item.user_id = :userId', { userId: context.userId });
    }

    if (filter.category != null) {
      qb.andWhere('item.category = :category', { category: filter.category });
    }

    if (filter.subcategory != null) {
      qb.andWhere('item.subcategory = :subcategory', { subcategory: filter.subcategory });
    }

    if (filter.brand != null) {
      qb.andWhere('lower(btrim(item.brand)) = lower(btrim(:brand))', { brand: filter.brand });
    }

    if (filter.productId != null) {
      qb.andWhere('item.product_id = :productId', { productId: filter.productId });
    }

    if (filter.lifecycleState != null) {
      qb.andWhere('item.lifecycle_state = :lifecycleState', { lifecycleState: filter.lifecycleState });
    }

    if (filter.isDigital != null) {
      qb.andWhere('item.is_digital = :isDigital', { isDigital: filter.isDigital });
    }

    if (filter.acquiredFrom != null) {
      qb.andWhere('item.acquired_at >= :acquiredFrom', { acquiredFrom: filter.acquiredFrom });
    }

    if (filter.acquiredTo != null) {
      qb.andWhere('item.acquired_at <= :acquiredTo', { acquiredTo: filter.acquiredTo });
    }

    // Composite seek past (createdAt, id). Both halves are required: created_at
    // alone drops every row that shares a timestamp with the cursor, which on a
    // bulk import is most of the page.
    if (keyset.afterCreatedAt != null && keyset.afterId != null) {
      qb.andWhere(
        '(item.created_at < :afterCreatedAt OR (item.created_at = :afterCreatedAt AND item.object_id < :afterId))',
        { afterCreatedAt: keyset.afterCreatedAt, afterId: keyset.afterId },
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: await this.composeMany(page),
      hasMore,
      nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Item | null)[]> {
    const entities = await this.itemRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
        mergedIntoObjectId: IsNull(),
      },
    });

    const items = await this.composeMany(entities);
    const map = new Map(items.map((item) => [item.id, item]));

    return ids.map((id) => map.get(id) ?? null);
  }

  /**
   * Lightweight identifiers for the most-recent things, for the
   * unified search/explorer feed. Full entities are batch-resolved downstream.
   */
  async getEntitiesForItems(
    context: ServiceContext,
    options: {
      limit?: number;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
      order?: 'ASC' | 'DESC';
    } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.itemRepository
      .createQueryBuilder('item')
      .select('item.id', 'id')
      .where('item.user_id = :userId', { userId: context.userId })
      // Tombstones must not enter the search/explorer feed: indexing one puts a
      // merged-away unit back in front of the user.
      .andWhere('item.merged_into_object_id IS NULL');

    if (options.startTime) {
      query = query.andWhere('item.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('item.created_at <= :endTime', { endTime: options.endTime });
    }

    // Composite keyset: page strictly past (afterTime, afterId) in
    // (created_at DESC, object_id DESC) — see ContentService.getEntitiesForContents.
    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        '(item.created_at < :afterTime OR (item.created_at = :afterTime AND item.object_id < :afterId))',
        { afterTime: options.afterTime, afterId: options.afterId },
      );
    }

    // Deterministic tiebreak so same-timestamp rows page consistently.
    query = query.orderBy('item.created_at', options.order ?? 'DESC').addOrderBy('item.object_id', 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'item' as IndexableEntity }));
  }

  /**
   * True total of items matching the same filters {@link getEntitiesForItems} applies (minus
   * the pagination-only `limit`/`order`/`afterTime`/`afterId`) — a real `COUNT(*)`, not the
   * length of one `limit`-bounded page of identifiers. See CalendarEventService.countEntitiesForEvents.
   */
  async countEntitiesForItems(
    context: ServiceContext,
    options: { startTime?: Date; endTime?: Date },
  ): Promise<number> {
    let query = this.itemRepository
      .createQueryBuilder('item')
      .where('item.user_id = :userId', { userId: context.userId })
      // Same predicate as getEntitiesForItems, or the count disagrees with the
      // page it is supposed to describe.
      .andWhere('item.merged_into_object_id IS NULL');

    if (options.startTime) {
      query = query.andWhere('item.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('item.created_at <= :endTime', { endTime: options.endTime });
    }

    return query.getCount();
  }

  async findById(context: ServiceContext, id: string): Promise<Item | null> {
    const entity = await this.itemRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
        mergedIntoObjectId: IsNull(),
      },
    });

    if (entity == null) {
      return null;
    }

    const [item] = await this.composeMany([entity]);

    return item;
  }

  /**
   * The Items associated with each of `fileIds`, keyed by file id. A file with
   * no items is absent from the map rather than a positional hole a caller
   * could zip its neighbours onto.
   *
   * This method assumes the context user has access to the corresponding Files.
   * This access must be ensured before safely calling this method.
   */
  async findByFileIds(context: ServiceContext, fileIds: string[]): Promise<Map<string, Item[]>> {
    if (fileIds.length === 0) {
      return new Map();
    }

    const queryBuilder = this.itemRepository.createQueryBuilder('object');

    queryBuilder
      .where("object.metadata->>'source_file_id' IN (:...fileIds)", { fileIds })
      .andWhere('object.merged_into_object_id IS NULL');

    if (context.userId !== SYSTEM_USER) {
      queryBuilder.andWhere('object.userId = :userId', { userId: context.userId });
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

    return itemsMap;
  }

  async update(context: ServiceContext, id: string, data: UpdateItemDto): Promise<Item | null> {
    const updateData: Partial<ItemEntity> = {};

    // Turning an existing item digital can collide with a body it already has,
    // and only the stored row knows about that — `physicalPatch` sees the patch.
    // Without this the schema's incorporeality CHECK fires mid-transaction and
    // reaches the caller as a 500, which reads as a server bug rather than the
    // contradiction it is.
    if (data.isDigital === true) {
      await this.assertNoStoredBody(context, id, data);
    }

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

    if (data.purchasePrice !== undefined) {
      updateData.purchasePrice = data.purchasePrice;
    }

    if (data.currency !== undefined) {
      updateData.currency = data.currency;
    }

    if (data.acquiredAt !== undefined) {
      updateData.acquiredAt = data.acquiredAt ?? null;
    }

    if (data.condition !== undefined) {
      updateData.condition = data.condition;
    }

    if (data.quantity !== undefined) {
      updateData.quantity = this.validQuantity(data.quantity);
    }

    if (data.metadata !== undefined) {
      updateData.metadata = data.metadata;
    }

    Object.assign(updateData, this.objectIdentityPatch(data));

    // Canonicalized measurements, appearance and acquisition — same helper the
    // create paths use, so there is one definition of what a stored millimetre
    // means.
    Object.assign(updateData, this.physicalPatch(data));

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
}

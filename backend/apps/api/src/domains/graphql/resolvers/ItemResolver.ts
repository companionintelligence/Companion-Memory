import { BadRequestException, ConflictException, UseGuards } from '@nestjs/common';
import { Parent, Query, Mutation, ResolveField, Resolver, Args, ID, Int } from '@nestjs/graphql';

import { Context, type RequestContext, type UserServiceContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { MaxArraySizePipe } from '@ci/common/pipes';
import {
  type ObjectIdentifierNamespace,
  ObjectIdentifierService,
  normalizeObjectIdentifier,
} from '@ci/domains/graph';
import {
  EntityMergeBlockService,
  type FindItemsFilter,
  type ObjectLifecycleState,
  type Item,
  ItemService,
  ObjectDuplicateService,
  ObjectMergeService,
  type PhysicalItemPropertiesDto,
  ProductModelService,
  adoptIngestIdentity,
} from '@ci/domains/memory';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { ItemAcquisitionLoader } from '../loaders/ItemAcquisitionLoader';
import { ItemFileLoader } from '../loaders/ItemFileLoader';
import { ItemIdentifierLoader } from '../loaders/ItemIdentifierLoader';
import { ItemObservationLoader } from '../loaders/ItemObservationLoader';
import { ItemProductLoader } from '../loaders/ItemProductLoader';
import { TagLoader } from '../loaders/TagLoader';
import { CreateItemInput } from '../types/CreateItemInput';
import { CreateItemPayload } from '../types/CreateItemPayload';
import { CreateThingInput } from '../types/CreateThingInput';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { EntityTagType } from '../types/EntityTagType';
import { FileType } from '../types/FileType';
import { GlobalUID } from '../types/GlobalUID';
import { ItemConnection } from '../types/ItemConnection';
import { ItemDuplicatesPayload } from '../types/ItemDuplicatesPayload';
import { ItemEdge } from '../types/ItemEdge';
import { ItemLifecycleState, ItemSortOrder } from '../types/ItemFilters';
import { AddItemIdentifierInput, RemoveItemIdentifierInput } from '../types/ItemIdentifierInput';
import { ItemCondition, ItemType } from '../types/ItemType';
import { LinkItemToProductInput } from '../types/LinkItemToProductInput';
import { MergeItemsInput } from '../types/MergeItemsInput';
import { MergeItemsPayload, ObjectMergeCountsType } from '../types/MergeItemsPayload';
import { ObjectByIdentifierPayload } from '../types/ObjectByIdentifierPayload';
import { ObjectIdentifierNamespaceEnum, ObjectIdentifierType } from '../types/ObjectIdentifierType';
import { ObjectObservationType } from '../types/ObjectObservationType';
import { PaginationArgs } from '../types/PaginationArgs';
import { PhysicalItemPropertiesInput } from '../types/PhysicalItemProperties';
import { ProductModelType } from '../types/ProductModelType';
import { ReceiptLineItemType } from '../types/ReceiptLineItemType';
import { UpdateItemInput } from '../types/UpdateItemInput';
import { UpdateItemPayload } from '../types/UpdateItemPayload';
import { decodeItemCursor, encodeItemCursor } from '../utils/itemCursor';
import { Paginator } from '../utils/Paginator';

/** Rows `findPage` fetches per round trip while draining for a refinement. */
const REFINE_CHUNK = 200;

/**
 * Rows a refined `items` query will walk before it stops.
 *
 * `query`, `condition`, `hasIdentifier` and every non-default `sort` are
 * predicates the live keyset index cannot serve, so they are applied to a
 * WINDOW of the keyset rather than to the table. The window is bounded on
 * purpose: the shape this replaced loaded every item the user owned into memory
 * and sliced it, which on a real library is a hundred thousand rows per
 * keystroke. A bounded walk is strictly better and, unlike the old one, says so
 * — `pageInfo.hasNextPage` stays true when the walk stopped early.
 */
const MAX_REFINE_SCAN = 2000;

/** Ids per `IN (...)` when checking identifier claims for a drained window. */
const IDENTIFIER_LOOKUP_CHUNK = 500;

/**
 * Page size for the refinement path when the caller names none.
 *
 * Mirrors `ItemService`'s own default and ceiling. Without them a refined query
 * with no `first` would hand back the entire drained window — up to
 * {@link MAX_REFINE_SCAN} nodes — while the same query on the fast path is
 * capped at 200 by the service. Two shapes of the same query returning wildly
 * different amounts of data is the kind of asymmetry that only shows up in
 * production.
 */
const DEFAULT_REFINED_PAGE_SIZE = 50;
const MAX_REFINED_PAGE_SIZE = 200;

/**
 * The physical half of an item input, forwarded verbatim to the service.
 *
 * Verbatim is the point: {@link ItemService} canonicalizes units and validates
 * bounds in ONE place (`normalizePhysicalProperties`), so the resolver must not
 * coerce, default or drop anything on the way past — a `null` here means the
 * caller cleared the field and an absent key means they never mentioned it, and
 * both readings have to survive the trip.
 */
function physicalProperties(input: PhysicalItemPropertiesInput): PhysicalItemPropertiesDto {
  return {
    lengthMm: input.lengthMm,
    widthMm: input.widthMm,
    heightMm: input.heightMm,
    massG: input.massG,
    volumeMl: input.volumeMl,
    dimensions: input.dimensions,
    unitSystem: input.unitSystem,
    colors: input.colors,
    colorHex: input.colorHex,
    materials: input.materials,
    composition: input.composition,
    acquisitionMethod: input.acquisitionMethod,
    acquiredFrom: input.acquiredFrom,
    manufacturedAt: input.manufacturedAt,
    expiresAt: input.expiresAt,
    isDigital: input.isDigital,
  };
}

/** Does the raw `identifier_codes` bag assert anything at all? */
function hasIdentifierCodes(item: Item): boolean {
  const codes = item.identifierCodes;
  if (codes == null) {
    return false;
  }

  return Object.values(codes).some((value) => value != null && String(value).trim() !== '');
}

/** Case-insensitive substring match over the fields a person would type at. */
function matchesQuery(item: Item, needle: string): boolean {
  return [item.name, item.description, item.brand, item.model, item.category, item.subcategory].some(
    (field) => field != null && field.toLowerCase().includes(needle),
  );
}

/** `null` sorts last in every order, because "unknown" is not "smallest". */
function compareNullable<T>(a: T | null, b: T | null, compare: (x: T, y: T) => number): number {
  if (a == null && b == null) {
    return 0;
  }

  if (a == null) {
    return 1;
  }

  if (b == null) {
    return -1;
  }

  return compare(a, b);
}

function compareItems(sort: ItemSortOrder, a: Item, b: Item): number {
  switch (sort) {
    case ItemSortOrder.OLDEST:
      return a.createdAt.getTime() - b.createdAt.getTime();
    case ItemSortOrder.NAME_ASC:
      return compareNullable(a.name, b.name, (x, y) => x.localeCompare(y));
    case ItemSortOrder.NAME_DESC:
      return compareNullable(a.name, b.name, (x, y) => y.localeCompare(x));
    case ItemSortOrder.VALUE_DESC:
      return compareNullable(a.currentValue ?? a.purchasePrice, b.currentValue ?? b.purchasePrice, (x, y) =>
        Number(y) === Number(x) ? 0 : Number(y) - Number(x),
      );
    case ItemSortOrder.VALUE_ASC:
      return compareNullable(a.currentValue ?? a.purchasePrice, b.currentValue ?? b.purchasePrice, (x, y) =>
        Number(x) === Number(y) ? 0 : Number(x) - Number(y),
      );
    case ItemSortOrder.RECENTLY_ACQUIRED:
      return compareNullable(a.acquiredAt, b.acquiredAt, (x, y) => y.getTime() - x.getTime());
    case ItemSortOrder.RECENTLY_SEEN:
      return compareNullable(a.lastSeenAt, b.lastSeenAt, (x, y) => y.getTime() - x.getTime());
    case ItemSortOrder.NEWEST:
    default:
      return b.createdAt.getTime() - a.createdAt.getTime();
  }
}

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => ItemType)
export class ItemResolver {
  constructor(
    private readonly itemFileLoader: ItemFileLoader,
    private readonly itemService: ItemService,
    private readonly tagLoader: TagLoader,
    private readonly itemIdentifierLoader: ItemIdentifierLoader,
    private readonly itemProductLoader: ItemProductLoader,
    private readonly itemObservationLoader: ItemObservationLoader,
    private readonly itemAcquisitionLoader: ItemAcquisitionLoader,
    private readonly objectIdentifierService: ObjectIdentifierService,
    private readonly objectMergeService: ObjectMergeService,
    private readonly objectDuplicateService: ObjectDuplicateService,
    private readonly productModelService: ProductModelService,
    private readonly entityMergeBlockService: EntityMergeBlockService,
  ) {}

  /**
   * The things list.
   *
   * `category`, `brand` and `lifecycleState` are real SQL predicates on
   * `ItemService.findPage`, which walks `objects_live_keyset_idx` and pages in
   * the database — cost bounded by page size however much the user owns. That
   * is the whole point of this query no longer calling `findAll`, which loaded
   * the entire table and sliced it in memory.
   *
   * `query`, `condition`, `hasIdentifier` and any `sort` other than `NEWEST`
   * are things the keyset cannot serve. They are applied to a bounded WINDOW of
   * it ({@link MAX_REFINE_SCAN} rows) rather than to the table, and the
   * connection says so: when the walk stops early `hasNextPage` stays true and
   * `totalCount` counts the matches found in the window, not the library. That
   * is a smaller promise than the old code made and a much smaller read.
   *
   * Forward-only. `last`/`before` are rejected rather than quietly ignored: a
   * keyset cursor cannot be walked backwards, and silently returning the first
   * page for a backwards request is worse than an error.
   */
  @Query(() => ItemConnection)
  async items(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
    @Args('query', {
      type: () => String,
      nullable: true,
      description: 'Substring of name, description, brand, model or category.',
    })
    query?: string,
    @Args('category', { type: () => String, nullable: true }) category?: string,
    @Args('brand', { type: () => String, nullable: true }) brand?: string,
    @Args('condition', { type: () => ItemCondition, nullable: true }) condition?: ItemCondition,
    @Args('lifecycleState', { type: () => ItemLifecycleState, nullable: true })
    lifecycleState?: ObjectLifecycleState,
    @Args('hasIdentifier', {
      type: () => Boolean,
      nullable: true,
      description: 'Only things that do (or do not) carry a barcode, serial or other code.',
    })
    hasIdentifier?: boolean,
    @Args('sort', { type: () => ItemSortOrder, nullable: true }) sort?: ItemSortOrder,
  ): Promise<ItemConnection> {
    const serviceContext = toServiceContext(context);

    if (pagination.last != null || pagination.before != null) {
      throw new BadRequestException(
        'The things list is a forward-only keyset: use first/after, not last/before.',
      );
    }

    const filter: FindItemsFilter = {
      ...(category != null ? { category } : {}),
      ...(brand != null ? { brand } : {}),
      ...(lifecycleState != null ? { lifecycleState } : {}),
    };

    const trimmedQuery = query?.trim().toLowerCase();
    const needle = trimmedQuery !== undefined && trimmedQuery !== '' ? trimmedQuery : undefined;
    const order = sort ?? ItemSortOrder.NEWEST;
    const refined =
      needle != null || condition != null || hasIdentifier != null || order !== ItemSortOrder.NEWEST;

    if (!refined) {
      return this.keysetPage(serviceContext, filter, pagination);
    }

    return this.refinedPage(serviceContext, filter, pagination, {
      needle,
      condition,
      hasIdentifier,
      order,
    });
  }

  /** The fast path: one `findPage` call, cursors straight off the keyset. */
  private async keysetPage(
    serviceContext: UserServiceContext,
    filter: FindItemsFilter,
    pagination: PaginationArgs,
  ): Promise<ItemConnection> {
    const after = decodeItemCursor(pagination.after);

    const page = await this.itemService.findPage(serviceContext, filter, {
      limit: pagination.first ?? undefined,
      afterCreatedAt: after?.createdAt ?? null,
      afterId: after?.id ?? null,
    });

    const edges: ItemEdge[] = page.items.map((entity) => ({
      node: ItemType.toType(entity),
      cursor: encodeItemCursor({ createdAt: entity.createdAt, id: entity.id }),
    }));

    return {
      edges,
      pageInfo: {
        hasNextPage: page.hasMore,
        hasPreviousPage: after != null,
        startCursor: edges[0]?.cursor ?? null,
        endCursor: edges[edges.length - 1]?.cursor ?? null,
      },
      // No COUNT is issued — see the note on the query. This is what the page
      // knows, not what the library holds.
      totalCount: edges.length,
    };
  }

  /**
   * The refinement path: drain a bounded window of the keyset, then filter and
   * order it. Cursors here are item global ids, matching every other
   * `Paginator`-backed list in the schema.
   */
  private async refinedPage(
    serviceContext: UserServiceContext,
    filter: FindItemsFilter,
    pagination: PaginationArgs,
    refinement: {
      needle?: string;
      condition?: ItemCondition;
      hasIdentifier?: boolean;
      order: ItemSortOrder;
    },
  ): Promise<ItemConnection> {
    const { window, truncated } = await this.drain(serviceContext, filter);

    let candidates = window;

    if (refinement.needle != null) {
      const needle = refinement.needle;
      candidates = candidates.filter((item) => matchesQuery(item, needle));
    }

    if (refinement.condition != null) {
      const wanted = refinement.condition as string;
      candidates = candidates.filter((item) => item.condition === wanted);
    }

    if (refinement.hasIdentifier != null) {
      candidates = await this.filterByIdentifierPresence(
        serviceContext,
        candidates,
        refinement.hasIdentifier,
      );
    }

    const ordered = [...candidates].sort((a, b) => compareItems(refinement.order, a, b));

    const { slice, pageInfo, totalCount } = Paginator.paginate(ordered, {
      first: Math.min(Math.max(pagination.first ?? DEFAULT_REFINED_PAGE_SIZE, 1), MAX_REFINED_PAGE_SIZE),
      after: pagination.after ?? undefined,
      getId: (entity) => GlobalUID.encode('item', entity.id),
    });

    const edges: ItemEdge[] = slice.map((entity) => {
      const node = ItemType.toType(entity);

      return { node, cursor: node.id };
    });

    return {
      edges,
      pageInfo: {
        ...pageInfo,
        // The walk stopped early, so "no next page" would be a lie even when
        // this window is exhausted.
        hasNextPage: pageInfo.hasNextPage || truncated,
      },
      totalCount,
    };
  }

  /** Walk the keyset up to {@link MAX_REFINE_SCAN} rows. */
  private async drain(
    serviceContext: UserServiceContext,
    filter: FindItemsFilter,
  ): Promise<{ window: Item[]; truncated: boolean }> {
    const window: Item[] = [];
    let cursor: { createdAt: Date; id: string } | null = null;

    while (window.length < MAX_REFINE_SCAN) {
      const page = await this.itemService.findPage(serviceContext, filter, {
        limit: Math.min(REFINE_CHUNK, MAX_REFINE_SCAN - window.length),
        afterCreatedAt: cursor?.createdAt ?? null,
        afterId: cursor?.id ?? null,
      });

      window.push(...page.items);

      if (!page.hasMore || page.nextCursor == null) {
        return { window, truncated: false };
      }

      cursor = page.nextCursor;
    }

    return { window, truncated: true };
  }

  /**
   * Split a window by whether each unit carries an identifier.
   *
   * Both sources count. `identifier_codes` is the raw jsonb bag the importer
   * writes, and `ci.object_identifiers` is the normalized claim index — a unit
   * whose bag is empty but whose claim won still HAS an identifier, and a unit
   * whose claim LOST (first-writer-wins) still asserted one. Checking only the
   * claim table would hide every duplicate; checking only the bag would hide
   * every scan.
   */
  private async filterByIdentifierPresence(
    serviceContext: UserServiceContext,
    items: Item[],
    wanted: boolean,
  ): Promise<Item[]> {
    const undecided = items.filter((item) => !hasIdentifierCodes(item));
    const claimed = new Set<string>();

    for (let offset = 0; offset < undecided.length; offset += IDENTIFIER_LOOKUP_CHUNK) {
      const chunk = undecided.slice(offset, offset + IDENTIFIER_LOOKUP_CHUNK);
      const bySubject = await this.objectIdentifierService.listForSubjects(
        serviceContext.userId,
        'object_instance',
        chunk.map((item) => item.id),
      );

      for (const [id, rows] of bySubject) {
        if (rows.length > 0) {
          claimed.add(id);
        }
      }
    }

    return items.filter((item) => (hasIdentifierCodes(item) || claimed.has(item.id)) === wanted);
  }

  @Query(() => ItemType, { nullable: true })
  async item(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ItemType | null> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('item', gid);

    const entity = await this.itemService.findById(serviceContext, id);

    return entity ? ItemType.toType(entity) : null;
  }

  /**
   * The barcode-scan entry point: what, if anything, does this code already
   * refer to?
   *
   * Subject-polymorphic by design. A GTIN answers with a product MODEL — you
   * know what it is, you may not own one — and a serial answers with the owned
   * INSTANCE. An instance answer carries its model too, so one scan resolves
   * both "which one" and "what is it".
   *
   * An unreadable code (failed check digit, wrong length) comes back unmatched
   * rather than as an error: a bad scan is a scan, not a client bug.
   */
  @Query(() => ObjectByIdentifierPayload)
  async objectByIdentifier(
    @Context() context: RequestContext,
    @Args('namespace', { type: () => ObjectIdentifierNamespaceEnum }) namespace: string,
    @Args('value', { type: () => String }) value: string,
    @Args('brand', { type: () => String, nullable: true }) brand?: string,
    @Args('sourceSystem', { type: () => String, nullable: true }) sourceSystem?: string,
  ): Promise<ObjectByIdentifierPayload> {
    const serviceContext = toServiceContext(context);

    const normalized = normalizeObjectIdentifier(namespace as ObjectIdentifierNamespace, value);
    if (normalized == null) {
      return { matched: false, namespace: null, value: null };
    }

    const match = await this.objectIdentifierService.resolve(
      serviceContext.userId,
      normalized.namespace,
      value,
      { brand, sourceSystem },
    );

    if (match == null) {
      return {
        matched: false,
        namespace: normalized.namespace,
        value: normalized.valueNormalized,
      };
    }

    if (match.subjectType === 'product_model') {
      const product = await this.productModelService.findById(serviceContext, match.subjectId);

      return {
        matched: product != null,
        namespace: match.namespace,
        value: match.valueNormalized,
        subjectType: match.subjectType,
        confidence: match.confidence,
        product: product ? ProductModelType.toType(product) : null,
      };
    }

    const item = await this.itemService.findById(serviceContext, match.subjectId);
    const product =
      item?.productId == null
        ? null
        : await this.productModelService.findById(serviceContext, item.productId);

    return {
      matched: item != null,
      namespace: match.namespace,
      value: match.valueNormalized,
      subjectType: match.subjectType,
      confidence: match.confidence,
      item: item ? ItemType.toType(item) : null,
      product: product ? ProductModelType.toType(product) : null,
    };
  }

  /**
   * Duplicate-owned-unit suggestions for the merge review UI: groups of live
   * units sharing an identifier, a product, or a brand+model bought the same
   * day. Suggestions only — merging is `mergeItems`, and it is a user decision.
   */
  @Query(() => ItemDuplicatesPayload)
  async itemDuplicates(
    @Context() context: RequestContext,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true }) offset?: number,
  ): Promise<ItemDuplicatesPayload> {
    const serviceContext = toServiceContext(context);

    const page = await this.objectDuplicateService.findDuplicateGroups(serviceContext, {
      limit: limit ?? undefined,
      offset: offset ?? undefined,
    });

    return {
      totalCount: page.totalCount,
      hasMore: page.hasMore,
      groups: page.groups.map((group) => ({
        reason: group.reason,
        value: group.value,
        totalItems: group.totalItems,
        items: group.items.map((item) => ItemType.toType(item)),
      })),
    };
  }

  @Mutation(() => CreateItemPayload)
  async createItem(
    @Context() context: RequestContext,
    @Args('input') input: CreateItemInput,
  ): Promise<CreateItemPayload> {
    const serviceContext = toServiceContext(context);

    const entity = await this.itemService.create(serviceContext, {
      name: input.name,
      description: input.description,
      category: input.category,
      subcategory: input.subcategory,
      brand: input.brand,
      model: input.model,
      currentValue: input.currentValue,
      purchasePrice: input.purchasePrice,
      currency: input.currency,
      acquiredAt: input.acquiredAt,
      condition: input.condition,
      identifierCodes: input.identifierCodes,
      metadata: input.metadata,
      ...physicalProperties(input),
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      item: entity ? ItemType.toType(entity) : undefined,
    };
  }

  /**
   * Batch, idempotent things ingest for the importer. Each input dedupes on the
   * provenance triple (owner, sourceType, sourceSystem, sourceId) so a re-sync
   * returns the existing item instead of inserting a duplicate (e.g. an Amazon
   * order id mapped to identifierCodes.order_id AND sourceId). Returns the
   * created-or-existing items in input order.
   */
  @Mutation(() => [ItemType])
  async createThings(
    @Context() context: RequestContext,
    @Args('input', { type: () => [CreateThingInput] }, new MaxArraySizePipe())
    input: CreateThingInput[],
  ): Promise<ItemType[]> {
    const serviceContext = toServiceContext(context);

    const items = await this.itemService.createMany(
      serviceContext,
      input.map((item) => ({
        name: item.name,
        description: item.description,
        category: item.category,
        subcategory: item.subcategory,
        brand: item.brand,
        model: item.model,
        purchasePrice: item.purchasePrice,
        currentValue: item.currentValue,
        currency: item.currency,
        acquiredAt: item.acquiredAt,
        condition: item.condition,
        identifierCodes: item.identifierCodes,
        metadata: item.metadata,
        sourceType: item.sourceType,
        sourceSystem: adoptIngestIdentity(item.sourceSystem, item.sourceId).system,
        sourceId: adoptIngestIdentity(item.sourceSystem, item.sourceId).id,
        ...physicalProperties(item),
      })),
    );

    return items.map((item) => ItemType.toType(item));
  }

  @Mutation(() => UpdateItemPayload)
  async updateItem(
    @Context() context: RequestContext,
    @Args('input') input: UpdateItemInput,
  ): Promise<UpdateItemPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('item', input.id);

    const entity = await this.itemService.update(serviceContext, id, {
      name: input.name,
      description: input.description,
      category: input.category,
      subcategory: input.subcategory,
      brand: input.brand,
      model: input.model,
      currentValue: input.currentValue,
      purchasePrice: input.purchasePrice,
      currency: input.currency,
      acquiredAt: input.acquiredAt,
      condition: input.condition,
      lifecycleState: input.lifecycleState,
      metadata: input.metadata,
      ...physicalProperties(input),
    });

    if (entity == null) {
      return {
        success: false,
      };
    }

    return {
      success: true,
      item: entity ? ItemType.toType(entity) : undefined,
    };
  }

  @Mutation(() => DeleteByIdPayload)
  async deleteItem(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    const serviceContext = toServiceContext(context);

    const id = GlobalUID.parse('item', input.id);

    const success = await this.itemService.remove(serviceContext, id);

    if (!success) {
      return {
        success: false,
      };
    }

    return {
      success,
      deletedId: input.id,
    };
  }

  /**
   * Merge duplicate owned units into one canonical unit: re-points identifier
   * claims, sightings, receipt lines and graph edges, folds the fields, and
   * tombstones the sources. See ObjectMergeService.
   */
  @Mutation(() => MergeItemsPayload)
  // ObjectMergeService tombstones each source and deletes the sources' search rows. One-way: the
  // schema has no unmerge.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async mergeItems(
    @Context() context: RequestContext,
    @Args('input') input: MergeItemsInput,
  ): Promise<MergeItemsPayload> {
    const serviceContext = toServiceContext(context);

    const sourceIds = input.sourceIds.map((gid) => GlobalUID.parse('item', gid));
    const targetId = GlobalUID.parse('item', input.targetId);

    const { target, counts } = await this.objectMergeService.mergeObjects(
      serviceContext,
      sourceIds,
      targetId,
    );

    return {
      success: true,
      item: ItemType.toType(target),
      counts: ObjectMergeCountsType.toType(counts),
    };
  }

  /**
   * Record that a suggested duplicate group is NOT the same thing.
   *
   * The counterpart to {@link ItemResolver.mergeItems}, and the reason
   * `itemDuplicates` can afford to be derived: the groups are recomputed from
   * identifiers, products and brand+model on every call, so without somewhere
   * to put the rejection "no, I own two of these" survives exactly until the
   * next page load — and the same group is proposed again, forever.
   *
   * Every PAIR in the group is blocked, because the group is what was offered.
   * `ObjectDuplicateService` already reads `ci.entity_merge_blocks` through
   * `blockedPairsAmong`/`dropBlocked`, so a blocked pair stops being proposed
   * on the very next query and a three-member group with one blocked pair
   * keeps the part the user never rejected.
   *
   * Deliberately the same shape and the same table as
   * `PersonResolver.rejectPersonDuplicates` — `ci.entity_merge_blocks` is
   * entity-agnostic by design, and an item's `object_id` IS an entity id. The
   * one thing this does NOT do that its Person twin does is stamp
   * `ci.merge_candidates`: that queue is written only by
   * `clean.duplicate_detect`, which proposes Person pairs and nothing else, so
   * there is no item row in it to resolve.
   */
  @Mutation(() => Boolean, {
    description: 'Mark a suggested duplicate group as distinct things, so it is never re-proposed',
  })
  async rejectItemDuplicates(
    @Context() context: RequestContext,
    @Args('itemIds', { type: () => [ID] }) itemIds: string[],
  ): Promise<boolean> {
    const ids = itemIds.map((gid) => GlobalUID.parse('item', gid));

    const serviceContext = toServiceContext(context);

    await this.entityMergeBlockService.blockAllPairs(serviceContext, ids, 'user_rejected');

    return true;
  }

  /**
   * Claim an identifier for one owned unit (source='user', confidence 1.0).
   *
   * FIRST-WRITER-WINS: if the code already belongs to another thing the claim
   * is NOT stolen, and the conflict is surfaced. Two things claiming one
   * barcode is a duplicate signal for review, not something to resolve by
   * silently re-pointing — the right fix is `mergeItems`.
   */
  @Mutation(() => [ObjectIdentifierType])
  async addItemIdentifier(
    @Context() context: RequestContext,
    @Args('input') input: AddItemIdentifierInput,
  ): Promise<ObjectIdentifierType[]> {
    const serviceContext = toServiceContext(context);

    const itemId = GlobalUID.parse('item', input.itemId);

    // Establish ownership before writing into the owner-scoped (but not
    // item-scoped) claim table, or a claim can be left pointing at a row this
    // user cannot see.
    const owned = await this.itemService.findById(serviceContext, itemId);
    if (owned == null) {
      throw new BadRequestException('No such thing.');
    }

    const match = await this.objectIdentifierService.addForSubject(
      serviceContext.userId,
      'object_instance',
      itemId,
      input.namespace as ObjectIdentifierNamespace,
      input.value,
      { brand: input.scope?.brand, sourceSystem: input.scope?.sourceSystem },
    );

    if (match == null) {
      throw new BadRequestException(
        `"${input.value}" does not normalize to a usable ${input.namespace} identifier`,
      );
    }

    if (match.subjectId !== itemId) {
      throw new ConflictException(
        'That identifier already belongs to another thing. Merge the two things instead of re-assigning it.',
      );
    }

    this.itemIdentifierLoader.clear(serviceContext, itemId);

    return this.identifiersFor(serviceContext, itemId);
  }

  @Mutation(() => [ObjectIdentifierType])
  // Same hard delete as removePersonIdentifier, via ObjectIdentifierService.removeForSubject.
  // Declared so the two siblings cannot drift apart on a rename.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async removeItemIdentifier(
    @Context() context: RequestContext,
    @Args('input') input: RemoveItemIdentifierInput,
  ): Promise<ObjectIdentifierType[]> {
    const serviceContext = toServiceContext(context);

    const itemId = GlobalUID.parse('item', input.itemId);

    await this.objectIdentifierService.removeForSubject(
      serviceContext.userId,
      'object_instance',
      itemId,
      input.namespace as ObjectIdentifierNamespace,
      input.value,
      { brand: input.scope?.brand, sourceSystem: input.scope?.sourceSystem },
    );

    this.itemIdentifierLoader.clear(serviceContext, itemId);

    return this.identifiersFor(serviceContext, itemId);
  }

  /**
   * Point an owned unit at the catalog model it is an instance of, or unlink it
   * by passing a null `productId`.
   */
  @Mutation(() => UpdateItemPayload)
  async linkItemToProduct(
    @Context() context: RequestContext,
    @Args('input') input: LinkItemToProductInput,
  ): Promise<UpdateItemPayload> {
    const serviceContext = toServiceContext(context);

    const itemId = GlobalUID.parse('item', input.itemId);
    const productId = input.productId == null ? null : GlobalUID.parse('product', input.productId);

    if (productId != null) {
      const product = await this.productModelService.findById(serviceContext, productId);
      if (product == null) {
        throw new BadRequestException('No such product model.');
      }
    }

    const entity = await this.itemService.update(serviceContext, itemId, { productId });

    if (entity == null) {
      return { success: false };
    }

    if (entity.productId != null) {
      this.itemProductLoader.clear(serviceContext, entity.productId);
    }

    return {
      success: true,
      item: ItemType.toType(entity),
    };
  }

  @ResolveField(() => FileType, { nullable: true })
  async file(@Context() context: RequestContext, @Parent() parent: ItemType): Promise<FileType | null> {
    const serviceContext = toServiceContext(context);

    if (parent.__source.sourceFileId == null) {
      return null;
    }

    const file = await this.itemFileLoader.load(serviceContext, parent.__source.sourceFileId);

    if (file == null) {
      return null;
    }

    return FileType.toType(file);
  }

  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: ItemType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'item',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }

  /** Codes claimed by THIS unit — a serial, an IMEI, a VIN. */
  @ResolveField(() => [ObjectIdentifierType])
  async identifiers(
    @Context() context: RequestContext,
    @Parent() parent: ItemType,
  ): Promise<ObjectIdentifierType[]> {
    const serviceContext = toServiceContext(context);

    const rows = await this.itemIdentifierLoader.load(serviceContext, parent.__source.id);

    return rows.map((row) => ObjectIdentifierType.toType(row));
  }

  /** The catalog model this unit is an INSTANCE_OF. */
  @ResolveField(() => ProductModelType, { nullable: true })
  async product(
    @Context() context: RequestContext,
    @Parent() parent: ItemType,
  ): Promise<ProductModelType | null> {
    const serviceContext = toServiceContext(context);

    const productId = parent.__source.productId;
    if (productId == null) {
      return null;
    }

    const product = await this.itemProductLoader.load(serviceContext, productId);

    return product ? ProductModelType.toType(product) : null;
  }

  /** Sightings resolved to this unit, most recent first. */
  @ResolveField(() => [ObjectObservationType])
  async observations(
    @Context() context: RequestContext,
    @Parent() parent: ItemType,
  ): Promise<ObjectObservationType[]> {
    const serviceContext = toServiceContext(context);

    const rows = await this.itemObservationLoader.load(serviceContext, parent.__source.id);

    return rows.map((row) => ObjectObservationType.toType(row));
  }

  /** The receipt line this unit was minted from. */
  @ResolveField(() => ReceiptLineItemType, { nullable: true })
  async acquisition(
    @Context() context: RequestContext,
    @Parent() parent: ItemType,
  ): Promise<ReceiptLineItemType | null> {
    const serviceContext = toServiceContext(context);

    const lineItemId = parent.__source.acquisitionLineItemId;
    if (lineItemId == null) {
      return null;
    }

    const line = await this.itemAcquisitionLoader.load(serviceContext, lineItemId);

    return line ? ReceiptLineItemType.toType(line) : null;
  }

  private async identifiersFor(
    serviceContext: UserServiceContext,
    itemId: string,
  ): Promise<ObjectIdentifierType[]> {
    const bySubject = await this.objectIdentifierService.listForSubjects(
      serviceContext.userId,
      'object_instance',
      [itemId],
    );

    return (bySubject.get(itemId) ?? []).map((row) => ObjectIdentifierType.toType(row));
  }
}

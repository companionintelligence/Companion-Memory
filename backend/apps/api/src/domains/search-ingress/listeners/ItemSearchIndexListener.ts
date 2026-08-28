import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
// The barrel, per the `no-cross-domain-internals` rule. It closes no require
// cycle: GraphModule imports MemoryModule, and neither imports search-ingress.
// The class is only the DI token here — the PROVIDER comes from MemoryModule
// (which this module already imports and which exports it), so no second
// instance is created.
import { ObjectIdentifierService } from '@ci/domains/graph';
import { type Item, ItemService, PlaceService, ProductModelService } from '@ci/domains/memory';
import {
  ItemCreatedEvent,
  ItemRemovedEvent,
  ItemUpdatedEvent,
  type ItemCreatedPayload,
  type ItemDeletedPayload,
  type ItemUpdatedPayload,
} from '@ci/domains/memory/events';
import {
  identifierSearchValues,
  itemSearchDocument,
  itemWeightedTexts,
} from '@ci/domains/search-ingress/searchTexts';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

/**
 * The parts of an owned unit's index text that do NOT live on `ci.objects`:
 * the identifiers it claims and the catalog model it is an instance of. The
 * search index has no join back to either table, so both are denormalized into
 * the unit's own document/tsvector at index time.
 */
interface ItemIndexContext {
  identifierValues: string[];
  productTitle: string | null;
  productBrand: string | null;
  productModelNumber: string | null;
  productCategory: string | null;
  productSubcategory: string | null;
}

const EMPTY_ITEM_CONTEXT: ItemIndexContext = {
  identifierValues: [],
  productTitle: null,
  productBrand: null,
  productModelNumber: null,
  productCategory: null,
  productSubcategory: null,
};

@Injectable()
export class ItemSearchIndexListener {
  constructor(
    private readonly itemService: ItemService,
    private readonly placeService: PlaceService,
    private readonly productModelService: ProductModelService,
    private readonly objectIdentifierService: ObjectIdentifierService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ItemSearchIndexListener.name);
  }

  @OnEvent(ItemCreatedEvent, { queue: 'search-index' })
  async indexItem(payload: ItemCreatedPayload | ItemUpdatedPayload) {
    this.logger.log('Adding new item to search index', {
      itemId: payload.itemId,
    });

    await this.upsertItem(payload);
  }

  @OnEvent(ItemUpdatedEvent, { queue: 'search-index' })
  async updateItem(payload: ItemCreatedPayload | ItemUpdatedPayload) {
    this.logger.log('Updating item in search index', {
      itemId: payload.itemId,
    });

    await this.upsertItem(payload);
  }

  @OnEvent(ItemRemovedEvent, { queue: 'search-index' })
  async unindexItem(payload: ItemDeletedPayload) {
    this.logger.log('Removing item in search index', {
      itemId: payload.itemId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'item',
      entityId: payload.itemId,
    });

    this.logger.log('Removed embedding for item');

    await this.vectorService.remove(context, {
      entityType: 'item',
      entityId: payload.itemId,
    });

    this.logger.log('Removed tsvector for item');
  }

  private async upsertItem(payload: ItemCreatedPayload | ItemUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const item = await this.itemService.findById(context, payload.itemId);

    if (item == null) {
      this.logger.warn('Item not found, skipping indexing');

      return;
    }

    // Merge tombstones must never (re-)enter the search index:
    // ObjectMergeService deleted their embedding + vector on purpose, and the
    // backfill sweep excludes them via ENTITY_SOURCE_MAP.item.backfillPredicate.
    // This is the live-path half of the same rule — an ItemUpdatedEvent that
    // raced the merge would otherwise put the loser straight back, and clicking
    // the result lands on a row nothing points at.
    if (item.mergedIntoObjectId != null) {
      this.logger.log('Item is a merge tombstone, removing from search index', {
        itemId: item.id,
      });

      await this.embeddingService.remove(context, { entityType: 'item', entityId: item.id });
      await this.vectorService.remove(context, { entityType: 'item', entityId: item.id });

      return;
    }

    if (item.userId == null) {
      this.logger.warn('Item has no associated user, cannot index');

      return;
    }

    const placeName = await this.lastSeenPlaceName(item.lastSeenPlaceEntityId);
    const extras = await this.indexContext(item);
    const fields = { ...item, lastSeenPlaceName: placeName, ...extras };
    const searchDocument = this.getSearchDocument(fields);

    if (searchDocument == null) {
      this.logger.log('Item has no search document, skipping embedding');
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

      await this.embeddingService.upsert(
        {
          userId: item.userId,
        },
        {
          entityType: 'item',
          entityId: item.id,
          embedding,
        },
      );

      this.logger.log('Generated embedding for item');
    }

    const searchItem = this.getSearchItem(fields);

    if (searchItem.length === 0) {
      this.logger.log('Item has no search item, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: item.userId,
        },
        {
          entityType: 'item',
          entityId: item.id,
          searchableText: searchItem,
        },
      );

      this.logger.log('Generated tsvector for item');
    }
  }

  private async lastSeenPlaceName(placeId: string | null): Promise<string | null> {
    if (!placeId) {
      return null;
    }

    const place = await this.placeService.findById({ userId: SYSTEM_USER }, placeId);
    const name = place?.name?.trim();

    return name && name.length > 0 ? name : null;
  }

  /**
   * Load the unit's identifier claims and its catalog model.
   *
   * Identifier lookups are keyed on `owner_user_id`, which is nullable on
   * `ci.objects` and falls back to `user_id` — the claim table is written with
   * whichever the writer had, and an item with no owner simply has no claims.
   */
  private async indexContext(item: Item): Promise<ItemIndexContext> {
    const ownerUserId = item.ownerUserId ?? item.userId;

    const identifierValues = ownerUserId == null ? [] : await this.identifierValues(ownerUserId, item.id);

    if (item.productId == null) {
      return { ...EMPTY_ITEM_CONTEXT, identifierValues };
    }

    const product = await this.productModelService.findById({ userId: SYSTEM_USER }, item.productId);

    if (product == null) {
      // A dangling product_id (the model was hard-deleted) is not a reason to
      // refuse to index the unit itself.
      return { ...EMPTY_ITEM_CONTEXT, identifierValues };
    }

    return {
      identifierValues,
      productTitle: product.title,
      productBrand: product.brand,
      productModelNumber: product.modelNumber,
      productCategory: product.category,
      productSubcategory: product.subcategory,
    };
  }

  private async identifierValues(ownerUserId: string, itemId: string): Promise<string[]> {
    const claims = await this.objectIdentifierService.listForSubjects(ownerUserId, 'object_instance', [
      itemId,
    ]);

    return identifierSearchValues(claims.get(itemId) ?? []);
  }

  private getSearchItem(fields: Parameters<typeof itemWeightedTexts>[0]): WeightedText[] {
    return itemWeightedTexts(fields);
  }

  private getSearchDocument(fields: Parameters<typeof itemSearchDocument>[0]): string | null {
    return itemSearchDocument(fields);
  }
}

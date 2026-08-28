import { Injectable } from '@nestjs/common';

import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';
import { EmbeddingGenerationService, shouldEmbedType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
// Via the barrel, and provided by MemoryModule — see the note on
// ItemSearchIndexListener.
import { ObjectIdentifierService } from '@ci/domains/graph';
import { type ProductModel, ProductModelService } from '@ci/domains/memory';
import {
  ProductCreatedEvent,
  ProductRemovedEvent,
  ProductUpdatedEvent,
  type ProductCreatedPayload,
  type ProductDeletedPayload,
  type ProductUpdatedPayload,
} from '@ci/domains/memory/events';
import {
  identifierSearchValues,
  productSearchDocument,
  productWeightedTexts,
} from '@ci/domains/search-ingress/searchTexts';

import { EmbeddingService } from '../services/EmbeddingService';
import { IndexSkipService } from '../services/IndexSkipService';
import { VectorService } from '../services/VectorService';
import { type WeightedText } from '../types';

/**
 * Indexes catalog product models (`ci.product_models`) as the first-class
 * `product` search type.
 *
 * A model is indexed on its OWN, not only through the units that instance it:
 * "my Bose QC45" has to find something even when the owned unit's row says
 * nothing but "headphones", and a model the user has researched but not bought
 * has no unit at all.
 */
@Injectable()
export class ProductSearchIndexListener {
  constructor(
    private readonly productModelService: ProductModelService,
    private readonly objectIdentifierService: ObjectIdentifierService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly indexSkipService: IndexSkipService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ProductSearchIndexListener.name);
  }

  @OnEvent(ProductCreatedEvent, { queue: 'search-index' })
  async indexProduct(payload: ProductCreatedPayload | ProductUpdatedPayload) {
    this.logger.log('Adding new product model to search index', {
      productId: payload.productId,
    });

    await this.upsertProduct(payload);
  }

  @OnEvent(ProductUpdatedEvent, { queue: 'search-index' })
  async updateProduct(payload: ProductCreatedPayload | ProductUpdatedPayload) {
    this.logger.log('Updating product model in search index', {
      productId: payload.productId,
    });

    await this.upsertProduct(payload);
  }

  @OnEvent(ProductRemovedEvent, { queue: 'search-index' })
  async unindexProduct(payload: ProductDeletedPayload) {
    this.logger.log('Removing product model from search index', {
      productId: payload.productId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'product',
      entityId: payload.productId,
    });

    this.logger.log('Removed embedding for product model');

    await this.vectorService.remove(context, {
      entityType: 'product',
      entityId: payload.productId,
    });

    this.logger.log('Removed tsvector for product model');
  }

  private async upsertProduct(payload: ProductCreatedPayload | ProductUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const product = await this.productModelService.findById(context, payload.productId);

    // A merge tombstone lands here, not in a branch of its own:
    // `ProductModelService.liveScope` filters `merged_into_product_id` for the
    // system context too, so a merged-away model reads as absent and this
    // method can never be handed one. Removing its rows is
    // `ObjectMergeService.mergeProductModels`' job, in the transaction that
    // tombstoned it, and the backfill sweep stays off it via
    // `ENTITY_SOURCE_MAP.product.backfillPredicate`.
    if (product == null) {
      this.logger.warn('Product model not found, skipping indexing');

      return;
    }

    if (product.userId == null) {
      this.logger.warn('Product model has no associated user, cannot index');

      return;
    }

    const fields = { ...product, identifierValues: await this.identifierValues(product) };
    const searchDocument = productSearchDocument(fields);

    if (!shouldEmbedType('product')) {
      this.logger.log('Product type not in embed allowlist, skipping embedding');
    } else if (searchDocument == null) {
      this.logger.log('Product model has no search document, skipping embedding');

      // Persist the skip so the backfill sweep (a LEFT JOIN on
      // ci_search.embeddings) stops re-finding this row on every run. Like
      // persons, products skip only on 'empty': "Mug" is a perfectly good
      // product title, so the too-short/trivial heuristics tuned for chat
      // messages must not apply here.
      await this.indexSkipService.recordSkip({
        entityType: 'product',
        entityId: product.id,
        reason: 'empty',
      });
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

      await this.embeddingService.upsert(
        {
          userId: product.userId,
        },
        {
          entityType: 'product',
          entityId: product.id,
          embedding,
        },
      );

      // A model that gained a title/brand is no longer skipped.
      await this.indexSkipService.clearSkip({
        entityType: 'product',
        entityId: product.id,
      });

      this.logger.log('Generated embedding for product model');
    }

    const searchContent: WeightedText[] = productWeightedTexts(fields);

    if (searchContent.length === 0) {
      this.logger.log('Product model has no search content, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: product.userId,
        },
        {
          entityType: 'product',
          entityId: product.id,
          searchableText: searchContent,
        },
      );

      this.logger.log('Generated tsvector for product model');
    }
  }

  /**
   * The GTIN/ASIN/ISBN claims this model holds. `owner_user_id` is nullable on
   * `ci.product_models` and falls back to `user_id`, mirroring how the claims
   * were written.
   */
  private async identifierValues(product: ProductModel): Promise<string[]> {
    const ownerUserId = product.ownerUserId ?? product.userId;

    if (ownerUserId == null) {
      return [];
    }

    const claims = await this.objectIdentifierService.listForSubjects(ownerUserId, 'product_model', [
      product.id,
    ]);

    return identifierSearchValues(claims.get(product.id) ?? []);
  }
}

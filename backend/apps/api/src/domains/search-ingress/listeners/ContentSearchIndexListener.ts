import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService, embedSkipReason, shouldEmbedType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Content, ContentService } from '@ci/domains/memory';
import {
  ContentCreatedEvent,
  ContentRemovedEvent,
  ContentUpdatedEvent,
  type ContentCreatedPayload,
  type ContentDeletedPayload,
  type ContentUpdatedPayload,
} from '@ci/domains/memory/events';
import { contentSearchDocument, contentWeightedTexts } from '@ci/domains/search-ingress/searchTexts';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { IndexSkipService } from '@ci/domains/search-ingress/services/IndexSkipService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

@Injectable()
export class ContentSearchIndexListener {
  constructor(
    private readonly contentService: ContentService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly indexSkipService: IndexSkipService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ContentSearchIndexListener.name);
  }

  @OnEvent(ContentCreatedEvent, { queue: 'search-index' })
  async indexContent(payload: ContentCreatedPayload | ContentUpdatedPayload) {
    this.logger.log('Adding new content to search index', {
      contentId: payload.contentId,
    });

    // Same re-drive race as EventSearchIndexListener.indexEvent: the sweep and the
    // pipeline's `index.embed` stage can both reach a freshly imported row, so
    // keep a vector that already exists. Only an update changes its source text.
    await this.upsertContent(payload, { keepExistingEmbedding: true });
  }

  @OnEvent(ContentUpdatedEvent, { queue: 'search-index' })
  async updateContent(payload: ContentCreatedPayload | ContentUpdatedPayload) {
    this.logger.log('Updating content in search index', {
      contentId: payload.contentId,
    });

    await this.upsertContent(payload);
  }

  @OnEvent(ContentRemovedEvent, { queue: 'search-index' })
  async unindexContent(payload: ContentDeletedPayload) {
    this.logger.log('Removing content in search index', {
      contentId: payload.contentId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'content',
      entityId: payload.contentId,
    });

    this.logger.log('Removed embedding for content');

    await this.vectorService.remove(context, {
      entityType: 'content',
      entityId: payload.contentId,
    });

    this.logger.log('Removed tsvector for content');

    await this.indexSkipService.clearSkip({
      entityType: 'content',
      entityId: payload.contentId,
    });
  }

  private async upsertContent(
    payload: ContentCreatedPayload | ContentUpdatedPayload,
    options: { keepExistingEmbedding?: boolean } = {},
  ) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const content = await this.contentService.findById(context, payload.contentId);

    if (content == null) {
      this.logger.warn('Content not found, skipping indexing');

      return;
    }

    // Scope the index entry to the owner. Read the scalar user_id first: it is
    // always present on a persisted row, whereas `user` is only set when the
    // relation was eager-loaded. (Historically NULL user_id here silently dropped
    // all importer content from the search index — see ContentEntity.userId.)
    const ownerId = content.userId ?? content.user?.id ?? null;

    if (ownerId == null) {
      this.logger.warn('Content has no associated user, cannot index');

      return;
    }

    const searchDocument = this.getSearchDocument(content);
    const skipReason = searchDocument == null ? 'empty' : embedSkipReason(searchDocument);

    if (!shouldEmbedType('content')) {
      this.logger.log('Content type not in embed allowlist, skipping embedding');
    } else if (skipReason != null) {
      this.logger.log('Skipping low-value content embedding', {
        contentId: content.id,
        skipReason,
      });

      // Persist the skip so the backfill sweep (LEFT JOIN on ci_search.embeddings)
      // stops re-finding this row on every run — without a marker the sweep never
      // converges and its no-op jobs starve the other entity types.
      await this.indexSkipService.recordSkip({
        entityType: 'content',
        entityId: content.id,
        reason: skipReason,
      });
    } else if (options.keepExistingEmbedding && (await this.hasEmbedding(ownerId, content.id))) {
      // No clearSkip here: the backfill excludes a row that has an embedding or a skip marker.
      this.logger.log('Content already embedded, keeping its embedding', {
        contentId: content.id,
      });
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument!);

      await this.embeddingService.upsert(
        {
          userId: ownerId,
        },
        {
          entityType: 'content',
          entityId: content.id,
          embedding,
        },
      );

      // An updated content row that became embeddable is no longer skipped.
      await this.indexSkipService.clearSkip({
        entityType: 'content',
        entityId: content.id,
      });

      this.logger.log('Generated embedding for content');
    }

    const searchContent = this.getSearchContent(content);

    if (searchContent.length === 0) {
      this.logger.log('Content has no search content, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: ownerId,
        },
        {
          entityType: 'content',
          entityId: content.id,
          searchableText: searchContent,
        },
      );

      this.logger.log('Generated tsvector for content');
    }
  }

  private async hasEmbedding(ownerId: string, contentId: string): Promise<boolean> {
    const embedded = await this.embeddingService.existingEntityIds({ userId: ownerId }, 'content', [
      contentId,
    ]);

    return embedded.has(contentId);
  }

  private getSearchContent(content: Content): WeightedText[] {
    return contentWeightedTexts(content);
  }

  private getSearchDocument(content: Content): string | null {
    return contentSearchDocument(content);
  }
}

import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService } from '@ci/common/embeddings';
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
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

@Injectable()
export class ContentSearchIndexListener {
  constructor(
    private readonly contentService: ContentService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
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

    await this.upsertContent(payload);
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
  }

  private async upsertContent(payload: ContentCreatedPayload | ContentUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const content = await this.contentService.findById(context, payload.contentId);

    if (content == null) {
      this.logger.warn('Content not found, skipping indexing');

      return;
    }

    if (content.user?.id == null) {
      this.logger.warn('Content has no associated user, cannot index');

      return;
    }

    const searchDocument = this.getSearchDocument(content);

    if (searchDocument == null) {
      this.logger.log('Content has no search document, skipping embedding');
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

      await this.embeddingService.upsert(
        {
          userId: content.user.id,
        },
        {
          entityType: 'content',
          entityId: content.id,
          embedding,
        },
      );

      this.logger.log('Generated embedding for content');
    }

    const searchContent = this.getSearchContent(content);

    if (searchContent.length === 0) {
      this.logger.log('Content has no search content, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: content.user.id,
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

  private getSearchContent(content: Content): WeightedText[] {
    const parts: WeightedText[] = [];

    if (content.title) {
      parts.push({ text: content.title, weight: 10 });
    }

    if (content.text) {
      parts.push({ text: content.text, weight: 5 });
    }

    if (content.type) {
      parts.push({ text: content.type, weight: 3 });
    }

    if (content.url) {
      parts.push({ text: content.url, weight: 3 });
    }

    if (content.mimetype) {
      parts.push({ text: content.mimetype, weight: 1 });
    }

    return parts;
  }

  private getSearchDocument(content: Content): string | null {
    const parts = new Set<string>();

    const push = (value: unknown) => {
      if (typeof value !== 'string') {
        return;
      }

      const normalized = value.trim();

      if (normalized.length === 0) {
        return;
      }

      parts.add(normalized);
    };

    push(content.text ?? null);
    push(content.type ?? null);
    push(content.mimetype ?? null);
    push(content.title ?? null);
    push(content.url ?? null);

    //We don't have any good examples of source_data fields to search on, but
    //putting this here as an example in case we ever do
    // const sourceData = (content.sourceData ?? {}) as Record<string, unknown>;
    // // We don't have a schema on properties yet. These values are an accumulated
    // // superset of values we've indexed in various places.
    // const candidateKeys = [];
    //
    // for (const key of candidateKeys) {
    //   push(sourceData[key]);
    // }
    //
    // const aliases = sourceData['aliases'];
    //
    // if (Array.isArray(aliases)) {
    //   for (const alias of aliases) {
    //     push(alias);
    //   }
    // }

    const result = Array.from(parts).join(' ');

    return result.length > 0 ? result : null;
  }
}

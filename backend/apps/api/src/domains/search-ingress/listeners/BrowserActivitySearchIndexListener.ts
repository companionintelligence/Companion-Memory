import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService, embedSkipReason, shouldEmbedType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { type BrowserActivity, BrowserActivityService } from '@ci/domains/browser-activity';
import {
  BrowserActivityCreatedEvent,
  BrowserActivityUpdatedEvent,
  BrowserActivityRemovedEvent,
  type BrowserActivityCreatedPayload,
  type BrowserActivityUpdatedPayload,
  type BrowserActivityDeletedPayload,
} from '@ci/domains/browser-activity/events';
import { OnEvent } from '@ci/domains/events';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

@Injectable()
export class BrowserActivitySearchIndexListener {
  constructor(
    private readonly browserActivityService: BrowserActivityService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(BrowserActivitySearchIndexListener.name);
  }

  @OnEvent(BrowserActivityCreatedEvent, { queue: 'search-index' })
  async indexBrowserActivity(payload: BrowserActivityCreatedPayload | BrowserActivityUpdatedPayload) {
    this.logger.log('Adding new browser activity to search index', {
      browserActivityId: payload.browserActivityId,
    });

    await this.upsertBrowserActivity(payload);
  }

  @OnEvent(BrowserActivityUpdatedEvent, { queue: 'search-index' })
  async updateBrowserActivity(payload: BrowserActivityCreatedPayload | BrowserActivityUpdatedPayload) {
    this.logger.log('Updating browser activity in search index', {
      browserActivityId: payload.browserActivityId,
    });

    await this.upsertBrowserActivity(payload);
  }

  @OnEvent(BrowserActivityRemovedEvent, { queue: 'search-index' })
  async unindexBrowserActivity(payload: BrowserActivityDeletedPayload) {
    this.logger.log('Removing browser activity in search index', {
      browserActivityId: payload.browserActivityId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'browser-activity',
      entityId: payload.browserActivityId,
    });

    this.logger.log('Removed embedding for browser activity');

    await this.vectorService.remove(context, {
      entityType: 'browser-activity',
      entityId: payload.browserActivityId,
    });

    this.logger.log('Removed tsvector for browser activity');
  }

  private async upsertBrowserActivity(
    payload: BrowserActivityCreatedPayload | BrowserActivityUpdatedPayload,
  ) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const browserActivity = await this.browserActivityService.findById(context, payload.browserActivityId);

    if (browserActivity == null) {
      this.logger.warn('Browser activity not found, skipping indexing');

      return;
    }

    if (browserActivity.user?.id == null) {
      this.logger.warn('Browser activity has no associated user, cannot index');

      return;
    }

    const searchDocument = this.getSearchDocument(browserActivity);
    const skipReason = searchDocument == null ? 'empty' : embedSkipReason(searchDocument);

    if (!shouldEmbedType('browser-activity')) {
      this.logger.log('Browser-activity type not in embed allowlist, skipping embedding');
    } else if (skipReason != null) {
      this.logger.log('Skipping low-value browser activity embedding', {
        browserActivityId: browserActivity.id,
        skipReason,
      });
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument!);

      await this.embeddingService.upsert(
        {
          userId: browserActivity.user.id,
        },
        {
          entityType: 'browser-activity',
          entityId: browserActivity.id,
          embedding,
        },
      );

      this.logger.log('Generated embedding for browser activity');
    }

    const searchContent = this.getSearchContent(browserActivity);

    if (searchContent.length === 0) {
      this.logger.log('Browser activity has no search content, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: browserActivity.user.id,
        },
        {
          entityType: 'browser-activity',
          entityId: browserActivity.id,
          searchableText: searchContent,
        },
      );

      this.logger.log('Generated tsvector for browser activity');
    }
  }

  private getSearchContent(browserActivity: BrowserActivity): WeightedText[] {
    const parts: WeightedText[] = [];

    if (browserActivity.title) {
      parts.push({ text: browserActivity.title, weight: 10 });
    }

    if (browserActivity.url) {
      parts.push({ text: browserActivity.url, weight: 5 });
    }

    const description = browserActivity.properties?.description;
    if (typeof description === 'string' && description.length > 0) {
      parts.push({ text: description, weight: 3 });
    }

    return parts;
  }

  private getSearchDocument(browserActivity: BrowserActivity): string | null {
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

    push(browserActivity.url ?? null);
    push(browserActivity.title ?? null);
    push(browserActivity.properties?.description ?? null);

    const result = Array.from(parts).join(' ');

    return result.length > 0 ? result : null;
  }
}

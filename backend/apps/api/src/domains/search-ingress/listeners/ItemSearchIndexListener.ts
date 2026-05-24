import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Item, ItemService } from '@ci/domains/memory';
import {
  ItemCreatedEvent,
  ItemRemovedEvent,
  ItemUpdatedEvent,
  type ItemCreatedPayload,
  type ItemDeletedPayload,
  type ItemUpdatedPayload,
} from '@ci/domains/memory/events';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

@Injectable()
export class ItemSearchIndexListener {
  constructor(
    private readonly itemService: ItemService,
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

    if (item.userId == null) {
      this.logger.warn('Item has no associated user, cannot index');

      return;
    }

    const searchDocument = this.getSearchDocument(item);

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

    const searchItem = this.getSearchItem(item);

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

  private getSearchItem(item: Item): WeightedText[] {
    const parts: WeightedText[] = [];

    if (item.name) {
      parts.push({ text: item.name, weight: 10 });
    }

    if (item.description) {
      parts.push({ text: item.description, weight: 5 });
    }

    if (item.brand) {
      parts.push({ text: item.brand, weight: 5 });
    }

    if (item.model) {
      parts.push({ text: item.model, weight: 5 });
    }

    if (item.category) {
      parts.push({ text: item.category, weight: 3 });
    }

    if (item.subcategory) {
      parts.push({ text: item.subcategory, weight: 3 });
    }

    if (item.maintenanceNotes) {
      const maintenanceNotes =
        typeof item.maintenanceNotes === 'string'
          ? item.maintenanceNotes
          : JSON.stringify(item.maintenanceNotes);
      if (maintenanceNotes.length > 0) {
        parts.push({ text: maintenanceNotes, weight: 1 });
      }
    }

    return parts;
  }

  private getSearchDocument(item: Item): string | null {
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

    push(item.name ?? null);
    push(item.description ?? null);
    push(item.category ?? null);
    push(item.subcategory ?? null);
    push(item.brand ?? null);
    push(item.model ?? null);
    push(item.maintenanceNotes ?? null);

    //We don't have any good examples of metadata fields to search on, but
    //putting this here as an example in case we ever do
    // const metadata = (item.metadata ?? {}) as Record<string, unknown>;
    // // We don't have a schema on properties yet. These values are an accumulated
    // // superset of values we've indexed in various places.
    // const candidateKeys = [];
    //
    // for (const key of candidateKeys) {
    //   push(metadata[key]);
    // }
    //
    // const aliases = metadata['aliases'];
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

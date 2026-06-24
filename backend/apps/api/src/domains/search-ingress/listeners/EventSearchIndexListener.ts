import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService, embedSkipReason, shouldEmbedType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Event, EventService } from '@ci/domains/memory';
import {
  EventCreatedEvent,
  EventRemovedEvent,
  EventUpdatedEvent,
  type EventCreatedPayload,
  type EventDeletedPayload,
  type EventUpdatedPayload,
} from '@ci/domains/memory/events';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

@Injectable()
export class EventSearchIndexListener {
  constructor(
    private readonly eventService: EventService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EventSearchIndexListener.name);
  }

  @OnEvent(EventCreatedEvent, { queue: 'search-index' })
  async indexEvent(payload: EventCreatedPayload | EventUpdatedPayload) {
    this.logger.log('Adding new event to search index', {
      eventId: payload.eventId,
    });

    await this.upsertEvent(payload);
  }

  @OnEvent(EventUpdatedEvent, { queue: 'search-index' })
  async updateEvent(payload: EventCreatedPayload | EventUpdatedPayload) {
    this.logger.log('Updating event in search index', {
      eventId: payload.eventId,
    });

    await this.upsertEvent(payload);
  }

  @OnEvent(EventRemovedEvent, { queue: 'search-index' })
  async unindexEvent(payload: EventDeletedPayload) {
    this.logger.log('Removing event in search index', {
      eventId: payload.eventId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'event',
      entityId: payload.eventId,
    });

    this.logger.log('Removed embedding for event');

    await this.vectorService.remove(context, {
      entityType: 'event',
      entityId: payload.eventId,
    });

    this.logger.log('Removed tsvector for event');
  }

  private async upsertEvent(payload: EventCreatedPayload | EventUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const event = await this.eventService.findById(context, payload.eventId);

    if (event == null) {
      this.logger.warn('Event not found, skipping indexing');

      return;
    }

    if (event.userId == null) {
      this.logger.warn('Event has no associated user, cannot index');

      return;
    }

    const searchDocument = this.getSearchDocument(event);
    const skipReason = searchDocument == null ? 'empty' : embedSkipReason(searchDocument);

    if (!shouldEmbedType('event')) {
      this.logger.log('Event type not in embed allowlist, skipping embedding');
    } else if (skipReason != null) {
      this.logger.log('Skipping low-value event embedding', {
        eventId: event.id,
        skipReason,
      });
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument!);

      await this.embeddingService.upsert(
        {
          userId: event.userId,
        },
        {
          entityType: 'event',
          entityId: event.id,
          embedding,
        },
      );

      this.logger.log('Generated embedding for event');
    }

    const searchEvent = this.getSearchEvent(event);

    if (searchEvent.length === 0) {
      this.logger.log('Event has no search event, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: event.userId,
        },
        {
          entityType: 'event',
          entityId: event.id,
          searchableText: searchEvent,
        },
      );

      this.logger.log('Generated tsvector for event');
    }
  }

  private getSearchEvent(event: Event): WeightedText[] {
    const parts: WeightedText[] = [];

    if (event.title) {
      parts.push({ text: event.title, weight: 10 });
    }

    if (event.description) {
      parts.push({ text: event.description, weight: 5 });
    }

    if (event.category) {
      parts.push({ text: event.category, weight: 3 });
    }

    if (event.eventType) {
      parts.push({ text: event.eventType, weight: 3 });
    }

    return parts;
  }

  private getSearchDocument(event: Event): string | null {
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

    push(event.title ?? null);
    push(event.description ?? null);
    push(event.category ?? null);
    push(event.eventType ?? null);

    // High-signal structured fields that capture sources (notably CI-Import-Tools)
    // record in event metadata. Without these, semantically-searchable content for
    // imported events would be limited to title/description; pulling the subject,
    // message text, track/artist, product name, etc. makes the imported memory
    // recallable. There is no metadata schema yet, so this is a curated allowlist
    // of keys observed across importers — extend as new sources land.
    const metadata = (event.metadata ?? {}) as Record<string, unknown>;
    const candidateKeys = [
      'Subject',
      'Text',
      'Track',
      'Artist',
      'Album',
      'Product',
      'Sender',
      'Book',
      'Author',
      'Title',
      'Name',
      'Notes',
    ];

    for (const key of candidateKeys) {
      push(metadata[key]);
    }

    const aliases = metadata['aliases'];

    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        push(alias);
      }
    }

    const result = Array.from(parts).join(' ');

    return result.length > 0 ? result : null;
  }
}

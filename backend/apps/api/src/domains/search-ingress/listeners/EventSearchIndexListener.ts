import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService, embedSkipReason, shouldEmbedType } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Event, CalendarEventService } from '@ci/domains/memory';
import {
  EventCreatedEvent,
  EventRemovedEvent,
  EventUpdatedEvent,
  type EventCreatedPayload,
  type EventDeletedPayload,
  type EventUpdatedPayload,
} from '@ci/domains/memory/events';
import {
  eventDisplayTitle,
  eventSearchDocument,
  eventWeightedTexts,
} from '@ci/domains/search-ingress/searchTexts';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

@Injectable()
export class EventSearchIndexListener {
  constructor(
    private readonly eventService: CalendarEventService,
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

    // A created event is re-driven by the maintenance sweep for rows that had no
    // embedding when it ran, and the pipeline's `index.embed_event` stage embeds
    // those same rows concurrently. By the time the job runs the vector is
    // usually there, so keep it: only an update changes the text it was made from.
    await this.upsertEvent(payload, { keepExistingEmbedding: true });
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

  private async upsertEvent(
    payload: EventCreatedPayload | EventUpdatedPayload,
    options: { keepExistingEmbedding?: boolean } = {},
  ) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const event = await this.eventService.findById(context, payload.eventId);

    if (event == null) {
      this.logger.warn('Event not found, skipping indexing');

      return;
    }

    if (event.eventType === 'planned_block') {
      this.logger.log('Skipping planned_block — index the task, not the block', {
        eventId: event.id,
      });

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
    } else if (options.keepExistingEmbedding && (await this.hasEmbedding(event.userId, event.id))) {
      this.logger.log('Event already embedded, keeping its embedding', {
        eventId: event.id,
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

  private async hasEmbedding(userId: string, eventId: string): Promise<boolean> {
    const embedded = await this.embeddingService.existingEntityIds({ userId }, 'event', [eventId]);

    return embedded.has(eventId);
  }

  private getSearchEvent(event: Event): WeightedText[] {
    return eventWeightedTexts(event);
  }

  private getSearchDocument(event: Event): string | null {
    return eventSearchDocument(event);
  }
}

/**
 * Re-exported from `searchTexts` (the builders' shared home since the pipeline
 * index stages joined the listeners as consumers) so existing importers and the
 * listener spec keep their path.
 */
export { eventDisplayTitle };

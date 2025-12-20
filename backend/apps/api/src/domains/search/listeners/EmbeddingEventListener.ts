import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Events, type EventPayloads, OnEvent } from '@ci/domains/events';

import { EmbeddingService } from '../services/EmbeddingService';

@Injectable()
export class EmbeddingEventListener {
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EmbeddingEventListener.name);
  }

  @OnEvent(Events.SEARCH_EMBED_ENTITY)
  async handleEntityEmbedding(payload: EventPayloads[Events.SEARCH_EMBED_ENTITY]) {
    try {
      if (!this.hasMeaningfulText(payload.searchContent)) {
        this.logger.debug('Skipping entity embedding due to empty search content', {
          ownerId: payload.ownerId,
          entityId: payload.entityId,
        });

        return;
      }

      const success = await this.embeddingService.embedEntity(payload.entityId, payload.searchContent);

      if (!success) {
        throw new Error('Embedding service reported a failure while generating entity embedding.');
      }
    } catch (error) {
      this.logger.error('Failed to embed graph entity', {
        ownerId: payload.ownerId,
        entityId: payload.entityId,
        entityType: payload.entityType,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  @OnEvent(Events.SEARCH_EMBED_CONTENT)
  async handleContentEmbedding(payload: EventPayloads[Events.SEARCH_EMBED_CONTENT]) {
    try {
      if (!this.hasMeaningfulText(payload.text)) {
        this.logger.debug('Skipping content embedding due to empty text', {
          ownerId: payload.ownerId,
          contentId: payload.contentId,
        });

        return;
      }

      const success = await this.embeddingService.embedContent(payload.contentId, payload.text);

      if (!success) {
        throw new Error('Embedding service reported a failure while generating content embedding.');
      }
    } catch (error) {
      this.logger.error('Failed to embed content record', {
        ownerId: payload.ownerId,
        contentId: payload.contentId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  @OnEvent(Events.SEARCH_EMBED_EVENT)
  async handleEventEmbedding(payload: EventPayloads[Events.SEARCH_EMBED_EVENT]) {
    try {
      if (!this.hasMeaningfulText(payload.searchContent)) {
        this.logger.debug('Skipping event embedding due to empty search content', {
          ownerId: payload.ownerId,
          eventId: payload.eventId,
        });

        return;
      }

      const success = await this.embeddingService.embedEvent(payload.eventId, payload.searchContent);

      if (!success) {
        throw new Error('Embedding service reported a failure while generating event embedding.');
      }
    } catch (error) {
      this.logger.error('Failed to embed event record', {
        ownerId: payload.ownerId,
        eventId: payload.eventId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  private hasMeaningfulText(value?: string | null): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }
}

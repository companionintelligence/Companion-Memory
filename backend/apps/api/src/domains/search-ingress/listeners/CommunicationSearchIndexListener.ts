import { Injectable } from '@nestjs/common';

import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';
import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Communication, CommunicationService } from '@ci/domains/memory';
import {
  CommunicationCreatedEvent,
  CommunicationUpdatedEvent,
  CommunicationRemovedEvent,
  type CommunicationCreatedPayload,
  type CommunicationUpdatedPayload,
  type CommunicationDeletedPayload,
} from '@ci/domains/memory/events';

import { EmbeddingService } from '../services/EmbeddingService';
import { VectorService } from '../services/VectorService';

@Injectable()
export class CommunicationSearchIndexListener {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(CommunicationSearchIndexListener.name);
  }

  @OnEvent(CommunicationCreatedEvent, { queue: 'search-index' })
  async indexCreate(payload: CommunicationCreatedPayload) {
    this.logger.log('Adding new communication to search index', {
      communicationId: payload.communicationId,
    });

    await this.indexUpsert(payload);
  }

  @OnEvent(CommunicationUpdatedEvent, { queue: 'search-index' })
  async indexUpdate(payload: CommunicationUpdatedPayload) {
    this.logger.log('Updating communication in search index', {
      communicationId: payload.communicationId,
    });

    await this.indexUpsert(payload);
  }

  @OnEvent(CommunicationRemovedEvent, { queue: 'search-index' })
  async indexRemove(payload: CommunicationDeletedPayload) {
    this.logger.log('Removing person in search index', {
      communicationId: payload.communicationId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await Promise.all([
      this.embeddingService.remove(context, {
        entityType: 'communication',
        entityId: payload.communicationId,
      }),
      this.vectorService.remove(context, {
        entityType: 'communication',
        entityId: payload.communicationId,
      }),
    ]);
  }

  private async indexUpsert(payload: CommunicationCreatedPayload | CommunicationUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const communication = await this.communicationService.findById(context, payload.communicationId);

    if (communication == null) {
      this.logger.warn('Communication not found, skipping indexing');

      return;
    }

    if (communication.userId == null) {
      this.logger.warn('Communication has no associated user, cannot index');

      return;
    }

    const searchDocument = this.getSearchDocument(communication);

    if (searchDocument == null) {
      this.logger.log('Communication has no search document, skipping embedding');
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

      await this.embeddingService.upsert(
        {
          userId: communication.userId,
        },
        {
          entityType: 'communication',
          entityId: communication.id,
          embedding,
        },
      );

      this.logger.log('Generated embedding for communication');
    }

    const searchContent = this.getSearchContent(communication);

    if (searchContent.length === 0) {
      this.logger.log('Communication has no search content, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: communication.userId,
        },
        {
          entityType: 'communication',
          entityId: communication.id,
          searchableText: searchContent,
        },
      );

      this.logger.log('Generated tsvector for communication');
    }
  }

  private getSearchContent(communication: Communication): string[] {
    const parts = [communication.subject, communication.preview];

    return parts.filter((part): part is string => typeof part === 'string' && part.length > 0);
  }

  private getSearchDocument(communication: Communication): string | null {
    const parts = [communication.subject, communication.preview, communication.content];

    return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
  }
}

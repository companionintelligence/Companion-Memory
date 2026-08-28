import { Injectable } from '@nestjs/common';

import { SYSTEM_USER, type ServiceContext } from '@ci/common/context';
import { EmbeddingGenerationService, embedSkipReason, shouldEmbedType } from '@ci/common/embeddings';
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
import {
  communicationSearchDocument,
  communicationWeightedTexts,
} from '@ci/domains/search-ingress/searchTexts';

import { EmbeddingService } from '../services/EmbeddingService';
import { IndexSkipService } from '../services/IndexSkipService';
import { VectorService } from '../services/VectorService';
import { type WeightedText } from '../types';

@Injectable()
export class CommunicationSearchIndexListener {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly indexSkipService: IndexSkipService,
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
    this.logger.log('Removing communication in search index', {
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
      this.indexSkipService.clearSkip({
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
    const skipReason = searchDocument == null ? 'empty' : embedSkipReason(searchDocument);

    if (!shouldEmbedType('communication')) {
      this.logger.log('Communication type not in embed allowlist, skipping embedding');
    } else if (skipReason != null) {
      this.logger.log('Skipping low-value communication embedding', {
        communicationId: communication.id,
        skipReason,
      });

      // Persist the skip so the backfill sweep (LEFT JOIN on ci_search.embeddings)
      // stops re-finding this row on every run — without a marker the sweep never
      // converges and its no-op jobs starve the other entity types.
      await this.indexSkipService.recordSkip({
        entityType: 'communication',
        entityId: communication.id,
        reason: skipReason,
      });
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument!);

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

      // An updated communication that became embeddable is no longer skipped.
      await this.indexSkipService.clearSkip({
        entityType: 'communication',
        entityId: communication.id,
      });

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

  private getSearchContent(communication: Communication): WeightedText[] {
    return communicationWeightedTexts(communication);
  }

  private getSearchDocument(communication: Communication): string | null {
    return communicationSearchDocument(communication);
  }
}

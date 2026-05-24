import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Concept, ConceptService } from '@ci/domains/memory';
import {
  ConceptCreatedEvent,
  ConceptRemovedEvent,
  ConceptUpdatedEvent,
  type ConceptCreatedPayload,
  type ConceptDeletedPayload,
  type ConceptUpdatedPayload,
} from '@ci/domains/memory/events';

import { EmbeddingService } from '../services/EmbeddingService';
import { VectorService } from '../services/VectorService';
import { type WeightedText } from '../types';

@Injectable()
export class ConceptSearchIndexListener {
  constructor(
    private readonly conceptService: ConceptService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ConceptSearchIndexListener.name);
  }

  @OnEvent(ConceptCreatedEvent, { queue: 'search-index' })
  async indexConcept(payload: ConceptCreatedPayload | ConceptUpdatedPayload) {
    this.logger.log('Adding new concept to search index', {
      conceptId: payload.conceptId,
    });

    await this.upsertConcept(payload);
  }

  @OnEvent(ConceptUpdatedEvent, { queue: 'search-index' })
  async updateConcept(payload: ConceptCreatedPayload | ConceptUpdatedPayload) {
    this.logger.log('Updating concept in search index', {
      conceptId: payload.conceptId,
    });

    await this.upsertConcept(payload);
  }

  @OnEvent(ConceptRemovedEvent, { queue: 'search-index' })
  async unindexConcept(payload: ConceptDeletedPayload) {
    this.logger.log('Removing concept in search index', {
      conceptId: payload.conceptId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'concept',
      entityId: payload.conceptId,
    });

    this.logger.log('Removed embedding for concept');

    await this.vectorService.remove(context, {
      entityType: 'concept',
      entityId: payload.conceptId,
    });

    this.logger.log('Removed tsvector for concept');
  }

  private async upsertConcept(payload: ConceptCreatedPayload | ConceptUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const concept = await this.conceptService.findById(context, payload.conceptId);

    if (concept == null) {
      this.logger.warn('Concept not found, skipping indexing');

      return;
    }

    if (concept.userId == null) {
      this.logger.warn('Concept has no associated user, cannot index');

      return;
    }

    const searchDocument = this.getSearchDocument(concept);

    if (searchDocument == null) {
      this.logger.log('Concept has no search document, skipping embedding');
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

      await this.embeddingService.upsert(
        {
          userId: concept.userId,
        },
        {
          entityType: 'concept',
          entityId: concept.id,
          embedding,
        },
      );

      this.logger.log('Generated embedding for concept');
    }

    const searchContent = this.getSearchContent(concept);

    if (searchContent.length === 0) {
      this.logger.log('Concept has no search content, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: concept.userId,
        },
        {
          entityType: 'concept',
          entityId: concept.id,
          searchableText: searchContent,
        },
      );

      this.logger.log('Generated tsvector for concept');
    }
  }

  private getSearchContent(concept: Concept): WeightedText[] {
    const parts: WeightedText[] = [];

    if (concept.name) {
      parts.push({ text: concept.name, weight: 10 });
    }

    if (concept.description) {
      parts.push({ text: concept.description, weight: 5 });
    }

    return parts;
  }

  private getSearchDocument(concept: Concept): string | null {
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

    push(concept.name ?? null);
    push(concept.description ?? null);

    const result = Array.from(parts).join(' ');

    return result.length > 0 ? result : null;
  }
}

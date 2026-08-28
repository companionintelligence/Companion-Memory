import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService, shouldEmbedType } from '@ci/common/embeddings';
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
import { IndexSkipService } from '../services/IndexSkipService';
import { VectorService } from '../services/VectorService';
import { type WeightedText } from '../types';

@Injectable()
export class ConceptSearchIndexListener {
  constructor(
    private readonly conceptService: ConceptService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly indexSkipService: IndexSkipService,
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

    await this.indexSkipService.clearSkip({
      entityType: 'concept',
      entityId: payload.conceptId,
    });

    this.logger.log('Removed skip marker for concept');
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

    if (!shouldEmbedType('concept')) {
      this.logger.log('Concept type not in embed allowlist, skipping embedding');
    } else if (searchDocument == null) {
      this.logger.log('Concept has no search document, skipping embedding', {
        conceptId: concept.id,
      });

      // A concept document is a NAME, not a message body, so the message-tuned
      // embedSkipReason heuristics must not gate it: they classify legitimate
      // names ('AI', 'Node.js', 'invoice.pdf') as too-short/url-only, and the
      // marker below would then hide them from search permanently — concept is
      // not in PIPELINE_COVERED_STAGES, and the bulk graph upsert path emits no
      // per-row event that could ever clear the marker. Only a concept with
      // neither a name nor a description is skipped.
      //
      // Persist that skip so the backfill sweep (LEFT JOIN on
      // ci_search.embeddings) stops re-finding this row on every run; a name
      // arriving later fires ConceptUpdatedEvent, which clears it.
      await this.indexSkipService.recordSkip({
        entityType: 'concept',
        entityId: concept.id,
        reason: 'empty',
      });

      // A concept that LOST its text keeps answering searches from the vector
      // written when it still had some, so drop it rather than leave it stale.
      await this.embeddingService.remove(context, {
        entityType: 'concept',
        entityId: concept.id,
      });
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

      // An updated concept that became embeddable is no longer skipped.
      await this.indexSkipService.clearSkip({
        entityType: 'concept',
        entityId: concept.id,
      });

      this.logger.log('Generated embedding for concept');
    }

    const searchContent = this.getSearchContent(concept);

    if (searchContent.length === 0) {
      await this.vectorService.remove(context, {
        entityType: 'concept',
        entityId: concept.id,
      });

      this.logger.log('Concept has no search content, removed tsvector');
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

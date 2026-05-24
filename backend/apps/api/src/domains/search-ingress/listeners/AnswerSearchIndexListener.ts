import { Injectable } from '@nestjs/common';

import { ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { type Answer, AnswerService } from '@ci/domains/intelligence';
import {
  AnswerCreatedEvent,
  AnswerRemovedEvent,
  AnswerUpdatedEvent,
  type AnswerCreatedPayload,
  type AnswerDeletedPayload,
  type AnswerUpdatedPayload,
} from '@ci/domains/intelligence/events';
import { EmbeddingService } from '@ci/domains/search-ingress/services/EmbeddingService';
import { VectorService } from '@ci/domains/search-ingress/services/VectorService';
import { type WeightedText } from '@ci/domains/search-ingress/types';

@Injectable()
export class AnswerSearchIndexListener {
  constructor(
    private readonly answerService: AnswerService,
    private readonly embeddingGenerationService: EmbeddingGenerationService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorService: VectorService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AnswerSearchIndexListener.name);
  }

  @OnEvent(AnswerCreatedEvent, { queue: 'search-index' })
  async indexAnswer(payload: AnswerCreatedPayload | AnswerUpdatedPayload) {
    this.logger.log('Adding new answer to search index', {
      answerId: payload.answerId,
    });

    await this.upsertAnswer(payload);
  }

  @OnEvent(AnswerUpdatedEvent, { queue: 'search-index' })
  async updateAnswer(payload: AnswerCreatedPayload | AnswerUpdatedPayload) {
    this.logger.log('Updating answer in search index', {
      answerId: payload.answerId,
    });

    await this.upsertAnswer(payload);
  }

  @OnEvent(AnswerRemovedEvent, { queue: 'search-index' })
  async unindexAnswer(payload: AnswerDeletedPayload) {
    this.logger.log('Removing answer in search index', {
      answerId: payload.answerId,
    });

    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    await this.embeddingService.remove(context, {
      entityType: 'answer',
      entityId: payload.answerId,
    });

    this.logger.log('Removed embedding for answer');

    await this.vectorService.remove(context, {
      entityType: 'answer',
      entityId: payload.answerId,
    });

    this.logger.log('Removed tsvector for answer');
  }

  private async upsertAnswer(payload: AnswerCreatedPayload | AnswerUpdatedPayload) {
    const context = {
      userId: SYSTEM_USER,
    } satisfies ServiceContext;

    const answer = await this.answerService.findById(context, payload.answerId);

    if (answer == null) {
      this.logger.warn('Answer not found, skipping indexing');

      return;
    }

    if (answer.user?.id == null) {
      this.logger.warn('Answer has no associated user, cannot index');

      return;
    }

    const searchDocument = this.getSearchDocument(answer);

    if (searchDocument == null) {
      this.logger.log('Answer has no search document, skipping embedding');
    } else {
      const embedding = await this.embeddingGenerationService.generateEmbedding(searchDocument);

      await this.embeddingService.upsert(
        {
          userId: answer.user.id,
        },
        {
          entityType: 'answer',
          entityId: answer.id,
          embedding,
        },
      );

      this.logger.log('Generated embedding for answer');
    }

    const searchAnswer = this.getSearchAnswer(answer);

    if (searchAnswer.length === 0) {
      this.logger.log('Answer has no search answer, skipping vectorization');
    } else {
      await this.vectorService.upsert(
        {
          userId: answer.user.id,
        },
        {
          entityType: 'answer',
          entityId: answer.id,
          searchableText: searchAnswer,
        },
      );

      this.logger.log('Generated tsvector for answer');
    }
  }

  private getSearchAnswer(answer: Answer): WeightedText[] {
    const parts: WeightedText[] = [];

    if (answer.answer) {
      parts.push({ text: answer.answer, weight: 10 });
    }

    if (answer.question?.text) {
      parts.push({ text: answer.question.text, weight: 5 });
    }

    return parts;
  }

  private getSearchDocument(answer: Answer): string | null {
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

    push(answer.answer ?? null);
    push(answer.question?.text ?? null);

    const result = Array.from(parts).join(' ');

    return result.length > 0 ? result : null;
  }
}

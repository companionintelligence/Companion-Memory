import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  EXCLUDE_QUESTIONS_WITH_PENDING_INFERRED_REVIEW,
  EXCLUDE_QUESTIONS_WITH_REJECTED_INFERRED_REVIEW,
} from '@ci/common/persistence';
import { Events, EventService } from '@ci/domains/events';
import {
  GraphIngestService,
  type GraphEntityInputDto,
  type GraphRelationshipInputDto,
} from '@ci/domains/graph';
import { AnswerService } from '@ci/domains/intelligence';

import { PromotionCandidateEntity, type PromotionCandidate } from '../entities/PromotionCandidateEntity';
import type { PromotionCandidateKind } from '../types';
import { shouldSkipHydrationCandidate } from '../utils/hydrationCandidateFilter';
import {
  isLegacyReviewPrompt,
  promotionSourceQuestion,
  promotionValueText,
} from '../utils/promotionCandidatePayload';

import { PromotionReviewPromptService } from './PromotionReviewPromptService';

export interface CreatePromotionCandidateDto {
  readonly kind: PromotionCandidateKind;
  readonly payload: Record<string, unknown>;
  readonly confidence: number;
  readonly evidence?: unknown[];
  readonly sourceJob?: string;
  readonly requiresUserInput?: boolean;
  readonly reviewPrompt?: string;
}

@Injectable()
export class PromotionCandidateService {
  constructor(
    @InjectRepository(PromotionCandidateEntity)
    private readonly repository: Repository<PromotionCandidateEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly graphIngestService: GraphIngestService,
    private readonly answerService: AnswerService,
    private readonly eventService: EventService,
    private readonly promotionReviewPromptService: PromotionReviewPromptService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PromotionCandidateService.name);
  }

  async create(
    context: UserServiceContext,
    dto: CreatePromotionCandidateDto,
  ): Promise<PromotionCandidate | null> {
    const userId = context.userId!;

    if (dto.kind === 'inferred_fact') {
      const questionId = dto.payload.questionId as string | undefined;

      if (questionId) {
        const existingForQuestion = await this.findPendingInferredFactForQuestion(userId, questionId);
        if (existingForQuestion) {
          existingForQuestion.payload = dto.payload;
          existingForQuestion.confidence = dto.confidence;
          existingForQuestion.reviewPrompt =
            dto.reviewPrompt ??
            (await this.promotionReviewPromptService.generate(context, {
              kind: dto.kind,
              payload: dto.payload,
              evidence: dto.evidence,
              sourceJob: dto.sourceJob ?? null,
            }));

          const saved = await this.repository.save(existingForQuestion);

          return saved as PromotionCandidate;
        }
      }

      if (await this.hasPendingInferredFactReview(userId)) {
        this.logger.log('Skipped inferred-answer review — another review is already pending', {
          userId,
          questionId,
        });

        return null;
      }
    }

    const reviewPrompt =
      dto.reviewPrompt ??
      (await this.promotionReviewPromptService.generate(context, {
        kind: dto.kind,
        payload: dto.payload,
        evidence: dto.evidence,
        sourceJob: dto.sourceJob ?? null,
      }));

    const entity = this.repository.create({
      id: uuid7(),
      userId,
      kind: dto.kind,
      payload: dto.payload,
      confidence: dto.confidence,
      evidence: dto.evidence ?? [],
      status: 'pending',
      sourceJob: dto.sourceJob ?? null,
      requiresUserInput: dto.requiresUserInput ?? true,
      reviewPrompt,
    });

    const saved = await this.repository.save(entity);

    return saved as PromotionCandidate;
  }

  async hasPendingInferredFactReview(userId: string): Promise<boolean> {
    const count = await this.repository.count({
      where: { userId, status: 'pending', kind: 'inferred_fact' },
    });

    return count > 0;
  }

  async findPendingInferredFactForQuestion(
    userId: string,
    questionId: string,
  ): Promise<PromotionCandidateEntity | null> {
    return this.repository
      .createQueryBuilder('pc')
      .where('pc.user_id = :userId', { userId })
      .andWhere('pc.status = :status', { status: 'pending' })
      .andWhere('pc.kind = :kind', { kind: 'inferred_fact' })
      .andWhere("pc.payload->>'questionId' = :questionId", { questionId })
      .getOne();
  }

  async listPending(context: UserServiceContext, limit = 1): Promise<PromotionCandidate[]> {
    const results: PromotionCandidate[] = [];
    let offset = 0;

    while (results.length < limit) {
      const rows = await this.repository.find({
        where: { userId: context.userId!, status: 'pending' },
        order: { createdAt: 'ASC' },
        take: 1,
        skip: offset,
      });

      const row = rows[0];
      if (!row) {
        break;
      }

      offset += 1;

      if (this.shouldAutoReject(row)) {
        row.status = 'rejected';
        await this.repository.save(row);
        continue;
      }

      if (isLegacyReviewPrompt(row.reviewPrompt)) {
        row.reviewPrompt = await this.promotionReviewPromptService.generate(context, {
          kind: row.kind,
          payload: row.payload,
          evidence: row.evidence,
          sourceJob: row.sourceJob,
        });
        await this.repository.save(row);
      }

      results.push(row as PromotionCandidate);
    }

    return results;
  }

  private shouldAutoReject(candidate: PromotionCandidateEntity): boolean {
    if (candidate.kind !== 'entity' || candidate.sourceJob !== 'hydrate_answers') {
      return false;
    }

    return shouldSkipHydrationCandidate(
      promotionValueText(candidate.payload, candidate.evidence),
      promotionSourceQuestion(candidate.payload),
    );
  }

  async accept(context: UserServiceContext, candidateId: string): Promise<PromotionCandidate | null> {
    const candidate = await this.repository.findOne({
      where: { id: candidateId, userId: context.userId! },
    });

    if (!candidate || candidate.status !== 'pending') {
      return null;
    }

    await this.applyCandidate(context, candidate);
    candidate.status = 'accepted';
    await this.repository.save(candidate);

    if (candidate.kind === 'inferred_fact') {
      const questionId = candidate.payload.questionId as string | undefined;
      if (questionId) {
        await this.rejectDuplicatePendingInferredFacts(context.userId!, questionId, candidate.id);
        await this.clearFeedQueueForQuestion(context.userId!, questionId);
      }
    }

    return candidate as PromotionCandidate;
  }

  async reject(context: UserServiceContext, candidateId: string): Promise<PromotionCandidate | null> {
    const candidate = await this.repository.findOne({
      where: { id: candidateId, userId: context.userId! },
    });

    if (!candidate || candidate.status !== 'pending') {
      return null;
    }

    if (candidate.kind === 'inferred_fact') {
      const questionId = candidate.payload.questionId as string | undefined;
      if (questionId) {
        await this.rejectAllPendingInferredFactsForQuestion(context.userId!, questionId);
        await this.clearFeedQueueForQuestion(context.userId!, questionId);
      } else {
        candidate.status = 'rejected';
        await this.repository.save(candidate);
      }
    } else {
      candidate.status = 'rejected';
      await this.repository.save(candidate);
    }

    if (!(await this.hasPendingInferredFactReview(context.userId!))) {
      await this.enqueueNextAnswerInference(context.userId!);
    }

    return candidate as PromotionCandidate;
  }

  async countPending(userId: string): Promise<number> {
    return this.repository.count({ where: { userId, status: 'pending' } });
  }

  private async applyCandidate(
    context: UserServiceContext,
    candidate: PromotionCandidateEntity,
  ): Promise<void> {
    if (candidate.kind === 'inferred_fact') {
      const questionId = candidate.payload.questionId as string | undefined;
      const inferredText = candidate.payload.inferredText as string | undefined;

      if (questionId && inferredText) {
        const existing = await this.answerService.findByQuestionId(context, questionId);
        if (existing) {
          await this.answerService.update(context, existing.id, {
            text: inferredText,
            answerMethod: 'inferred',
            answerSource: 'inferred',
          });
        } else {
          await this.answerService.create(context, {
            text: inferredText,
            question: { id: questionId },
            answerMethod: 'inferred',
            answerSource: 'inferred',
          });
        }
      }
    } else if (candidate.kind === 'relationship' || candidate.kind === 'entity') {
      const entities = (candidate.payload.entities ?? []) as GraphEntityInputDto[];
      const relationships = (candidate.payload.relationships ?? []) as GraphRelationshipInputDto[];

      if (entities.length > 0 || relationships.length > 0) {
        await this.graphIngestService.ingest(context, { entities, relationships });
      }
    }

    this.logger.log('Promotion candidate accepted', {
      userId: context.userId,
      candidateId: candidate.id,
      kind: candidate.kind,
    });
  }

  private async rejectAllPendingInferredFactsForQuestion(userId: string, questionId: string): Promise<void> {
    await this.repository
      .createQueryBuilder()
      .update(PromotionCandidateEntity)
      .set({ status: 'rejected' })
      .where('user_id = :userId', { userId })
      .andWhere('kind = :kind', { kind: 'inferred_fact' })
      .andWhere('status = :status', { status: 'pending' })
      .andWhere("payload->>'questionId' = :questionId", { questionId })
      .execute();
  }

  private async rejectDuplicatePendingInferredFacts(
    userId: string,
    questionId: string,
    acceptedCandidateId: string,
  ): Promise<void> {
    await this.repository
      .createQueryBuilder()
      .update(PromotionCandidateEntity)
      .set({ status: 'rejected' })
      .where('user_id = :userId', { userId })
      .andWhere('kind = :kind', { kind: 'inferred_fact' })
      .andWhere('status = :status', { status: 'pending' })
      .andWhere("payload->>'questionId' = :questionId", { questionId })
      .andWhere('promotion_candidate_id <> :acceptedCandidateId', { acceptedCandidateId })
      .execute();
  }

  private async clearFeedQueueForQuestion(userId: string, questionId: string): Promise<void> {
    await this.dataSource.query(
      `
      DELETE FROM ci.feed_queue fq
      WHERE fq.user_id = $1
        AND fq.item_type = 'promotion_review'
        AND EXISTS (
          SELECT 1
          FROM ci.promotion_candidates pc
          WHERE pc.promotion_candidate_id::text = fq.metadata->>'promotionCandidateId'
            AND pc.user_id = $1
            AND pc.kind = 'inferred_fact'
            AND pc.payload->>'questionId' = $2
        );
      `,
      [userId, questionId],
    );
  }

  private async enqueueNextAnswerInference(userId: string): Promise<void> {
    const questionId = await this.findNextInferenceQuestionId(userId);

    if (!questionId) {
      this.logger.log('No unanswered questions left for inference after review', { userId });

      return;
    }

    await this.eventService.send(
      Events.INFER_QUESTION_ANSWER,
      {
        ownerId: userId,
        questionId,
      },
      {
        singletonKey: `infer:${userId}:${questionId}`,
      },
    );

    this.logger.log('Queued next answer inference after review decision', { userId, questionId });
  }

  private async findNextInferenceQuestionId(userId: string): Promise<string | null> {
    type Row = { id: string };
    const rows = (await this.dataSource.query(
      `
      SELECT q.question_id AS id
      FROM ci.questions q
      WHERE q.is_active = TRUE
        AND (q.is_private_to IS NULL OR q.is_private_to = $1)
        AND NOT EXISTS (
          SELECT 1 FROM ci.answers a
          WHERE a.question_id = q.question_id
            AND a.user_id = $1
            AND a.answer_method IN ('user', 'inferred')
            AND a.answer_text IS NOT NULL
            AND TRIM(a.answer_text) <> ''
        )
        ${EXCLUDE_QUESTIONS_WITH_PENDING_INFERRED_REVIEW}
        ${EXCLUDE_QUESTIONS_WITH_REJECTED_INFERRED_REVIEW}
      ORDER BY q.created_at ASC
      LIMIT 1;
      `,
      [userId],
    )) as Row[];

    return rows[0]?.id ?? null;
  }
}

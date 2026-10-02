import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, type UserServiceContext, SYSTEM_USER } from '@ci/common/context';
import { computeChunkSize } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { AnswerCreatedEvent, AnswerUpdatedEvent, AnswerRemovedEvent } from '@ci/domains/intelligence/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { Answer, AnswerEntity } from '../entities/AnswerEntity';
import type { CreateAnswerDto, UpdateAnswerDto } from '../types';

import { QuestionService } from './QuestionService';

/**
 * `ci.answers.answer_method` for words a person typed. `update` has always
 * stamped it on a user correction; `create` left it NULL, so the same answer
 * read differently depending on whether it had been edited yet. NULL is also not
 * "answered" to the two inference selectors (`answer_method IN ('user',
 * 'inferred')` in QuestionService.findUnansweredByUserId and
 * SmartRotationListener), so a question the person had already answered by hand
 * kept being offered to the model, which then discarded its own answer.
 */
const USER_ANSWER_METHOD = 'user';

/**
 * Hourly UTC per-user answer count. Declared locally so this domain carries
 * no dependency on aggregating consumers; they enforce the shape structurally
 * where they consume it.
 */
export interface HourlyAnswerCount {
  userId: string;
  bucketStart: Date;
  count: number;
}

@Injectable()
export class AnswerService {
  constructor(
    @InjectRepository(AnswerEntity)
    private readonly answerRepository: Repository<AnswerEntity>,
    private readonly eventService: EventService,
    private readonly questionService: QuestionService,
  ) {}

  /**
   * @param options.emitCreated When true (default) an AnswerCreatedEvent is sent so
   *   the row indexes/enriches live. The bulk path passes false: emitting a per-row
   *   pgboss event for every ingested row is the dominant cost at import volume, so
   *   bulk-loaded rows are instead swept by the post-load search-index backfill.
   *   The feed-queue cleanup is always applied (it's a plain DELETE, not a pgboss
   *   fan-out) so an answered question leaves the feed regardless of path.
   *
   * The question's `times_answered` is bumped on every path for the same reason:
   * it is one relative UPDATE, and a counter that skipped the import path would
   * report a number nobody could interpret.
   */
  async create(
    context: UserServiceContext,
    data: CreateAnswerDto,
    options: { emitCreated?: boolean } = {},
  ): Promise<Answer> {
    const { emitCreated = true } = options;

    // No method named, and no source other than the user's own (the column's
    // default is 'user_input'): this is a typed answer. An explicit method — the
    // inference writer's, a survey's — is never overridden, and neither is a row
    // whose source says someone else wrote it.
    const answerMethod =
      data.answerMethod ??
      (data.answerSource === undefined || data.answerSource === 'user_input'
        ? USER_ANSWER_METHOD
        : undefined);

    const instance = this.answerRepository.create({
      id: data.id ?? uuidv7(),
      answer: data.text,
      question: {
        id: data.question.id,
      },
      user: {
        id: context.userId,
      },
      ...(answerMethod !== undefined ? { answerMethod } : {}),
      ...(data.answerSource !== undefined ? { answerSource: data.answerSource } : {}),
      ...(data.answerConfidence !== undefined ? { answerConfidence: data.answerConfidence } : {}),
      ...(data.answerRationale !== undefined ? { answerRationale: data.answerRationale } : {}),
      ...(data.answerEvidence !== undefined ? { answerEvidence: data.answerEvidence } : {}),
      ...(data.sessionContext !== undefined ? { sessionContext: data.sessionContext } : {}),
    });

    const entity = await this.answerRepository.save(instance);

    // Count the answer against its question. Every path that records a NEW
    // answer funnels through here or through createMany, so these two calls are
    // the whole writer for ci.questions.times_answered — REST POST /answers, the
    // createAnswer(s) GraphQL mutations, the onboarding context prompts, and the
    // smart-rotation inference listener all land on one of them. Editing an
    // existing answer (AnswerService.update, which is how the inference listener
    // overwrites an answer the user already gave) deliberately does not count:
    // it is the same answer rewritten, not a second one.
    await this.questionService.recordQuestionAnswered(data.question.id);

    await this.questionService.removeFromFeedQueue(context.userId, data.question.id);

    if (emitCreated) {
      await this.eventService.send(AnswerCreatedEvent, {
        answerId: entity.id,
      });
    }

    return AnswerEntity.toEgressType(entity);
  }

  /**
   * Batch answers ingest. Replaces the per-row save + feed-queue DELETE +
   * AnswerCreatedEvent loop with one set-based INSERT, one batched feed-queue
   * cleanup, and one hydration SELECT. Answers have no dedup key, so every input
   * row is inserted. Returns the created answers in input order.
   *
   * Bulk ingest does NOT emit a per-row AnswerCreatedEvent: the per-row pgboss
   * fan-out was the dominant cost at import volume. Search indexing for
   * bulk-loaded rows is deferred to the post-load batch embed
   * (POST /api/maintenance/search-index/backfill). Single-row create() still
   * emits, so interactive creates index live. The feed-queue cleanup is still
   * applied (batched) so answered questions leave the feed.
   */
  async createMany(context: UserServiceContext, data: CreateAnswerDto[]): Promise<Answer[]> {
    if (data.length === 0) {
      return [];
    }

    const entities = data.map((item) =>
      this.answerRepository.create({
        id: item.id ?? uuidv7(),
        answer: item.text,
        // The batch form of `create`: rows get the column's default source
        // ('user_input'), so they get the typed answer's method too.
        answerMethod: item.answerMethod ?? USER_ANSWER_METHOD,
        question: {
          id: item.question.id,
        },
        user: {
          id: context.userId,
        },
      }),
    );

    // Split into param-budget-bounded chunks so a large batch never exceeds
    // Postgres' 65535 bind-param limit (computeChunkSize is the same helper
    // bulkInsertIdempotent uses). Answers have no dedup key, so every chunk is a
    // plain multi-row INSERT.
    const chunkSize = computeChunkSize(this.answerRepository.metadata.columns.length);
    for (let offset = 0; offset < entities.length; offset += chunkSize) {
      await this.answerRepository
        .createQueryBuilder()
        .insert()
        // Route through `metadata.target` so TS picks the `ObjectLiteral` overload
        // of `.values()`; passing the entity class narrows to
        // `_QueryDeepPartialEntity`, which rejects the jsonb `sessionContext` column.
        .into(this.answerRepository.metadata.target)
        .values(entities.slice(offset, offset + chunkSize))
        .execute();
    }

    // Batched times_answered bump: one UPDATE for the whole batch. Deliberately
    // NOT de-duplicated the way the feed-queue cleanup below is — two answers to
    // the same question are two answers, and must count twice.
    await this.questionService.recordManyQuestionsAnswered(data.map((item) => item.question.id));

    // Batched feed-queue cleanup: drop every answered question from the feed in
    // one DELETE instead of N per-row removeFromFeedQueue calls.
    const questionIds = [...new Set(data.map((item) => item.question.id))];
    await this.questionService.removeManyFromFeedQueue(context.userId, questionIds);

    const ids = entities.map((entity) => entity.id);
    const rows = await this.answerRepository.find({
      where: { id: In(ids) },
      relations: ['user', 'question'],
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return entities.map((entity) => AnswerEntity.toEgressType(byId.get(entity.id) ?? entity));
  }

  async findAll(context: UserServiceContext): Promise<Answer[]> {
    const result = await this.answerRepository.find({
      where: {
        user: {
          id: context.userId,
        },
      },
      relations: ['user', 'question'],
    });

    return result.map((entity) => AnswerEntity.toEgressType(entity));
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Answer | null)[]> {
    if (ids.length === 0) {
      return [];
    }

    const result = await this.answerRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
        id: In(ids),
      },
      relations: ['user', 'question'],
    });

    const map = new Map(result.map((entity) => [entity.id, AnswerEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findById(context: ServiceContext, id: string): Promise<Answer | null> {
    const result = await this.answerRepository.findOne({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
        id: id,
      },
      relations: ['user', 'question'],
    });

    return result ? AnswerEntity.toEgressType(result) : null;
  }

  async findByQuestionId(context: ServiceContext, questionId: string): Promise<Answer | null> {
    const result = await this.answerRepository.findOne({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
        question: {
          id: questionId,
        },
      },
      relations: ['user', 'question'],
    });

    return result ? AnswerEntity.toEgressType(result) : null;
  }

  async update(context: ServiceContext, id: string, data: UpdateAnswerDto): Promise<Answer | null> {
    const updateData: Partial<AnswerEntity> = {};

    if (data.text !== undefined) {
      updateData.answer = data.text;
    }

    if (data.answerConfidence !== undefined) {
      updateData.answerConfidence = data.answerConfidence;
    }

    if (data.answerRationale !== undefined) {
      updateData.answerRationale = data.answerRationale;
    }

    if (data.answerEvidence !== undefined) {
      updateData.answerEvidence = data.answerEvidence;
    }

    if (data.answerSource !== undefined) {
      updateData.answerSource = data.answerSource;
    }

    if (data.answerMethod !== undefined) {
      updateData.answerMethod = data.answerMethod;
    }

    if (data.answeredAt !== undefined) {
      updateData.answeredAt = data.answeredAt;
    }

    if (data.sessionContext !== undefined) {
      updateData.sessionContext = data.sessionContext;
    }

    if (data.emotionalState !== undefined) {
      updateData.emotionalState = data.emotionalState;
    }

    if (data.locationContext !== undefined) {
      updateData.locationContext = data.locationContext;
    }

    if (data.extractedEntities !== undefined) {
      updateData.extractedEntities = data.extractedEntities;
    }

    if (data.sentimentScore !== undefined) {
      updateData.sentimentScore = data.sentimentScore;
    }

    if (data.complexityScore !== undefined) {
      updateData.complexityScore = data.complexityScore;
    }

    if (data.isSensitive !== undefined) {
      updateData.isSensitive = data.isSensitive;
    }

    if (data.sharingLevel !== undefined) {
      updateData.sharingLevel = data.sharingLevel;
    }

    // A text edit with no explicit provenance is a USER CORRECTION: the person
    // read what the appliance had inferred on their behalf and rewrote it. Those
    // words are now theirs, so the row stops claiming to be a machine inference —
    // source and method flip, and the confidence and rationale are cleared rather
    // than left behind, since a score the model gave to text it no longer wrote
    // would be a lie the UI renders as a badge.
    //
    // Gated on the caller NOT naming a source, so the inference listener's own
    // update (which passes answerSource: 'inferred' explicitly) is untouched. The
    // REST/GraphQL edit paths only ever pass `text`, which is exactly the case
    // this catches.
    const isUserCorrection = data.text !== undefined && data.answerSource === undefined;

    if (isUserCorrection) {
      updateData.answerSource = 'user_input';
      updateData.answerMethod = data.answerMethod ?? 'user';

      if (data.answerConfidence === undefined) {
        updateData.answerConfidence = null;
      }

      if (data.answerRationale === undefined) {
        updateData.answerRationale = null;
      }

      // Same reasoning as the rationale, one step further: the citations point at
      // rows that grounded a sentence the user has just replaced. Left behind,
      // the drawer would offer messages and events as the provenance of words
      // they never supported — a stronger lie than a stale score, because it
      // names real records to back it up.
      if (data.answerEvidence === undefined) {
        updateData.answerEvidence = null;
      }
    }

    const answer = await this.answerRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      },
    });

    if (answer) {
      Object.assign(answer, updateData);
      await this.answerRepository.save(answer);
    } else {
      return null;
    }

    await this.eventService.send(AnswerUpdatedEvent, {
      answerId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const answer = await this.answerRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          user: { id: context.userId },
        }),
      },
    });

    if (!answer) {
      return false;
    }

    await this.answerRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        user: { id: context.userId },
      }),
    });

    await this.eventService.send(AnswerRemovedEvent, {
      answerId: id,
    });

    return true;
  }

  /**
   * Lightweight identifiers for the most-recent answers, for the unified
   * search/explorer feed. Full entities are batch-resolved downstream.
   */
  async getEntitiesForAnswers(
    context: ServiceContext,
    options: {
      limit?: number;
      startTime?: Date;
      endTime?: Date;
      afterTime?: Date;
      afterId?: string;
      order?: 'ASC' | 'DESC';
    } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.answerRepository
      .createQueryBuilder('answer')
      .select('answer.answer_id', 'id')
      .where('answer.user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('answer.answered_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('answer.answered_at <= :endTime', { endTime: options.endTime });
    }

    // Composite keyset: page strictly past (afterTime, afterId) in
    // (answered_at DESC, answer_id DESC) — see ContentService.getEntitiesForContents.
    // Answers order by answered_at, which is also what getEntityTimestamp sorts them on.
    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        '(answer.answered_at < :afterTime OR (answer.answered_at = :afterTime AND answer.answer_id < :afterId))',
        { afterTime: options.afterTime, afterId: options.afterId },
      );
    }

    // Deterministic tiebreak so same-timestamp rows page consistently.
    query = query
      .orderBy('answer.answered_at', options.order ?? 'DESC')
      .addOrderBy('answer.answer_id', 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'answer' as IndexableEntity }));
  }

  /**
   * True total of answers matching the same filters {@link getEntitiesForAnswers} applies
   * (minus the pagination-only `limit`/`order`/`afterTime`/`afterId`) — a real `COUNT(*)`, not
   * the length of one `limit`-bounded page of identifiers. See CalendarEventService.countEntitiesForEvents.
   */
  async countEntitiesForAnswers(
    context: ServiceContext,
    options: { startTime?: Date; endTime?: Date },
  ): Promise<number> {
    let query = this.answerRepository
      .createQueryBuilder('answer')
      .where('answer.user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('answer.answered_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('answer.answered_at <= :endTime', { endTime: options.endTime });
    }

    return query.getCount();
  }

  /**
   * Hourly UTC activity buckets for the activity rollup: answers counted by
   * `answeredAt`, per user. AnswerEntity models the user only as a relation,
   * so the FK column is referenced directly.
   */
  async aggregateHourlyActivity(): Promise<HourlyAnswerCount[]> {
    const rows: Array<{ user_id: string; bucket_start: Date; count: number }> = await this.answerRepository
      .createQueryBuilder('answer')
      .select('answer.user_id', 'user_id')
      .addSelect(`date_trunc('hour', answer.answeredAt, 'UTC')`, 'bucket_start')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('user_id')
      .addGroupBy('bucket_start')
      .getRawMany();

    return rows.map((row) => ({ userId: row.user_id, bucketStart: row.bucket_start, count: row.count }));
  }
}

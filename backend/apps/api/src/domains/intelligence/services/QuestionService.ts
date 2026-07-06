import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, type FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { EventService } from '@ci/domains/events';
import {
  QuestionCreatedEvent,
  QuestionUpdatedEvent,
  QuestionRemovedEvent,
} from '@ci/domains/intelligence/events';

import { Question, QuestionEntity } from '../entities/QuestionEntity';
import type { CreateQuestionDto, UpdateQuestionDto } from '../types';

const FEED_QUESTION_QUEUE_LIMIT = 3;

@Injectable()
export class QuestionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(QuestionEntity)
    private readonly questionRepository: Repository<QuestionEntity>,
    private readonly eventService: EventService,
  ) {}

  /**
   * Resolve the effective is_private_to for a question: an explicit value on the
   * DTO wins; otherwise a real (non-system) caller privatizes to themselves, and
   * a system caller leaves it public (null).
   */
  private resolveIsPrivateTo(context: ServiceContext, data: CreateQuestionDto): string | null {
    return data.isPrivateTo !== undefined
      ? data.isPrivateTo
      : context.userId && context.userId !== SYSTEM_USER
        ? context.userId
        : null;
  }

  /**
   * @param options.emitCreated When true (default) a QuestionCreatedEvent is sent so
   *   the row indexes/enriches live. The bulk path passes false: emitting a per-row
   *   pgboss event for every ingested row is the dominant cost at import volume, so
   *   bulk-loaded rows are instead swept by the post-load search-index backfill.
   */
  async create(
    context: ServiceContext,
    data: CreateQuestionDto,
    options: { emitCreated?: boolean } = {},
  ): Promise<Question> {
    const { emitCreated = true } = options;
    const id = data.id ?? uuidv7();

    const isPrivateTo = this.resolveIsPrivateTo(context, data);

    const instance = await this.questionRepository.create({
      id,
      text: data.text,
      category: data.category,
      isSeedQuestion: data.isSeedQuestion ?? false,
      createdByLlm: data.createdByLlm ?? false,
      frequencyRecommendation: data.frequencyRecommendation,
      isActive: data.isActive ?? true,
      isPrivateTo: isPrivateTo,
    });

    const entity = await this.questionRepository.save(instance);

    if (emitCreated) {
      await this.eventService.send(QuestionCreatedEvent, {
        questionId: id,
      });
    }

    return QuestionEntity.toEgressType(entity);
  }

  /**
   * Batch questions ingest. Replaces the per-row save + QuestionCreatedEvent loop
   * with one set-based INSERT plus one hydration SELECT. Questions have no dedup
   * key, so every input row is inserted; per-question logic (id allocation,
   * isPrivateTo resolution) is preserved. Returns the created questions in input
   * order.
   *
   * Bulk ingest does NOT emit a per-row QuestionCreatedEvent: the per-row pgboss
   * fan-out was the dominant cost at import volume. Search indexing for
   * bulk-loaded rows is deferred to the post-load batch embed
   * (POST /api/maintenance/search-index/backfill). Single-row create() still
   * emits, so interactive creates index live.
   */
  async createMany(context: ServiceContext, data: CreateQuestionDto[]): Promise<Question[]> {
    if (data.length === 0) {
      return [];
    }

    const entities = data.map((item) =>
      this.questionRepository.create({
        id: item.id ?? uuidv7(),
        text: item.text,
        category: item.category,
        isSeedQuestion: item.isSeedQuestion ?? false,
        createdByLlm: item.createdByLlm ?? false,
        frequencyRecommendation: item.frequencyRecommendation,
        isActive: item.isActive ?? true,
        isPrivateTo: this.resolveIsPrivateTo(context, item),
      }),
    );

    await this.questionRepository
      .createQueryBuilder()
      .insert()
      // Route through `metadata.target` so TS picks the `ObjectLiteral` overload
      // of `.values()` (matches the other bulk-ingest services).
      .into(this.questionRepository.metadata.target)
      .values(entities)
      .execute();

    const ids = entities.map((entity) => entity.id);
    const rows = await this.questionRepository.find({ where: { id: In(ids) } });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return entities.map((entity) => QuestionEntity.toEgressType(byId.get(entity.id) ?? entity));
  }

  async findAll(context: ServiceContext): Promise<Question[]> {
    const whereClauses: FindOptionsWhere<QuestionEntity>[] = [
      {
        isActive: true,
        isPrivateTo: IsNull(),
      },
    ];

    if (context?.userId !== SYSTEM_USER) {
      whereClauses.push({ isActive: true, isPrivateTo: context.userId });
    }

    const result = await this.questionRepository.find({
      where: whereClauses,
    });

    const unique = new Map<string, QuestionEntity>();

    for (const entity of result) {
      unique.set(entity.id, entity);
    }

    return Array.from(unique.values()).map((entity) => QuestionEntity.toEgressType(entity));
  }

  async findById(context: ServiceContext, id: string): Promise<Question | null> {
    const whereClauses: FindOptionsWhere<QuestionEntity>[] = [
      {
        id: id,
        isPrivateTo: IsNull(),
      },
    ];

    if (context?.userId && context.userId !== SYSTEM_USER) {
      whereClauses.push({ id: id, isPrivateTo: context.userId });
    }

    const result = await this.questionRepository.findOne({
      where: whereClauses,
    });

    return result ? QuestionEntity.toEgressType(result) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<Question[]> {
    const whereClauses: FindOptionsWhere<QuestionEntity>[] = [
      {
        id: In(ids),
        isPrivateTo: IsNull(),
      },
    ];

    if (context?.userId && context.userId !== SYSTEM_USER) {
      whereClauses.push({ id: In(ids), isPrivateTo: context.userId });
    }

    const results = await this.questionRepository.find({
      where: whereClauses,
    });

    const unique = new Map<string, QuestionEntity>();

    for (const entity of results) {
      unique.set(entity.id, entity);
    }

    return Array.from(unique.values()).map((entity) => QuestionEntity.toEgressType(entity));
  }

  async update(
    context: ServiceContext,
    questionId: string,
    data: UpdateQuestionDto,
  ): Promise<Question | null> {
    const updateData: Partial<QuestionEntity> = {};

    if (data.subcategory !== undefined) {
      updateData.category = data.subcategory;
    }

    if (data.text !== undefined) {
      updateData.text = data.text;
    }

    if (data.contextTags !== undefined) {
      updateData.contextTags = data.contextTags;
    }

    if (data.questionType !== undefined) {
      updateData.questionType = data.questionType;
    }

    if (data.isSeedQuestion !== undefined) {
      updateData.isSeedQuestion = data.isSeedQuestion;
    }

    if (data.isActive !== undefined) {
      updateData.isActive = data.isActive;
    }

    if (data.createdByLlm !== undefined) {
      updateData.createdByLlm = data.createdByLlm;
    }

    if (data.frequencyRecommendation !== undefined) {
      updateData.frequencyRecommendation = data.frequencyRecommendation;
    }

    if (data.timesAsked !== undefined) {
      updateData.timesAsked = data.timesAsked;
    }

    if (data.timesAnswered !== undefined) {
      updateData.timesAnswered = data.timesAnswered;
    }

    if (data.isPrivateTo !== undefined) {
      updateData.isPrivateTo = data.isPrivateTo;
    }

    const question = await this.questionRepository.findOne({
      where: {
        id: questionId,
        ...(context.userId !== SYSTEM_USER && {
          isPrivateTo: context.userId,
        }),
      },
    });

    if (question) {
      Object.assign(question, updateData);
      await this.questionRepository.save(question);
    } else {
      return null;
    }

    await this.eventService.send(QuestionUpdatedEvent, {
      questionId: questionId,
    });

    return this.findById(context, questionId);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const question = await this.questionRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          isPrivateTo: context.userId,
        }),
      },
    });

    if (!question) {
      return false;
    }

    await this.questionRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        isPrivateTo: context.userId,
      }),
    });

    await this.eventService.send(QuestionRemovedEvent, {
      questionId: id,
    });

    return true;
  }

  async findUnansweredByUserId(): Promise<Map<string | null, string[]>> {
    // TODO: We need to refine how we're selecting "unanswered questions".
    //
    // This first cut gets the fundamentals roughly nailed down.
    //
    // OK, so what about multiple tenants on a server box? How do we make sure
    // that we're not choking out user answer processing because of a noisy neighbor?
    // We can consider querying for top 5 for every user.
    //
    // How do we achieve stability? It's likely the best answer we're going to get to
    // a question is a user-provided one. We might consider answers "stable" if they
    // have such an answer. We can offer users a way to correct LLM infererences.
    //
    // Otherwise how could we consider an answer good enough? It's possible we
    // could infer a second answer that would be worse than the first.
    //
    // Point being that there are rough edges here that we need to refine. But the
    // concept of "get me unaswered questions by user," can clearly live here.

    type Row = {
      id: string;
      user_id: string | null;
    };

    const rows = (await this.dataSource.query(`
      SELECT
        q.question_id as id,
        COALESCE(q.is_private_to, a.user_id) as user_id
      FROM
        ci.questions as q
      LEFT JOIN ci.answers as a ON a.question_id = q.question_id
      WHERE q.is_active = TRUE
        AND (a.answer_id IS NULL OR a.answer_text IS NULL)
        AND (
          q.is_private_to IS NULL
          OR a.user_id IS NULL
          OR a.user_id = q.is_private_to
        )
      LIMIT 5;
    `)) satisfies Array<Row>;

    const groupedByUserId = new Map<string | null, string[]>();

    for (const row of rows) {
      const userId = row.user_id;

      if (!groupedByUserId.has(userId)) {
        groupedByUserId.set(userId, []);
      }

      groupedByUserId.get(userId)!.push(row.id);
    }

    return groupedByUserId;
  }

  async findOneUnanswered(context: ServiceContext): Promise<Question | null> {
    if (!context.userId || context.userId === SYSTEM_USER) {
      return null;
    }

    type Row = {
      id: string;
    };

    await this.cleanupFeedQueue(context.userId);

    const rows = (await this.dataSource.query(
      `
      SELECT
        q.question_id as id
      FROM
        ci.feed_queue as fq
      JOIN ci.questions as q ON q.question_id = fq.question_id
      LEFT JOIN ci.answers as a ON a.question_id = fq.question_id
        AND a.user_id = fq.user_id
      WHERE fq.user_id = $1
        AND q.is_active = TRUE
        AND (a.answer_id IS NULL OR a.answer_text IS NULL)
      ORDER BY fq.enqueued_at ASC, fq.feed_queue_id ASC
      LIMIT 1;
    `,
      [context.userId],
    )) satisfies Array<Row>;

    if (rows.length === 0) {
      return null;
    }

    return this.findById(context, rows[0].id);
  }

  async listFeedQueueUserIds(): Promise<string[]> {
    type Row = {
      id: string;
    };

    const rows = (await this.dataSource.query(
      `
      SELECT id
      FROM ci.users
      WHERE onboarded = TRUE
      ORDER BY created_at ASC;
      `,
    )) satisfies Array<Row>;

    return rows.map((row) => row.id);
  }

  async enqueueNextFeedQueueQuestion(
    userId: string,
    maxQueueSize = FEED_QUESTION_QUEUE_LIMIT,
  ): Promise<boolean> {
    await this.cleanupFeedQueue(userId);

    type QueueCountRow = {
      count: string;
    };
    const countRows = (await this.dataSource.query(
      `
      SELECT COUNT(*)::text as count
      FROM ci.feed_queue
      WHERE user_id = $1
        AND question_id IS NOT NULL;
      `,
      [userId],
    )) satisfies Array<QueueCountRow>;
    const queueSize = Number.parseInt(countRows[0]?.count ?? '0', 10);

    if (queueSize >= maxQueueSize) {
      return false;
    }

    type CandidateRow = {
      id: string;
    };
    const candidates = (await this.dataSource.query(
      `
      SELECT q.question_id as id
      FROM ci.questions as q
      WHERE q.is_active = TRUE
        AND (q.is_private_to IS NULL OR q.is_private_to = $1)
        AND NOT EXISTS (
          SELECT 1
          FROM ci.answers as a
          WHERE a.question_id = q.question_id
            AND a.user_id = $1
            AND a.answer_text IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ci.feed_queue as fq
          WHERE fq.user_id = $1
            AND fq.question_id = q.question_id
        )
      ORDER BY q.created_at ASC, q.question_id ASC
      LIMIT 1;
      `,
      [userId],
    )) satisfies Array<CandidateRow>;

    const candidate = candidates[0];
    if (!candidate) {
      return false;
    }

    const insertedRows = (await this.dataSource.query(
      `
      INSERT INTO ci.feed_queue (feed_queue_id, user_id, question_id, enqueued_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id, question_id) DO NOTHING
      RETURNING question_id;
      `,
      [uuidv7(), userId, candidate.id],
    )) satisfies Array<{ question_id: string }>;

    return insertedRows.length > 0;
  }

  async removeFromFeedQueue(userId: string, questionId: string): Promise<void> {
    await this.dataSource.query(
      `
      DELETE FROM ci.feed_queue
      WHERE user_id = $1
        AND question_id = $2;
      `,
      [userId, questionId],
    );
  }

  /**
   * Batched {@link removeFromFeedQueue}: drop every listed question from the
   * user's feed in a single DELETE. Used by the bulk answer-ingest path so
   * answering N questions costs one query instead of N.
   */
  async removeManyFromFeedQueue(userId: string, questionIds: string[]): Promise<void> {
    if (questionIds.length === 0) {
      return;
    }

    await this.dataSource.query(
      `
      DELETE FROM ci.feed_queue
      WHERE user_id = $1
        AND question_id = ANY($2::uuid[]);
      `,
      [userId, questionIds],
    );
  }

  private async cleanupFeedQueue(userId: string): Promise<void> {
    await this.dataSource.query(
      `
      DELETE FROM ci.feed_queue as fq
      USING ci.answers as a
      WHERE fq.user_id = $1
        AND fq.question_id IS NOT NULL
        AND a.user_id = fq.user_id
        AND a.question_id = fq.question_id
        AND a.answer_text IS NOT NULL;
      `,
      [userId],
    );

    await this.dataSource.query(
      `
      DELETE FROM ci.feed_queue as fq
      WHERE fq.user_id = $1
        AND fq.question_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM ci.questions as q
          WHERE q.question_id = fq.question_id
            AND q.is_active = TRUE
        );
      `,
      [userId],
    );
  }
}

import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, type FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, SYSTEM_USER } from '@ci/common/context';
import { computeChunkSize } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import {
  QuestionCreatedEvent,
  QuestionUpdatedEvent,
  QuestionRemovedEvent,
} from '@ci/domains/intelligence/events';

import { Question, QuestionEntity } from '../entities/QuestionEntity';
import type { CreateQuestionDto, UpdateQuestionDto } from '../types';

const FEED_QUESTION_QUEUE_LIMIT = 3;
/** Unanswered front-of-queue questions rotate after this long on the feed. */
export const FEED_QUESTION_STALE_MS = 30 * 60 * 1000;

const GAP_AWARE_CANDIDATE_SQL = `
  WITH category_coverage AS (
    SELECT
      q.question_category AS category,
      COUNT(DISTINCT a.answer_id)::int AS answered_count
    FROM ci.questions q
    LEFT JOIN ci.answers a
      ON a.question_id = q.question_id
      AND a.user_id = $1
      AND a.answer_text IS NOT NULL
      AND TRIM(a.answer_text) <> ''
    WHERE q.is_active = TRUE
      AND (q.is_private_to IS NULL OR q.is_private_to = $1)
    GROUP BY q.question_category
  )
  SELECT q.question_id AS id
  FROM ci.questions q
  LEFT JOIN category_coverage cc ON cc.category = q.question_category
  WHERE q.is_active = TRUE
    AND (q.is_private_to IS NULL OR q.is_private_to = $1)
    AND NOT EXISTS (
      SELECT 1
      FROM ci.answers a
      WHERE a.question_id = q.question_id
        AND a.user_id = $1
        AND a.answer_text IS NOT NULL
        AND TRIM(a.answer_text) <> ''
    )
    AND NOT EXISTS (
      SELECT 1
      FROM ci.feed_queue fq
      WHERE fq.user_id = $1
        AND fq.question_id = q.question_id
    )
  ORDER BY COALESCE(cc.answered_count, 0) ASC, RANDOM()
  LIMIT 1;
`;

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

    // Split into param-budget-bounded chunks so a large batch never exceeds
    // Postgres' 65535 bind-param limit (computeChunkSize is the same helper
    // bulkInsertIdempotent uses). Questions have no dedup key, so every chunk is
    // a plain multi-row INSERT.
    const chunkSize = computeChunkSize(this.questionRepository.metadata.columns.length);
    for (let offset = 0; offset < entities.length; offset += chunkSize) {
      await this.questionRepository
        .createQueryBuilder()
        .insert()
        // Route through `metadata.target` so TS picks the `ObjectLiteral` overload
        // of `.values()` (matches the other bulk-ingest services).
        .into(this.questionRepository.metadata.target)
        .values(entities.slice(offset, offset + chunkSize))
        .execute();
    }

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
      WITH unanswered AS (
        SELECT
          q.question_id AS id,
          COALESCE(q.is_private_to, u.user_id) AS user_id,
          q.created_at,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(q.is_private_to, u.user_id)
            ORDER BY q.created_at ASC
          ) AS rn
        FROM ci.questions q
        CROSS JOIN (SELECT DISTINCT id AS user_id FROM ci.users WHERE id IS NOT NULL) u
        WHERE q.is_active = TRUE
          AND (q.is_private_to IS NULL OR q.is_private_to = u.user_id)
          AND NOT EXISTS (
            SELECT 1
            FROM ci.answers a
            WHERE a.question_id = q.question_id
              AND a.user_id = u.user_id
              AND a.answer_method IN ('user', 'inferred')
              AND a.answer_text IS NOT NULL
              AND TRIM(a.answer_text) <> ''
          )
      )
      SELECT id, user_id
      FROM unanswered
      WHERE rn <= 1;
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

    await this.cleanupFeedQueue(context.userId);
    await this.rotateStaleFeedQuestions(context.userId);
    await this.ensureFeedQueueHasQuestion(context.userId);

    type Row = {
      id: string;
      feed_queue_id: string;
    };

    const rows = (await this.dataSource.query(
      `
      SELECT
        q.question_id as id,
        fq.feed_queue_id
      FROM
        ci.feed_queue as fq
      JOIN ci.questions as q ON q.question_id = fq.question_id
      LEFT JOIN ci.answers as a ON a.question_id = fq.question_id
        AND a.user_id = fq.user_id
      WHERE fq.user_id = $1
        AND fq.question_id IS NOT NULL
        AND q.is_active = TRUE
        AND (a.answer_id IS NULL OR a.answer_text IS NULL OR TRIM(a.answer_text) = '')
      ORDER BY fq.enqueued_at ASC, fq.feed_queue_id ASC
      LIMIT 1;
    `,
      [context.userId],
    )) satisfies Array<Row>;

    if (rows.length === 0) {
      return null;
    }

    const { id: questionId, feed_queue_id: feedQueueId } = rows[0];
    await this.recordFeedQuestionPresentation(context.userId, questionId);

    const question = await this.findById(context, questionId);
    if (!question) {
      return null;
    }

    return Object.assign(question, { presentationId: feedQueueId });
  }

  /**
   * Move a front-of-queue question that was shown but left unanswered for too
   * long to the back and top up with a fresh pick when possible.
   */
  async rotateStaleFeedQuestions(userId: string): Promise<boolean> {
    type FrontRow = {
      feed_queue_id: string;
      question_id: string;
      metadata: Record<string, unknown> | null;
    };

    const frontRows = (await this.dataSource.query(
      `
      SELECT
        fq.feed_queue_id,
        fq.question_id,
        fq.metadata
      FROM ci.feed_queue fq
      JOIN ci.questions q ON q.question_id = fq.question_id
      LEFT JOIN ci.answers a
        ON a.question_id = fq.question_id
        AND a.user_id = fq.user_id
      WHERE fq.user_id = $1
        AND fq.question_id IS NOT NULL
        AND q.is_active = TRUE
        AND (a.answer_id IS NULL OR a.answer_text IS NULL OR TRIM(a.answer_text) = '')
      ORDER BY fq.enqueued_at ASC, fq.feed_queue_id ASC
      LIMIT 1;
      `,
      [userId],
    )) satisfies Array<FrontRow>;

    const front = frontRows[0];
    if (!front) {
      return false;
    }

    const lastPresentedRaw = front.metadata?.lastPresentedAt;
    if (typeof lastPresentedRaw !== 'string') {
      return false;
    }

    const lastPresentedAt = Date.parse(lastPresentedRaw);
    if (!Number.isFinite(lastPresentedAt) || Date.now() - lastPresentedAt < FEED_QUESTION_STALE_MS) {
      return false;
    }

    await this.dataSource.query(
      `
      UPDATE ci.feed_queue
      SET
        enqueued_at = NOW(),
        metadata = (COALESCE(metadata, '{}'::jsonb) - 'lastPresentedAt') || jsonb_build_object('rotatedAt', to_jsonb(NOW()::text))
      WHERE feed_queue_id = $1;
      `,
      [front.feed_queue_id],
    );

    await this.enqueueNextFeedQueueQuestion(userId, FEED_QUESTION_QUEUE_LIMIT);

    return true;
  }

  /** Stamp first presentation time on the feed row and bump times_asked on the question. */
  async recordFeedQuestionPresentation(userId: string, questionId: string): Promise<void> {
    type Row = { updated: boolean };
    const rows = (await this.dataSource.query(
      `
      UPDATE ci.feed_queue
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('lastPresentedAt', to_jsonb(NOW()::text))
      WHERE user_id = $1
        AND question_id = $2
        AND (metadata->>'lastPresentedAt' IS NULL)
      RETURNING TRUE AS updated;
      `,
      [userId, questionId],
    )) satisfies Array<Row>;

    if (!rows[0]?.updated) {
      return;
    }

    await this.dataSource.query(
      `
      UPDATE ci.questions
      SET times_asked = times_asked + 1
      WHERE question_id = $1;
      `,
      [questionId],
    );
  }

  /** Ensure at least one unanswered question is queued when candidates exist. */
  async ensureFeedQueueHasQuestion(userId: string): Promise<boolean> {
    type QueueCountRow = { count: string };
    const countRows = (await this.dataSource.query(
      `
      SELECT COUNT(*)::text AS count
      FROM ci.feed_queue fq
      JOIN ci.questions q ON q.question_id = fq.question_id
      LEFT JOIN ci.answers a
        ON a.question_id = fq.question_id
        AND a.user_id = fq.user_id
      WHERE fq.user_id = $1
        AND fq.question_id IS NOT NULL
        AND q.is_active = TRUE
        AND (a.answer_id IS NULL OR a.answer_text IS NULL OR TRIM(a.answer_text) = '');
      `,
      [userId],
    )) satisfies Array<QueueCountRow>;

    const activeCount = Number.parseInt(countRows[0]?.count ?? '0', 10);
    if (activeCount > 0) {
      return false;
    }

    return this.enqueueNextFeedQueueQuestion(userId, 1);
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
    const candidates = (await this.dataSource.query(GAP_AWARE_CANDIDATE_SQL, [
      userId,
    ])) satisfies Array<CandidateRow>;

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

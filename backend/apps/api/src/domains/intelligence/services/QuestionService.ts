import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, type FindOptionsWhere, In, IsNull, Not, Repository } from 'typeorm';
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
import { inferenceDispatchOpenSql } from '../inferenceDispatchGate';
import { QUESTION_ROTATION_ORDER_SQL, QUESTION_ROTATION_RANK_SQL, TIER_RANK_SQL } from '../questionOrder';
import { excludeForkedOriginsSql } from '../questionScope';
import type {
  AnswerEvidence,
  CreateQuestionDto,
  QuestionCatalogueQueryDto,
  QuestionInferenceStanding,
  UpdateQuestionDto,
} from '../types';

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
      ${excludeForkedOriginsSql('q', '$1')}
    GROUP BY q.question_category
  )
  SELECT q.question_id AS id
  FROM ci.questions q
  LEFT JOIN category_coverage cc ON cc.category = q.question_category
  WHERE q.is_active = TRUE
    AND (q.is_private_to IS NULL OR q.is_private_to = $1)
    ${excludeForkedOriginsSql('q', '$1')}
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
  ORDER BY ${TIER_RANK_SQL} ASC, COALESCE(cc.answered_count, 0) ASC, RANDOM()
  LIMIT 1;
`;

/**
 * The caller's most recent real answer to each question, or nothing. A LATERAL
 * rather than a plain LEFT JOIN so a question that somehow carries two answer
 * rows still yields exactly one catalogue row.
 *
 * `$1` is the caller's user id (NULL for a system caller, which then matches no
 * answers — `= NULL` is NULL, not true).
 */
const CATALOGUE_ANSWER_LATERAL_SQL = `
  LEFT JOIN LATERAL (
    SELECT
      a.answer_id,
      a.answer_text,
      a.answer_source,
      a.answer_confidence,
      a.answer_rationale,
      a.answer_evidence,
      a.answered_at
    FROM ci.answers a
    WHERE a.question_id = q.question_id
      AND a.user_id = $1::uuid
      AND a.answer_text IS NOT NULL
      AND TRIM(a.answer_text) <> ''
    ORDER BY a.answered_at DESC, a.answer_id DESC
    LIMIT 1
  ) a ON TRUE
`;

/**
 * Visibility + lifecycle + free-text predicate. Facets are computed against
 * THIS and not against the full predicate below: narrowing to one category must
 * not collapse the category picker to the one category already chosen.
 */
const CATALOGUE_BASE_WHERE_SQL = `
  (q.is_private_to IS NULL OR q.is_private_to = $1::uuid)
  ${excludeForkedOriginsSql('q', '$1::uuid')}
  AND ($2 = 'all' OR q.is_active = ($2 = 'active'))
  AND ($3::text IS NULL OR q.question_text ILIKE '%' || $3 || '%')
`;

const CATALOGUE_FULL_WHERE_SQL = `
  ${CATALOGUE_BASE_WHERE_SQL}
  AND ($4::text IS NULL OR q.question_category = $4)
  AND ($5::text IS NULL OR q.answer_tier = $5)
  AND ($6 = 'all' OR (a.answer_id IS NOT NULL) = ($6 = 'answered'))
`;

/** The answered/unanswered state of one catalogue row, for the browse surface. */
export interface QuestionCatalogueAnswer {
  id: string;
  text: string;
  /** 'user_input' | 'inferred' | 'observed' | 'imported' — drives AnswerProvenance. */
  source: string | null;
  confidence: number | null;
  rationale: string | null;
  /**
   * The database rows an inferred answer was actually read out of — both the
   * ones the model cited and the ones it was shown and passed over. See
   * `ci.answers.answer_evidence`. Null for every answer the user typed, and for
   * inferred rows written before the column existed.
   *
   * Inlined on the browse payload rather than fetched per-answer because the
   * drawer opens off a row that is already on screen: a second round trip to
   * show the provenance of something already rendered is a spinner for no
   * reason. Kept affordable at the write end instead — AnswerInferenceListener
   * caps both arrays and both snippet lengths before the row is stored, which is
   * what makes the browse payload a function of the caps and not of how
   * connected the retrieval happened to be.
   *
   * Passed through as the whole jsonb wrapper (`row.answer_evidence`), so a
   * field added at the write end reaches the drawer without a change here.
   */
  evidence: AnswerEvidence | null;
  answeredAt: Date;
}

export interface QuestionCatalogueEntry {
  id: string;
  /**
   * `ci.questions.question_key` — the stable slug a curated question is known
   * by, or null for the ~1.3k rows nobody addresses by name. Callers that
   * asked with `keys` key their results off this, not off `id`: the id is
   * minted per appliance and means nothing to them.
   */
  key: string | null;
  text: string;
  category: string | null;
  answerTier: string | null;
  questionType: string | null;
  frequencyRecommendation: string | null;
  isActive: boolean;
  isSeedQuestion: boolean;
  createdByLlm: boolean;
  isPrivateTo: string | null;
  /**
   * Set when this row is the caller's own copy of a shared catalogue row, minted
   * because their edit could not land on the shared original. The original is
   * hidden from them, so this row stands in its place.
   */
  forkedFromQuestionId: string | null;
  timesAsked: number;
  timesAnswered: number;
  createdAt: Date;
  updatedAt: Date;
  answer: QuestionCatalogueAnswer | null;
}

export interface QuestionCatalogueFacetBucket {
  value: string | null;
  count: number;
}

export interface QuestionCataloguePage {
  data: QuestionCatalogueEntry[];
  totalCount: number;
  limit: number;
  offset: number;
  facets: {
    categories: QuestionCatalogueFacetBucket[];
    answerTiers: QuestionCatalogueFacetBucket[];
    answeredCount: number;
    unansweredCount: number;
  };
}

/**
 * Make a user string safe to drop between `%…%` in an ILIKE. Without this a
 * search for `_` or `%` matches everything, and a trailing backslash makes the
 * pattern invalid. Backslash is Postgres' default LIKE escape character.
 */
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

type CatalogueRow = {
  id: string;
  question_key: string | null;
  text: string;
  category: string | null;
  answer_tier: string | null;
  question_type: string | null;
  frequency_recommendation: string | null;
  is_active: boolean;
  is_seed_question: boolean;
  created_by_llm: boolean;
  is_private_to: string | null;
  forked_from_question_id: string | null;
  times_asked: number;
  times_answered: number;
  created_at: Date;
  updated_at: Date;
  answer_id: string | null;
  answer_text: string | null;
  answer_source: string | null;
  answer_confidence: number | null;
  answer_rationale: string | null;
  answer_evidence: AnswerEvidence | null;
  answered_at: Date | null;
  total_count: number;
};

type CatalogueFacetRow = {
  category: string | null;
  answer_tier: string | null;
  count: number;
  answered_count: number;
};

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
   * Which questions a caller may SEE, keyed by id: the shared catalogue
   * (`is_private_to IS NULL`) plus their own private questions, never another
   * user's. This is the read rule, and it is deliberately wider than the write
   * rule below — being shown a shared question costs nothing, changing one
   * changes what every other person on the appliance gets asked.
   */
  private readableWhere(context: ServiceContext, id: string): FindOptionsWhere<QuestionEntity>[] {
    const clauses: FindOptionsWhere<QuestionEntity>[] = [{ id, isPrivateTo: IsNull() }];

    if (context.userId && context.userId !== SYSTEM_USER) {
      clauses.push({ id, isPrivateTo: context.userId });
    }

    return clauses;
  }

  /**
   * Whether a row the caller can see is also a row they may write to IN PLACE.
   *
   * Only their own private questions are — plus everything, for a system caller
   * (migrations, cron, internal services, which have no user to fork on behalf
   * of). A shared catalogue row is read-only to an ordinary caller: `update`
   * forks it into a private copy instead, see {@link forkSharedQuestion}.
   *
   * `remove` uses the same rule and does NOT fork, so hard delete stays
   * own-private-only: ci.answers and ci.feed_queue both cascade from
   * ci.questions, and a shared row can hold other people's answers. Retiring a
   * shared reflection is `isActive: false`, which forks.
   */
  private isWritableInPlace(context: ServiceContext, question: QuestionEntity): boolean {
    return context.userId === SYSTEM_USER || question.isPrivateTo === context.userId;
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
      answerTier: data.answerTier ?? null,
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
        answerTier: item.answerTier ?? null,
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

  /**
   * Which shared rows this caller has replaced with a private copy, as origin
   * ids. The SQL selectors express this as a NOT EXISTS (see
   * {@link excludeForkedOriginsSql}); the repository-based ones filter with
   * this instead, because TypeORM's `where` cannot express the anti-join.
   *
   * Queried rather than derived from the result set: a fork retired with
   * `isActive: false` is exactly the case where the origin must still be
   * hidden, and that fork is not in an active-only result to derive from.
   */
  private async forkedOriginIds(context: ServiceContext): Promise<Set<string>> {
    if (!context.userId || context.userId === SYSTEM_USER) {
      return new Set();
    }

    const forks = await this.questionRepository.find({
      where: { isPrivateTo: context.userId, forkedFromQuestionId: Not(IsNull()) },
    });

    return new Set(
      forks
        .map((fork) => fork.forkedFromQuestionId)
        .filter((originId): originId is string => Boolean(originId)),
    );
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

    const [result, replaced] = await Promise.all([
      this.questionRepository.find({ where: whereClauses }),
      this.forkedOriginIds(context),
    ]);

    const unique = new Map<string, QuestionEntity>();

    for (const entity of result) {
      if (replaced.has(entity.id)) {
        continue;
      }

      unique.set(entity.id, entity);
    }

    return Array.from(unique.values()).map((entity) => QuestionEntity.toEgressType(entity));
  }

  /**
   * The reflection catalogue, browsable: paged, filterable by category / answer
   * tier / lifecycle / answered-state and searchable by text, with each row
   * carrying the caller's own answer (and its provenance) when one exists.
   *
   * `findAll` cannot serve this — it returns only active questions, applies no
   * filters, and hands the whole catalogue to the caller to slice in memory.
   * At ~1.3k active rows that is already the difference between a page and a
   * full table scan on every keystroke.
   */
  async findCatalogue(
    context: ServiceContext,
    query: QuestionCatalogueQueryDto,
  ): Promise<QuestionCataloguePage> {
    const { status, answered, limit, offset } = query;
    const userId = context.userId === SYSTEM_USER ? null : context.userId;
    const search = query.search ? escapeLikeTerm(query.search) : null;

    // Positions are shared between the page query and the facet query, so the
    // two predicates stay in lockstep. $4..$6 are page-only.
    const params: unknown[] = [
      userId,
      status,
      search,
      query.category ?? null,
      query.answerTier ?? null,
      answered,
      limit,
      offset,
    ];

    // The allow-list stays out of CATALOGUE_FULL_WHERE_SQL because that
    // constant is shared by three queries that bind different numbers of
    // params, and node-postgres rejects a query text referencing a param index
    // the caller did not pass.
    //
    // But it has to reach ALL THREE, not just the page query. It previously
    // reached only that one, so an `ids`-filtered request reported a
    // `totalCount` and facet buckets for the entire catalogue — the pager
    // offering pages that cannot exist, and the facet counts describing a set
    // the caller did not ask for.
    //
    // Positioned per query, since each binds a different prefix of `params`.
    // `ids` and `keys` are ANDed and take positions in the order they are
    // pushed, so neither has to know whether the other was sent.
    const allowListFor = (base: number): { sql: string; values: unknown[] } => {
      const clauses: string[] = [];
      const values: unknown[] = [];

      if (query.ids?.length) {
        values.push(query.ids);
        clauses.push(`AND q.question_id = ANY($${base + values.length}::uuid[])`);
      }

      if (query.keys?.length) {
        values.push(query.keys);
        clauses.push(`AND q.question_key = ANY($${base + values.length}::text[])`);
      }

      return { sql: clauses.join('\n      '), values };
    };

    const pageAllowList = allowListFor(params.length);
    params.push(...pageAllowList.values);
    const pageAllowListSql = pageAllowList.sql;

    const rows = (await this.dataSource.query(
      `
      SELECT
        q.question_id AS id,
        q.question_key,
        q.question_text AS text,
        q.question_category AS category,
        q.answer_tier,
        q.question_type,
        q.frequency_recommendation,
        q.is_active,
        q.is_seed_question,
        q.created_by_llm,
        q.is_private_to,
        q.forked_from_question_id,
        q.times_asked,
        q.times_answered,
        q.created_at,
        q.updated_at,
        a.answer_id,
        a.answer_text,
        a.answer_source,
        a.answer_confidence,
        a.answer_rationale,
        a.answer_evidence,
        a.answered_at,
        COUNT(*) OVER ()::int AS total_count
      FROM ci.questions q
      ${CATALOGUE_ANSWER_LATERAL_SQL}
      WHERE ${CATALOGUE_FULL_WHERE_SQL}
      ${pageAllowListSql}
      ORDER BY
        q.question_category ASC NULLS LAST,
        ${TIER_RANK_SQL} ASC,
        q.question_text ASC,
        q.question_id ASC
      LIMIT $7 OFFSET $8;
      `,
      params,
    )) satisfies Array<CatalogueRow>;

    // The facet query ignores $4..$6 but is handed the same array: node-postgres
    // tolerates unreferenced trailing params only when they are not passed, so
    // slice down to what the statement actually uses — then re-append the
    // allow-list at the position this shorter statement gives it.
    const facetAllowList = allowListFor(3);
    const facetRows = (await this.dataSource.query(
      `
      SELECT
        q.question_category AS category,
        q.answer_tier,
        COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE a.answer_id IS NOT NULL)::int AS answered_count
      FROM ci.questions q
      ${CATALOGUE_ANSWER_LATERAL_SQL}
      WHERE ${CATALOGUE_BASE_WHERE_SQL}
      ${facetAllowList.sql}
      GROUP BY 1, 2;
      `,
      [...params.slice(0, 3), ...facetAllowList.values],
    )) satisfies Array<CatalogueFacetRow>;

    const categories = new Map<string | null, number>();
    const answerTiers = new Map<string | null, number>();
    let answeredCount = 0;
    let unansweredCount = 0;

    for (const row of facetRows) {
      const count = Number(row.count);
      const answeredInBucket = Number(row.answered_count);

      categories.set(row.category, (categories.get(row.category) ?? 0) + count);
      answerTiers.set(row.answer_tier, (answerTiers.get(row.answer_tier) ?? 0) + count);
      answeredCount += answeredInBucket;
      unansweredCount += count - answeredInBucket;
    }

    const countAllowList = allowListFor(6);

    // The window count rides on the rows, so an empty page carries none. That is
    // usually because nothing matched — but it is also what a page past the end
    // looks like (deactivate the last row on the last page and you are there),
    // and reporting 0 then would tell the pager there is nothing to go back to.
    const totalCount =
      rows.length > 0
        ? Number(rows[0].total_count)
        : offset === 0
          ? 0
          : Number(
              (
                (await this.dataSource.query(
                  `
                  SELECT COUNT(*)::int AS total_count
                  FROM ci.questions q
                  ${CATALOGUE_ANSWER_LATERAL_SQL}
                  WHERE ${CATALOGUE_FULL_WHERE_SQL}
                  ${countAllowList.sql};
                  `,
                  [...params.slice(0, 6), ...countAllowList.values],
                )) satisfies Array<{ total_count: number }>
              )[0]?.total_count ?? 0,
            );

    const toSortedBuckets = (buckets: Map<string | null, number>): QuestionCatalogueFacetBucket[] =>
      Array.from(buckets.entries())
        .map(([value, count]) => ({ value, count }))
        // Untiered/uncategorised rows sort last — they are the pre-catalogue
        // leftovers, not something to lead a picker with.
        .sort((left, right) =>
          left.value === null ? 1 : right.value === null ? -1 : left.value.localeCompare(right.value),
        );

    return {
      data: rows.map((row) => ({
        id: row.id,
        key: row.question_key,
        text: row.text,
        category: row.category,
        answerTier: row.answer_tier,
        questionType: row.question_type,
        frequencyRecommendation: row.frequency_recommendation,
        isActive: row.is_active,
        isSeedQuestion: row.is_seed_question,
        createdByLlm: row.created_by_llm,
        isPrivateTo: row.is_private_to,
        forkedFromQuestionId: row.forked_from_question_id,
        timesAsked: Number(row.times_asked),
        timesAnswered: Number(row.times_answered),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        answer:
          row.answer_id && row.answer_text
            ? {
                id: row.answer_id,
                text: row.answer_text,
                source: row.answer_source,
                confidence: row.answer_confidence,
                rationale: row.answer_rationale,
                evidence: row.answer_evidence,
                answeredAt: row.answered_at as Date,
              }
            : null,
      })),
      totalCount,
      limit,
      offset,
      facets: {
        categories: toSortedBuckets(categories),
        answerTiers: toSortedBuckets(answerTiers),
        answeredCount,
        unansweredCount,
      },
    };
  }

  async findById(context: ServiceContext, id: string): Promise<Question | null> {
    const result = await this.questionRepository.findOne({
      where: this.readableWhere(context, id),
    });

    return result ? QuestionEntity.toEgressType(result) : null;
  }

  /**
   * Batched read: one entry per requested id, IN ID ORDER, `null` for an id
   * that does not exist or is private to somebody else.
   *
   * The shape matters as much as the rows. This used to return the SET of
   * visible questions — planner order, short by one for every id it could not
   * see — and its only caller is a DataLoader, which pairs a batch result with
   * its keys by POSITION. Every sibling `findByIds` in the codebase
   * (CalendarEventService, PlaceService, ContentService, ThreadService,
   * FileService …) already re-keys; this one now matches them.
   */
  async findByIds(context: ServiceContext, ids: string[]): Promise<(Question | null)[]> {
    if (ids.length === 0) {
      return [];
    }

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

    const byId = new Map<string, Question>();

    for (const entity of results) {
      byId.set(entity.id, QuestionEntity.toEgressType(entity));
    }

    return ids.map((id) => byId.get(id) ?? null);
  }

  /**
   * Apply an edit to a reflection the caller can see.
   *
   * The catalogue mixes ~1.3k shared rows every user on the appliance is asked
   * from with each person's own private ones, so what this DOES depends on
   * which kind the row is:
   *
   * - the caller's own private question, or any question for a system caller —
   *   edited in place, as before;
   * - a shared catalogue row — copied first. The caller gets a private copy
   *   carrying their edit, and the shared row is left exactly as it was. See
   *   {@link forkSharedQuestion};
   * - anything else (another user's private question) — `null`, no write.
   *
   * Editing a shared row in place would mean one person rewording, recategorising
   * or retiring (`isActive: false`) what everybody else gets asked — and
   * "retire this, it is too personal" is precisely the edit somebody makes
   * without meaning it for the whole household.
   *
   * NOTE the returned question's `id` is the fork's, not the id that was passed
   * in, whenever a shared row was forked. Callers that re-fetch by the id they
   * sent will find the untouched origin; use the returned row.
   */
  async update(
    context: ServiceContext,
    questionId: string,
    data: UpdateQuestionDto,
  ): Promise<Question | null> {
    const updateData: Partial<QuestionEntity> = {};

    // `subcategory` is the historical spelling; `category` wins when both come in.
    if (data.subcategory !== undefined) {
      updateData.category = data.subcategory;
    }

    if (data.category !== undefined) {
      updateData.category = data.category;
    }

    if (data.answerTier !== undefined) {
      updateData.answerTier = data.answerTier;
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
      where: this.readableWhere(context, questionId),
    });

    if (!question) {
      return null;
    }

    if (!this.isWritableInPlace(context, question)) {
      // Reachable only for a shared row (readableWhere already excluded other
      // people's private ones), and only for a caller who has an id to own the
      // copy — every edge routes through toServiceContext, which rejects the
      // rest, but a fork with no owner would violate questions_fork_is_owned.
      if (!context.userId || context.userId === SYSTEM_USER) {
        return null;
      }

      return this.forkSharedQuestion(context.userId, question, updateData);
    }

    Object.assign(question, updateData);
    await this.questionRepository.save(question);

    await this.eventService.send(QuestionUpdatedEvent, {
      questionId: questionId,
    });

    return this.findById(context, questionId);
  }

  /**
   * Copy-on-write for a shared catalogue row: the caller gets a private copy of
   * it carrying their edit, and the shared row is not touched.
   *
   * A second edit updates that same copy rather than minting another — the
   * `questions_fork_owner_uniq` partial index makes one-fork-per-(origin, owner)
   * a database guarantee, and this is the read that honours it.
   *
   * The copy is NOT seed content, whatever the origin was: the seed migration's
   * own down-path deletes rows by `is_seed_question AND NOT created_by_llm`, and
   * it must not take somebody's edit with it.
   */
  private async forkSharedQuestion(
    userId: string,
    origin: QuestionEntity,
    updateData: Partial<QuestionEntity>,
  ): Promise<Question> {
    const existingFork = await this.questionRepository.findOne({
      where: { forkedFromQuestionId: origin.id, isPrivateTo: userId },
    });

    if (existingFork) {
      // Its evidence class is deliberately left as it is, not copied from the
      // origin again: that would overwrite a copy that is stricter than its origin
      // with the looser one. An edit cannot move it either (it is not on
      // UpdateQuestionDto), so only a migration ever changes it.
      Object.assign(existingFork, updateData, {
        isPrivateTo: userId,
        forkedFromQuestionId: origin.id,
      });
      await this.questionRepository.save(existingFork);

      await this.eventService.send(QuestionUpdatedEvent, {
        questionId: existingFork.id,
      });

      return QuestionEntity.toEgressType(existingFork);
    }

    const fork = this.questionRepository.create({
      id: uuidv7(),
      text: origin.text,
      // The key comes across deliberately. A curated surface asks for its
      // questions by key, and the origin is hidden from whoever forked it — so
      // a keyless copy would blank that question for the one user who cared
      // enough to edit it. questions_question_key_owner_uniq is scoped to
      // (question_key, is_private_to), which is what lets the copy hold the
      // same key as the shared row it replaces.
      key: origin.key ?? null,
      // The class comes across for the same reason, with more at stake. Both
      // inference selectors skip a 'hand_entry' question and the origin is hidden
      // from whoever forked it, so a copy left to the column default
      // ('traceable') is a question the job must never answer on this person's
      // behalf, offered to it the moment they reword it.
      evidenceClass: origin.evidenceClass,
      category: origin.category,
      answerTier: origin.answerTier ?? null,
      contextTags: origin.contextTags,
      questionType: origin.questionType,
      frequencyRecommendation: origin.frequencyRecommendation,
      isActive: origin.isActive,
      isSeedQuestion: false,
      createdByLlm: false,
      // Presentation counters belong to the shared row's history, not this copy's.
      timesAsked: 0,
      timesAnswered: 0,
    });

    // Ownership and provenance are the fork's identity and are applied last: an
    // edit may carry `isPrivateTo` (UpdateQuestionDto allows it) and must not be
    // able to hand the new row to somebody else or hide where it came from.
    Object.assign(fork, updateData, {
      isPrivateTo: userId,
      forkedFromQuestionId: origin.id,
    });

    const saved = await this.questionRepository.save(fork);

    await this.adoptOwnHistory(userId, origin.id, saved.id);

    await this.eventService.send(QuestionCreatedEvent, {
      questionId: saved.id,
    });

    return QuestionEntity.toEgressType(saved);
  }

  /**
   * Move the caller's own history from a shared row onto the copy that now
   * replaces it for them. Nobody else's rows move.
   *
   * Answers point at a question id, so without this an edit would leave the
   * caller's existing answers on an origin they no longer see — their answered
   * reflection would read as unanswered. The feed row is deleted rather than
   * repointed: `feed_queue` is unique on (user_id, question_id) and the
   * gap-aware selector re-queues the copy on the next pass if it is still
   * unanswered.
   */
  private async adoptOwnHistory(userId: string, originId: string, forkId: string): Promise<void> {
    await this.dataSource.query(
      `
      UPDATE ci.answers
      SET question_id = $3
      WHERE question_id = $2
        AND user_id = $1;
      `,
      [userId, originId, forkId],
    );

    await this.removeFromFeedQueue(userId, originId);
  }

  /**
   * Hard delete, and deliberately NOT copy-on-write like {@link update}: it
   * stays own-private-only. ci.answers and ci.feed_queue both cascade from
   * ci.questions, so deleting a shared catalogue row would destroy answers
   * other people wrote. Retiring a shared reflection is `isActive: false`,
   * which forks a private copy and leaves everyone else's feed alone.
   *
   * Returns false rather than throwing when the caller may not delete the row,
   * including when they can see it perfectly well.
   */
  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const question = await this.questionRepository.findOne({
      where: this.readableWhere(context, id),
    });

    if (!question || !this.isWritableInPlace(context, question)) {
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

  /**
   * The next question per user worth spending an inference slot on.
   *
   * `attemptHistory` names the pg-boss queue and event the caller dispatches
   * inference on; it is how this method sees attempts that produced no answer.
   * An inference that times out, or that every gate in AnswerInferenceListener
   * discards, writes nothing to ci.answers — so before this filter existed the
   * same question came back every tick, forever. Measured live: one question
   * re-dispatched every 60 seconds for hours, monopolizing both the single-slot
   * `llm` queue and the GPU under it, while every other unanswered question
   * starved. SmartRotationListener.findNextUnansweredQuestionId fixed the same
   * head-of-line block the same way (see its doc comment for the design: the
   * shallow pgboss.job/pgboss.archive history is a feature — a permanently
   * unanswerable question ages back in at one attempt per retention window
   * rather than being silenced for good, and if the queue binding ever moves,
   * this degrades to the old order, which is the safe direction to fail).
   *
   * Among questions with the same attempt standing, the order is the
   * catalogue's rotation order from questionOrder.ts — tier, batch age, then a
   * round-robin across categories in the order the seed files list them. The
   * listener takes the same definition, so the two selectors cannot drift.
   *
   * An owner who still has an inference waiting or running, or who was sent one
   * within `intervalMinutes`, is left out entirely — see
   * {@link inferenceDispatchOpenSql}. That gate is applied to the user set, before
   * the per-question work, so a tick on which everyone is gated costs a scan of
   * the queue's own rows and nothing else.
   */
  async findUnansweredByUserId(attemptHistory: {
    queue: string;
    eventName: string;
    cooldownHours: number;
    intervalMinutes: number;
  }): Promise<Map<string | null, string[]>> {
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

    const rows = (await this.dataSource.query(
      `
      WITH attempts AS (
        SELECT
          dispatched.data->>'ownerId' AS user_id,
          dispatched.data->>'questionId' AS question_id,
          MAX(dispatched.created_on) AS last_attempt_at
        FROM (
          SELECT data, created_on
          FROM pgboss.job
          WHERE name = $1
            AND data->>'name' = $2
          UNION ALL
          SELECT data, created_on
          FROM pgboss.archive
          WHERE name = $1
            AND data->>'name' = $2
        ) dispatched
        GROUP BY 1, 2
      ),
      rotation AS (${QUESTION_ROTATION_RANK_SQL}),
      unanswered AS (
        SELECT
          q.question_id AS id,
          COALESCE(q.is_private_to, u.user_id) AS user_id,
          q.created_at,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(q.is_private_to, u.user_id)
            -- Never-attempted before ever-attempted, least recently attempted
            -- first among retries; the catalogue's rotation order WITHIN those
            -- groups, so the factual-first preference still decides what a
            -- fresh appliance asks about first, and every appliance asks it in
            -- the same order. Not by question_id: see questionOrder.ts.
            ORDER BY att.last_attempt_at ASC NULLS FIRST, ${QUESTION_ROTATION_ORDER_SQL}
          ) AS rn
        FROM ci.questions q
        CROSS JOIN (
          SELECT DISTINCT usr.id AS user_id
          FROM ci.users usr
          WHERE usr.id IS NOT NULL
            -- The per-owner backlog cap and cadence. Aliased, because the gate's
            -- subqueries read pgboss.job, which has an \`id\` of its own.
            AND ${inferenceDispatchOpenSql({
              ownerText: 'usr.id::text',
              queue: '$1',
              eventName: '$2',
              intervalMinutes: '$4',
            })}
        ) u
        LEFT JOIN attempts att
          ON att.question_id = q.question_id::text
         AND att.user_id = COALESCE(q.is_private_to, u.user_id)::text
        LEFT JOIN rotation qr ON qr.question_id = q.question_id
        WHERE q.is_active = TRUE
          -- Never spend an inference slot on a question the corpus cannot
          -- ground (body measurements, medical facts, the make of the boiler).
          -- The model would return a refusal, and because the NOT EXISTS below
          -- counts any non-empty answer as answered, that refusal would then
          -- occupy the slot for good. See 20260825074747_add_question_evidence_class.
          AND q.evidence_class <> 'hand_entry'
          AND (q.is_private_to IS NULL OR q.is_private_to = u.user_id)
          ${excludeForkedOriginsSql('q', 'u.user_id')}
          AND NOT EXISTS (
            SELECT 1
            FROM ci.answers a
            WHERE a.question_id = q.question_id
              AND a.user_id = u.user_id
              AND a.answer_method IN ('user', 'inferred')
              AND a.answer_text IS NOT NULL
              AND TRIM(a.answer_text) <> ''
          )
          -- The cooldown. A question tried inside the window is not offered
          -- again, whatever became of the attempt; with every candidate inside
          -- the window this returns nothing for that user and the caller's
          -- tick enqueues nothing, which is the intended idle state.
          AND (att.last_attempt_at IS NULL OR att.last_attempt_at < NOW() - make_interval(hours => $3))
      )
      SELECT id, user_id
      FROM unanswered
      WHERE rn <= 1;
    `,
      [
        attemptHistory.queue,
        attemptHistory.eventName,
        attemptHistory.cooldownHours,
        attemptHistory.intervalMinutes,
      ],
    )) satisfies Array<Row>;

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

  /**
   * May this owner be sent another inference right now? The same gate
   * {@link findUnansweredByUserId} applies to every owner at once, asked for one
   * — for `SmartRotationListener`, which selects per owner and wants to say WHY
   * it skipped rather than fold "gated" into "nothing left to ask".
   */
  async isInferenceDispatchOpen(
    userId: string,
    dispatch: { queue: string; eventName: string; intervalMinutes: number },
  ): Promise<boolean> {
    type Row = { open: boolean };
    const rows = (await this.dataSource.query(
      `SELECT ${inferenceDispatchOpenSql({
        ownerText: '$1',
        queue: '$2',
        eventName: '$3',
        intervalMinutes: '$4',
      })} AS open`,
      [userId, dispatch.queue, dispatch.eventName, dispatch.intervalMinutes],
    )) as Row[];

    return rows[0]?.open === true;
  }

  /**
   * What `ci.questions` says about one question RIGHT NOW, read the way the
   * inference selectors read it for this caller.
   *
   * {@link findUnansweredByUserId} and `SmartRotationListener`'s
   * `findNextUnansweredQuestionId` only pick a question that is active, not
   * `hand_entry`, and not hidden from the owner by one of their own forks. They
   * check that when a job is QUEUED, and the job then waits in pg-boss — behind
   * the single-slot LLM queue — before anything runs it. In that gap a migration
   * can retire the row, a reclassification can mark it `hand_entry`, and the
   * owner can fork it. {@link findById} sees none of that: it settles who may
   * READ the row and nothing else. So `AnswerInferenceListener` asks this at the
   * moment it RUNS.
   *
   * The facts come back separately, not as one verdict, so the caller can say
   * which of them stopped a job. The `is_active` and `evidence_class` tests are
   * spelled out in both selectors and are the contract this has to keep (see
   * SmartRotationListener.md); the fork rule is the shared
   * {@link excludeForkedOriginsSql}, so that one cannot drift.
   *
   * `null` when the caller cannot see the row at all — it does not exist, or it
   * is private to somebody else — which is the rule {@link findById} applies.
   */
  async findInferenceStanding(
    context: ServiceContext,
    id: string,
  ): Promise<QuestionInferenceStanding | null> {
    type Row = {
      is_active: boolean;
      evidence_class: string;
      forked_by_caller: boolean;
    };

    // SYSTEM_USER is a Symbol, so it can never be bound as a parameter. It owns
    // no private rows and no forks either, and NULL says exactly that in SQL:
    // only shared rows are visible, and nothing is forked.
    const userId = context.userId && context.userId !== SYSTEM_USER ? context.userId : null;

    const rows = (await this.dataSource.query(
      `
      SELECT
        q.is_active,
        q.evidence_class,
        -- "Forked by the caller" is "does not survive the shared fork filter".
        -- Said through excludeForkedOriginsSql rather than a second copy of its
        -- subquery, so the two cannot disagree about what a fork is.
        NOT EXISTS (
          SELECT 1
          FROM ci.questions visible
          WHERE visible.question_id = q.question_id
            ${excludeForkedOriginsSql('visible', '$2::uuid')}
        ) AS forked_by_caller
      FROM ci.questions q
      WHERE q.question_id = $1::uuid
        AND (q.is_private_to IS NULL OR q.is_private_to = $2::uuid)
      `,
      [id, userId],
    )) satisfies Array<Row>;

    const row = rows[0];

    if (!row) {
      return null;
    }

    return {
      isActive: row.is_active,
      evidenceClass: row.evidence_class,
      forkedByCaller: row.forked_by_caller,
    };
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

    await this.rotateFeedQueueRow(front.feed_queue_id);
    await this.enqueueNextFeedQueueQuestion(userId, FEED_QUESTION_QUEUE_LIMIT);

    return true;
  }

  /** Push one feed-queue row to the back of the FIFO. Shared by staleness rotation and an explicit user skip. */
  private async rotateFeedQueueRow(feedQueueId: string): Promise<void> {
    await this.dataSource.query(
      `
      UPDATE ci.feed_queue
      SET
        enqueued_at = NOW(),
        metadata = (COALESCE(metadata, '{}'::jsonb) - 'lastPresentedAt') || jsonb_build_object('rotatedAt', to_jsonb(NOW()::text))
      WHERE feed_queue_id = $1;
      `,
      [feedQueueId],
    );
  }

  /**
   * Move the front-of-queue question to the back on the owner's own say-so —
   * "Skip" on the reflection prompt.
   *
   * `findOneUnanswered` always returns the SAME front-of-queue row
   * deterministically (`ORDER BY enqueued_at ASC ... LIMIT 1`), and only
   * `rotateStaleFeedQuestions` ever moves it — gated on 30 minutes of
   * inactivity. Calling `findOneUnanswered` again right after a user-pressed
   * Skip therefore returned the identical question: the frontend's "Skip"
   * used to hide the card locally instead, which meant the same question
   * reappeared on the next reload with no memory of having been skipped.
   * An explicit skip is a stronger, more deliberate signal than mere
   * staleness, so it bypasses the 30-minute gate entirely — reusing the exact
   * rotation `rotateStaleFeedQuestions` performs rather than a second copy of
   * the "move to back" SQL.
   *
   * A no-op (not an error) when the front row has moved on since the caller
   * fetched it, or the queue is empty — either way there is nothing to skip.
   */
  async skipFrontFeedQuestion(userId: string, presentationId: string): Promise<boolean> {
    const rows = (await this.dataSource.query(
      `SELECT feed_queue_id FROM ci.feed_queue WHERE feed_queue_id = $1 AND user_id = $2;`,
      [presentationId, userId],
    )) satisfies Array<{ feed_queue_id: string }>;

    if (rows.length === 0) {
      return false;
    }

    await this.rotateFeedQueueRow(presentationId);
    await this.enqueueNextFeedQueueQuestion(userId, FEED_QUESTION_QUEUE_LIMIT);

    return true;
  }

  /**
   * Stamp first presentation time on the feed row and bump times_asked on the question.
   *
   * One statement, so the bump happens exactly when the stamp does and no
   * result has to be read back to decide it. The two-statement version gated
   * the bump on `rows[0]?.updated` from a bare `UPDATE … RETURNING`, which
   * TypeORM returns as the pair `[rows, rowCount]` — `rows[0]` was the rows
   * array, `.updated` was always undefined, and times_asked never moved.
   */
  async recordFeedQuestionPresentation(userId: string, questionId: string): Promise<void> {
    await this.dataSource.query(
      `
      WITH presented AS (
        UPDATE ci.feed_queue
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('lastPresentedAt', to_jsonb(NOW()::text))
        WHERE user_id = $1
          AND question_id = $2
          AND (metadata->>'lastPresentedAt' IS NULL)
        RETURNING 1
      )
      UPDATE ci.questions
      SET times_asked = times_asked + 1
      WHERE question_id = $2
        AND EXISTS (SELECT 1 FROM presented);
      `,
      [userId, questionId],
    );
  }

  /**
   * Bump `times_answered` on the question a newly recorded answer belongs to —
   * the counterpart of the `times_asked` bump in
   * {@link recordFeedQuestionPresentation}, and the only writer of that column.
   *
   * Counts ANSWERS RECORDED, not distinct questions answered and not distinct
   * people: `ci.questions` is an appliance-wide catalogue (a row is shared until
   * somebody's edit forks it — see `forkedFromQuestionId`), so this is the same
   * appliance-wide usage statistic `times_asked` already is. Editing an existing
   * answer does not bump it; only a new `ci.answers` row does.
   *
   * The UPDATE is relative (`times_answered + 1`) rather than a read of the
   * current value followed by a write of value+1, so two answers landing
   * concurrently cannot lose one another's increment.
   */
  async recordQuestionAnswered(questionId: string): Promise<void> {
    await this.dataSource.query(
      `
      UPDATE ci.questions
      SET times_answered = times_answered + 1
      WHERE question_id = $1;
      `,
      [questionId],
    );
  }

  /**
   * Batched {@link recordQuestionAnswered}: bump `times_answered` for a whole
   * ingest batch in one UPDATE instead of N.
   *
   * Takes the question id of every answer in the batch, duplicates included —
   * answering the same question twice in one batch must count twice, exactly as
   * two separate `recordQuestionAnswered` calls would. The ids are folded into
   * (id, count) pairs here so the statement touches each row once, and the
   * addition stays relative for the same lost-update reason as the single path.
   */
  async recordManyQuestionsAnswered(questionIds: string[]): Promise<void> {
    if (questionIds.length === 0) {
      return;
    }

    const counts = new Map<string, number>();
    for (const questionId of questionIds) {
      counts.set(questionId, (counts.get(questionId) ?? 0) + 1);
    }

    await this.dataSource.query(
      `
      UPDATE ci.questions q
      SET times_answered = q.times_answered + c.n
      FROM (
        SELECT unnest($1::uuid[]) AS question_id, unnest($2::int[]) AS n
      ) AS c
      WHERE q.question_id = c.question_id;
      `,
      [[...counts.keys()], [...counts.values()]],
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

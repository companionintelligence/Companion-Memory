import { z } from 'zod';

export type ActionSource = 'legacy' | 'correlation' | 'anomaly' | 'suggestion';

export interface CreateActionDto {
  id?: string;
  title: string;
  text: string;
  imageUrl?: string;
  priority?: number;
  threadId?: string;
  seen?: boolean;
  dismissed?: boolean;
  source?: ActionSource;
  metadata?: Record<string, unknown>;
}

/**
 * One database row the model actually cited when it inferred an answer.
 *
 * This is the difference between "the appliance is fairly sure" and "the
 * appliance read THESE FOUR MESSAGES, on these dates, and here is what they
 * said". `answer_rationale` is the model's sentence about its evidence; this is
 * the evidence.
 */
export interface AnswerEvidenceCitation {
  /**
   * Which numbered line of the EVIDENCE block the model named in
   * `first_person_evidence`. Kept so a stored citation can be lined up against
   * the prompt in a log, and so the drawer can show them in the order the model
   * cited them rather than in retrieval order.
   */
  line: number;
  /**
   * How to find the row again.
   *
   * `EntityResolutionService`'s own discriminant for anything that came through
   * entity resolution — 'communication', 'event', 'content', 'item', 'person',
   * 'place', 'concept', 'note', 'browser-activity', 'file', 'thread', 'receipt'
   * — plus 'graph-node' (a `ci.entities.entity_id`) and 'agent-memory' (a
   * `ci.agent_memory.id`) for the two channels that bypass it.
   *
   * Typed `string` rather than the union it is written from: this is read back
   * out of a jsonb column, so a row written by an older or newer build can
   * legitimately carry a value this build has never heard of, and a narrow type
   * here would be a lie the compiler enforces.
   */
  type: string;
  /** Primary key of the row, in whichever table `type` names. */
  id: string;
  /**
   * When the record HAPPENED (ISO-8601), or null for the types with no moment of
   * their own. Not the import time — see SerializerService.timeOf.
   */
  at: string | null;
  /**
   * Who produced the line.
   *
   * 'own' is the only value that can appear in {@link AnswerEvidence.citations}:
   * the speaker gate (`enforceFirstPersonEvidence`) discards an answer whose
   * citations are not the owner's own records. Both values appear in
   * {@link AnswerEvidence.uncited}, and that is most of the point of storing it —
   * an inbound line that was retrieved and correctly NOT used is the single most
   * informative thing in the retrieval, because it is the appliance declining to
   * read somebody else's words back as the owner's.
   */
  voice: 'own' | 'other';
  /**
   * The evidence line VERBATIM as the model read it, truncated. Serialized text,
   * not the raw column: showing the owner something other than what the model
   * saw would defeat the point of showing them anything.
   */
  snippet: string;
}

/**
 * The retrieval that stands behind one inferred answer.
 *
 * Stored on `ci.answers.answer_evidence`. NULL on the column means no inference
 * ever recorded evidence for that row — a user-typed answer, an import, or an
 * inferred row written before this existed. It never means "cited nothing":
 * an answer that cites nothing is discarded rather than written.
 */
export interface AnswerEvidence {
  /** The rows the model named, in citation order. Capped — see the listener. */
  citations: AnswerEvidenceCitation[];
  /**
   * The rows that were retrieved, put in front of the model, and NOT named by
   * it — in the block order the model read them, same shape as
   * {@link citations} so one reader renders both.
   *
   * This is the difference between `linesShown: 20` being a number the owner has
   * to take on faith and being a list they can scroll. It is also the only way
   * to see WHY something was missed rather than only what was used: a record
   * that should have carried the answer and did not appear here at all is a
   * RETRIEVAL failure, and the same record sitting in this list unnamed is a
   * READING failure. Those need different fixes and were previously
   * indistinguishable from outside.
   *
   * OPTIONAL, and the distinction matters to the drawer: absent means this row
   * predates the field and its unused lines are gone for good, so nothing may
   * claim the list is complete. An empty array means the model named every line
   * it was shown.
   */
  uncited?: AnswerEvidenceCitation[];
  /**
   * Every line put in front of the model, cited or not.
   *
   * Still counted independently of the two arrays rather than derived from
   * them: both are capped, so `citations.length + uncited.length` can be short
   * of what was really read, and this is the number that says so.
   */
  linesShown: number;
  /** How many of those were the owner's own records rather than other people's. */
  linesOwn: number;
  /** The model that wrote the answer, the score and the rationale. */
  model: string | null;
}

export interface CreateAnswerDto {
  id?: string;
  text: string;
  question: {
    id: string;
  };
  answerConfidence?: number | null;
  answerRationale?: string | null;
  answerEvidence?: AnswerEvidence | null;
  answerSource?: string;
  answerMethod?: string;
  answeredAt?: Date;
  sessionContext?: Record<string, unknown>;
  emotionalState?: string;
  locationContext?: string;
  extractedEntities?: string[];
  sentimentScore?: number;
  complexityScore?: number;
  isSensitive?: boolean;
  sharingLevel?: string;
}

export interface UpdateAnswerDto {
  text?: string;
  answerConfidence?: number | null;
  answerRationale?: string | null;
  answerEvidence?: AnswerEvidence | null;
  answerSource?: string;
  answerMethod?: string;
  answeredAt?: Date;
  sessionContext?: Record<string, unknown>;
  emotionalState?: string;
  locationContext?: string;
  extractedEntities?: string[];
  sentimentScore?: number;
  complexityScore?: number;
  isSensitive?: boolean;
  sharingLevel?: string;
}

/**
 * `ci.questions.answer_tier` — which half of the catalogue a reflection belongs
 * to. Mirrors the `questions_answer_tier_check` constraint; selection orders by
 * it (see TIER_RANK_SQL in questionOrder.ts).
 */
export const ANSWER_TIERS = ['factual', 'preference', 'narrative'] as const;
export type AnswerTier = (typeof ANSWER_TIERS)[number];

export interface CreateQuestionDto {
  id?: string;
  text: string;
  category?: string;
  answerTier?: AnswerTier | null;
  isSeedQuestion?: boolean;
  isActive?: boolean;
  createdByLlm?: boolean;
  frequencyRecommendation?: string;
  isPrivateTo?: string | null;
}

export interface UpdateQuestionDto {
  /** Historical name for `category` on the REST/GraphQL edge; still honoured. */
  subcategory?: string;
  category?: string;
  answerTier?: AnswerTier | null;
  text?: string;
  contextTags?: string[];
  questionType?: string;
  isSeedQuestion?: boolean;
  isActive?: boolean;
  createdByLlm?: boolean;
  frequencyRecommendation?: string;
  timesAsked?: number;
  timesAnswered?: number;
  isPrivateTo?: string;
}

const questionTextSchema = z
  .string()
  .trim()
  .min(1, 'Reflection text is required')
  .max(500, 'Reflection text must be 500 characters or less');

const questionCategorySchema = z
  .string()
  .trim()
  .min(1, 'Category is required')
  .max(120, 'Category must be 120 characters or less');

export const skipFeedQuestionSchema = z.object({
  presentationId: z.string().min(1),
});

export const createQuestionSchema = z.object({
  text: questionTextSchema,
  // `subcategory` predates `category` on this endpoint and was the ONLY field
  // the schema accepted, while the service reads `data.category` — so every
  // REST-created question landed with a null category. Both spellings are
  // accepted now; `category` wins when both are sent.
  category: questionCategorySchema.optional(),
  subcategory: questionCategorySchema.optional(),
  answerTier: z.enum(ANSWER_TIERS).nullish(),
});

export const updateQuestionSchema = z
  .object({
    text: questionTextSchema.optional(),
    category: questionCategorySchema.optional(),
    subcategory: questionCategorySchema.optional(),
    answerTier: z.enum(ANSWER_TIERS).nullish(),
    // Deactivation is the supported way to retire a reflection: ci.answers and
    // ci.feed_queue both cascade on delete, so a hard DELETE takes real human
    // answers with it.
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

/**
 * Query string for `GET /questions/catalogue`. Everything arrives as a string,
 * so the numeric and enum fields are coerced/validated rather than trusted.
 */
export const questionCatalogueQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  category: z.string().trim().max(120).optional(),
  answerTier: z.enum(ANSWER_TIERS).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  answered: z.enum(['answered', 'unanswered', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  // Comma-separated question ids — an explicit allow-list layered on top of
  // the other filters. Lets a caller with a fixed, known set of ids (the Self
  // page's curated Life Details list) fetch exactly those rows plus their
  // answer status in one call, instead of one call per id or over-fetching a
  // whole category.
  ids: z
    .string()
    .trim()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(z.string().uuid()).max(100).optional()),
  // Comma-separated `ci.questions.question_key` slugs — the same allow-list as
  // `ids`, addressed by a name that survives leaving this database. A uuid
  // belongs to one appliance (`gen_uuid_v7()` mints a new one per install), so
  // client code that hardcoded curated ids matched nothing anywhere else and
  // silently rendered a dead section; a key is written by the seed migration
  // and means the same thing everywhere. Prefer this over `ids` for anything
  // fixed and curated. Both may be sent, and then both must match.
  keys: z
    .string()
    .trim()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(z.string().max(120)).max(100).optional()),
});

export type QuestionCatalogueQueryDto = z.infer<typeof questionCatalogueQuerySchema>;

export const createAnswerSchema = z.object({
  text: z.string().min(1, 'Answer text is required').max(5000, 'Answer text must be 5000 characters or less'),
  question: z.object({
    id: z.string().uuid('Invalid question ID'),
  }),
});

export const updateAnswerSchema = z.object({
  text: z
    .string()
    .min(1, 'Answer text is required')
    .max(5000, 'Answer text must be 5000 characters or less')
    .optional(),
});

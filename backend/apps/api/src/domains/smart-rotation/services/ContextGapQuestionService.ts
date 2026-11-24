import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod/v3';

import { type RequestContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { QuestionService } from '@ci/domains/intelligence';
import { OllamaService, PROMPT_MODEL } from '@ci/domains/llm';
import { UserContextService } from '@ci/domains/memory';

const GENERATED_QUESTION_SCHEMA = z.object({
  text: z.string().min(8).max(500),
  category: z.string().min(2).max(120),
});

const GENERATED_QUESTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    category: { type: 'string' },
  },
  required: ['text', 'category'],
};

/** Minimum gap between LLM-authored feed questions for one user. */
const LLM_QUESTION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * This call was previously unbounded — no signal, no timeout — so a hung or
 * slow-loading model call blocked its caller (SmartRotationListener) for as
 * long as the underlying fetch took to fail on its own, rather than failing
 * fast and being retried. Same fix, same 60s budget, as
 * AnswerInferenceListener's first version (it has since moved to
 * `llm.answerInferenceTimeoutMs`) — see the comment at its timeout for the
 * full contention story. Stays on {@link PROMPT_MODEL}
 * deliberately: this generates the actual question text a person reads on
 * their feed, so it is a bounds-only fix, not a model change.
 */
const QUESTION_GENERATION_TIMEOUT_MS = 60_000;

/** Output cap (Ollama `options.num_predict`) — one short question, generous headroom. */
const QUESTION_GENERATION_MAX_OUTPUT_TOKENS = 300;

/** Keep the model resident (Ollama `keep_alive`) — same PROMPT_MODEL as chat, so this warms it rather than contending. */
const QUESTION_GENERATION_KEEP_ALIVE = '1h';

@Injectable()
export class ContextGapQuestionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly questionService: QuestionService,
    private readonly userContextService: UserContextService,
    private readonly ollamaService: OllamaService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ContextGapQuestionService.name);
  }

  /**
   * When the seed pool has nothing fresh to show, generate a user-specific
   * question from context gaps and enqueue it on the feed.
   */
  async tryGenerateAndEnqueue(userId: string): Promise<boolean> {
    if (await this.hasRecentLlmQuestion(userId)) {
      return false;
    }

    const gapCategory = await this.findWeakestCategory(userId);
    const userContext = await this.userContextService.getUserContextForLLM(userId);
    const dossier = userContext ? this.userContextService.formatContextForSystemPrompt(userContext) : '';

    const prompt = [
      'You help a personal memory assistant decide what to ask the user next.',
      `Target category (lowest coverage): ${gapCategory ?? 'General'}`,
      dossier
        ? `Known context:\n${dossier.slice(0, 2500)}`
        : 'Known context: (minimal — user is still onboarding)',
      '',
      'Write ONE concise, friendly, open-ended question that would materially improve understanding of this user.',
      'Do not repeat generic onboarding prompts. Return JSON only.',
    ].join('\n');

    const llmContext = { userId } as RequestContext;
    const serviceContext = { userId } as UserServiceContext;

    let parsed: z.infer<typeof GENERATED_QUESTION_SCHEMA>;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUESTION_GENERATION_TIMEOUT_MS);

    try {
      const response = await this.ollamaService.chat(llmContext, [{ role: 'user', content: prompt }], {
        model: PROMPT_MODEL,
        enableTools: false,
        format: GENERATED_QUESTION_JSON_SCHEMA,
        signal: controller.signal,
        maxOutputTokens: QUESTION_GENERATION_MAX_OUTPUT_TOKENS,
        keepAlive: QUESTION_GENERATION_KEEP_ALIVE,
      });

      parsed = GENERATED_QUESTION_SCHEMA.parse(JSON.parse(response.message.content));
    } catch (error) {
      this.logger.warn('Context-gap question generation failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return false;
    } finally {
      clearTimeout(timer);
    }

    const question = await this.questionService.create(
      serviceContext,
      {
        text: parsed.text.trim(),
        category: parsed.category.trim(),
        isSeedQuestion: false,
        createdByLlm: true,
        isActive: true,
        isPrivateTo: userId,
      },
      { emitCreated: true },
    );

    await this.dataSource.query(
      `
      INSERT INTO ci.feed_queue (feed_queue_id, user_id, question_id, enqueued_at, metadata)
      VALUES ($1, $2, $3, NOW(), $4::jsonb)
      ON CONFLICT (user_id, question_id) DO NOTHING;
      `,
      [
        uuidv7(),
        userId,
        question.id,
        JSON.stringify({ source: 'context_gap_llm', generatedAt: new Date().toISOString() }),
      ],
    );

    this.logger.log('Enqueued context-gap LLM question', {
      userId,
      questionId: question.id,
      category: parsed.category,
    });

    return true;
  }

  private async hasRecentLlmQuestion(userId: string): Promise<boolean> {
    type Row = { recent: boolean };
    const rows = (await this.dataSource.query(
      `
      SELECT EXISTS (
        SELECT 1
        FROM ci.feed_queue fq
        JOIN ci.questions q ON q.question_id = fq.question_id
        WHERE fq.user_id = $1
          AND q.created_by_llm = TRUE
          AND fq.enqueued_at > NOW() - INTERVAL '1 millisecond' * $2
      ) AS recent;
      `,
      [userId, LLM_QUESTION_COOLDOWN_MS],
    )) as Row[];

    return rows[0]?.recent ?? false;
  }

  private async findWeakestCategory(userId: string): Promise<string | null> {
    type Row = { category: string | null };
    const rows = (await this.dataSource.query(
      `
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
      SELECT category
      FROM category_coverage
      ORDER BY answered_count ASC, category ASC NULLS LAST
      LIMIT 1;
      `,
      [userId],
    )) as Row[];

    return rows[0]?.category ?? null;
  }
}

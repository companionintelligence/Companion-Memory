import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { Events, EventService, OnEvent } from '@ci/domains/events';
import { excludeForkedOriginsSql, QuestionService } from '@ci/domains/intelligence';
import { LLM_QUEUE } from '@ci/domains/llm';
import { GraphEnrichmentService, MaintenanceOrchestratorService } from '@ci/domains/maintenance';
import {
  ContextPromptGenerateService,
  CrossTableHydrationService,
  LifeContextService,
} from '@ci/domains/personalization';
import { PythonFunctionService } from '@ci/domains/python-functions';
import { SuggestionSyncService } from '@ci/domains/schedule';

import { SmartRotationWorkEvent, type SmartRotationWorkPayload } from '../events';
import { ContextGapQuestionService } from '../services/ContextGapQuestionService';
import { SMART_ROTATION_QUEUE, type SmartRotationWorkType } from '../types';

const FEED_QUEUE_LIMIT = 3;

/**
 * How long a question sits out of the inference rotation after one has been
 * DISPATCHED for it — whatever that dispatch went on to produce.
 *
 * Six hours against a 20-minute tick (`SMART_ROTATION_CRONS.answer_infer`), so
 * a question is retried at most four times a day. Short enough that a genuinely
 * transient failure — an Ollama restart, a model reload, the 60s
 * `INFERENCE_TIMEOUT_MS` firing under load — costs the question a few hours
 * rather than its place in the rotation; long enough that re-asking is never
 * what the appliance spends an inference slot on while something untried is
 * waiting.
 *
 * It is deliberately a flat cooldown rather than exponential backoff: the
 * attempt history this reads from (see {@link SmartRotationListener.findNextUnansweredQuestionId})
 * only reaches back a day or so, so a curve past that could not be expressed
 * honestly. What actually bounds a permanently-unanswerable question is the
 * least-recently-attempted ORDER BY, not this number.
 *
 * Exported because AnswerInferenceCron's selection
 * (QuestionService.findUnansweredByUserId) runs the same rotation over the
 * same pg-boss history; two cooldowns for one attempt record would let the
 * shorter path re-dispatch inside the longer path's window.
 */
export const INFERENCE_ATTEMPT_COOLDOWN_HOURS = 6;

@Injectable()
export class SmartRotationListener {
  constructor(
    private readonly questionService: QuestionService,
    private readonly contextGapQuestionService: ContextGapQuestionService,
    private readonly eventService: EventService,
    private readonly suggestionSyncService: SuggestionSyncService,
    private readonly pythonFunctionService: PythonFunctionService,
    private readonly graphEnrichmentService: GraphEnrichmentService,
    private readonly maintenanceOrchestratorService: MaintenanceOrchestratorService,
    private readonly contextPromptGenerateService: ContextPromptGenerateService,
    private readonly crossTableHydrationService: CrossTableHydrationService,
    private readonly lifeContextService: LifeContextService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SmartRotationListener.name);
  }

  // `policy: 'short'` is what makes the singletonKeys both senders rely on
  // (`smart-rotation:${userId}:${workType}` from SmartRotationService and
  // ContextPromptController) actually refuse a duplicate — pg-boss's default
  // `standard` policy stores a singletonKey but never enforces it. Safe here
  // because every send on this queue carries a key.
  @OnEvent(SmartRotationWorkEvent, {
    queue: SMART_ROTATION_QUEUE,
    queueOptions: { policy: 'short' },
  })
  async handleWork(payload: SmartRotationWorkPayload): Promise<void> {
    await this.executeWork(payload.userId, payload.workType);
  }

  private async executeWork(userId: string, workType: SmartRotationWorkType): Promise<void> {
    switch (workType) {
      case 'question_feed': {
        await this.questionService.rotateStaleFeedQuestions(userId);
        let enqueued = await this.questionService.enqueueNextFeedQueueQuestion(userId, FEED_QUEUE_LIMIT);

        if (!enqueued) {
          enqueued = await this.contextGapQuestionService.tryGenerateAndEnqueue(userId);
        }

        this.logger.log('Smart rotation question feed', { userId, enqueued });

        return;
      }

      case 'answer_infer': {
        const questionId = await this.findNextUnansweredQuestionId(userId);

        if (!questionId) {
          // Two different situations, deliberately reported as one: there is
          // nothing left unanswered, or everything still unanswered was tried
          // within the cooldown. Both mean "spend this slot on nothing", and on
          // a small catalogue the second is the normal steady state rather than
          // a fault.
          this.logger.log(
            'Smart rotation answer infer skipped — nothing unanswered outside the attempt cooldown',
            { userId, cooldownHours: INFERENCE_ATTEMPT_COOLDOWN_HOURS },
          );

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

        this.logger.log('Smart rotation answer infer enqueued', { userId, questionId });

        return;
      }

      case 'schedule_sync': {
        const context = { userId } as UserServiceContext;
        const written = await this.suggestionSyncService.sync(context);

        this.logger.log('Smart rotation schedule sync', { userId, written });

        return;
      }

      case 'insights': {
        const hasNovelty = await this.lifeContextService.hasNoveltySinceLastRun(userId, 'insights');
        if (!hasNovelty) {
          this.logger.log('Smart rotation insights skipped — no novelty', { userId });

          return;
        }

        // Dispatch to the summary service via pg-boss (deferred completion +
        // retries) instead of a blocking HTTP call. Personalization is
        // resolved here because the trust dial lives app-side.
        const lifeContext = await this.lifeContextService.buildForUser(userId);
        const enqueued = await this.pythonFunctionService.dispatch(
          'summary',
          'insights_generation',
          userId,
          {
            timezone: 'UTC',
            lookback_hours: 72,
            personalization: {
              trust_mode: lifeContext.trustMode,
              insight_volume_multiplier: lifeContext.insightVolumeMultiplier,
            },
          },
          { singletonKey: `fn:insights_generation:${userId}:rotation` },
        );

        this.logger.log('Smart rotation insights dispatched', { userId, enqueued });

        return;
      }

      case 'summaries': {
        const hoursSince = await this.hoursSinceLastSummary(userId);
        const stale = hoursSince == null || hoursSince >= 24;
        const functionName = stale ? 'dossier_refresh' : 'hourly_summary';

        const enqueued = await this.pythonFunctionService.dispatch(
          'summary',
          functionName,
          userId,
          {},
          { singletonKey: `fn:${functionName}:${userId}:rotation` },
        );

        this.logger.log('Smart rotation summary dispatched', { userId, functionName, enqueued });

        return;
      }

      case 'graph_link': {
        if (this.maintenanceOrchestratorService.isRunning(userId)) {
          this.logger.log('Smart rotation graph link skipped — orchestrator busy', { userId });

          return;
        }

        const summary = await this.maintenanceOrchestratorService.orchestrate(userId, {
          stages: ['extract_people', 'link_communications', 'link_events'],
          options: {
            extractPeople: { windowDays: 30 },
            linkCommunications: { windowDays: 14, windowLimit: 300 },
            linkEvents: { pageSize: 500 },
          },
        });

        this.logger.log('Smart rotation graph link', {
          userId,
          ok: summary.ok,
          legs: summary.legs.map((leg) => ({ leg: leg.leg, ok: leg.ok })),
        });

        return;
      }

      case 'graph_enrich': {
        const hasNovelty = await this.lifeContextService.hasNoveltySinceLastRun(userId, 'graph_enrich');
        if (!hasNovelty) {
          this.logger.log('Smart rotation graph enrich skipped — no novelty', { userId });

          return;
        }

        const result = await this.graphEnrichmentService.enrich(userId, {
          maxCommunications: 20,
          maxEvents: 10,
          maxAnswers: 10,
        });

        this.logger.log('Smart rotation graph enrich', {
          userId,
          sampledRecords: result.sampledRecords,
          preferenceEdgesWritten: result.preferenceEdgesWritten,
          familyEdgesWritten: result.familyEdgesWritten,
          generalEdgesWritten: result.generalEdgesWritten,
          reviewQueued: result.reviewQueued,
        });

        return;
      }

      case 'context_prompt': {
        const created = await this.contextPromptGenerateService.generateIfEmpty(userId);

        this.logger.log('Smart rotation context prompt', { userId, created });

        return;
      }

      case 'hydrate_answers': {
        const context = { userId } as UserServiceContext;
        const result = await this.crossTableHydrationService.hydrateAnswers(context);

        this.logger.log('Smart rotation hydrate answers', { userId, ...result });

        return;
      }

      case 'hydrate_things': {
        const context = { userId } as UserServiceContext;
        const result = await this.crossTableHydrationService.hydrateThings(context);

        this.logger.log('Smart rotation hydrate things', { userId, ...result });

        return;
      }

      default:
        throw new Error(`Unknown smart rotation work type: ${workType satisfies never}`);
    }
  }

  private async hoursSinceLastSummary(userId: string): Promise<number | null> {
    type Row = { created_at: Date | null };
    const rows = (await this.dataSource.query(
      `
      SELECT MAX(created_at) AS created_at
      FROM ci.summaries
      WHERE user_id = $1
        AND period_type != 'insight';
      `,
      [userId],
    )) as Row[];

    const createdAt = rows[0]?.created_at;

    if (!createdAt) {
      return null;
    }

    return (Date.now() - new Date(createdAt).getTime()) / 3_600_000;
  }

  /**
   * The next question to spend an inference slot on: least recently ATTEMPTED
   * first, never-attempted before ever-attempted, and nothing tried inside
   * {@link INFERENCE_ATTEMPT_COOLDOWN_HOURS}.
   *
   * ═══ WHY THIS IS NOT "THE OLDEST UNANSWERED QUESTION" ═══
   *
   * It was, and that is a head-of-line block: the ORDER BY was `q.created_at
   * ASC` alone, and the only thing that removed a question from the result was
   * a row appearing in ci.answers. An inference that times out, or that every
   * gate in AnswerInferenceListener discards, writes nothing — so the same row
   * came back on the next tick, and the next, forever.
   *
   * Measured on the reference appliance: "Which of these places is home?"
   * (created 06:59:54.327386, uniquely the oldest — the rest of the seed batch
   * lands at .372079) took 46 of 46 dispatches over 17 hours, produced 24 dead
   * letters, and left ci.answers EMPTY. The other 1,278 eligible questions were
   * never offered to the model once.
   *
   * ═══ WHERE THE ATTEMPT HISTORY COMES FROM ═══
   *
   * pg-boss's own job rows, which are the durable record of what this listener
   * dispatched: `pgboss.job` while a job is live and `pgboss.archive` after it
   * completes. No new table and no new column — `SmartRotationService` already
   * reads `pgboss.job` for its backlog check and `LifeContextService` already
   * reads `pgboss.archive` for its last-run timestamp, and the rotation's stated
   * design is that "cadence is enforced by schedule + PGBoss singleton keys, not
   * a separate state table".
   *
   * That history is shallow — `expireInHours: 12` / `deleteAfterHours: 24` in
   * PGBossEventService, so roughly a day and a half — and that is a FEATURE
   * here, not a limitation worked around: a question whose attempts have aged
   * out reads as never-attempted and returns to the front of the rotation. So
   * nothing is ever permanently silenced, and the standing cost of a
   * permanently-unanswerable question is one slot per history window (~1 of the
   * 72 dispatches a day) rather than all of them.
   *
   * The queue name is matched as well as the event name so Postgres can prune
   * to the `llm` partition (`AnswerInferenceListener` binds
   * `Events.INFER_QUESTION_ANSWER` to `LLM_QUEUE`). If that binding ever moves,
   * this reads as "no attempt history" and degrades to the old
   * oldest-unanswered order — which is the safe direction to fail.
   *
   * The owner id is bound TWICE, as $1 and $5. Postgres deduces a single type
   * per parameter, and this query compares the owner both to a uuid column
   * (`q.is_private_to`) and to a jsonb text field (`data->>'ownerId'`); one
   * parameter cannot be both. Casting either side instead would either break
   * the same deduction or run a uuid cast over payloads this query has not yet
   * filtered down to inference dispatches.
   */
  private async findNextUnansweredQuestionId(userId: string): Promise<string | null> {
    type Row = { id: string };
    const rows = (await this.dataSource.query(
      `
      WITH attempts AS (
        SELECT
          dispatched.data->>'questionId' AS question_id,
          MAX(dispatched.created_on) AS last_attempt_at
        FROM (
          SELECT data, created_on
          FROM pgboss.job
          WHERE name = $2
            AND data->>'name' = $3
            AND data->>'ownerId' = $5
          UNION ALL
          SELECT data, created_on
          FROM pgboss.archive
          WHERE name = $2
            AND data->>'name' = $3
            AND data->>'ownerId' = $5
        ) dispatched
        GROUP BY 1
      )
      SELECT q.question_id AS id
      FROM ci.questions q
      LEFT JOIN attempts a ON a.question_id = q.question_id::text
      WHERE q.is_active = TRUE
        -- Same guard as QuestionService.findUnansweredByUserId. This is a
        -- SECOND, independent copy of "next unanswered question", and it did
        -- not carry the filter — so hand-entry questions the cron path refuses
        -- were still reaching inference through here, once an hour, forever.
        -- Observed: "How tall are you?" (hand_entry) answered from the owner's
        -- own outbound line "It'll be like a foot tall." — about an object,
        -- written to their profile as their height.
        AND q.evidence_class <> 'hand_entry'
        AND (q.is_private_to IS NULL OR q.is_private_to = $1)
        ${excludeForkedOriginsSql('q', '$1')}
        AND NOT EXISTS (
          SELECT 1 FROM ci.answers ans
          WHERE ans.question_id = q.question_id
            AND ans.user_id = $1
            AND ans.answer_method IN ('user', 'inferred')
            AND ans.answer_text IS NOT NULL
            AND TRIM(ans.answer_text) <> ''
        )
        AND (a.last_attempt_at IS NULL OR a.last_attempt_at < NOW() - make_interval(hours => $4))
      -- The whole fix, in one line. NULLS FIRST is what puts every untried
      -- question ahead of every retry; the created_at tiebreak keeps the
      -- original oldest-first order WITHIN each of those two groups, so the
      -- rotation still works the backlog in the order it was seeded.
      --
      -- question_id last, because created_at alone is not a total order here:
      -- the seed catalogue was inserted in bulk, so 1,278 of these rows share a
      -- created_at to the microsecond and Postgres is free to return them in
      -- any order. Without a deterministic tiebreak the row this returns for a
      -- tied group could vary run to run, which is the same shape of problem
      -- the fix is for.
      ORDER BY a.last_attempt_at ASC NULLS FIRST, q.created_at ASC, q.question_id ASC
      LIMIT 1;
      `,
      [userId, LLM_QUEUE, Events.INFER_QUESTION_ANSWER, INFERENCE_ATTEMPT_COOLDOWN_HOURS, userId],
    )) as Row[];

    return rows[0]?.id ?? null;
  }
}

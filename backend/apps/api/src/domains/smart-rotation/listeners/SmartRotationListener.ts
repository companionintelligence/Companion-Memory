import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { Events, EventService, OnEvent } from '@ci/domains/events';
import { QuestionService } from '@ci/domains/intelligence';
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

  @OnEvent(SmartRotationWorkEvent, { queue: SMART_ROTATION_QUEUE })
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
        const questionId = await this.findTopUnansweredQuestionId(userId);

        if (!questionId) {
          this.logger.log('Smart rotation answer infer skipped — no unanswered questions', { userId });

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

      case 'hydrate_inventory': {
        const context = { userId } as UserServiceContext;
        const result = await this.crossTableHydrationService.hydrateInventory(context);

        this.logger.log('Smart rotation hydrate inventory', { userId, ...result });

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

  private async findTopUnansweredQuestionId(userId: string): Promise<string | null> {
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
      ORDER BY q.created_at ASC
      LIMIT 1;
      `,
      [userId],
    )) as Row[];

    return rows[0]?.id ?? null;
  }
}

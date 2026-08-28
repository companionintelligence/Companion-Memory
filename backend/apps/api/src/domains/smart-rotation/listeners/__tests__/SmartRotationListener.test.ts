import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { Events } from '@ci/domains/events';
import type { QuestionService } from '@ci/domains/intelligence';
import type { GraphEnrichmentService, MaintenanceOrchestratorService } from '@ci/domains/maintenance';
import type { ContextPromptGenerateService, CrossTableHydrationService } from '@ci/domains/personalization';
import type { PythonFunctionService } from '@ci/domains/python-functions';
import type { SuggestionSyncService } from '@ci/domains/schedule';

import { SmartRotationListener } from '../../listeners/SmartRotationListener';

function buildListener(overrides: {
  questionService?: QuestionService;
  contextGapQuestionService?: import('../../services/ContextGapQuestionService').ContextGapQuestionService;
  eventService?: EventService;
  suggestionSyncService?: SuggestionSyncService;
  pythonFunctionService?: PythonFunctionService;
  graphEnrichmentService?: GraphEnrichmentService;
  maintenanceOrchestratorService?: MaintenanceOrchestratorService;
  contextPromptGenerateService?: ContextPromptGenerateService;
  crossTableHydrationService?: CrossTableHydrationService;
  lifeContextService?: { hasNoveltySinceLastRun: jest.Mock; buildForUser: jest.Mock };
  dataSource?: { query: jest.Mock };
}) {
  const questionService = (overrides.questionService ?? {}) as QuestionService;
  const contextGapQuestionService = (overrides.contextGapQuestionService ??
    {}) as import('../../services/ContextGapQuestionService').ContextGapQuestionService;
  const eventService = (overrides.eventService ?? { send: jest.fn() }) as unknown as EventService;
  const suggestionSyncService = (overrides.suggestionSyncService ?? {}) as SuggestionSyncService;
  const pythonFunctionService = (overrides.pythonFunctionService ?? {}) as PythonFunctionService;
  const graphEnrichmentService = (overrides.graphEnrichmentService ?? {}) as GraphEnrichmentService;
  const maintenanceOrchestratorService = (overrides.maintenanceOrchestratorService ??
    {}) as MaintenanceOrchestratorService;
  const contextPromptGenerateService = (overrides.contextPromptGenerateService ??
    {}) as ContextPromptGenerateService;
  const crossTableHydrationService = (overrides.crossTableHydrationService ??
    {}) as CrossTableHydrationService;
  const lifeContextService = (overrides.lifeContextService ?? {
    hasNoveltySinceLastRun: jest.fn(),
    buildForUser: jest.fn(),
  }) as never;
  const dataSource = overrides.dataSource ?? { query: jest.fn() };
  const logger = { setContext() {}, log() {} } as unknown as LoggerService;

  return new SmartRotationListener(
    questionService,
    contextGapQuestionService,
    eventService,
    suggestionSyncService,
    pythonFunctionService,
    graphEnrichmentService,
    maintenanceOrchestratorService,
    contextPromptGenerateService,
    crossTableHydrationService,
    lifeContextService,
    dataSource as never,
    logger,
  );
}

describe('SmartRotationListener', () => {
  it('delegates schedule_sync to SuggestionSyncService', async () => {
    const suggestionSyncService = {
      sync: jest.fn().mockResolvedValue(3),
    } as unknown as SuggestionSyncService;

    const listener = buildListener({ suggestionSyncService });

    await listener.handleWork({ userId: 'user-1', workType: 'schedule_sync' });

    expect(suggestionSyncService.sync).toHaveBeenCalledWith({ userId: 'user-1' });
  });

  it('delegates answer_infer to the inference event bus', async () => {
    const eventService = { send: jest.fn().mockResolvedValue(['job-1']) } as unknown as EventService;
    const dataSource = { query: jest.fn().mockResolvedValue([{ id: 'q-1' }]) };

    const listener = buildListener({ eventService, dataSource });

    await listener.handleWork({ userId: 'user-1', workType: 'answer_infer' });

    expect(eventService.send).toHaveBeenCalledWith(
      Events.INFER_QUESTION_ANSWER,
      {
        ownerId: 'user-1',
        questionId: 'q-1',
      },
      {
        singletonKey: 'infer:user-1:q-1',
      },
    );
  });

  it('delegates graph_link to the maintenance orchestrator graph prep legs', async () => {
    const maintenanceOrchestratorService = {
      isRunning: jest.fn().mockReturnValue(false),
      orchestrate: jest.fn().mockResolvedValue({ ok: true, legs: [], totalDurationMs: 1 }),
    } as unknown as MaintenanceOrchestratorService;

    const listener = buildListener({ maintenanceOrchestratorService });

    await listener.handleWork({ userId: 'user-1', workType: 'graph_link' });

    expect(maintenanceOrchestratorService.orchestrate).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        stages: ['extract_people', 'link_communications', 'link_events'],
      }),
    );
  });

  it('delegates context_prompt to ContextPromptGenerateService', async () => {
    const contextPromptGenerateService = {
      generateIfEmpty: jest.fn().mockResolvedValue(true),
    } as unknown as ContextPromptGenerateService;

    const listener = buildListener({ contextPromptGenerateService });

    await listener.handleWork({ userId: 'user-1', workType: 'context_prompt' });

    expect(contextPromptGenerateService.generateIfEmpty).toHaveBeenCalledWith('user-1');
  });

  describe('question_feed', () => {
    it('does not fall back to ContextGapQuestionService when the feed queue already enqueued a question', async () => {
      const questionService = {
        rotateStaleFeedQuestions: jest.fn().mockResolvedValue(undefined),
        enqueueNextFeedQueueQuestion: jest.fn().mockResolvedValue(true),
      } as unknown as QuestionService;
      const contextGapQuestionService = {
        tryGenerateAndEnqueue: jest.fn(),
      } as unknown as import('../../services/ContextGapQuestionService').ContextGapQuestionService;

      const listener = buildListener({ questionService, contextGapQuestionService });

      await listener.handleWork({ userId: 'user-1', workType: 'question_feed' });

      expect(questionService.rotateStaleFeedQuestions).toHaveBeenCalledWith('user-1');
      expect(questionService.enqueueNextFeedQueueQuestion).toHaveBeenCalledWith('user-1', 3);
      expect(contextGapQuestionService.tryGenerateAndEnqueue).not.toHaveBeenCalled();
    });

    it('falls back to ContextGapQuestionService when the feed queue has no candidate', async () => {
      const questionService = {
        rotateStaleFeedQuestions: jest.fn().mockResolvedValue(undefined),
        enqueueNextFeedQueueQuestion: jest.fn().mockResolvedValue(false),
      } as unknown as QuestionService;
      const contextGapQuestionService = {
        tryGenerateAndEnqueue: jest.fn().mockResolvedValue(true),
      } as unknown as import('../../services/ContextGapQuestionService').ContextGapQuestionService;

      const listener = buildListener({ questionService, contextGapQuestionService });

      await listener.handleWork({ userId: 'user-1', workType: 'question_feed' });

      expect(contextGapQuestionService.tryGenerateAndEnqueue).toHaveBeenCalledWith('user-1');
    });
  });

  describe('answer_infer', () => {
    it('skips dispatch when there are no unanswered questions', async () => {
      const eventService = { send: jest.fn() } as unknown as EventService;
      const dataSource = { query: jest.fn().mockResolvedValue([]) };

      const listener = buildListener({ eventService, dataSource });

      await listener.handleWork({ userId: 'user-1', workType: 'answer_infer' });

      expect(eventService.send).not.toHaveBeenCalled();
    });

    it('never offers a hand-entry question to inference', async () => {
      const eventService = { send: jest.fn() } as unknown as EventService;
      const dataSource = { query: jest.fn().mockResolvedValue([{ id: 'q-1' }]) };

      const listener = buildListener({ eventService, dataSource });

      await listener.handleWork({ userId: 'user-1', workType: 'answer_infer' });

      // This is a SECOND copy of "next unanswered question", separate from
      // QuestionService.findUnansweredByUserId. It shipped without the filter,
      // so hand-entry questions the cron path refuses still reached inference
      // through here once an hour — "How tall are you?" came back
      // "It'll be like a foot tall.", read off a message about an object.
      const [sql] = dataSource.query.mock.calls[0] as [string];
      expect(sql.replace(/\s+/g, ' ')).toContain("q.evidence_class <> 'hand_entry'");
    });
  });

  describe('insights', () => {
    it('skips dispatch when there is no novelty since the last run', async () => {
      const pythonFunctionService = { dispatch: jest.fn() } as unknown as PythonFunctionService;
      const lifeContextService = {
        hasNoveltySinceLastRun: jest.fn().mockResolvedValue(false),
        buildForUser: jest.fn(),
      };

      const listener = buildListener({ pythonFunctionService, lifeContextService });

      await listener.handleWork({ userId: 'user-1', workType: 'insights' });

      expect(lifeContextService.hasNoveltySinceLastRun).toHaveBeenCalledWith('user-1', 'insights');
      expect(lifeContextService.buildForUser).not.toHaveBeenCalled();
      expect(pythonFunctionService.dispatch).not.toHaveBeenCalled();
    });

    it('dispatches insights_generation with the personalization payload when there is novelty', async () => {
      const pythonFunctionService = {
        dispatch: jest.fn().mockResolvedValue(true),
      } as unknown as PythonFunctionService;
      const lifeContextService = {
        hasNoveltySinceLastRun: jest.fn().mockResolvedValue(true),
        buildForUser: jest.fn().mockResolvedValue({
          trustMode: 'hands_off',
          insightVolumeMultiplier: 1.5,
        }),
      };

      const listener = buildListener({ pythonFunctionService, lifeContextService });

      await listener.handleWork({ userId: 'user-1', workType: 'insights' });

      expect(lifeContextService.buildForUser).toHaveBeenCalledWith('user-1');
      expect(pythonFunctionService.dispatch).toHaveBeenCalledWith(
        'summary',
        'insights_generation',
        'user-1',
        {
          timezone: 'UTC',
          lookback_hours: 72,
          personalization: {
            trust_mode: 'hands_off',
            insight_volume_multiplier: 1.5,
          },
        },
        { singletonKey: 'fn:insights_generation:user-1:rotation' },
      );
    });
  });

  describe('summaries', () => {
    it('dispatches dossier_refresh when there is no prior summary at all', async () => {
      const pythonFunctionService = {
        dispatch: jest.fn().mockResolvedValue(true),
      } as unknown as PythonFunctionService;
      const dataSource = { query: jest.fn().mockResolvedValue([{ created_at: null }]) };

      const listener = buildListener({ pythonFunctionService, dataSource });

      await listener.handleWork({ userId: 'user-1', workType: 'summaries' });

      expect(pythonFunctionService.dispatch).toHaveBeenCalledWith(
        'summary',
        'dossier_refresh',
        'user-1',
        {},
        { singletonKey: 'fn:dossier_refresh:user-1:rotation' },
      );
    });

    it('dispatches dossier_refresh when the last summary is >= 24h stale', async () => {
      const pythonFunctionService = {
        dispatch: jest.fn().mockResolvedValue(true),
      } as unknown as PythonFunctionService;
      const staleDate = new Date(Date.now() - 25 * 3_600_000);
      const dataSource = { query: jest.fn().mockResolvedValue([{ created_at: staleDate }]) };

      const listener = buildListener({ pythonFunctionService, dataSource });

      await listener.handleWork({ userId: 'user-1', workType: 'summaries' });

      expect(pythonFunctionService.dispatch).toHaveBeenCalledWith(
        'summary',
        'dossier_refresh',
        'user-1',
        {},
        { singletonKey: 'fn:dossier_refresh:user-1:rotation' },
      );
    });

    it('dispatches hourly_summary when the last summary is fresh (< 24h)', async () => {
      const pythonFunctionService = {
        dispatch: jest.fn().mockResolvedValue(true),
      } as unknown as PythonFunctionService;
      const freshDate = new Date(Date.now() - 1 * 3_600_000);
      const dataSource = { query: jest.fn().mockResolvedValue([{ created_at: freshDate }]) };

      const listener = buildListener({ pythonFunctionService, dataSource });

      await listener.handleWork({ userId: 'user-1', workType: 'summaries' });

      expect(pythonFunctionService.dispatch).toHaveBeenCalledWith(
        'summary',
        'hourly_summary',
        'user-1',
        {},
        { singletonKey: 'fn:hourly_summary:user-1:rotation' },
      );
    });
  });

  describe('graph_link busy-skip', () => {
    it('skips orchestration when the maintenance orchestrator is already running for the user', async () => {
      const maintenanceOrchestratorService = {
        isRunning: jest.fn().mockReturnValue(true),
        orchestrate: jest.fn(),
      } as unknown as MaintenanceOrchestratorService;

      const listener = buildListener({ maintenanceOrchestratorService });

      await listener.handleWork({ userId: 'user-1', workType: 'graph_link' });

      expect(maintenanceOrchestratorService.isRunning).toHaveBeenCalledWith('user-1');
      expect(maintenanceOrchestratorService.orchestrate).not.toHaveBeenCalled();
    });
  });

  describe('graph_enrich', () => {
    it('skips enrichment when there is no novelty since the last run', async () => {
      const graphEnrichmentService = { enrich: jest.fn() } as unknown as GraphEnrichmentService;
      const lifeContextService = {
        hasNoveltySinceLastRun: jest.fn().mockResolvedValue(false),
        buildForUser: jest.fn(),
      };

      const listener = buildListener({ graphEnrichmentService, lifeContextService });

      await listener.handleWork({ userId: 'user-1', workType: 'graph_enrich' });

      expect(lifeContextService.hasNoveltySinceLastRun).toHaveBeenCalledWith('user-1', 'graph_enrich');
      expect(graphEnrichmentService.enrich).not.toHaveBeenCalled();
    });

    it('runs enrichment with the sampling caps when there is novelty', async () => {
      const graphEnrichmentService = {
        enrich: jest.fn().mockResolvedValue({
          sampledRecords: 5,
          preferenceEdgesWritten: 1,
          familyEdgesWritten: 0,
          generalEdgesWritten: 2,
          reviewQueued: 0,
        }),
      } as unknown as GraphEnrichmentService;
      const lifeContextService = {
        hasNoveltySinceLastRun: jest.fn().mockResolvedValue(true),
        buildForUser: jest.fn(),
      };

      const listener = buildListener({ graphEnrichmentService, lifeContextService });

      await listener.handleWork({ userId: 'user-1', workType: 'graph_enrich' });

      expect(graphEnrichmentService.enrich).toHaveBeenCalledWith('user-1', {
        maxCommunications: 20,
        maxEvents: 10,
        maxAnswers: 10,
      });
    });
  });

  describe('hydrate_answers / hydrate_things', () => {
    it('delegates hydrate_answers to CrossTableHydrationService.hydrateAnswers', async () => {
      const crossTableHydrationService = {
        hydrateAnswers: jest.fn().mockResolvedValue({ written: 4 }),
      } as unknown as CrossTableHydrationService;

      const listener = buildListener({ crossTableHydrationService });

      await listener.handleWork({ userId: 'user-1', workType: 'hydrate_answers' });

      expect(crossTableHydrationService.hydrateAnswers).toHaveBeenCalledWith({ userId: 'user-1' });
    });

    it('delegates hydrate_things to CrossTableHydrationService.hydrateThings', async () => {
      const crossTableHydrationService = {
        hydrateThings: jest.fn().mockResolvedValue({ written: 2 }),
      } as unknown as CrossTableHydrationService;

      const listener = buildListener({ crossTableHydrationService });

      await listener.handleWork({ userId: 'user-1', workType: 'hydrate_things' });

      expect(crossTableHydrationService.hydrateThings).toHaveBeenCalledWith({ userId: 'user-1' });
    });
  });

  it('throws on an unrecognized work type instead of silently no-oping', async () => {
    const listener = buildListener({});

    await expect(
      listener.handleWork({
        userId: 'user-1',
        workType: 'not_a_real_work_type' as never,
      }),
    ).rejects.toThrow('Unknown smart rotation work type: not_a_real_work_type');
  });
});

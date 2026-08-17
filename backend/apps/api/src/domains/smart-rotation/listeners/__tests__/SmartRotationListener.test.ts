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
});

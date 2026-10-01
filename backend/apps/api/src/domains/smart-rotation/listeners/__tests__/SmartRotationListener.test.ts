import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import { Events } from '@ci/domains/events';
import {
  QUESTION_ROTATION_ORDER_SQL,
  QUESTION_ROTATION_RANK_SQL,
  type QuestionService,
} from '@ci/domains/intelligence';
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
  lifeContextService?: { buildForUser: jest.Mock };
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

    // ═══ HEAD-OF-LINE BLOCKING ═══
    //
    // These three assert the SHAPE of the selection, because a mocked
    // DataSource cannot rank rows. The behaviour they stand in for — that a
    // question dispatched an hour ago loses to one never dispatched — is
    // proved against a real Postgres in
    // SmartRotationListener.answerInfer.integration.spec.ts.
    //
    // Without them, the query that shipped ("ORDER BY q.created_at ASC" and
    // nothing else) sent 46 of 46 dispatches to a single question over 17
    // hours while 1,278 others were never offered to the model at all.
    it('ranks candidates by when inference was last dispatched, untried questions first', async () => {
      const eventService = { send: jest.fn() } as unknown as EventService;
      const dataSource = { query: jest.fn().mockResolvedValue([{ id: 'q-1' }]) };

      const listener = buildListener({ eventService, dataSource });

      await listener.handleWork({ userId: 'user-1', workType: 'answer_infer' });

      const [sql] = dataSource.query.mock.calls[0] as [string];
      const flattened = sql.replace(/\s+/g, ' ');

      expect(flattened).toContain(
        `ORDER BY a.last_attempt_at ASC NULLS FIRST, ${QUESTION_ROTATION_ORDER_SQL.replace(/\s+/g, ' ').trim()} LIMIT 1`,
      );
    });

    // The same rotation order as QuestionService.findUnansweredByUserId, taken
    // from the one shared definition. This copy used to carry its own: no tier
    // rank, and a question_id tiebreak that is a different shuffle on every
    // appliance, because the seeded catalogue has random v4 ids and one
    // created_at. The round-robin itself is proved against a real Postgres in
    // SmartRotationListener.answerInfer.integration.spec.ts.
    it('takes untried questions in the shared catalogue rotation order, joined from the shared ranks', async () => {
      const eventService = { send: jest.fn() } as unknown as EventService;
      const dataSource = { query: jest.fn().mockResolvedValue([{ id: 'q-1' }]) };

      const listener = buildListener({ eventService, dataSource });

      await listener.handleWork({ userId: 'user-1', workType: 'answer_infer' });

      const [sql] = dataSource.query.mock.calls[0] as [string];
      const flattened = sql.replace(/\s+/g, ' ');

      expect(flattened).toContain(`rotation AS (${QUESTION_ROTATION_RANK_SQL.replace(/\s+/g, ' ')})`);
      expect(flattened).toContain('LEFT JOIN rotation qr ON qr.question_id = q.question_id');

      const order = flattened.slice(flattened.indexOf('ORDER BY a.last_attempt_at'));

      expect(order).toMatch(/CASE q\.answer_tier/);
      expect(order.search(/CASE q\.answer_tier/)).toBeLessThan(order.indexOf('q.created_at ASC'));
      // The uuid may only settle rows that agree on every other term.
      expect(order.indexOf('q.question_id ASC')).toBeGreaterThan(order.indexOf('qr.category_round ASC'));
      expect(order).toMatch(/q\.question_id ASC LIMIT 1/);
    });

    it('reads the attempt history from both the live and the archived pg-boss job rows', async () => {
      const eventService = { send: jest.fn() } as unknown as EventService;
      const dataSource = { query: jest.fn().mockResolvedValue([{ id: 'q-1' }]) };

      const listener = buildListener({ eventService, dataSource });

      await listener.handleWork({ userId: 'user-1', workType: 'answer_infer' });

      const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
      const flattened = sql.replace(/\s+/g, ' ');

      // Live rows alone would forget an attempt the moment its job completed,
      // which is most of them.
      expect(flattened).toContain('FROM pgboss.job');
      expect(flattened).toContain('FROM pgboss.archive');
      // Bound, not interpolated: the queue name is what prunes the partition
      // and the event name is what identifies an inference dispatch.
      // The owner is bound twice — Postgres deduces one type per parameter and
      // this query needs the owner as a uuid AND as jsonb text.
      expect(params).toEqual([
        'user-1',
        'llm-background',
        Events.INFER_QUESTION_ANSWER,
        expect.any(Number),
        'user-1',
      ]);
    });

    it('holds a question out of the rotation for a cooldown after it was dispatched', async () => {
      const eventService = { send: jest.fn() } as unknown as EventService;
      const dataSource = { query: jest.fn().mockResolvedValue([{ id: 'q-1' }]) };

      const listener = buildListener({ eventService, dataSource });

      await listener.handleWork({ userId: 'user-1', workType: 'answer_infer' });

      const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
      const flattened = sql.replace(/\s+/g, ' ');

      expect(flattened).toContain(
        'AND (a.last_attempt_at IS NULL OR a.last_attempt_at < NOW() - make_interval(hours => $4))',
      );

      // Finite, so nothing is ever silenced for good — an LLM outage costs a
      // question a few hours, not its place in the rotation.
      const cooldownHours = params[3] as number;
      expect(cooldownHours).toBeGreaterThan(0);
      expect(cooldownHours).toBeLessThanOrEqual(24);
    });
  });

  describe('insights', () => {
    it('always dispatches so the sidecar can compare against the last stored insight', async () => {
      const pythonFunctionService = {
        dispatch: jest.fn().mockResolvedValue(true),
      } as unknown as PythonFunctionService;
      const lifeContextService = {
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
    // The dossier gate answers ONE boolean: has a summary been stored since
    // the dossier was built. `true` is also what every unknown resolves to
    // inside the SQL — no user row, no self entity, the `'{}'` default
    // dossier, or a `lastUpdatedAt` that will not parse.
    const dossierGate = (stale: boolean) => ({ query: jest.fn().mockResolvedValue([{ stale }]) });
    const dispatchMock = () => jest.fn().mockResolvedValue(true);

    // Deliberately named for what it asserts: the gate is a mock here, so this
    // is "the gate reported stale", not "the user is new". Whether a user with
    // no dossier actually resolves to stale is a question about SQL, answered
    // against a real Postgres in
    // PythonFunctionCrons.dossierGate.integration.spec.ts.
    it('dispatches the hourly digest and then the dossier, in that order, when the gate reports stale', async () => {
      const dispatch = dispatchMock();
      const pythonFunctionService = { dispatch } as unknown as PythonFunctionService;

      const listener = buildListener({ pythonFunctionService, dataSource: dossierGate(true) });

      await listener.handleWork({ userId: 'user-1', workType: 'summaries' });

      expect(dispatch).toHaveBeenNthCalledWith(
        1,
        'summary',
        'hourly_summary',
        'user-1',
        {},
        { singletonKey: 'fn:hourly_summary:user-1:rotation' },
      );
      expect(dispatch).toHaveBeenNthCalledWith(
        2,
        'summary',
        'dossier_refresh',
        'user-1',
        {},
        { singletonKey: 'fn:dossier_refresh:user-1:rotation' },
      );
    });

    it('dispatches the dossier when a summary has been stored since it was built', async () => {
      const dispatch = dispatchMock();
      const pythonFunctionService = { dispatch } as unknown as PythonFunctionService;

      const listener = buildListener({ pythonFunctionService, dataSource: dossierGate(true) });

      await listener.handleWork({ userId: 'user-1', workType: 'summaries' });

      expect(dispatch).toHaveBeenCalledWith(
        'summary',
        'dossier_refresh',
        'user-1',
        {},
        { singletonKey: 'fn:dossier_refresh:user-1:rotation' },
      );
    });

    // SMART_ROTATION_CRONS.summaries ticks hourly, and on a quiet appliance
    // hourly_summary returns skipped:no_activity without writing a row.
    // Ungated, the dossier ran a full LLM pass over the same unchanged
    // summaries 24 times a day, on the GPU the digest itself contends for.
    it('skips the dossier when nothing has been stored since it was last built', async () => {
      const dispatch = dispatchMock();
      const pythonFunctionService = { dispatch } as unknown as PythonFunctionService;

      const listener = buildListener({ pythonFunctionService, dataSource: dossierGate(false) });

      await listener.handleWork({ userId: 'user-1', workType: 'summaries' });

      expect(dispatch).not.toHaveBeenCalledWith(
        'summary',
        'dossier_refresh',
        'user-1',
        expect.anything(),
        expect.anything(),
      );
    });

    // The half of the either/or bug that must never come back: a user with no
    // summaries can only escape by being given the digest, so the digest is
    // dispatched before the gate is consulted and irrespective of its answer.
    it('never withholds the hourly digest, including when the dossier is skipped', async () => {
      const dispatch = dispatchMock();
      const pythonFunctionService = { dispatch } as unknown as PythonFunctionService;
      const dataSource = dossierGate(false);

      const listener = buildListener({ pythonFunctionService, dataSource });

      await listener.handleWork({ userId: 'user-1', workType: 'summaries' });

      expect(dispatch).toHaveBeenCalledWith(
        'summary',
        'hourly_summary',
        'user-1',
        {},
        { singletonKey: 'fn:hourly_summary:user-1:rotation' },
      );
      // Ordering, not decoration: if the gate query ever moved ahead of the
      // digest, a database blip would withhold the one job that makes a
      // summary-less user recoverable.
      expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(dataSource.query.mock.invocationCallOrder[0]);
    });

    // A mocked DataSource cannot rank timestamps, so these pin the SHAPE of
    // the gate — the parts that decide WHICH question it asks. Nothing
    // executes THIS query: the gate is entirely in TypeScript, and the summary
    // sidecar's own dossier tests reach no database at all (tests/conftest.py
    // sets a fake DATABASE_URL and every activity is monkeypatched). The same
    // predicate, asked set-wise for the fan-out, IS executed against a real
    // Postgres in PythonFunctionCrons.dossierGate.integration.spec.ts — which
    // is where an inverted comparison or a mistyped AT TIME ZONE would be
    // caught.
    it('gates on the dossier payload stamp rather than the entity row timestamp', async () => {
      const dispatch = dispatchMock();
      const pythonFunctionService = { dispatch } as unknown as PythonFunctionService;
      const dataSource = dossierGate(true);

      const listener = buildListener({ pythonFunctionService, dataSource });

      await listener.handleWork({ userId: 'user-1', workType: 'summaries' });

      const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
      const flattened = sql.replace(/\s+/g, ' ');

      // store_dossier_activity writes the payload into ci.entities.dossier and
      // the generator stamps it with lastUpdatedAt. entities.updated_at is
      // bumped by unrelated entity writes (imports, merges, enrichment), any
      // one of which would read as "the dossier is current" and suppress a
      // rebuild that is genuinely owed. Matched on the bare column name: an
      // alias rename (`entities.updated_at`, `ent.updated_at`) reintroduces
      // exactly the bug while satisfying any one spelling of it.
      expect(flattened).toContain("JSON_VALUE(e.dossier, '$.lastUpdatedAt'");
      expect(flattened).not.toMatch(/\bupdated_at\b/);
      // A bare ::timestamp cast throws on a malformed stamp, which would take
      // the whole summaries tick down with it; ON ERROR turns it into
      // "unknown", and unknown means stale.
      expect(flattened).toContain('DEFAULT NULL ON ERROR');
      expect(flattened).toContain('(SELECT built_at FROM built) IS NULL');
      // Compared in naive UTC, because the sidecar stamps datetime.utcnow()
      // and the API pool pins no session TimeZone.
      expect(flattened).toContain("fresh.created_at AT TIME ZONE 'UTC' > (SELECT built_at FROM built)");
      expect(params).toEqual(['user-1']);
    });

    it('counts only the period types the dossier actually reads', async () => {
      const dispatch = dispatchMock();
      const pythonFunctionService = { dispatch } as unknown as PythonFunctionService;
      const dataSource = dossierGate(true);

      const listener = buildListener({ pythonFunctionService, dataSource });

      await listener.handleWork({ userId: 'user-1', workType: 'summaries' });

      const [sql] = dataSource.query.mock.calls[0] as [string];

      // fetch_summaries_for_dossier_activity reads hourly + daily only.
      // `insight` rows live in the same table and are written hourly by
      // insights_generation — counting one as dossier input would restore the
      // every-hour rebuild through the back door.
      expect(sql.replace(/\s+/g, ' ')).toContain("fresh.period_type IN ('hourly', 'daily')");
    });

    it('treats an unreadable gate result as stale so a first dossier is never withheld', async () => {
      const dispatch = dispatchMock();
      const pythonFunctionService = { dispatch } as unknown as PythonFunctionService;

      const listener = buildListener({
        pythonFunctionService,
        dataSource: { query: jest.fn().mockResolvedValue([]) },
      });

      await listener.handleWork({ userId: 'user-1', workType: 'summaries' });

      expect(dispatch).toHaveBeenCalledWith(
        'summary',
        'dossier_refresh',
        'user-1',
        {},
        { singletonKey: 'fn:dossier_refresh:user-1:rotation' },
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

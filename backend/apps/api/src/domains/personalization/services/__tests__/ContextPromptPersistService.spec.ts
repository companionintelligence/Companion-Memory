import type { UserServiceContext } from '@ci/common/context';

import type { ContextPromptSource, SelectorSpec } from '../../contextPrompt.types';
import { ContextPromptPersistService } from '../ContextPromptPersistService';

function selector(overrides: Partial<SelectorSpec> = {}): SelectorSpec {
  return { type: 'yes_no', prompt: 'Did you go for a run today?', ...overrides };
}

function promptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prompt-1',
    userId: 'user-1',
    status: 'answered',
    selector: selector(),
    response: 'yes',
    source: { kind: 'daily_metric', id: 'conversations_low' } as ContextPromptSource,
    ...overrides,
  };
}

/**
 * Every constructor dependency mocked, matching the convention already used
 * throughout `asks/` and `search-ingress/listeners/__tests__` — `persist()`
 * orchestrates ten collaborators and two raw `dataSource.query` idempotency
 * checks; none of them are the thing under test.
 */
function makeService(
  options: {
    row?: Record<string, unknown> | null;
    existingAnswer?: { id: string; question_id: string } | null;
  } = {},
) {
  const dataSourceQuery = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM ci.answers')) {
      return options.existingAnswer ? [options.existingAnswer] : [];
    }

    if (sql.includes('FROM ci.questions')) {
      return [];
    }

    // The property write's counting CTE — an outer SELECT, so the driver
    // hands back rows, not the `[rows, rowCount]` pair of a bare UPDATE.
    if (sql.includes('UPDATE ci.entities')) {
      return [{ count: 1 }];
    }

    return [];
  });
  const dataSource = { query: dataSourceQuery };

  const contextPromptService = {
    findById: jest.fn().mockResolvedValue(options.row === undefined ? promptRow() : options.row),
    markWritten: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };
  const answerService = { create: jest.fn().mockResolvedValue({ id: 'answer-1' }) };
  const questionService = { create: jest.fn().mockResolvedValue({ id: 'question-new' }) };
  const graphIngestService = {
    ingest: jest.fn().mockResolvedValue({ entities: [], relationships: [], errors: [] }),
  };
  const eventService = { create: jest.fn().mockResolvedValue([{ id: 'event-1' }]) };
  const placement = {
    timezoneFor: jest.fn().mockResolvedValue('America/Los_Angeles'),
    acceptCandidate: jest.fn().mockResolvedValue(undefined),
  };
  const homeConfirmService = { confirmFromResponse: jest.fn().mockResolvedValue(false) };
  const dailyMetricsService = { refreshForUser: jest.fn().mockResolvedValue(undefined) };
  const ollamaService = { chat: jest.fn().mockResolvedValue({ message: { content: '{}' } }) };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ContextPromptPersistService(
    dataSource as never,
    contextPromptService as never,
    answerService as never,
    questionService as never,
    graphIngestService as never,
    eventService as never,
    placement as never,
    homeConfirmService as never,
    dailyMetricsService as never,
    ollamaService as never,
    logger as never,
  );

  return {
    service,
    dataSourceQuery,
    contextPromptService,
    answerService,
    questionService,
    graphIngestService,
    eventService,
    placement,
    homeConfirmService,
    dailyMetricsService,
    ollamaService,
    logger,
  };
}

const CTX_USER = 'user-1';

describe('ContextPromptPersistService.persist — gating', () => {
  it('is a no-op when the prompt row cannot be found', async () => {
    const { service, contextPromptService, answerService } = makeService({ row: null });

    await service.persist(CTX_USER, 'prompt-1');

    expect(answerService.create).not.toHaveBeenCalled();
    expect(contextPromptService.markWritten).not.toHaveBeenCalled();
    expect(contextPromptService.markFailed).not.toHaveBeenCalled();
  });

  it.each(['pending', 'written', 'skipped'])(
    'is a no-op for a %s prompt (only answered/failed are persisted)',
    async (status) => {
      const { service, answerService } = makeService({ row: promptRow({ status }) });

      await service.persist(CTX_USER, 'prompt-1');

      expect(answerService.create).not.toHaveBeenCalled();
    },
  );

  it('retries a previously-failed prompt', async () => {
    const { service, answerService, contextPromptService } = makeService({
      row: promptRow({ status: 'failed' }),
    });

    await service.persist(CTX_USER, 'prompt-1');

    expect(answerService.create).toHaveBeenCalled();
    expect(contextPromptService.markWritten).toHaveBeenCalled();
  });
});

describe('ContextPromptPersistService.persist — the linked Q&A write always happens', () => {
  it('writes an answer row for a plain response, and marks the prompt written', async () => {
    const { service, answerService, contextPromptService } = makeService();

    await service.persist(CTX_USER, 'prompt-1');

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: CTX_USER },
      expect.objectContaining({ text: 'yes', answerMethod: 'user', answerSource: 'user_input' }),
    );
    expect(contextPromptService.markWritten).toHaveBeenCalledWith(
      'prompt-1',
      expect.objectContaining({ writer: 'write_answer' }),
    );
  });

  // The idempotency guard: a re-run of persist() for the SAME prompt must reuse
  // the already-written answer's question, not mint a duplicate ci.answers row.
  it('reuses the existing answer/question on a re-run instead of writing a duplicate', async () => {
    const { service, answerService, dataSourceQuery } = makeService({
      existingAnswer: { id: 'answer-existing', question_id: 'question-existing' },
    });

    await service.persist(CTX_USER, 'prompt-1');

    expect(dataSourceQuery).toHaveBeenCalledWith(expect.stringContaining('FROM ci.answers'), [
      CTX_USER,
      'prompt-1',
    ]);
    expect(answerService.create).not.toHaveBeenCalled();
  });

  // A day-deferral / negative response ("no, not today") is a genuine answer —
  // it still gets a Q&A row — but must not also write a phantom timeline entry.
  it('day-deferral responses still write the Q&A pair but classify as skip_write', async () => {
    const { service, answerService, eventService, placement, contextPromptService } = makeService({
      row: promptRow({
        response: 'no',
        source: { kind: 'candidate', id: 'cand-1', day: '2026-08-20' },
      }),
    });

    await service.persist(CTX_USER, 'prompt-1');

    expect(answerService.create).toHaveBeenCalled(); // writeLinkedQa always runs
    expect(eventService.create).not.toHaveBeenCalled();
    expect(placement.acceptCandidate).not.toHaveBeenCalled();
    expect(contextPromptService.markWritten).toHaveBeenCalledWith(
      'prompt-1',
      expect.objectContaining({ writer: 'skip_write' }),
    );
  });
});

describe('ContextPromptPersistService.persist — write_schedule_accept', () => {
  it('passes the Ollama-filled duration through to placement.acceptCandidate', async () => {
    const uuid = '019804a1-31e3-7000-8000-000000000001';
    const { service, ollamaService, placement } = makeService({
      row: promptRow({ response: uuid, source: { kind: 'candidate', id: 'cand-1', day: '2026-08-20' } }),
    });
    ollamaService.chat.mockResolvedValue({
      message: { content: JSON.stringify({ startTime: '2026-08-20T17:00:00.000Z', durationMinutes: 60 }) },
    });

    await service.persist(CTX_USER, 'prompt-1');

    expect(placement.acceptCandidate).toHaveBeenCalledWith(
      { userId: CTX_USER },
      uuid,
      expect.any(Date),
      expect.objectContaining({ durationMinutes: 60 }),
    );
  });

  it('accepts the candidate id named by the response when it is a UUID', async () => {
    const uuid = '019804a1-31e3-7000-8000-000000000001';
    const { service, placement } = makeService({
      row: promptRow({
        response: uuid,
        source: { kind: 'candidate', id: 'cand-1', day: '2026-08-20' },
      }),
    });

    await service.persist(CTX_USER, 'prompt-1');

    expect(placement.acceptCandidate).toHaveBeenCalledWith(
      { userId: CTX_USER },
      uuid,
      expect.any(Date),
      expect.objectContaining({}),
    );
  });

  it('falls back to the SOURCE id as the candidate when the response is not a uuid', async () => {
    const uuid = '019804a1-31e3-7000-8000-000000000002';
    const { service, placement } = makeService({
      row: promptRow({
        response: 'yes',
        source: { kind: 'candidate', id: uuid, day: '2026-08-20' },
      }),
    });

    await service.persist(CTX_USER, 'prompt-1');

    expect(placement.acceptCandidate).toHaveBeenCalledWith(
      { userId: CTX_USER },
      uuid,
      expect.any(Date),
      expect.anything(),
    );
  });

  it('marks the prompt FAILED (not written) when no candidate id can be resolved at all', async () => {
    const { service, contextPromptService, logger } = makeService({
      row: promptRow({ response: 'yes', source: { kind: 'candidate' } }),
    });

    await service.persist(CTX_USER, 'prompt-1');

    expect(contextPromptService.markFailed).toHaveBeenCalled();
    expect(contextPromptService.markWritten).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('falls back to placement defaults (empty times) when the Ollama fill throws', async () => {
    const uuid = '019804a1-31e3-7000-8000-000000000003';
    const { service, ollamaService, placement, logger } = makeService({
      row: promptRow({ response: uuid, source: { kind: 'candidate', id: 'cand-1', day: '2026-08-20' } }),
    });
    ollamaService.chat.mockRejectedValue(new Error('ollama unreachable'));

    await service.persist(CTX_USER, 'prompt-1');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('fell back to placement defaults'),
      expect.objectContaining({ writer: 'write_schedule_accept' }),
    );
    // Still completes successfully — the LLM fill is a nicety, not a hard dependency.
    expect(placement.acceptCandidate).toHaveBeenCalled();
  });
});

describe('ContextPromptPersistService.persist — write_event_actual', () => {
  const LAST_NIGHT_SOURCE: ContextPromptSource = { kind: 'event', id: 'last-night', place: 'last_night' };

  it('writes ONE event for a single-activity recollection', async () => {
    const { service, eventService, ollamaService } = makeService({
      row: promptRow({ response: 'Had dinner with Liam', source: LAST_NIGHT_SOURCE }),
    });
    ollamaService.chat.mockResolvedValue({ message: { content: '{}' } }); // triggers the splitActivities fallback

    await service.persist(CTX_USER, 'prompt-1');

    expect(eventService.create).toHaveBeenCalledTimes(1);
    expect(eventService.create).toHaveBeenCalledWith(
      { userId: CTX_USER },
      expect.objectContaining({
        title: 'Had dinner with Liam',
        status: 'confirmed',
        is_predicted: false,
        created_by: 'context_prompt',
      }),
    );
  });

  it('splits a multi-activity recollection into MULTIPLE sequential events', async () => {
    const { service, eventService, ollamaService } = makeService({
      row: promptRow({
        response: 'Went to Venice and then met Griffin and Wes for drinks',
        source: LAST_NIGHT_SOURCE,
      }),
    });
    ollamaService.chat.mockResolvedValue({ message: { content: '{}' } });

    await service.persist(CTX_USER, 'prompt-1');

    expect(eventService.create).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = eventService.create.mock.calls;
    expect(firstCall[1]).toMatchObject({ title: 'Went to Venice' });
    expect(secondCall[1]).toMatchObject({ title: 'met Griffin and Wes for drinks' });
    // Sequential, not overlapping: the second activity starts no earlier than
    // the first one's end (the `cursor` progression in writeActualEvents).
    expect((secondCall[1].start_time as Date).getTime()).toBeGreaterThanOrEqual(
      (firstCall[1].end_time as Date).getTime(),
    );
  });

  it('uses events named by the LLM fill directly, skipping splitActivities entirely', async () => {
    const { service, eventService, ollamaService } = makeService({
      row: promptRow({ response: 'ignored raw text', source: LAST_NIGHT_SOURCE }),
    });
    ollamaService.chat.mockResolvedValue({
      message: {
        content: JSON.stringify({
          events: [
            { title: 'Dinner', durationMinutes: 90 },
            { title: 'Movie', durationMinutes: 120 },
          ],
        }),
      },
    });

    await service.persist(CTX_USER, 'prompt-1');

    expect(eventService.create).toHaveBeenCalledTimes(2);
    expect(eventService.create.mock.calls[0][1]).toMatchObject({ title: 'Dinner' });
    expect(eventService.create.mock.calls[1][1]).toMatchObject({ title: 'Movie' });
  });
});

describe('ContextPromptPersistService.persist — write_known_place', () => {
  const HOME_SOURCE: ContextPromptSource = { kind: 'daily_metric', id: 'confirm_home' };

  it('confirms home and triggers a metrics refresh when the write succeeds', async () => {
    const { service, homeConfirmService, dailyMetricsService } = makeService({
      row: promptRow({ response: 'yes', source: HOME_SOURCE }),
    });
    homeConfirmService.confirmFromResponse.mockResolvedValue(true);

    await service.persist(CTX_USER, 'prompt-1');

    expect(homeConfirmService.confirmFromResponse).toHaveBeenCalledWith({ userId: CTX_USER }, 'yes');
    // Fire-and-forget refresh; awaiting a tick lets the .catch()-wrapped promise settle.
    await Promise.resolve();
    expect(dailyMetricsService.refreshForUser).toHaveBeenCalledWith({ userId: CTX_USER });
  });

  it('does not refresh metrics when the confirm write was a no-op', async () => {
    const { service, dailyMetricsService } = makeService({
      row: promptRow({ response: 'no', source: HOME_SOURCE }),
    });

    await service.persist(CTX_USER, 'prompt-1');

    expect(dailyMetricsService.refreshForUser).not.toHaveBeenCalled();
  });

  it('a failing metrics refresh is caught and logged, not thrown — home confirm itself still succeeds', async () => {
    const { service, homeConfirmService, dailyMetricsService, logger, contextPromptService } = makeService({
      row: promptRow({ response: 'yes', source: HOME_SOURCE }),
    });
    homeConfirmService.confirmFromResponse.mockResolvedValue(true);
    dailyMetricsService.refreshForUser.mockRejectedValue(new Error('metrics down'));

    await service.persist(CTX_USER, 'prompt-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(contextPromptService.markWritten).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Home confirm metrics refresh failed',
      expect.objectContaining({ error: 'metrics down' }),
    );
  });
});

describe('ContextPromptPersistService.persist — failure handling', () => {
  it('marks the prompt failed and logs when a writer throws mid-execute', async () => {
    const { service, eventService, contextPromptService, logger } = makeService({
      row: promptRow({
        response: 'A quiet night in',
        source: { kind: 'event', id: 'last-night', place: 'last_night' },
      }),
    });
    eventService.create.mockRejectedValue(new Error('db exploded'));

    await service.persist(CTX_USER, 'prompt-1');

    expect(contextPromptService.markFailed).toHaveBeenCalledWith(
      'prompt-1',
      expect.objectContaining({ writer: 'write_event_actual' }),
    );
    expect(contextPromptService.markWritten).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Context prompt write failed',
      expect.objectContaining({ error: 'db exploded' }),
    );
  });
});

/**
 * `execute()`'s remaining writer branches (write_person_properties,
 * write_place_properties, write_graph_relationship, and the write_graph_entity
 * fallback) are declared on `ContextPromptWritePlan['writer']` and implemented
 * here, but `persist()` only ever calls `execute()` for
 * write_event_actual/write_schedule_accept/write_known_place — every OTHER
 * writer (including these) returns from `persist()` after `writeLinkedQa`
 * without ever reaching `execute()`. That gating is exercised above
 * ("the linked Q&A write always happens"). These branches are tested directly
 * against the real method so the logic they contain — which protects real
 * guarantees (an entity property write is owner-scoped; a relationship write
 * demands all three ids) — has coverage independent of whether some future
 * caller reaches them.
 */
const ENTITY_UUID = '019804a1-31e3-7000-8000-000000000099';

describe('ContextPromptPersistService.execute — writer branches not reachable from persist()', () => {
  function callExecute(
    service: ContextPromptPersistService,
    plan: Record<string, unknown>,
    response: unknown = 'yes',
    source: ContextPromptSource = { kind: 'entity', id: ENTITY_UUID },
  ) {
    const ctx: UserServiceContext = { userId: CTX_USER };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (service as any).execute(ctx, plan, selector(), response, source, 'UTC');
  }

  it('write_person_properties merges a role into the entity, scoped to the owner', async () => {
    const { service, dataSourceQuery } = makeService();

    await callExecute(
      service,
      { writer: 'write_person_properties', entityId: ENTITY_UUID, properties: {} },
      'Friend',
    );

    expect(dataSourceQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE ci.entities'), [
      ENTITY_UUID,
      JSON.stringify({ userResponse: 'Friend', responseText: 'Friend', role: 'Friend' }),
      CTX_USER,
    ]);
  });

  it('throws when the property write matches no entity (wrong owner, or gone)', async () => {
    const { service, dataSourceQuery } = makeService();
    // This stub used to answer `[]` — rows — for a bare `UPDATE … RETURNING`,
    // which the driver answers with `[[], 0]`, so the guard only ever fired
    // here. The statement now counts through a CTE and the stub says 0.
    dataSourceQuery.mockImplementation(async (sql: string) =>
      sql.includes('UPDATE ci.entities') ? [{ count: 0 }] : [],
    );

    await expect(
      callExecute(service, { writer: 'write_place_properties', entityId: ENTITY_UUID, properties: {} }),
    ).rejects.toThrow('property write matched no entity');

    const [sql] =
      dataSourceQuery.mock.calls.find(([text]) => String(text).includes('UPDATE ci.entities')) ?? [];
    expect(sql).toMatch(/RETURNING 1\s*\)\s*SELECT count\(\*\)::int AS count FROM updated/);
  });

  it('throws when a property write plan has no resolvable entityId', async () => {
    const { service } = makeService();

    await expect(
      callExecute(
        service,
        { writer: 'write_person_properties', properties: {} },
        'Friend',
        { kind: 'daily_metric', id: 'conversations_low' }, // not an entity source — no id to fall back to
      ),
    ).rejects.toThrow('property write requires entityId');
  });

  it('write_graph_relationship requires all three of fromEntityId/toEntityId/relationshipType', async () => {
    const { service, graphIngestService } = makeService();

    await expect(
      callExecute(service, { writer: 'write_graph_relationship', properties: {}, fromEntityId: 'a' }),
    ).rejects.toThrow('write_graph_relationship requires fromEntityId, toEntityId, relationshipType');
    expect(graphIngestService.ingest).not.toHaveBeenCalled();
  });

  it('write_graph_relationship ingests the relationship when fully specified', async () => {
    const { service, graphIngestService } = makeService();

    await callExecute(service, {
      writer: 'write_graph_relationship',
      properties: {},
      fromEntityId: '019804a1-31e3-7000-8000-000000000010',
      toEntityId: '019804a1-31e3-7000-8000-000000000011',
      relationshipType: 'KNOWS',
    });

    expect(graphIngestService.ingest).toHaveBeenCalledWith(
      { userId: CTX_USER },
      expect.objectContaining({
        relationships: [
          expect.objectContaining({ type: 'KNOWS', fromEntityType: 'Person', toEntityType: 'Person' }),
        ],
      }),
    );
  });

  it('write_answer with no resolvable questionId falls back to a graph concept write', async () => {
    const { service, graphIngestService, answerService } = makeService();

    await callExecute(service, { writer: 'write_answer', properties: {} }, 'Photography');

    expect(answerService.create).not.toHaveBeenCalled();
    expect(graphIngestService.ingest).toHaveBeenCalledWith(
      { userId: CTX_USER },
      expect.objectContaining({
        entities: [expect.objectContaining({ entityType: 'Concept', name: 'Photography' })],
      }),
    );
  });

  it('write_answer WITH a resolvable questionId writes a real answer, not a concept', async () => {
    const { service, answerService, graphIngestService } = makeService();

    await callExecute(
      service,
      { writer: 'write_answer', properties: {}, questionId: '019804a1-31e3-7000-8000-000000000020' },
      'Photography',
    );

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: CTX_USER },
      expect.objectContaining({ question: { id: '019804a1-31e3-7000-8000-000000000020' } }),
    );
    expect(graphIngestService.ingest).not.toHaveBeenCalled();
  });
});

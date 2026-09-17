import type { LoggerService } from '@ci/common/logging';
import type { OllamaService } from '@ci/domains/llm/services/OllamaService';
import { EventEntity, type CalendarEventService } from '@ci/domains/memory';
import { PersonalizationService } from '@ci/domains/personalization';
import type { SearchService } from '@ci/domains/search-next';

import type { TaskService } from '../TaskService';
import {
  EventNowService,
  PROCESS_BATCH_SIZE,
  PROCESS_TIMEOUT_MS,
  TodoProcessService,
  VerifyDoneService,
} from '../TodoProcessService';

const CTX_USER = 'user-1';

const HIT_ID = '11111111-1111-7111-8111-111111111111';
const BLOCK_ID = '22222222-2222-7222-8222-222222222222';

const HOUR_MS = 60 * 60 * 1000;

/**
 * SearchService.search() really only ever returns `{ id, type }` — see
 * SearchService.search()'s final `.map` — so every fixture here mimics that
 * bare shape. Anything richer (name/snippet/timestamp) must come back through
 * `dataSource.query`, which is exactly the hydration path under test.
 */
function makeSearchService(hits: Array<{ id: string; type: string }>) {
  return {
    search: jest.fn(async () => hits),
  } as unknown as SearchService;
}

function makeDataSource(rows: Array<Record<string, unknown>>) {
  return { query: jest.fn(async () => rows) };
}

function makeLogger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
}

function makeEventQb(rows: EventEntity[]) {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => rows),
  };
}

/**
 * A planned block exactly as PlannedBlockService.placeAt persists one: a real
 * EventEntity (no title column) whose metadata is only `{ generator, taskId }`.
 * The title lives on the CTI base row and must be read back through
 * CalendarEventService — a fixture that puts a title in `metadata` invents a shape the
 * writer never produces.
 */
function makeBlock(overrides: Partial<EventEntity> = {}): EventEntity {
  return Object.assign(new EventEntity(), {
    id: BLOCK_ID,
    taskId: 'task-1',
    status: 'confirmed',
    eventType: 'planned_block',
    startTime: new Date(Date.now() - HOUR_MS),
    endTime: new Date(Date.now() - HOUR_MS / 2),
    metadata: { generator: 'planning.placer', taskId: 'task-1' },
    ...overrides,
  });
}

function makeEventService(events: Array<{ id: string; title: string | null }>) {
  return {
    findByIds: jest.fn(async (_context: unknown, ids: string[]) =>
      ids.map((id) => events.find((event) => event.id === id) ?? null),
    ),
  } as unknown as CalendarEventService;
}

/** Real trust-dial arithmetic, so threshold coincidences cannot be mocked away. */
function makePersonalizationService(trustMode: 'cautious' | 'balanced' | 'hands_off') {
  const profile = PersonalizationService.profileForTrustMode(trustMode);

  return {
    decideAction: jest.fn(
      async (_userId: string, input: Parameters<typeof PersonalizationService.decide>[1]) =>
        PersonalizationService.decide(profile, input),
    ),
  };
}

describe('EventNowService', () => {
  it('recalls each block by its real base-row title, not a constant literal', async () => {
    const searchService = makeSearchService([]);
    const service = new EventNowService(
      { createQueryBuilder: jest.fn(() => makeEventQb([makeBlock()])) } as never,
      makeEventService([{ id: BLOCK_ID, title: 'Dentist appointment' }]),
      {} as TaskService,
      searchService,
      makePersonalizationService('balanced') as never,
      makeDataSource([]) as never,
      makeLogger(),
    );

    await service.runForUser(CTX_USER);

    const [, options] = (searchService.search as jest.Mock).mock.calls[0];
    expect(options.query).toBe('Dentist appointment');
    expect(options.query).not.toContain('planned block');
  });

  it('does not act on a cancel keyword that belongs to some other memory', async () => {
    const searchService = makeSearchService([{ id: HIT_ID, type: 'communication' }]);
    const dataSource = makeDataSource([
      {
        id: HIT_ID,
        entity_type: 'communication',
        name: 'Re: the 3pm block',
        snippet: 'happened to get cancelled, so we moved the retro',
        occurred_at: new Date(Date.now() - HOUR_MS),
      },
    ]);
    const personalizationService = makePersonalizationService('hands_off');
    const block = makeBlock();
    const eventRepository = {
      createQueryBuilder: jest.fn(() => makeEventQb([block])),
      save: jest.fn(async (row: EventEntity) => row),
    };
    const taskService = {
      createPendingChange: jest.fn(async () => null),
      hasDeclinedChangeSince: jest.fn(async () => false),
    } as unknown as TaskService;

    const service = new EventNowService(
      eventRepository as never,
      makeEventService([{ id: BLOCK_ID, title: 'Dentist appointment' }]),
      taskService,
      searchService,
      personalizationService as never,
      dataSource as never,
      makeLogger(),
    );

    const result = await service.runForUser(CTX_USER);

    expect(personalizationService.decideAction).not.toHaveBeenCalled();
    expect(taskService.createPendingChange).not.toHaveBeenCalled();
    expect(eventRepository.save).not.toHaveBeenCalled();
    expect(block.status).toBe('confirmed');
    expect(result).toEqual({ proposed: 0 });
  });

  it('proposes a review — never cancels the block itself — on attributable evidence', async () => {
    const searchService = makeSearchService([{ id: HIT_ID, type: 'communication' }]);
    const dataSource = makeDataSource([
      {
        id: HIT_ID,
        entity_type: 'communication',
        name: 'Text from Sam',
        snippet: 'I could not attend the dentist appointment today, they cancelled it.',
        occurred_at: new Date(Date.now() - HOUR_MS),
      },
    ]);
    // hands_off is the most permissive dial there is; even here the block must
    // survive untouched.
    const personalizationService = makePersonalizationService('hands_off');
    const block = makeBlock();
    const eventRepository = {
      createQueryBuilder: jest.fn(() => makeEventQb([block])),
      save: jest.fn(async (row: EventEntity) => row),
    };
    const createPendingChange = jest.fn(async () => null);
    const taskService = {
      createPendingChange,
      hasDeclinedChangeSince: jest.fn(async () => false),
    } as unknown as TaskService;

    const service = new EventNowService(
      eventRepository as never,
      makeEventService([{ id: BLOCK_ID, title: 'Dentist appointment' }]),
      taskService,
      searchService,
      personalizationService as never,
      dataSource as never,
      makeLogger(),
    );

    const result = await service.runForUser(CTX_USER);

    expect(createPendingChange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CTX_USER }),
      expect.objectContaining({ taskId: 'task-1', kind: 'event_revise' }),
    );
    expect(eventRepository.save).not.toHaveBeenCalled();
    expect(block.status).toBe('confirmed');
    expect(result).toEqual({ proposed: 1 });
  });

  it('does not re-propose a cancellation the user has already dismissed', async () => {
    // The ±2h window covers this block on ~4 consecutive hourly ticks, and
    // createPendingChange only de-dupes against a row that is still `pending` —
    // so a declined prompt came straight back on the next tick.
    const searchService = makeSearchService([{ id: HIT_ID, type: 'communication' }]);
    const dataSource = makeDataSource([
      {
        id: HIT_ID,
        entity_type: 'communication',
        name: 'Text from Sam',
        snippet: 'I could not attend the dentist appointment today, they cancelled it.',
        occurred_at: new Date(Date.now() - HOUR_MS),
      },
    ]);
    const createPendingChange = jest.fn(async () => null);
    const hasDeclinedChangeSince = jest.fn(async () => true);
    const service = new EventNowService(
      { createQueryBuilder: jest.fn(() => makeEventQb([makeBlock()])) } as never,
      makeEventService([{ id: BLOCK_ID, title: 'Dentist appointment' }]),
      { createPendingChange, hasDeclinedChangeSince } as unknown as TaskService,
      searchService,
      makePersonalizationService('hands_off') as never,
      dataSource as never,
      makeLogger(),
    );

    const result = await service.runForUser(CTX_USER);

    expect(hasDeclinedChangeSince).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CTX_USER }),
      'task-1',
      'event_revise',
      expect.any(Date),
    );
    expect(createPendingChange).not.toHaveBeenCalled();
    expect(result).toEqual({ proposed: 0 });
  });

  it('ignores cancellation evidence from long before the block', async () => {
    const searchService = makeSearchService([{ id: HIT_ID, type: 'communication' }]);
    const dataSource = makeDataSource([
      {
        id: HIT_ID,
        entity_type: 'communication',
        name: 'Text from Sam',
        snippet: 'I could not attend the dentist appointment, cancelled it.',
        occurred_at: new Date(Date.now() - 5 * 365 * 24 * HOUR_MS),
      },
    ]);
    const taskService = {
      createPendingChange: jest.fn(async () => null),
      hasDeclinedChangeSince: jest.fn(async () => false),
    } as unknown as TaskService;
    const eventRepository = {
      createQueryBuilder: jest.fn(() => makeEventQb([makeBlock()])),
      save: jest.fn(async (row: EventEntity) => row),
    };

    const service = new EventNowService(
      eventRepository as never,
      makeEventService([{ id: BLOCK_ID, title: 'Dentist appointment' }]),
      taskService,
      searchService,
      makePersonalizationService('hands_off') as never,
      dataSource as never,
      makeLogger(),
    );

    const result = await service.runForUser(CTX_USER);

    expect(taskService.createPendingChange).not.toHaveBeenCalled();
    expect(result).toEqual({ proposed: 0 });
  });
});

describe('VerifyDoneService', () => {
  function buildService(opts: {
    hits: Array<{ id: string; type: string }>;
    rows: Array<Record<string, unknown>>;
    trustMode: 'cautious' | 'balanced' | 'hands_off';
    taskTitle: string;
    block?: EventEntity;
    /** Whether the user has already dismissed this block's question. */
    declined?: boolean;
  }) {
    const searchService = makeSearchService(opts.hits);
    const dataSource = makeDataSource(opts.rows);
    const personalizationService = makePersonalizationService(opts.trustMode);
    const complete = jest.fn(async () => ({ id: 'task-1', status: 'done' }));
    const createPendingChange = jest.fn(async () => null);
    const hasDeclinedChangeSince = jest.fn(async () => opts.declined ?? false);
    const taskService = {
      findById: jest.fn(async () => ({ id: 'task-1', title: opts.taskTitle, status: 'open' })),
      complete,
      createPendingChange,
      hasDeclinedChangeSince,
    } as unknown as TaskService;
    const block = opts.block ?? makeBlock();
    const eventRepository = {
      createQueryBuilder: jest.fn(() => makeEventQb([block])),
      save: jest.fn(async (row: EventEntity) => row),
    };

    return {
      block,
      complete,
      createPendingChange,
      eventRepository,
      hasDeclinedChangeSince,
      personalizationService,
      searchService,
      service: new VerifyDoneService(
        eventRepository as never,
        taskService,
        searchService,
        personalizationService as never,
        dataSource as never,
        makeLogger(),
      ),
    };
  }

  it('does not retrieve on the very words the completion signal tests', async () => {
    const { service, searchService } = buildService({
      hits: [],
      rows: [],
      trustMode: 'balanced',
      taskTitle: 'Renew passport',
    });

    await service.runForUser(CTX_USER);

    const [, options] = (searchService.search as jest.Mock).mock.calls[0];
    expect(options.query).toBe('Renew passport');
    expect(options.query).not.toMatch(/finish|complete/i);
  });

  it('does not auto-complete a task from an unrelated "completed" message in the default trust mode', async () => {
    const { service, complete, createPendingChange, block, personalizationService } = buildService({
      hits: [{ id: HIT_ID, type: 'communication' }],
      rows: [
        {
          id: HIT_ID,
          entity_type: 'communication',
          name: 'Your order has been completed',
          snippet: 'Thanks for shopping with us.',
          occurred_at: new Date(Date.now() - HOUR_MS / 2),
        },
      ],
      trustMode: 'balanced',
      taskTitle: 'Renew passport',
    });

    const result = await service.runForUser(CTX_USER);

    expect(complete).not.toHaveBeenCalled();
    expect(block.status).toBe('confirmed');
    expect(personalizationService.decideAction).toHaveBeenCalledWith(CTX_USER, {
      kind: 'task_complete',
      confidence: 0.55,
    });
    expect(createPendingChange).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ completed: 0, pending: 1 });
  });

  it('asks rather than auto-completes on attributable evidence in the default trust mode', async () => {
    const { service, complete, createPendingChange, personalizationService } = buildService({
      hits: [{ id: HIT_ID, type: 'communication' }],
      rows: [
        {
          id: HIT_ID,
          entity_type: 'communication',
          name: 'Text to Alex',
          snippet: 'Just finished the quarterly report, sending it over now.',
          occurred_at: new Date(Date.now() - HOUR_MS / 2),
        },
      ],
      trustMode: 'balanced',
      taskTitle: 'Quarterly report',
    });

    const result = await service.runForUser(CTX_USER);

    expect(personalizationService.decideAction).toHaveBeenCalledWith(CTX_USER, {
      kind: 'task_complete',
      confidence: 0.8,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(createPendingChange).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ completed: 0, pending: 1 });
  });

  it('auto-completes under hands_off when the evidence names the task and postdates the block', async () => {
    const { service, complete, block } = buildService({
      hits: [{ id: HIT_ID, type: 'communication' }],
      rows: [
        {
          id: HIT_ID,
          entity_type: 'communication',
          name: 'Text to Alex',
          snippet: 'Just finished the quarterly report, sending it over now.',
          occurred_at: new Date(Date.now() - HOUR_MS / 2),
        },
      ],
      trustMode: 'hands_off',
      taskTitle: 'Quarterly report',
    });

    const result = await service.runForUser(CTX_USER);

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ userId: CTX_USER }), 'task-1');
    expect(block.status).toBe('completed');
    expect(result).toEqual({ completed: 1, pending: 0 });
  });

  // ═══ a dismissal is a decision, and it has to survive the next tick ═══
  //
  // createPendingChange de-dupes only against a row that is still `pending`, so
  // declining moved the row out of the set that was suppressing it: the hourly
  // cron re-filed the identical "did this get done?" prompt for as long as the
  // block stayed inside the 36h lookback — about 36 more times — and every
  // dismissal was silently discarded. Nothing anywhere read `declined`.
  it('does not re-ask a question the user has already dismissed for this block', async () => {
    const { service, createPendingChange, hasDeclinedChangeSince, block } = buildService({
      hits: [],
      rows: [],
      trustMode: 'balanced',
      taskTitle: 'Renew passport',
      declined: true,
    });

    const result = await service.runForUser(CTX_USER);

    expect(hasDeclinedChangeSince).toHaveBeenCalledWith(
      expect.objectContaining({ userId: CTX_USER }),
      'task-1',
      'complete',
      block.endTime,
    );
    expect(createPendingChange).not.toHaveBeenCalled();
    expect(result).toEqual({ completed: 0, pending: 0 });
  });

  it('asks again for a block that ended after the decline', async () => {
    // The suppression is bounded by the block's own end, so it settles that
    // occurrence rather than muting the task for good.
    const { service, createPendingChange } = buildService({
      hits: [],
      rows: [],
      trustMode: 'balanced',
      taskTitle: 'Renew passport',
      declined: false,
    });

    const result = await service.runForUser(CTX_USER);

    expect(createPendingChange).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ completed: 0, pending: 1 });
  });

  it('does not let a NULL status hide a block from the pass', async () => {
    // `ci.events.status` has no NOT NULL yet (EventEntity.status), and
    // three-valued `status NOT IN (...)` evaluates to NULL for such a row —
    // which WHERE drops. COALESCE keeps it, because "no status" is the one
    // value that certainly does not mean the block is done.
    const { service, eventRepository } = buildService({
      hits: [],
      rows: [],
      trustMode: 'balanced',
      taskTitle: 'Renew passport',
    });

    await service.runForUser(CTX_USER);

    const qb = eventRepository.createQueryBuilder.mock.results[0].value as {
      andWhere: jest.Mock;
    };

    expect(qb.andWhere.mock.calls.map(([sql]) => sql)).toContain(
      "COALESCE(event.status, '') NOT IN (:...doneStatuses)",
    );
  });

  it('does not complete from evidence that predates the block', async () => {
    const { service, complete, createPendingChange } = buildService({
      hits: [{ id: HIT_ID, type: 'communication' }],
      rows: [
        {
          id: HIT_ID,
          entity_type: 'communication',
          name: 'Text to Alex',
          snippet: 'Just finished the quarterly report, sending it over now.',
          occurred_at: new Date(Date.now() - 5 * 365 * 24 * HOUR_MS),
        },
      ],
      trustMode: 'hands_off',
      taskTitle: 'Quarterly report',
    });

    const result = await service.runForUser(CTX_USER);

    expect(complete).not.toHaveBeenCalled();
    expect(createPendingChange).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ completed: 0, pending: 1 });
  });
});

describe('TodoProcessService', () => {
  it('feeds the LLM hydrated memory content, not bare type:id lines', async () => {
    const searchService = makeSearchService([{ id: HIT_ID, type: 'communication' }]);
    const dataSource = makeDataSource([
      {
        id: HIT_ID,
        entity_type: 'communication',
        name: 'Text from Sam',
        snippet: 'Already picked up the dry cleaning, no need to go.',
        occurred_at: new Date(Date.now() - HOUR_MS),
      },
    ]);
    const chat = jest.fn<
      Promise<{ message: { role: string; content: string } }>,
      [unknown, Array<{ role: string; content: string }>, unknown]
    >(async () => ({
      message: { role: 'assistant', content: JSON.stringify({ action: 'none' }) },
    }));
    const ollamaService = { chat } as unknown as OllamaService;
    const taskService = {
      findAll: jest.fn(async () => [{ id: 'task-1', title: 'Pick up dry cleaning', description: null }]),
    } as unknown as TaskService;

    const service = new TodoProcessService(
      taskService,
      searchService,
      ollamaService,
      makePersonalizationService('balanced') as never,
      dataSource as never,
      makeLogger(),
    );

    await service.runForUser(CTX_USER);

    expect(chat).toHaveBeenCalledTimes(1);
    const [, messages] = chat.mock.calls[0];
    expect(messages[0].content).toContain('Already picked up the dry cleaning');
    expect(messages[0].content).not.toContain(`communication:${HIT_ID}`);
    // The hydration query is scoped to the caller and asks for exactly the ids
    // search() returned.
    expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [[HIT_ID], CTX_USER]);
  });

  // ═══ the line between "asks you" and "closes your task for you" ═══
  //
  // `complete` is the only suggestion routed through the `task_complete` gate
  // (0.85 in balanced) instead of `task_mutate`'s autoPromoteThreshold (0.55),
  // and clampConfidence's 0.75 default — what a small model returning a bare
  // {"action":"complete"} gets — sits between the two. So mis-routing that
  // suggestion does not fail loudly: it silently turns a Plan-page
  // confirmation into the appliance closing the user's task from a keyword
  // recall hit, with VerifyDoneService then stamping the block done.
  describe('a completion suggestion', () => {
    function buildService(opts: {
      trustMode: 'cautious' | 'balanced' | 'hands_off';
      suggestion: Record<string, unknown>;
    }) {
      const searchService = makeSearchService([{ id: HIT_ID, type: 'communication' }]);
      const dataSource = makeDataSource([
        {
          id: HIT_ID,
          entity_type: 'communication',
          name: 'Text to Alex',
          snippet: 'Picked the passport up from the office this morning.',
          occurred_at: new Date(Date.now() - HOUR_MS),
        },
      ]);
      const chat = jest.fn(async () => ({
        message: { role: 'assistant', content: JSON.stringify(opts.suggestion) },
      })) as unknown as OllamaService['chat'];
      const complete = jest.fn(async () => ({ id: 'task-1', status: 'done' }));
      const createPendingChange = jest.fn(async () => null);
      const taskService = {
        findAll: jest.fn(async () => [{ id: 'task-1', title: 'Renew passport', description: null }]),
        complete,
        createPendingChange,
        appendNotes: jest.fn(),
        update: jest.fn(),
        findByTitleMatch: jest.fn(async () => null),
      } as unknown as TaskService;
      const personalizationService = makePersonalizationService(opts.trustMode);

      return {
        complete,
        createPendingChange,
        personalizationService,
        service: new TodoProcessService(
          taskService,
          searchService,
          { chat } as unknown as OllamaService,
          personalizationService as never,
          dataSource as never,
          makeLogger(),
        ),
      };
    }

    it('asks rather than closing the task in the default trust mode', async () => {
      const { service, complete, createPendingChange, personalizationService } = buildService({
        trustMode: 'balanced',
        // No `confidence`: the bare answer a utility model actually returns,
        // which clampConfidence turns into 0.75.
        suggestion: { action: 'complete', rationale: 'Alex was told the passport arrived.' },
      });

      const result = await service.runForUser(CTX_USER);

      expect(personalizationService.decideAction).toHaveBeenCalledWith(CTX_USER, {
        kind: 'task_complete',
        confidence: 0.75,
      });
      expect(complete).not.toHaveBeenCalled();
      expect(createPendingChange).toHaveBeenCalledWith(
        expect.objectContaining({ userId: CTX_USER }),
        expect.objectContaining({
          taskId: 'task-1',
          kind: 'complete',
          patch: {},
          rationale: 'Alex was told the passport arrived.',
          confidence: 0.75,
        }),
      );
      expect(result).toEqual({ applied: 0, pending: 1 });
    });

    it('closes the task under hands_off', async () => {
      const { service, complete, createPendingChange, personalizationService } = buildService({
        trustMode: 'hands_off',
        suggestion: { action: 'complete', confidence: 0.92, rationale: 'Passport collected.' },
      });

      const result = await service.runForUser(CTX_USER);

      expect(personalizationService.decideAction).toHaveBeenCalledWith(CTX_USER, {
        kind: 'task_complete',
        confidence: 0.92,
      });
      expect(complete).toHaveBeenCalledWith(expect.objectContaining({ userId: CTX_USER }), 'task-1');
      expect(createPendingChange).not.toHaveBeenCalled();
      expect(result).toEqual({ applied: 1, pending: 0 });
    });

    it('still asks under hands_off when the model is unsure', async () => {
      // ALWAYS_REVIEW_BELOW_CONFIDENCE (0.55) is a floor under every trust
      // mode, so the most permissive dial there is still cannot close a task
      // on a hedge.
      const { service, complete, createPendingChange, personalizationService } = buildService({
        trustMode: 'hands_off',
        suggestion: { action: 'complete', confidence: 0.4 },
      });

      const result = await service.runForUser(CTX_USER);

      expect(personalizationService.decideAction).toHaveBeenCalledWith(CTX_USER, {
        kind: 'task_complete',
        confidence: 0.4,
      });
      expect(complete).not.toHaveBeenCalled();
      expect(createPendingChange).toHaveBeenCalledWith(
        expect.objectContaining({ userId: CTX_USER }),
        // The model gave no rationale, so the user still gets a sentence.
        expect.objectContaining({ kind: 'complete', rationale: 'Looks like this may be done.' }),
      );
      expect(result).toEqual({ applied: 0, pending: 1 });
    });
  });

  // ═══ every active task gets a turn ═══
  //
  // `findAll` orders by due_at ASC NULLS LAST and an overdue date never
  // advances, so the old fixed `LIMIT 40` handed every six-hour tick the SAME
  // forty rows: a user with more than forty active tasks had a tail that was
  // never reviewed at all, and the run's `applied`/`pending` tallies could not
  // show it because they only count what the run looked at.
  describe('candidate rotation', () => {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

    /** The titles the run actually sent to the model, in order. */
    async function reviewedTitles(now: number, taskCount: number): Promise<string[]> {
      const searchService = makeSearchService([{ id: HIT_ID, type: 'communication' }]);
      const dataSource = makeDataSource([
        {
          id: HIT_ID,
          entity_type: 'communication',
          name: 'Text from Sam',
          snippet: 'Already picked up the dry cleaning, no need to go.',
          occurred_at: new Date(now - HOUR_MS),
        },
      ]);
      const chat = jest.fn(async () => ({
        message: { role: 'assistant', content: JSON.stringify({ action: 'none' }) },
      })) as unknown as OllamaService['chat'];
      const tasks = Array.from({ length: taskCount }, (_unused, index) => ({
        id: `task-${index}`,
        title: `Task ${index}`,
        description: null,
      }));
      const taskService = { findAll: jest.fn(async () => tasks) } as unknown as TaskService;

      const service = new TodoProcessService(
        taskService,
        searchService,
        { chat } as unknown as OllamaService,
        makePersonalizationService('balanced') as never,
        dataSource as never,
        makeLogger(),
      );

      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

      try {
        await service.runForUser(CTX_USER);
      } finally {
        nowSpy.mockRestore();
      }

      return (chat as jest.Mock).mock.calls.map(([, messages]) => messages[0].content.split('\n')[0]);
    }

    it('moves on to the tasks the previous run could not reach', async () => {
      const tick = 4 * SIX_HOURS_MS;
      const first = await reviewedTitles(tick, PROCESS_BATCH_SIZE + 5);
      const second = await reviewedTitles(tick + SIX_HOURS_MS, PROCESS_BATCH_SIZE + 5);

      expect(first).toHaveLength(PROCESS_BATCH_SIZE);
      expect(second).toHaveLength(PROCESS_BATCH_SIZE);
      // The five that fell off the end of the first window are reviewed by the
      // next tick — under the old fixed LIMIT they never were.
      const starved = ['Task: Task 40', 'Task: Task 41', 'Task: Task 42', 'Task: Task 43', 'Task: Task 44'];

      expect(first).toEqual(expect.not.arrayContaining(starved));
      expect(second).toEqual(expect.arrayContaining(starved));
    });

    it('leaves a pool that fits in one batch exactly as it was', async () => {
      const reviewed = await reviewedTitles(7 * SIX_HOURS_MS, 3);

      expect(reviewed).toEqual(['Task: Task 0', 'Task: Task 1', 'Task: Task 2']);
    });
  });
});

// ═══ per-item guards ═══
//
// TodoScanService and InboxScanService already wrap their per-item loops so one
// item's failure cannot force pg-boss to redeliver the whole job and re-walk
// every item already applied. These three did not: an item that threw took the
// rest of the batch with it, and because the job then FAILED rather than
// resuming per-item, the survivors waited a full tick (6h / 1h / 1h) for a
// review they had already earned.
describe('per-item failure isolation', () => {
  it('TodoProcessService reviews the rest of the batch after one task throws', async () => {
    const searchService = makeSearchService([{ id: HIT_ID, type: 'communication' }]);
    const dataSource = makeDataSource([
      {
        id: HIT_ID,
        entity_type: 'communication',
        name: 'Text from Sam',
        snippet: 'Already picked up the dry cleaning, no need to go.',
        occurred_at: new Date(Date.now() - HOUR_MS),
      },
    ]);
    const chat = jest.fn(async () => ({
      message: { role: 'assistant', content: JSON.stringify({ action: 'revise', title: 'Renamed' }) },
    })) as unknown as OllamaService['chat'];
    const update = jest.fn(async (_ctx: unknown, taskId: string) => {
      // The LLM-suggested reparent/rename target can vanish between suggest()
      // and update() under concurrent job activity — assertOwnsParent then
      // throws NotFoundException straight out of the loop.
      if (taskId === 'task-2') {
        throw new Error('Parent task not found');
      }

      return { id: taskId };
    });
    const taskService = {
      findAll: jest.fn(async () => [
        { id: 'task-1', title: 'Pick up dry cleaning', description: null },
        { id: 'task-2', title: 'Pick up dry cleaning', description: null },
        { id: 'task-3', title: 'Pick up dry cleaning', description: null },
      ]),
      update,
      appendNotes: jest.fn(),
      complete: jest.fn(),
      createPendingChange: jest.fn(async () => null),
      findByTitleMatch: jest.fn(async () => null),
    } as unknown as TaskService;

    const service = new TodoProcessService(
      taskService,
      searchService,
      { chat } as unknown as OllamaService,
      makePersonalizationService('hands_off') as never,
      dataSource as never,
      makeLogger(),
    );

    const result = await service.runForUser(CTX_USER);

    expect(update.mock.calls.map(([, taskId]) => taskId)).toEqual(['task-1', 'task-2', 'task-3']);
    expect(result).toEqual({ applied: 2, pending: 0 });
  });

  it('EventNowService proposes on the rest of the batch after one block throws', async () => {
    const searchService = makeSearchService([{ id: HIT_ID, type: 'communication' }]);
    const dataSource = makeDataSource([
      {
        id: HIT_ID,
        entity_type: 'communication',
        name: 'Text from Sam',
        snippet: 'I could not attend the dentist appointment today, they cancelled it.',
        occurred_at: new Date(Date.now() - HOUR_MS),
      },
    ]);
    const blocks = [
      makeBlock({ id: BLOCK_ID, taskId: 'task-1' }),
      makeBlock({ id: 'block-2', taskId: 'task-2' }),
      makeBlock({ id: 'block-3', taskId: 'task-3' }),
    ];
    const createPendingChange = jest.fn(async (_ctx: unknown, data: { taskId: string }) => {
      if (data.taskId === 'task-2') {
        throw new Error('deadlock detected');
      }

      return null;
    });

    const service = new EventNowService(
      { createQueryBuilder: jest.fn(() => makeEventQb(blocks)) } as never,
      makeEventService(blocks.map((block) => ({ id: block.id, title: 'Dentist appointment' }))),
      { createPendingChange, hasDeclinedChangeSince: jest.fn(async () => false) } as unknown as TaskService,
      searchService,
      makePersonalizationService('hands_off') as never,
      dataSource as never,
      makeLogger(),
    );

    const result = await service.runForUser(CTX_USER);

    expect(createPendingChange.mock.calls.map(([, data]) => data.taskId)).toEqual([
      'task-1',
      'task-2',
      'task-3',
    ]);
    expect(result).toEqual({ proposed: 2 });
  });

  it('VerifyDoneService reviews the rest of the batch after one block throws', async () => {
    const blocks = [
      makeBlock({ id: BLOCK_ID, taskId: 'task-1' }),
      makeBlock({ id: 'block-2', taskId: 'task-2' }),
      makeBlock({ id: 'block-3', taskId: 'task-3' }),
    ];
    const createPendingChange = jest.fn(async (_ctx: unknown, data: { taskId: string }) => {
      if (data.taskId === 'task-2') {
        throw new Error('deadlock detected');
      }

      return null;
    });
    const taskService = {
      findById: jest.fn(async (_ctx: unknown, id: string) => ({
        id,
        title: 'Renew passport',
        status: 'open',
      })),
      complete: jest.fn(),
      createPendingChange,
      hasDeclinedChangeSince: jest.fn(async () => false),
    } as unknown as TaskService;

    const service = new VerifyDoneService(
      {
        createQueryBuilder: jest.fn(() => makeEventQb(blocks)),
        save: jest.fn(async (row: EventEntity) => row),
      } as never,
      taskService,
      makeSearchService([]),
      makePersonalizationService('balanced') as never,
      makeDataSource([]) as never,
      makeLogger(),
    );

    const result = await service.runForUser(CTX_USER);

    expect(createPendingChange.mock.calls.map(([, data]) => data.taskId)).toEqual([
      'task-1',
      'task-2',
      'task-3',
    ]);
    expect(result).toEqual({ completed: 0, pending: 2 });
  });
});

describe('TodoProcessService LLM budget', () => {
  it('allows the LLM at least 60s before aborting, not 15', () => {
    // Was 15s — the tightest of the three planning-domain LLM budgets, and
    // the same failure mode as TodoScanService/InboxScanService: a local
    // model under real load needs far more than 15s for a first token.
    expect(PROCESS_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});

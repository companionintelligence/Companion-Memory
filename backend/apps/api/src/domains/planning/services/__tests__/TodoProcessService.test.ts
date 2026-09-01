import type { LoggerService } from '@ci/common/logging';
import type { OllamaService } from '@ci/domains/llm/services/OllamaService';
import { EventEntity, type CalendarEventService } from '@ci/domains/memory';
import { PersonalizationService } from '@ci/domains/personalization';
import type { SearchService } from '@ci/domains/search-next';

import type { TaskService } from '../TaskService';
import {
  EventNowService,
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
    const taskService = { createPendingChange: jest.fn(async () => null) } as unknown as TaskService;

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
    const taskService = { createPendingChange } as unknown as TaskService;

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
    const taskService = { createPendingChange: jest.fn(async () => null) } as unknown as TaskService;
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
  }) {
    const searchService = makeSearchService(opts.hits);
    const dataSource = makeDataSource(opts.rows);
    const personalizationService = makePersonalizationService(opts.trustMode);
    const complete = jest.fn(async () => ({ id: 'task-1', status: 'done' }));
    const createPendingChange = jest.fn(async () => null);
    const taskService = {
      findById: jest.fn(async () => ({ id: 'task-1', title: opts.taskTitle, status: 'open' })),
      complete,
      createPendingChange,
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
});

describe('TodoProcessService LLM budget', () => {
  it('allows the LLM at least 60s before aborting, not 15', () => {
    // Was 15s — the tightest of the three planning-domain LLM budgets, and
    // the same failure mode as TodoScanService/InboxScanService: a local
    // model under real load needs far more than 15s for a first token.
    expect(PROCESS_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});

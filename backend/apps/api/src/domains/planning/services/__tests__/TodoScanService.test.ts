import type { LoggerService } from '@ci/common/logging';
import type { OllamaService } from '@ci/domains/llm/services/OllamaService';
import type { PersonalizationService } from '@ci/domains/personalization';
import type { SearchService } from '@ci/domains/search-next';

import type { PlannedBlockService } from '../PlannedBlockService';
import type { ProposedTaskReconcileService } from '../ProposedTaskReconcileService';
import { TaskService } from '../TaskService';
import { SCAN_TIMEOUT_MS, TodoScanService } from '../TodoScanService';

const USER_ID = 'user-1';
const HIT_ID = '11111111-1111-7111-8111-111111111111';

function makeSearchService() {
  return {
    search: jest.fn(async () => [{ id: HIT_ID, type: 'communication' }]),
  } as unknown as SearchService;
}

function makeDataSource() {
  return {
    query: jest.fn(async () => [
      { id: HIT_ID, entity_type: 'communication', name: 'Reminder', snippet: 'Call the vet about Mochi.' },
    ]),
  };
}

function makeOllamaService(items: Array<Record<string, unknown>>) {
  return {
    chat: jest.fn(async (_ctx: unknown, messages: Array<{ content?: string }>) => {
      const prompt = messages?.[0]?.content ?? '';

      if (prompt.includes('Classify each numbered source.')) {
        const indexes = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
        const unique = [...new Set(indexes)];
        const addressed = items.some((item) => item.sourceIndex != null);
        const decisions = unique.map((sourceIndex) => {
          const chosen = addressed
            ? items.filter((item) => item.sourceIndex === sourceIndex)
            : sourceIndex === unique[0]
              ? items.slice(0, 1)
              : [];

          if (chosen.length === 0) {
            return { sourceIndex, action: 'skip' };
          }

          const first = chosen[0]!;

          return {
            sourceIndex,
            action: 'candidate',
            title: first.title,
            detail: first.detail,
            confidence: first.confidence,
          };
        });

        return { message: { role: 'assistant', content: JSON.stringify({ decisions }) } };
      }

      return { message: { role: 'assistant', content: JSON.stringify({ items }) } };
    }),
  } as unknown as OllamaService;
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

function makeProposedReconcile(): ProposedTaskReconcileService {
  return {
    reconcileStaleProposed: jest.fn(async () => ({ redated: 0, archived: 0 })),
    windowForToday: jest.fn(async () => ({
      scheduledFor: '2026-08-26',
      dueAt: new Date('2026-08-26T12:00:00.000Z'),
    })),
  } as unknown as ProposedTaskReconcileService;
}

describe('TodoScanService per-item error isolation', () => {
  it("one item's failure does not abort the rest of the batch", async () => {
    // Three surfaced items: the first creates cleanly, the second throws mid-
    // processing (simulating a transient DB error on that one row), the third
    // must still be reached. Before the fix, an uncaught throw here propagated
    // out of runForUser() and pg-boss would redeliver the WHOLE job — including
    // re-walking the already-applied first item.
    const items = [
      { title: 'Call the vet', confidence: 0.9, sourceIndex: 1 },
      { title: 'Explodes', confidence: 0.9, sourceIndex: 2 },
      { title: 'Pay the invoice', confidence: 0.9, sourceIndex: 3 },
    ];

    const created = new Set<string>();
    const taskService = {
      findAll: jest.fn(async () => []),
      findBySourceRef: jest.fn(async () => null),
      findByTitleMatch: jest.fn(async () => null),
      create: jest.fn(async (_ctx: unknown, dto: { title: string }) => {
        if (dto.title === 'Explodes') {
          throw new Error('simulated transient failure');
        }

        created.add(dto.title);

        return { id: `task-${dto.title}`, title: dto.title, status: 'open' };
      }),
    } as unknown as TaskService;

    const personalizationService = {
      decideAction: jest.fn(async () => 'auto'),
    } as unknown as PersonalizationService;

    const plannedBlockService = {
      tryPlaceAfterOpen: jest.fn(async () => ({ status: 'placed' })),
    } as unknown as PlannedBlockService;

    const logger = makeLogger();
    const proposedReconcile = makeProposedReconcile();

    const hitIds = [
      '11111111-1111-7111-8111-111111111111',
      '22222222-2222-7222-8222-222222222222',
      '33333333-3333-7333-8333-333333333333',
    ];
    const service = new TodoScanService(
      taskService,
      {
        search: jest.fn(async () => hitIds.map((id) => ({ id, type: 'communication' }))),
      } as unknown as SearchService,
      makeOllamaService(items),
      personalizationService,
      plannedBlockService,
      {
        query: jest.fn(async () =>
          hitIds.map((id, index) => ({
            id,
            entity_type: 'communication',
            name: `Reminder ${index + 1}`,
            snippet: 'Call the vet about Mochi.',
          })),
        ),
      } as never,
      proposedReconcile,
      logger,
    );

    const result = await service.runForUser(USER_ID);

    // Both the item before and the item after the throw were still applied.
    expect(created).toEqual(new Set(['Call the vet', 'Pay the invoice']));
    expect(result.created).toBe(2);
    expect(proposedReconcile.reconcileStaleProposed).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Todo scan item failed; continuing with remaining items',
      expect.objectContaining({ title: 'Explodes' }),
    );
  });
});

describe('TodoScanService stale proposed sweep', () => {
  it('sweeps with an empty relevant set when memory has no hits', async () => {
    const searchService = {
      search: jest.fn(async () => []),
    } as unknown as SearchService;
    const proposedReconcile = makeProposedReconcile();
    const logger = makeLogger();

    const service = new TodoScanService(
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(),
        findByTitleMatch: jest.fn(),
        create: jest.fn(),
      } as unknown as TaskService,
      searchService,
      makeOllamaService([]),
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeDataSource() as never,
      proposedReconcile,
      logger,
    );

    const result = await service.runForUser(USER_ID);

    expect(proposedReconcile.reconcileStaleProposed).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      expect.objectContaining({ sourceKind: 'memory_scan', relevantTitles: [] }),
    );
    expect(result).toEqual({ created: 0, proposed: 0, appended: 0, redated: 0, archived: 0 });
  });

  it('does not sweep when the LLM fails', async () => {
    const ollamaService = {
      chat: jest.fn(async () => {
        throw new Error('model timeout');
      }),
    } as unknown as OllamaService;
    const proposedReconcile = makeProposedReconcile();

    const service = new TodoScanService(
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(),
        findByTitleMatch: jest.fn(),
        create: jest.fn(),
      } as unknown as TaskService,
      makeSearchService(),
      ollamaService,
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeDataSource() as never,
      proposedReconcile,
      makeLogger(),
    );

    await service.runForUser(USER_ID);

    expect(proposedReconcile.reconcileStaleProposed).not.toHaveBeenCalled();
  });

  it('does not sweep when the search fails', async () => {
    // The twin of the LLM case above, and the more dangerous one: memoryHits()
    // returns `null` for a failure and `[]` for a genuinely empty corpus, and
    // those two returns are one line apart. Collapse them and a single flaky
    // SearchService call on the daily cron sweeps with an empty relevant set —
    // which archives the user's whole proposed backlog.
    const searchService = {
      search: jest.fn(async () => {
        throw new Error('vector index unavailable');
      }),
    } as unknown as SearchService;
    const proposedReconcile = makeProposedReconcile();
    const taskService = {
      findAll: jest.fn(async () => []),
      findBySourceRef: jest.fn(),
      findByTitleMatch: jest.fn(),
      create: jest.fn(),
    } as unknown as TaskService;

    const service = new TodoScanService(
      taskService,
      searchService,
      makeOllamaService([]),
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeDataSource() as never,
      proposedReconcile,
      makeLogger(),
    );

    // The cron job must not fail either — a search outage is not a reason for
    // pg-boss to redeliver the whole scan.
    await expect(service.runForUser(USER_ID)).resolves.toEqual({
      created: 0,
      proposed: 0,
      appended: 0,
      redated: 0,
      archived: 0,
    });
    expect(proposedReconcile.reconcileStaleProposed).not.toHaveBeenCalled();
    expect(taskService.create).not.toHaveBeenCalled();
  });

  it('stamps scheduledFor and dueAt on newly proposed tasks', async () => {
    const create = jest.fn(async (_ctx: unknown, dto: { title: string }) => ({
      id: `task-${dto.title}`,
      ...dto,
      status: 'proposed',
    }));
    const proposedReconcile = makeProposedReconcile();

    const service = new TodoScanService(
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create,
      } as unknown as TaskService,
      makeSearchService(),
      makeOllamaService([{ title: 'Call the vet', confidence: 0.9 }]),
      { decideAction: jest.fn(async () => 'review') } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeDataSource() as never,
      proposedReconcile,
      makeLogger(),
    );

    const result = await service.runForUser(USER_ID);

    expect(result.proposed).toBe(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      expect.objectContaining({
        title: 'Call the vet',
        status: 'proposed',
        scheduledFor: '2026-08-26',
        dueAt: new Date('2026-08-26T12:00:00.000Z'),
      }),
    );
  });
});

describe('TodoScanService duplicate suppression', () => {
  it('does not create a near-duplicate of an already proposed task', async () => {
    const create = jest.fn();

    const service = new TodoScanService(
      {
        findAll: jest.fn(async () => [
          { title: 'Call the vet about Mochi', status: 'proposed', sourceKind: 'memory_scan', metadata: {} },
        ]),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create,
      } as unknown as TaskService,
      makeSearchService(),
      makeOllamaService([{ title: 'Call the vet', confidence: 0.9 }]),
      { decideAction: jest.fn(async () => 'review') } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeDataSource() as never,
      makeProposedReconcile(),
      makeLogger(),
    );

    const result = await service.runForUser(USER_ID);

    expect(create).not.toHaveBeenCalled();
    expect(result.proposed).toBe(0);
  });

  // ═══ the same to-do, surfaced again tomorrow ═══
  //
  // This cron re-reads the same memory corpus every day, so the model surfaces
  // the same item over and over. TaskService.memoryScanSourceRef exists so
  // "same normalized title → same source_ref" makes that second sighting an
  // append onto the row the user already has instead of a fresh copy. Break
  // the lookup or the `existing` branch and the Plan page accretes a duplicate
  // of every recurring to-do, one per day.
  it('appends onto the task the source ref already points at instead of creating a second one', async () => {
    const existing = { id: 'task-9', title: 'Call the vet', status: 'proposed' };
    const findBySourceRef = jest.fn(async () => existing);
    const appendNotes = jest.fn(async () => existing);
    const create = jest.fn();

    const service = new TodoScanService(
      {
        findAll: jest.fn(async () => []),
        findBySourceRef,
        findByTitleMatch: jest.fn(async () => null),
        appendNotes,
        create,
      } as unknown as TaskService,
      makeSearchService(),
      makeOllamaService([{ title: 'Call the vet', detail: 'Ask about the dental quote.', confidence: 0.9 }]),
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeDataSource() as never,
      makeProposedReconcile(),
      makeLogger(),
    );

    const result = await service.runForUser(USER_ID);

    expect(findBySourceRef).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      'memory_scan',
      TaskService.memoryScanSourceRef('Call the vet'),
    );
    expect(appendNotes).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      'task-9',
      'Ask about the dental quote.',
    );
    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ appended: 1, created: 0, proposed: 0 }));
  });

  it('writes nothing at all when the re-surfaced item carries no new detail', async () => {
    const appendNotes = jest.fn();
    const create = jest.fn();

    const service = new TodoScanService(
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => ({ id: 'task-9', title: 'Call the vet' })),
        findByTitleMatch: jest.fn(async () => null),
        appendNotes,
        create,
      } as unknown as TaskService,
      makeSearchService(),
      makeOllamaService([{ title: 'Call the vet', confidence: 0.9 }]),
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeDataSource() as never,
      makeProposedReconcile(),
      makeLogger(),
    );

    const result = await service.runForUser(USER_ID);

    expect(appendNotes).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ appended: 0, created: 0, proposed: 0 }));
  });
});

describe('TodoScanService LLM budget', () => {
  it('allows the LLM at least 60s before aborting, not 20', () => {
    // Was 20s. The one production run this scan ever made against a real
    // local model aborted with "This operation was aborted" before the
    // model responded at all — a bare one-word completion against the same
    // model took over two minutes on the same hardware. 20s was not a
    // safety margin, it was a guarantee this feature would never produce a
    // proposal on the hardware most likely to need a generous budget.
    expect(SCAN_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});

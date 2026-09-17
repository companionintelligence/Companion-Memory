import type { LoggerService } from '@ci/common/logging';
import type { OllamaService } from '@ci/domains/llm/services/OllamaService';
import type { CommunicationEntity } from '@ci/domains/memory';
import type { PersonalizationService } from '@ci/domains/personalization';

import { SCAN_DEDUP_LIMIT } from '../../engine/taskTitleSimilarity';
import { InboxScanService, LOOKBACK_MS, SCAN_TIMEOUT_MS } from '../InboxScanService';
import type { PlannedBlockService } from '../PlannedBlockService';
import type { PlanningTimeService } from '../PlanningTimeService';
import { ProposedTaskReconcileService } from '../ProposedTaskReconcileService';
import type { TaskService } from '../TaskService';

const USER_ID = 'user-1';

function makeMessage(overrides: Partial<CommunicationEntity> = {}): CommunicationEntity {
  return {
    id: 'comm-1',
    communicationType: 'email',
    time: new Date('2026-08-19T10:00:00.000Z'),
    subject: 'Invoice due',
    preview: 'Please pay the attached invoice by Friday.',
    summary: null,
    content: null,
    ...overrides,
  } as unknown as CommunicationEntity;
}

/**
 * The service issues TWO query builders now: the anchor query
 * (`select(MAX(comm.time)).getRawOne()`) that positions the scan window on the
 * corpus, and the candidate query (`getMany()`). One shared spy object serves
 * both, so `andWhere` calls from either are visible on the same mock.
 *
 * `anchor` defaults to the newest row's time — i.e. "the corpus is what these
 * rows say it is" — which is what makes the historical-import case the DEFAULT
 * shape in these tests rather than a special one.
 */
function makeCommunicationRepository(rows: CommunicationEntity[], anchor?: Date | null) {
  const newest =
    anchor === undefined
      ? rows.reduce<Date | null>((max, row) => (max == null || row.time > max ? row.time : max), null)
      : anchor;

  const qb = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawOne: jest.fn(async () => ({ newest })),
    getMany: jest.fn(async () => rows),
  };

  return { createQueryBuilder: jest.fn(() => qb), qb };
}

function makeOllamaService(items: Array<Record<string, unknown>>) {
  return {
    chat: jest.fn(async () => ({
      message: { role: 'assistant', content: JSON.stringify({ items }) },
    })),
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

describe('InboxScanService per-item error isolation', () => {
  it("one item's failure does not abort the rest of the batch", async () => {
    // Same failure mode as TodoScanService: a mid-batch throw must not
    // propagate out of runForUser() and force pg-boss to redeliver (and
    // re-walk) the whole job.
    const items = [
      { title: 'Pay the invoice', confidence: 0.9 },
      { title: 'Explodes', confidence: 0.9 },
      { title: 'Reply to Sam', confidence: 0.9 },
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

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      taskService,
      makeOllamaService(items),
      personalizationService,
      plannedBlockService,
      proposedReconcile,
      logger,
    );

    const result = await service.runForUser(USER_ID);

    expect(created).toEqual(new Set(['Pay the invoice', 'Reply to Sam']));
    expect(result.created).toBe(2);
    expect(proposedReconcile.reconcileStaleProposed).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Inbox scan item failed; continuing with remaining items',
      expect.objectContaining({ title: 'Explodes' }),
    );
  });
});

describe('InboxScanService stale proposed sweep', () => {
  it('sweeps with an empty relevant set when there are no recent messages', async () => {
    const proposedReconcile = makeProposedReconcile();

    const service = new InboxScanService(
      makeCommunicationRepository([]) as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(),
        findByTitleMatch: jest.fn(),
        create: jest.fn(),
      } as unknown as TaskService,
      makeOllamaService([]),
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      proposedReconcile,
      makeLogger(),
    );

    const result = await service.runForUser(USER_ID);

    expect(proposedReconcile.reconcileStaleProposed).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      expect.objectContaining({ sourceKind: 'inbox', relevantTitles: [] }),
    );
    expect(result).toEqual({ created: 0, proposed: 0, placed: 0, redated: 0, archived: 0 });
  });

  it('does not sweep when the LLM fails', async () => {
    const proposedReconcile = makeProposedReconcile();
    const ollamaService = {
      chat: jest.fn(async () => {
        throw new Error('model timeout');
      }),
    } as unknown as OllamaService;

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(),
        findByTitleMatch: jest.fn(),
        create: jest.fn(),
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      proposedReconcile,
      makeLogger(),
    );

    await service.runForUser(USER_ID);

    expect(proposedReconcile.reconcileStaleProposed).not.toHaveBeenCalled();
  });
});

describe('InboxScanService stale sweep vs the reconcile service cap window', () => {
  it('does not decline a proposed inbox task that falls outside the same capped/ordered window `tracked` uses', async () => {
    // Reproduces the cap-window mismatch end to end, wiring a REAL
    // ProposedTaskReconcileService (not the usual mock) so its `findAll` call
    // is exercised too. `tracked` here (built via
    // findAll({ status: SCAN_DEDUP_STATUSES, limit: SCAN_DEDUP_LIMIT }),
    // ordered due_at ASC NULLS LAST) is entirely filled by SCAN_DEDUP_LIMIT
    // older-due archived rows, so the one live `proposed` inbox row — due
    // yesterday, i.e. later than every filler row — sorts past the cap and
    // falls outside it. Before the fix, reconcileStaleProposed queried an
    // UNCAPPED `status: ['proposed']` and would find + decline that row
    // anyway, purely because it fell outside `tracked`'s slice, not because it
    // stopped being relevant.
    const filler = Array.from({ length: SCAN_DEDUP_LIMIT }, (_, i) => ({
      id: `filler-${i}`,
      title: `Filler task ${i}`,
      status: 'archived',
      sourceKind: 'memory_scan',
      sourceRef: null,
      metadata: {},
      dueAt: new Date(Date.UTC(2020, 0, 1 + (i % 28))),
      scheduledFor: null,
      deferUntil: null,
      createdAt: new Date(Date.UTC(2020, 0, 1)),
    }));
    const staleProposed = {
      id: 'inbox-proposal',
      title: 'Follow up on invoice',
      status: 'proposed',
      sourceKind: 'inbox',
      sourceRef: 'ref-invoice',
      metadata: {},
      dueAt: new Date('2026-08-25T12:00:00.000Z'),
      scheduledFor: '2026-08-25', // "yesterday" relative to `today` below
      deferUntil: null,
      createdAt: new Date('2026-08-20T10:00:00.000Z'),
    };
    const allTasks = [...filler, staleProposed];

    const declineProposed = jest.fn(async (_ctx: unknown, id: string) => ({ id, status: 'archived' }));
    const update = jest.fn(async (_ctx: unknown, id: string, data: Record<string, unknown>) => ({
      id,
      ...data,
    }));

    const taskService = {
      // Mirrors the real TaskService.findAll contract this fix depends on:
      // filter by `status`, order `due_at` ascending, then honour `limit`.
      findAll: jest.fn(async (_ctx: unknown, options: { status?: string[]; limit?: number } = {}) => {
        let rows = allTasks;

        if (options.status?.length) {
          rows = rows.filter((task) => options.status!.includes(task.status));
        }

        rows = [...rows].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());

        return options.limit ? rows.slice(0, options.limit) : rows;
      }),
      findBySourceRef: jest.fn(async () => null),
      findByTitleMatch: jest.fn(async () => null),
      create: jest.fn(),
      declineProposed,
      update,
    } as unknown as TaskService;

    const planningTime = {
      today: jest.fn(async () => '2026-08-26'),
      localDate: jest.fn(async (_ctx: unknown, instant: Date) => instant.toISOString().slice(0, 10)),
      toInstant: jest.fn(
        async (_ctx: unknown, date: string, wall: string) => new Date(`${date}T${wall}:00.000Z`),
      ),
    } as unknown as PlanningTimeService;

    const proposedReconcile = new ProposedTaskReconcileService(taskService, planningTime, makeLogger());

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage({ id: 'comm-1' })]) as never,
      taskService,
      makeOllamaService([]),
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      proposedReconcile,
      makeLogger(),
    );

    await service.runForUser(USER_ID);

    expect(declineProposed).not.toHaveBeenCalledWith(expect.anything(), 'inbox-proposal');
    expect(update).not.toHaveBeenCalledWith(expect.anything(), 'inbox-proposal', expect.anything());
  });
});

describe('InboxScanService scan window and LLM budget', () => {
  it('keeps the window 30 days wide', () => {
    // This is the WIDTH, and it was never the bug — widening it from 3 days to
    // 30 was the previous attempt at the dead-scan fix and the 30-day window
    // was also empty on the live appliance. Position is the fix (see the next
    // test); 30 days just keeps this a "recent inbox" triage rather than a
    // full-history scan, which is extract_graph's job.
    expect(LOOKBACK_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('anchors `since` to the newest message in the corpus, not to the wall clock', async () => {
    // THE regression test for the dead scan. On the live appliance the newest
    // inbound message is 2026-06-16 and the exact predicate this service issued
    // (`time >= now() - 30d`) returned 0 rows, so ~48 runs a day short-circuited
    // before the model was ever called.
    //
    // Note this also fails the tempting `GREATEST(now() - LOOKBACK,
    // max(time) - LOOKBACK)` formulation, which is algebraically
    // `GREATEST(now(), max(time)) - LOOKBACK` and therefore just `now() -
    // LOOKBACK` for any historical import — a "fix" that changes nothing.
    const corpusNewest = new Date('2026-06-16T18:24:00.000Z');
    const repository = makeCommunicationRepository([makeMessage({ time: corpusNewest })]);

    const service = new InboxScanService(
      repository as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create: jest.fn(),
      } as unknown as TaskService,
      makeOllamaService([]),
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    await service.runForUser(USER_ID);

    const sinceCall = repository.qb.andWhere.mock.calls.find((call) => call[0] === 'comm.time >= :since');
    expect(sinceCall).toBeDefined();
    const since = (sinceCall![1] as { since: Date }).since;

    expect(since.getTime()).toBe(corpusNewest.getTime() - LOOKBACK_MS);
    // And emphatically not the old behaviour.
    expect(Math.abs(since.getTime() - (Date.now() - LOOKBACK_MS))).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it('caps the anchor at now() so a future-dated row cannot drag the window forward', async () => {
    // Import corpora have shipped garbage timestamps before. The cap lives in
    // the anchor QUERY (`time <= :now`), which both ignores the bad row and
    // avoids the `LEAST(now(), max(time))` form, where one 2099-dated row
    // collapses the anchor to now() and silently restores the broken behaviour.
    const repository = makeCommunicationRepository([makeMessage()]);

    const service = new InboxScanService(
      repository as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create: jest.fn(),
      } as unknown as TaskService,
      makeOllamaService([]),
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    const before = Date.now();
    await service.runForUser(USER_ID);

    const nowCall = repository.qb.andWhere.mock.calls.find((call) => call[0] === 'comm.time <= :now');
    expect(nowCall).toBeDefined();
    expect((nowCall![1] as { now: Date }).now.getTime()).toBeGreaterThanOrEqual(before);
    // The candidate query deliberately does NOT carry that cap — filtering
    // future-dated rows out of the candidate list is a separate behaviour
    // change and is not made here.
    expect(repository.qb.andWhere.mock.calls.filter((call) => call[0] === 'comm.time <= :now')).toHaveLength(
      1,
    );
  });

  it('never runs the candidate query when the user has no inbound messages at all', async () => {
    const repository = makeCommunicationRepository([], null);
    const proposedReconcile = makeProposedReconcile();
    const ollamaService = makeOllamaService([{ title: 'Should not run' }]);

    const service = new InboxScanService(
      repository as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(),
        findByTitleMatch: jest.fn(),
        create: jest.fn(),
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      proposedReconcile,
      makeLogger(),
    );

    await service.runForUser(USER_ID);

    expect(repository.qb.getMany).not.toHaveBeenCalled();
    expect(ollamaService.chat).not.toHaveBeenCalled();
    // Same sweep as the pre-existing "no recent messages" path.
    expect(proposedReconcile.reconcileStaleProposed).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      expect.objectContaining({ relevantTitles: [] }),
    );
  });

  it('bounds generation and keeps the model warm across the 30-minute cadence', async () => {
    // Without these the 60s budget is not one the call can meet: a bounded
    // `items` array does not bound generation, and a 30-minute cadence exceeds
    // Ollama's 5-minute eviction window so the model reloads inside the budget.
    const ollamaService = makeOllamaService([]);

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create: jest.fn(),
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    await service.runForUser(USER_ID);

    const options = (ollamaService.chat as jest.Mock).mock.calls[0][2] as {
      maxOutputTokens?: number;
      keepAlive?: string;
      format?: {
        properties: { items: { maxItems?: number; items: { properties: Record<string, unknown> } } };
      };
    };

    expect(options.maxOutputTokens).toBeGreaterThan(0);
    expect(options.keepAlive).toBe('1h');
    // The grammar the schema compiles to is what actually stops the model.
    expect(options.format?.properties.items.maxItems).toBe(12);
    expect(options.format?.properties.items.items.properties.title).toEqual(
      expect.objectContaining({ maxLength: expect.any(Number) }),
    );
  });

  it('treats an output-cap truncation as a model failure and does not sweep', async () => {
    const proposedReconcile = makeProposedReconcile();
    const ollamaService = {
      chat: jest.fn(async () => ({
        done_reason: 'length',
        message: { role: 'assistant', content: '{"items":[{"title":"trunca' },
      })),
    } as unknown as OllamaService;
    const logger = makeLogger();

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create: jest.fn(),
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      proposedReconcile,
      logger,
    );

    await service.runForUser(USER_ID);

    expect(proposedReconcile.reconcileStaleProposed).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Inbox scan hit its output cap; raise SCAN_MAX_OUTPUT_TOKENS',
      expect.anything(),
    );
  });

  it('allows the LLM at least 60s before aborting, not 20', () => {
    // Confirmed live: a bare one-word completion against a real local model
    // took over two minutes on real hardware, and the one production run
    // that night aborted with "This operation was aborted" before the model
    // ever responded — 20s was not a safety margin, it was a guarantee of
    // failure on exactly the hardware most likely to need a generous one.
    expect(SCAN_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe('InboxScanService idempotency over an unchanging corpus', () => {
  // Anchoring the window turns this job from "0 rows, no-op" into one that
  // actually asks the model every 30 minutes. On a static import the candidate
  // set is CONSTANT, and nothing is claimed when the model answers `{"items":[]}`
  // — so without a structural gate the identical prompt is re-sent 48 times a
  // day, forever. These tests are the proof that it is not.

  it('asks the model once, then skips while the candidate set is unchanged', async () => {
    const proposedReconcile = makeProposedReconcile();
    const ollamaService = makeOllamaService([]);
    const create = jest.fn();

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      {
        findAll: jest.fn(async () => [
          { title: 'Existing proposal', status: 'proposed', sourceKind: 'inbox', metadata: {} },
        ]),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create,
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      proposedReconcile,
      makeLogger(),
    );

    await service.runForUser(USER_ID);
    await service.runForUser(USER_ID);
    await service.runForUser(USER_ID);

    expect(ollamaService.chat).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    // Both runs still sweep — and with the LIVE proposal titles, never with []
    // (which would mass-archive the user's own proposals every 30 minutes).
    expect(proposedReconcile.reconcileStaleProposed).toHaveBeenCalledTimes(3);
    for (const call of (proposedReconcile.reconcileStaleProposed as jest.Mock).mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ relevantTitles: ['Existing proposal'] }));
    }
  });

  it('asks once more after a claim shrinks the candidate set, then stops', async () => {
    // Model claims message 1 on run 1 -> `fresh` shrinks -> a new fingerprint
    // earns exactly one more ask -> run 3 sees a stable set and skips.
    const ollamaService = makeOllamaService([{ title: 'Pay the invoice', confidence: 0.9, sourceIndex: 1 }]);
    const tasks: Array<Record<string, unknown>> = [];

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage({ id: 'comm-1' }), makeMessage({ id: 'comm-2' })]) as never,
      {
        findAll: jest.fn(async () => tasks),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create: jest.fn(async (_ctx: unknown, dto: Record<string, unknown>) => {
          const task = { id: `task-${tasks.length}`, ...dto };
          tasks.push(task);

          return task;
        }),
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn(async () => 'review') } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    await service.runForUser(USER_ID);
    expect(tasks[0]?.metadata).toEqual(expect.objectContaining({ sourceCommunicationId: 'comm-1' }));

    await service.runForUser(USER_ID);
    await service.runForUser(USER_ID);

    expect(ollamaService.chat).toHaveBeenCalledTimes(2);
    // One card total, not one per run.
    expect(tasks).toHaveLength(1);
  });

  it('does not arm the gate when the model fails, so an outage cannot silence the scan', async () => {
    let attempts = 0;
    const ollamaService = {
      chat: jest.fn(async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error('model timeout');
        }

        return { message: { role: 'assistant', content: '{"items":[]}' } };
      }),
    } as unknown as OllamaService;

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create: jest.fn(),
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    await service.runForUser(USER_ID);
    await service.runForUser(USER_ID);

    expect(ollamaService.chat).toHaveBeenCalledTimes(2);
  });

  it('re-arms when a genuinely new message arrives', async () => {
    const rows = [makeMessage({ id: 'comm-1' })];
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(async () => ({ newest: rows[rows.length - 1].time })),
      getMany: jest.fn(async () => rows),
    };
    const ollamaService = makeOllamaService([]);

    const service = new InboxScanService(
      { createQueryBuilder: jest.fn(() => qb) } as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create: jest.fn(),
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    await service.runForUser(USER_ID);
    await service.runForUser(USER_ID);
    expect(ollamaService.chat).toHaveBeenCalledTimes(1);

    rows.push(makeMessage({ id: 'comm-2', time: new Date('2026-08-20T10:00:00.000Z') }));
    await service.runForUser(USER_ID);

    expect(ollamaService.chat).toHaveBeenCalledTimes(2);
  });

  it('gates per user, not globally', async () => {
    const ollamaService = makeOllamaService([]);

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create: jest.fn(),
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    await service.runForUser(USER_ID);
    await service.runForUser('user-2');

    expect(ollamaService.chat).toHaveBeenCalledTimes(2);
  });

  it('orders candidates by a UNIQUE key so tied timestamps cannot reshuffle the set', async () => {
    // `ORDER BY time DESC` alone is a PARTIAL order. Postgres may return tied
    // rows in any order and the order it picks depends on the plan, so both the
    // fingerprint's input AND — where a tie group straddles LIMIT 30 — the
    // candidate set itself vary run to run on an unchanging corpus. Either one
    // defeats the gate and puts the job back to asking the model every 30
    // minutes forever. The live window has three timestamp ties inside its top
    // 30 and the inbound corpus has tie groups up to 17 rows wide, so this is
    // reachable, not theoretical. `id` is the surrogate uuid PK, so (time, id)
    // is a total order.
    const repo = makeCommunicationRepository([makeMessage()]);

    const service = new InboxScanService(
      repo as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create: jest.fn(),
      } as unknown as TaskService,
      makeOllamaService([]),
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    await service.runForUser(USER_ID);

    expect(repo.qb.orderBy).toHaveBeenCalledWith('comm.time', 'DESC');
    expect(repo.qb.addOrderBy).toHaveBeenCalledWith('comm.id', 'DESC');
  });

  it('fingerprints the candidate SET, not the row order it arrived in', async () => {
    // Belt and braces for the tiebreaker above, guarding the other half of the
    // same defect: if the two runs see the same rows in a different order —
    // a plan flip, a HOT update, a later edit to the query's ORDER BY — an
    // order-sensitive hash misses the gate and the model is asked again. Feed
    // the identical set back reversed and assert the gate still holds.
    const a = makeMessage({ id: 'comm-a' });
    const b = makeMessage({ id: 'comm-b' });
    const orderings = [
      [a, b],
      [b, a],
    ];
    let run = 0;

    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(async () => ({ newest: a.time })),
      getMany: jest.fn(async () => orderings[Math.min(run++, orderings.length - 1)]),
    };
    const ollamaService = makeOllamaService([]);

    const service = new InboxScanService(
      { createQueryBuilder: jest.fn(() => qb) } as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create: jest.fn(),
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    await service.runForUser(USER_ID);
    await service.runForUser(USER_ID);

    expect(ollamaService.chat).toHaveBeenCalledTimes(1);
  });

  it('does not arm the gate when the answer is discarded by a later failure', async () => {
    // The gate must be armed by APPLYING an answer, not by receiving one.
    // `sweepStale` and `windowForToday` are unguarded DB round trips, and
    // neither runForUser nor PlanningJobsListener.onInboxScan catches, so a
    // transient error there rejects the pg-boss job and it retries IN THIS
    // PROCESS. Arming before that work meant the retry matched the gate,
    // skipped the model, created nothing — and, the corpus being static and the
    // fingerprint therefore constant, went on creating nothing forever. That is
    // the very "planning proposes nothing" symptom, reintroduced by its own fix.
    const proposedReconcile = makeProposedReconcile();
    let sweeps = 0;
    (proposedReconcile.reconcileStaleProposed as jest.Mock).mockImplementation(async () => {
      sweeps += 1;

      if (sweeps === 1) {
        throw new Error('pool exhausted during a bulk import');
      }

      return { redated: 0, archived: 0 };
    });

    const ollamaService = makeOllamaService([{ title: 'Pay the invoice', confidence: 0.9 }]);
    const create = jest.fn(async (_ctx: unknown, dto: Record<string, unknown>) => ({ id: 'task-1', ...dto }));

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create,
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn(async () => 'auto') } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn(async () => ({ status: 'skipped' })) } as unknown as PlannedBlockService,
      proposedReconcile,
      makeLogger(),
    );

    // Run 1 gets a real answer, then dies in the sweep before applying it.
    await expect(service.runForUser(USER_ID)).rejects.toThrow('pool exhausted');
    expect(create).not.toHaveBeenCalled();

    // The retry must ask again and actually create the task the model already
    // produced once.
    await service.runForUser(USER_ID);

    expect(ollamaService.chat).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('still arms after a run that created nothing, so a stable answer is asked once', async () => {
    // The mirror of the test above, and the reason its fix is "arm after the
    // loop" rather than "arm only when something was created". A model that
    // answers `{"items":[]}`, or a personalization policy that skips every
    // item, is a COMPLETE run over an unchanged corpus — re-asking it 48 times
    // a day is the unbounded loop the gate exists to prevent.
    const ollamaService = makeOllamaService([{ title: 'Pay the invoice', confidence: 0.9 }]);
    const create = jest.fn();

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create,
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn(async () => 'skip') } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    await service.runForUser(USER_ID);
    await service.runForUser(USER_ID);
    await service.runForUser(USER_ID);

    expect(ollamaService.chat).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('InboxScanService duplicate suppression', () => {
  it('does not create a near-duplicate of an already proposed task', async () => {
    const create = jest.fn();
    const ollamaService = makeOllamaService([
      {
        title: 'Register for Network On Zoom',
        detail: 'One Registration. A New Network Every Month.',
        confidence: 0.9,
      },
    ]);

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      {
        findAll: jest.fn(async () => [
          { title: "Register for 'Network On Zoom'", status: 'proposed', sourceKind: 'inbox', metadata: {} },
        ]),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create,
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn(async () => 'review') } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    const result = await service.runForUser(USER_ID);

    expect(create).not.toHaveBeenCalled();
    expect(result.proposed).toBe(0);
    expect(ollamaService.chat).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          content: expect.stringContaining('Already tracked'),
        }),
      ],
      expect.anything(),
    );
  });

  it('keeps existing proposals when the model returns nothing new', async () => {
    const proposedReconcile = makeProposedReconcile();

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      {
        findAll: jest.fn(async () => [
          { title: "Register for 'Network On Zoom'", status: 'proposed', sourceKind: 'inbox', metadata: {} },
        ]),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create: jest.fn(),
      } as unknown as TaskService,
      makeOllamaService([]),
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      proposedReconcile,
      makeLogger(),
    );

    await service.runForUser(USER_ID);

    expect(proposedReconcile.reconcileStaleProposed).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      expect.objectContaining({
        sourceKind: 'inbox',
        relevantTitles: ["Register for 'Network On Zoom'"],
      }),
    );
  });

  it('skips the model when every recent message already produced a task', async () => {
    const ollamaService = makeOllamaService([{ title: 'Should not run', confidence: 0.9 }]);

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage({ id: 'comm-1' })]) as never,
      {
        findAll: jest.fn(async () => [
          {
            title: "Register for 'Network On Zoom'",
            status: 'proposed',
            sourceKind: 'inbox',
            metadata: { sourceCommunicationId: 'comm-1' },
          },
        ]),
        findBySourceRef: jest.fn(),
        findByTitleMatch: jest.fn(),
        create: jest.fn(),
      } as unknown as TaskService,
      ollamaService,
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    const result = await service.runForUser(USER_ID);

    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(result.proposed).toBe(0);
  });

  it('archives later proposed rephrasings of a task already on the board', async () => {
    const declineProposed = jest.fn(async () => ({ status: 'archived' }));

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      {
        findAll: jest.fn(async () => [
          {
            id: 'first',
            title: "Register for 'Network On Zoom'",
            status: 'proposed',
            sourceKind: 'inbox',
            metadata: {},
            createdAt: new Date('2026-08-20T10:00:00.000Z'),
          },
          {
            id: 'second',
            title: 'Register for Network On Zoom',
            status: 'proposed',
            sourceKind: 'inbox',
            metadata: {},
            createdAt: new Date('2026-08-21T10:00:00.000Z'),
          },
        ]),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        declineProposed,
        create: jest.fn(),
      } as unknown as TaskService,
      makeOllamaService([]),
      { decideAction: jest.fn() } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    await service.runForUser(USER_ID);

    expect(declineProposed).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }), 'second');
    expect(declineProposed).not.toHaveBeenCalledWith(expect.anything(), 'first');
  });

  it('creates only one task when the model emits several wordings of the same job', async () => {
    const create = jest.fn(async (_ctx: unknown, dto: { title: string }) => ({
      id: `task-${dto.title}`,
      ...dto,
      status: 'proposed',
    }));

    const service = new InboxScanService(
      makeCommunicationRepository([makeMessage()]) as never,
      {
        findAll: jest.fn(async () => []),
        findBySourceRef: jest.fn(async () => null),
        findByTitleMatch: jest.fn(async () => null),
        create,
      } as unknown as TaskService,
      makeOllamaService([
        { title: "Register for 'Network On Zoom'", confidence: 0.9 },
        { title: 'Register for Network On Zoom', confidence: 0.8 },
        { title: "Register for the 'Network On Zoom' event", confidence: 0.7 },
      ]),
      { decideAction: jest.fn(async () => 'review') } as unknown as PersonalizationService,
      { tryPlaceAfterOpen: jest.fn() } as unknown as PlannedBlockService,
      makeProposedReconcile(),
      makeLogger(),
    );

    const result = await service.runForUser(USER_ID);

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.proposed).toBe(1);
  });
});

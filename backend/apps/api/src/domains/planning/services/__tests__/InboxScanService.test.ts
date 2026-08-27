import type { LoggerService } from '@ci/common/logging';
import type { OllamaService } from '@ci/domains/llm/services/OllamaService';
import type { CommunicationEntity } from '@ci/domains/memory';
import type { PersonalizationService } from '@ci/domains/personalization';

import { InboxScanService, LOOKBACK_MS, SCAN_TIMEOUT_MS } from '../InboxScanService';
import type { PlannedBlockService } from '../PlannedBlockService';
import type { ProposedTaskReconcileService } from '../ProposedTaskReconcileService';
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

function makeCommunicationRepository(rows: CommunicationEntity[]) {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn(async () => rows),
  };

  return { createQueryBuilder: jest.fn(() => qb) };
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

describe('InboxScanService scan window and LLM budget', () => {
  it('looks back 30 days, not 3', () => {
    // Was 3 days. A personal-data export is historical by construction — its
    // newest message is whenever the export was taken, not "now" — so a
    // 3-day window swept zero rows on every run against a real 432k-message
    // import (the most recent communication was over two months old). 30
    // days still bounds this to a "recent inbox" triage, not a full-history
    // scan, while actually having a chance of finding something.
    expect(LOOKBACK_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('passes a `since` to the query that is ~30 days ago, not ~3', async () => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => []),
    };
    const communicationRepository = { createQueryBuilder: jest.fn(() => qb) };

    const service = new InboxScanService(
      communicationRepository as never,
      {
        findBySourceRef: jest.fn(),
        findByTitleMatch: jest.fn(),
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
    const after = Date.now();

    const sinceCall = qb.andWhere.mock.calls.find((call) => call[0] === 'comm.time >= :since');
    expect(sinceCall).toBeDefined();
    const since = (sinceCall![1] as { since: Date }).since;
    const ageMs = before - since.getTime();

    // Bracket around 30 days (not exactly 3, and not so far off that this
    // would pass with e.g. a stray extra/missing zero in the constant).
    expect(ageMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(ageMs).toBeLessThan(31 * 24 * 60 * 60 * 1000 + (after - before));
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

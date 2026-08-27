/* eslint-disable @typescript-eslint/no-explicit-any */
import { IsNull, LessThan, MoreThanOrEqual } from 'typeorm';

import { TOOL_INVOCATION_ERROR_MAX_LENGTH, type ToolInvokedPayload } from '../../events';
import {
  DEFAULT_INVOCATION_PAGE,
  MAX_INVOCATION_PAGE,
  TOOL_INVOCATION_RETENTION_DAYS,
  ToolInvocationLedgerService,
  clampLimit,
  truncateError,
} from '../ToolInvocationLedgerService';

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
}

function makeRepository() {
  return {
    create: jest.fn((row: unknown) => row),
    save: jest.fn(async (row: unknown) => row),
    find: jest.fn(async () => []),
    delete: jest.fn(async () => ({ affected: 7 })),
  } as any;
}

function makeService() {
  const repository = makeRepository();

  return { repository, service: new ToolInvocationLedgerService(repository, makeLogger()) };
}

function payload(overrides: Partial<ToolInvokedPayload> = {}): ToolInvokedPayload {
  return {
    intent: 'memory.recall',
    tool: 'memory_recall',
    domain: 'memory',
    source: 'native',
    userId: 'user-1',
    occurredAt: '2026-08-26T12:00:00.000Z',
    outcome: 'success',
    external: false,
    destructive: false,
    ...overrides,
  };
}

describe('ToolInvocationLedgerService', () => {
  it('maps a payload onto the row, nulling every absent optional (the columns are nullable)', async () => {
    const { repository, service } = makeService();

    await service.record(payload({ userId: undefined, domain: undefined, capability: undefined }));

    const [row] = repository.create.mock.calls[0];
    expect(row).toMatchObject({
      intent: 'memory.recall',
      tool: 'memory_recall',
      source: 'native',
      outcome: 'success',
      userId: null,
      domain: null,
      capability: null,
      apiKeyId: null,
      correlationId: null,
      errorCode: null,
      error: null,
      durationMs: null,
    });
    expect(row.occurredAt).toStrictEqual(new Date('2026-08-26T12:00:00.000Z'));
  });

  it('preserves the emitted occurredAt rather than stamping insert time — the event is durable and replayable', async () => {
    const { repository, service } = makeService();

    await service.record(payload({ occurredAt: '2025-01-01T00:00:00.000Z' }));

    expect(repository.create.mock.calls[0][0].occurredAt).toStrictEqual(new Date('2025-01-01T00:00:00.000Z'));
  });

  it('truncates an over-long error rather than letting the CHECK reject the whole row', async () => {
    const { repository, service } = makeService();

    await service.record(payload({ error: 'e'.repeat(TOOL_INVOCATION_ERROR_MAX_LENGTH + 100) }));

    expect(repository.create.mock.calls[0][0].error).toHaveLength(TOOL_INVOCATION_ERROR_MAX_LENGTH);
  });

  it('scopes listForUser to one account and orders newest first', async () => {
    const { repository, service } = makeService();

    await service.listForUser('user-9');

    expect(repository.find).toHaveBeenCalledWith({
      where: { userId: 'user-9' },
      order: { occurredAt: 'DESC' },
      take: DEFAULT_INVOCATION_PAGE,
    });
  });

  it('listSystem asks for the rows that belong to nobody, which no user-scoped read can return', async () => {
    const { repository, service } = makeService();

    await service.listSystem();

    expect(repository.find.mock.calls[0][0].where).toStrictEqual({ userId: IsNull() });
  });

  it('applies the tool / outcome / since filters', async () => {
    const { repository, service } = makeService();
    const since = new Date('2026-08-01T00:00:00.000Z');

    await service.listForUser('user-1', { tool: 'memory_forget', outcome: 'refused', since, limit: 5 });

    expect(repository.find).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        tool: 'memory_forget',
        outcome: 'refused',
        occurredAt: MoreThanOrEqual(since),
      },
      order: { occurredAt: 'DESC' },
      take: 5,
    });
  });

  it('prunes at exactly the retention horizon and reports what it deleted', async () => {
    const { repository, service } = makeService();
    const now = new Date('2026-08-26T00:00:00.000Z');

    const deleted = await service.prune(now);

    expect(deleted).toBe(7);
    const cutoff = new Date(now.getTime() - TOOL_INVOCATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(repository.delete).toHaveBeenCalledWith({ occurredAt: LessThan(cutoff) });
  });
});

describe('clampLimit', () => {
  it('defaults, floors, and caps', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_INVOCATION_PAGE);
    expect(clampLimit(0)).toBe(DEFAULT_INVOCATION_PAGE);
    expect(clampLimit(-3)).toBe(DEFAULT_INVOCATION_PAGE);
    expect(clampLimit(NaN)).toBe(DEFAULT_INVOCATION_PAGE);
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit(10.9)).toBe(10);
    // An unbounded take on a per-tool-call table is a way to ask for a year of rows at once.
    expect(clampLimit(100_000)).toBe(MAX_INVOCATION_PAGE);
  });
});

describe('truncateError', () => {
  it('is null-in-null-out and cuts at the cap', () => {
    expect(truncateError(undefined)).toBeNull();
    expect(truncateError('')).toBeNull();
    expect(truncateError('short')).toBe('short');
    expect(truncateError('y'.repeat(TOOL_INVOCATION_ERROR_MAX_LENGTH))).toHaveLength(
      TOOL_INVOCATION_ERROR_MAX_LENGTH,
    );
    expect(truncateError('y'.repeat(TOOL_INVOCATION_ERROR_MAX_LENGTH + 1))).toHaveLength(
      TOOL_INVOCATION_ERROR_MAX_LENGTH,
    );
  });
});

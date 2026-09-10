/* eslint-disable @typescript-eslint/no-explicit-any */
import { LessThan } from 'typeorm';

import { TOOL_INVOCATION_ERROR_MAX_LENGTH, type ToolInvokedPayload } from '../../events';
import {
  DEFAULT_INVOCATION_PAGE,
  MAX_INVOCATION_PAGE,
  TOOL_INVOCATION_RETENTION_DAYS,
  ToolInvocationLedgerService,
  clampLimit,
  decodeCursor,
  encodeCursor,
  truncateError,
} from '../ToolInvocationLedgerService';

function makeLogger() {
  return { setContext: jest.fn(), debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
}

/**
 * A recording stand-in for the TypeORM query builder.
 *
 * The read path builds SQL fragments rather than a `FindOptionsWhere`, so the fragments and their
 * parameters ARE the behaviour under test — particularly the keyset predicate, which is the one
 * clause that can be subtly wrong (comparing only the timestamp, or the wrong direction) while
 * still returning a plausible-looking page.
 */
function makeQueryBuilder(rows: unknown[]) {
  const builder: any = {
    wheres: [] as string[],
    params: {} as Record<string, unknown>,
    orders: [] as [string, string][],
    taken: undefined as number | undefined,
    andWhere: jest.fn((sql: string, params?: Record<string, unknown>) => {
      builder.wheres.push(sql);
      Object.assign(builder.params, params ?? {});

      return builder;
    }),
    orderBy: jest.fn((field: string, direction: string) => {
      builder.orders.push([field, direction]);

      return builder;
    }),
    addOrderBy: jest.fn((field: string, direction: string) => {
      builder.orders.push([field, direction]);

      return builder;
    }),
    take: jest.fn((n: number) => {
      builder.taken = n;

      return builder;
    }),
    getMany: jest.fn(async () => rows),
  };

  return builder;
}

function makeRepository(rows: unknown[] = []) {
  const builder = makeQueryBuilder(rows);

  return {
    builder,
    repository: {
      create: jest.fn((row: unknown) => row),
      save: jest.fn(async (row: unknown) => row),
      createQueryBuilder: jest.fn(() => builder),
      delete: jest.fn(async () => ({ affected: 7 })),
    } as any,
  };
}

function makeService(rows: unknown[] = []) {
  const { repository, builder } = makeRepository(rows);

  return { repository, builder, service: new ToolInvocationLedgerService(repository, makeLogger()) };
}

/** A row shaped just enough for the paginator: it reads `occurredAt` and `id` and nothing else. */
function row(id: string, occurredAt: string) {
  return { id, occurredAt: new Date(occurredAt) };
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

  it('records the principal, the app that owns it, and the tier — the three facts the ledger used to drop', async () => {
    const { repository, service } = makeService();

    await service.record(
      payload({ principal: 'managed-app', principalName: 'app:ci-openclaw:ci-marketplace', tier: 'local' }),
    );

    expect(repository.create.mock.calls[0][0]).toMatchObject({
      principal: 'managed-app',
      principalName: 'app:ci-openclaw:ci-marketplace',
      tier: 'local',
    });
  });

  it('nulls the principal facts when the payload omits them, rather than inventing an owner', async () => {
    const { repository, service } = makeService();

    await service.record(payload());

    expect(repository.create.mock.calls[0][0]).toMatchObject({
      principal: null,
      principalName: null,
      tier: null,
    });
  });

  it('scopes listForUser to one account and orders on the full keyset, newest first', async () => {
    const { builder, service } = makeService();

    await service.listForUser('user-9');

    expect(builder.wheres).toStrictEqual(['invocation.user_id = :userId']);
    expect(builder.params).toMatchObject({ userId: 'user-9' });
    // Both halves of the key, or the cursor cannot resolve a tie it will certainly meet.
    expect(builder.orders).toStrictEqual([
      ['invocation.occurred_at', 'DESC'],
      ['invocation.id', 'DESC'],
    ]);
    // One more than the page, so "is there more" needs no COUNT over a year of rows.
    expect(builder.taken).toBe(DEFAULT_INVOCATION_PAGE + 1);
  });

  it('listSystem asks for the rows that belong to nobody, which no user-scoped read can return', async () => {
    const { builder, service } = makeService();

    await service.listSystem();

    expect(builder.wheres).toStrictEqual(['invocation.user_id IS NULL']);
  });

  it('applies the tool / outcome / since / principal / app filters', async () => {
    const { builder, service } = makeService();
    const since = new Date('2026-08-01T00:00:00.000Z');

    await service.listForUser('user-1', {
      tool: 'memory_forget',
      outcome: 'refused',
      since,
      limit: 5,
      principal: 'managed-app',
      principalName: 'app:ci-openclaw:ci-marketplace',
    });

    expect(builder.wheres).toStrictEqual([
      'invocation.user_id = :userId',
      'invocation.tool = :tool',
      'invocation.outcome = :outcome',
      'invocation.occurred_at >= :since',
      'invocation.principal = :principal',
      'invocation.principal_name = :principalName',
    ]);
    expect(builder.params).toStrictEqual({
      userId: 'user-1',
      tool: 'memory_forget',
      outcome: 'refused',
      since,
      principal: 'managed-app',
      principalName: 'app:ci-openclaw:ci-marketplace',
    });
    expect(builder.taken).toBe(6);
  });

  it('pages on the whole key, not just the timestamp — a tie is ordinary, not exceptional', async () => {
    const { builder, service } = makeService();
    const cursor = { occurredAt: new Date('2026-08-20T10:00:00.000Z'), id: 'aaaaaaaa-0000-7000-8000-000000000001' };

    await service.listForUser('user-1', { cursor });

    expect(builder.wheres).toContain(
      '(invocation.occurred_at, invocation.id) < (:cursorAt, CAST(:cursorId AS uuid))',
    );
    expect(builder.params).toMatchObject({ cursorAt: cursor.occurredAt, cursorId: cursor.id });
  });

  it('hands back a nextCursor only when there is genuinely another page', async () => {
    const rows = [row('id-1', '2026-08-20T12:00:00.000Z'), row('id-2', '2026-08-20T11:00:00.000Z')];

    // Asked for 1: the read takes 2, gets 2, so row two is proof of a next page and is not shown.
    const { service } = makeService(rows);
    const page = await service.listForUser('user-1', { limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe('id-1');
    expect(page.nextCursor).toBe(encodeCursor({ occurredAt: rows[0]!.occurredAt, id: 'id-1' }));
  });

  it('ends the ledger with a null cursor rather than an empty page that looks like more', async () => {
    const { service } = makeService([row('id-1', '2026-08-20T12:00:00.000Z')]);

    const page = await service.listForUser('user-1', { limit: 5 });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
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

describe('cursor codec', () => {
  it('round-trips both halves of the key', () => {
    const cursor = { occurredAt: new Date('2026-08-20T10:00:00.000Z'), id: 'aaaaaaaa-0000-7000-8000-000000000001' };

    expect(decodeCursor(encodeCursor(cursor))).toStrictEqual(cursor);
  });

  it('is URL-safe, because it travels as a query parameter', () => {
    const encoded = encodeCursor({
      occurredAt: new Date('2026-08-20T10:00:00.000Z'),
      id: 'aaaaaaaa-0000-7000-8000-000000000001',
    });

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('splits on the FIRST separator, so a timestamp is never truncated by one in the id', () => {
    // Belt and braces: uuids carry no `|`, but the codec should not depend on
    // that to be correct. The timestamp is the half with a guaranteed format;
    // the id is whatever the primary key happens to be.
    const raw = Buffer.from('2026-08-20T10:00:00.000Z|weird|id', 'utf8').toString('base64url');

    const cursor = decodeCursor(raw);

    expect(cursor.id).toBe('weird|id');
    expect(cursor.occurredAt).toStrictEqual(new Date('2026-08-20T10:00:00.000Z'));
  });

  it('throws on a malformed cursor rather than silently meaning "first page"', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow();
    expect(() => decodeCursor(Buffer.from('no-separator', 'utf8').toString('base64url'))).toThrow();
    expect(() => decodeCursor(Buffer.from('not-a-date|id', 'utf8').toString('base64url'))).toThrow();
    expect(() => decodeCursor(Buffer.from('2026-08-20T10:00:00.000Z|', 'utf8').toString('base64url'))).toThrow();
  });
});

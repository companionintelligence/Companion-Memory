/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException } from '@nestjs/common';

import { encodeCursor } from '../../services/ToolInvocationLedgerService';
import { ToolInvocationsController, parseInvocationQuery } from '../ToolInvocationsController';

function makeLedger() {
  return {
    listForUser: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listSystem: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
  } as any;
}

describe('ToolInvocationsController', () => {
  it('reads only the calling account, never a userId the caller supplied', async () => {
    const ledger = makeLedger();
    const controller = new ToolInvocationsController(ledger);

    await controller.listMine({ userId: 'user-1' } as any, 'memory_forget', 'refused', undefined, '10');

    expect(ledger.listForUser).toHaveBeenCalledWith('user-1', {
      tool: 'memory_forget',
      outcome: 'refused',
      limit: 10,
    });
  });

  it('refuses an unauthenticated caller rather than reading somebody else rows', async () => {
    const controller = new ToolInvocationsController(makeLedger());

    // toServiceContext throws UnauthorizedException when the context carries no userId.
    await expect(controller.listMine({} as any)).rejects.toThrow();
  });

  it('serves the system-caller rows, which no user-scoped read can reach', async () => {
    const ledger = makeLedger();
    const controller = new ToolInvocationsController(ledger);

    await controller.listSystem(undefined, 'error');

    expect(ledger.listSystem).toHaveBeenCalledWith({ outcome: 'error' });
  });

  it('passes the principal filters through, so "what has this app been doing" is one request', async () => {
    const ledger = makeLedger();
    const controller = new ToolInvocationsController(ledger);

    await controller.listMine(
      { userId: 'user-1' } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      'managed-app',
      'app:ci-openclaw:ci-marketplace',
    );

    expect(ledger.listForUser).toHaveBeenCalledWith('user-1', {
      principal: 'managed-app',
      principalName: 'app:ci-openclaw:ci-marketplace',
    });
  });

  it('returns the page envelope, not a bare array — the cursor has to reach the caller', async () => {
    const ledger = makeLedger();
    ledger.listForUser.mockResolvedValue({ items: [], nextCursor: 'abc' });

    const page = await new ToolInvocationsController(ledger).listMine({ userId: 'user-1' } as any);

    expect(page).toStrictEqual({ items: [], nextCursor: 'abc' });
  });
});

describe('parseInvocationQuery', () => {
  it('rejects an unknown outcome instead of silently dropping the filter', () => {
    // A dropped `?outcome=refuse` would answer "nothing was refused" with a page of successes —
    // the wrong answer to the one question this endpoint exists to answer.
    expect(() => parseInvocationQuery({ outcome: 'refuse' })).toThrow(BadRequestException);
  });

  it('accepts every real outcome', () => {
    expect(parseInvocationQuery({ outcome: 'refused' })).toStrictEqual({ outcome: 'refused' });
    expect(parseInvocationQuery({ outcome: 'timeout' })).toStrictEqual({ outcome: 'timeout' });
  });

  it('rejects an unparseable since and a non-positive limit', () => {
    expect(() => parseInvocationQuery({ since: 'last tuesday' })).toThrow(BadRequestException);
    expect(() => parseInvocationQuery({ limit: '0' })).toThrow(BadRequestException);
    expect(() => parseInvocationQuery({ limit: 'many' })).toThrow(BadRequestException);
  });

  it('is empty when nothing is asked for, so an absent filter is not a filter on empty string', () => {
    expect(parseInvocationQuery({})).toStrictEqual({});
    expect(parseInvocationQuery({ tool: '', outcome: '', since: '', limit: '' })).toStrictEqual({});
  });

  it('parses since as an instant', () => {
    expect(parseInvocationQuery({ since: '2026-08-01T00:00:00Z' })).toStrictEqual({
      since: new Date('2026-08-01T00:00:00Z'),
    });
  });

  it('rejects an unknown principal, for the same reason it rejects an unknown outcome', () => {
    // `?principal=app` silently dropped would answer "here is everything you did" to the question
    // "what did the installed apps do".
    expect(() => parseInvocationQuery({ principal: 'app' })).toThrow(BadRequestException);
    expect(() => parseInvocationQuery({ principal: 'Owner' })).toThrow(BadRequestException);
  });

  it('accepts both real principals', () => {
    expect(parseInvocationQuery({ principal: 'owner' })).toStrictEqual({ principal: 'owner' });
    expect(parseInvocationQuery({ principal: 'managed-app' })).toStrictEqual({
      principal: 'managed-app',
    });
  });

  it('maps the wire name `app` onto the column name', () => {
    expect(parseInvocationQuery({ app: 'app:ci-hermes:ci-marketplace' })).toStrictEqual({
      principalName: 'app:ci-hermes:ci-marketplace',
    });
  });

  it('round-trips a real cursor and 400s a forged one', () => {
    const cursor = {
      occurredAt: new Date('2026-08-20T10:00:00.000Z'),
      id: 'aaaaaaaa-0000-7000-8000-000000000001',
    };

    expect(parseInvocationQuery({ cursor: encodeCursor(cursor) })).toStrictEqual({ cursor });
    // Never a silent first page: a client looping over page one would keep reporting the newest
    // rows as if they were the next ones.
    expect(() => parseInvocationQuery({ cursor: 'nonsense' })).toThrow(BadRequestException);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException } from '@nestjs/common';

import { ToolInvocationsController, parseInvocationQuery } from '../ToolInvocationsController';

function makeLedger() {
  return {
    listForUser: jest.fn().mockResolvedValue([]),
    listSystem: jest.fn().mockResolvedValue([]),
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
});

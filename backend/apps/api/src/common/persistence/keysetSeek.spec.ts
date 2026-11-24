import { keysetOrderOf, keysetSeek, keysetSeekExact } from './keysetSeek';

/**
 * What the predicate MEANS, against real rows in Postgres, is held by
 * `graphql/resolvers/__tests__/SearchResolver.timedOrder.integration.spec.ts` (the bucket seek) and
 * `__tests__/keysetPaginate.subMillisecond.integration.spec.ts` (the exact one). This file pins what
 * is written and what is bound.
 */
describe('keysetOrderOf', () => {
  it.each([
    ['ASC', 'ASC'],
    ['asc', 'ASC'],
    ['DESC', 'DESC'],
    ['desc', 'DESC'],
    [{ startTime: 'ASC' }, 'ASC'],
    [{ time: 'asc' }, 'ASC'],
    [{ startTime: 'DESC' }, 'DESC'],
    // Nothing asked for: newest first, as every caller that passes no order has always had.
    [undefined, 'DESC'],
    [null, 'DESC'],
    [{}, 'DESC'],
    ['sideways', 'DESC'],
    [1, 'DESC'],
  ])('reads %j as %s', (order, expected) => {
    expect(keysetOrderOf(order)).toBe(expected);
  });

  it('lets the first key of an order object decide, as the primary sort does', () => {
    expect(keysetOrderOf({ startTime: 'ASC', endTime: 'DESC' })).toBe('ASC');
    expect(keysetOrderOf({ startTime: 'DESC', endTime: 'ASC' })).toBe('DESC');
  });
});

describe('keysetSeek', () => {
  const afterTime = new Date('2026-05-01T00:00:00.123Z');
  const afterId = '018f0000-0000-7000-8000-00000000abcd';

  it('binds the cursor, and the first instant of the millisecond after it', () => {
    const [, params] = keysetSeek('note.updated_at', 'note.id', 'ASC', afterTime, afterId);

    expect(params).toEqual({
      afterTime,
      afterTimeEnd: new Date('2026-05-01T00:00:00.124Z'),
      afterId,
    });

    // The cursor itself is handed through untouched, not rewritten.
    expect(params.afterTime).toBe(afterTime);
  });

  it('carries the end of the bucket across a second, a day and a month boundary', () => {
    const [, params] = keysetSeek(
      'note.updated_at',
      'note.id',
      'DESC',
      new Date('2026-04-30T23:59:59.999Z'),
      afterId,
    );

    expect(params.afterTimeEnd.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('seeks upwards for ASC: later buckets, or this bucket past the id', () => {
    const [sql] = keysetSeek('note.updated_at', 'note.id', 'ASC', afterTime, afterId);

    expect(sql).toBe(
      '(note.updated_at >= :afterTime AND (note.updated_at >= :afterTimeEnd OR ' +
        '(note.updated_at >= :afterTime AND note.updated_at < :afterTimeEnd AND note.id > :afterId)))',
    );
  });

  it('seeks downwards for DESC: earlier buckets, or this bucket before the id', () => {
    const [sql] = keysetSeek('note.updated_at', 'note.id', 'DESC', afterTime, afterId);

    expect(sql).toBe(
      '(note.updated_at < :afterTimeEnd AND (note.updated_at < :afterTime OR ' +
        '(note.updated_at >= :afterTime AND note.updated_at < :afterTimeEnd AND note.id < :afterId)))',
    );
  });

  it('never compares the time for equality, which no microsecond value could satisfy', () => {
    for (const order of ['ASC', 'DESC'] as const) {
      const [sql] = keysetSeek('note.updated_at', 'note.id', order, afterTime, afterId);

      expect(sql).not.toMatch(/updated_at\s*=/);
    }
  });

  it('writes the expressions it is given, so a computed ordering key seeks on the same expression', () => {
    const key = 'COALESCE(receipt.purchased_at, receipt.updated_at)';
    const [sql] = keysetSeek(key, 'receipt.receipt_id', 'ASC', afterTime, afterId);

    expect(sql.split(key)).toHaveLength(5);
    expect(sql).toContain('receipt.receipt_id > :afterId');
  });
});

describe('keysetSeekExact', () => {
  // Postgres' own spelling of a timestamptz(6): what `CAST(col AS text)` prints, microseconds and all.
  const afterTime = '2026-05-01 00:00:00.123456+00';
  const afterId = '018f0000-0000-7000-8000-00000000abcd';

  it('binds the cursor as it was given: a string, so no microsecond is lost on the way in', () => {
    const [, params] = keysetSeekExact('content.created_at', 'content.id', 'DESC', afterTime, afterId);

    expect(params).toEqual({ afterTime, afterId });
    // Not a `Date`: that is milliseconds, which is the flaw this exists to avoid.
    expect(typeof params.afterTime).toBe('string');
  });

  it('seeks downwards for DESC: earlier instants, or this instant before the id', () => {
    const [sql] = keysetSeekExact('content.created_at', 'content.id', 'DESC', afterTime, afterId);

    expect(sql).toBe(
      '(content.created_at <= :afterTime AND (content.created_at < :afterTime OR ' +
        '(content.created_at = :afterTime AND content.id < :afterId)))',
    );
  });

  it('seeks upwards for ASC: later instants, or this instant past the id', () => {
    const [sql] = keysetSeekExact('content.created_at', 'content.id', 'ASC', afterTime, afterId);

    expect(sql).toBe(
      '(content.created_at >= :afterTime AND (content.created_at > :afterTime OR ' +
        '(content.created_at = :afterTime AND content.id > :afterId)))',
    );
  });

  it('leads with the redundant bound on the bare column, which is what gives the planner an index range', () => {
    for (const [order, bound] of [
      ['DESC', '<='],
      ['ASC', '>='],
    ] as const) {
      const [sql] = keysetSeekExact('content.created_at', 'content.id', order, afterTime, afterId);

      // Outside the OR, on the column itself. Taking it out leaves a seek that is still correct and
      // walks, then discards, every row newer than the cursor on every page.
      expect(sql.startsWith(`(content.created_at ${bound} :afterTime AND (`)).toBe(true);
      // Bare: nothing wrapped around the column (no cast, no date_trunc), or the index cannot be used.
      expect(sql).not.toMatch(/\w\([^)]*content\.created_at/);
    }
  });

  it('does compare the instant for equality, because the cursor is the instant and not its millisecond', () => {
    for (const order of ['ASC', 'DESC'] as const) {
      const [sql] = keysetSeekExact('content.created_at', 'content.id', order, afterTime, afterId);

      expect(sql).toContain('content.created_at = :afterTime');
    }
  });

  it('writes the expressions it is given, so a computed ordering key seeks on the same expression', () => {
    const key = 'COALESCE(receipt.purchased_at, receipt.updated_at)';
    const [sql] = keysetSeekExact(key, 'receipt.receipt_id', 'ASC', afterTime, afterId);

    expect(sql.split(key)).toHaveLength(4);
    expect(sql).toContain('receipt.receipt_id > :afterId');
  });
});

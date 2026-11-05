import { type SeekKey, multiKeySeek, seekOrder } from './multiKeySeek';

/** The people list's order: plausibility rank, trimmed name NULLS LAST, newest first, id. */
const PEOPLE: SeekKey[] = [
  { expr: 'rank', order: 'ASC' },
  { expr: 'name_key', order: 'ASC', nulls: 'LAST', nullable: true },
  { expr: 'p.created_at', order: 'DESC', read: 'CAST(p.created_at AS text)' },
  { expr: 'p.id', order: 'DESC' },
];

describe('seekOrder', () => {
  it('writes the order as given, with Postgres defaults for null placement', () => {
    expect(seekOrder(PEOPLE, false)).toEqual([
      { expr: 'rank', order: 'ASC', nulls: 'NULLS LAST' },
      { expr: 'name_key', order: 'ASC', nulls: 'NULLS LAST' },
      { expr: 'p.created_at', order: 'DESC', nulls: 'NULLS FIRST' },
      { expr: 'p.id', order: 'DESC', nulls: 'NULLS FIRST' },
    ]);
  });

  it('flips every direction and null placement for a backward page', () => {
    expect(seekOrder(PEOPLE, true)).toEqual([
      { expr: 'rank', order: 'DESC', nulls: 'NULLS FIRST' },
      { expr: 'name_key', order: 'DESC', nulls: 'NULLS FIRST' },
      { expr: 'p.created_at', order: 'ASC', nulls: 'NULLS LAST' },
      { expr: 'p.id', order: 'ASC', nulls: 'NULLS LAST' },
    ]);
  });
});

describe('multiKeySeek', () => {
  it('expands a mixed-direction order into one arm per key, forward', () => {
    const [sql, params] = multiKeySeek(PEOPLE, [0, 'bob', '2026-05-01 00:00:00.123456+00', 'id-1'], false);

    expect(sql).toBe(
      '(' +
        '(rank > :seek0) OR ' +
        '(rank = :seek0 AND (name_key > :seek1 OR name_key IS NULL)) OR ' +
        '(rank = :seek0 AND name_key IS NOT DISTINCT FROM :seek1 AND p.created_at < :seek2) OR ' +
        '(rank = :seek0 AND name_key IS NOT DISTINCT FROM :seek1 AND p.created_at = :seek2 AND p.id < :seek3)' +
        ')',
    );
    expect(params).toEqual({ seek0: 0, seek1: 'bob', seek2: '2026-05-01 00:00:00.123456+00', seek3: 'id-1' });
  });

  it('mirrors every comparison for a backward page', () => {
    const [sql] = multiKeySeek(PEOPLE, [0, 'bob', 't', 'id-1'], true);

    expect(sql).toBe(
      '(' +
        '(rank < :seek0) OR ' +
        '(rank = :seek0 AND name_key < :seek1) OR ' +
        '(rank = :seek0 AND name_key IS NOT DISTINCT FROM :seek1 AND p.created_at > :seek2) OR ' +
        '(rank = :seek0 AND name_key IS NOT DISTINCT FROM :seek1 AND p.created_at = :seek2 AND p.id > :seek3)' +
        ')',
    );
  });

  it('seeks past a NULL name by shape: only the other NULLs follow it, by the later keys', () => {
    const [sql, params] = multiKeySeek(PEOPLE, [1, null, 't', 'id-1'], false);

    expect(sql).toBe(
      '(' +
        '(rank > :seek0) OR ' +
        '(rank = :seek0 AND name_key IS NULL AND p.created_at < :seek2) OR ' +
        '(rank = :seek0 AND name_key IS NULL AND p.created_at = :seek2 AND p.id < :seek3)' +
        ')',
    );
    expect(params).toEqual({ seek0: 1, seek2: 't', seek3: 'id-1' });
  });

  it('backward from a NULL name, every named row of the rank follows (NULLs now sort first)', () => {
    const [sql] = multiKeySeek(PEOPLE, [1, null, 't', 'id-1'], true);

    expect(sql).toContain('(rank = :seek0 AND name_key IS NOT NULL) OR');
  });

  it('answers a predicate nothing matches when no row can follow the cursor', () => {
    expect(multiKeySeek([{ expr: 'n', order: 'ASC', nullable: true }], [null], false)).toEqual(['1 = 0', {}]);
  });

  it('refuses a cursor with the wrong number of values', () => {
    expect(() => multiKeySeek(PEOPLE, [0, 'bob'], false)).toThrow(/4 keys but 2/);
  });
});

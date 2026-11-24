import { decodeItemCursor, encodeItemCursor } from './itemCursor';

const ID = '550e8400-e29b-41d4-a716-446655440001';

/** What a cursor is on the wire, written by hand so the codec cannot grade its own work. */
const wire = (text: string): string => Buffer.from(text).toString('base64');

describe('encodeItemCursor / decodeItemCursor', () => {
  it('carries the instant to the microsecond, as the text it was given', () => {
    const cursor = { createdAt: '2026-05-01T00:00:00.123456Z', id: ID };

    expect(decodeItemCursor(encodeItemCursor(cursor))).toEqual(cursor);
    // Opaque to a client, trivially debuggable here.
    expect(Buffer.from(encodeItemCursor(cursor), 'base64').toString('utf-8')).toBe(
      `${cursor.createdAt}|${ID}`,
    );
  });

  it('keeps trailing zeros, which are the difference between an instant and its millisecond', () => {
    expect(decodeItemCursor(wire(`2026-05-01T00:00:00.100000Z|${ID}`))?.createdAt).toBe(
      '2026-05-01T00:00:00.100000Z',
    );
  });

  it('decodes a cursor an earlier release minted, which holds milliseconds', () => {
    // `new Date(...).toISOString()`: always three digits.
    expect(decodeItemCursor(wire(`2026-05-01T00:00:00.123Z|${ID}`))).toEqual({
      createdAt: '2026-05-01T00:00:00.123Z',
      id: ID,
    });
  });

  it('reads the new form as an ISO date to the millisecond on a server that predates it', () => {
    // The half-rolled-out deploy: the old decoder was `new Date(prefix)`, and V8 drops the digits past the third.
    expect(new Date('2026-05-01T00:00:00.123456Z').toISOString()).toBe('2026-05-01T00:00:00.123Z');
  });

  it.each([
    ['nothing', null],
    ['undefined', undefined],
    ['the empty string', ''],
    ['no separator', wire('2026-05-01T00:00:00.123456Z')],
    ['no id', wire('2026-05-01T00:00:00.123456Z|')],
    ['no time', wire(`|${ID}`)],
    ['not base64 of anything', '%%%'],
  ])('treats %s as no cursor', (_what, raw) => {
    expect(decodeItemCursor(raw)).toBeNull();
  });

  // The time is bound into the query as text. `new Date()` used to refuse the first two; Postgres
  // would refuse all of these, and a stale bookmark should show the first page, not a 500.
  it.each([
    ['a day that does not exist', '2026-02-30T00:00:00.000000Z'],
    ['a month that does not exist', '2026-13-01T00:00:00.000000Z'],
    ['the 24th hour', '2026-05-01T24:00:00.000000Z'],
    ['a leap day in a common year', '2027-02-29T00:00:00.000000Z'],
    ['year zero, which Postgres does not have', '0000-05-01T00:00:00.000000Z'],
    ['a zone offset', '2026-05-01T00:00:00.123456+05:30'],
    ['no zone', '2026-05-01T00:00:00.123456'],
    ["Postgres' own spelling", '2026-05-01 00:00:00.123456+00'],
    ['more than six fractional digits', '2026-05-01T00:00:00.1234567Z'],
    ['a trailing dot', '2026-05-01T00:00:00.Z'],
    ['leading space', ' 2026-05-01T00:00:00.123456Z'],
    ['a lower-case z', '2026-05-01T00:00:00.123456z'],
    ['words', 'yesterday'],
    ['a date with no time', '2026-05-01'],
  ])('treats %s as no cursor', (_what, createdAt) => {
    expect(decodeItemCursor(wire(`${createdAt}|${ID}`))).toBeNull();
  });

  it.each([
    ['a leap day in a leap year', '2028-02-29T12:00:00.000001Z'],
    ['a time with no fraction', '2026-05-01T00:00:00Z'],
    ['one fractional digit', '2026-05-01T00:00:00.1Z'],
    ['the last microsecond of a day', '2026-05-01T23:59:59.999999Z'],
  ])('accepts %s', (_what, createdAt) => {
    expect(decodeItemCursor(wire(`${createdAt}|${ID}`))).toEqual({ createdAt, id: ID });
  });

  it('keeps a separator in the id, as the first one splits time from id', () => {
    expect(decodeItemCursor(wire('2026-05-01T00:00:00.123456Z|a|b'))).toEqual({
      createdAt: '2026-05-01T00:00:00.123456Z',
      id: 'a|b',
    });
  });
});

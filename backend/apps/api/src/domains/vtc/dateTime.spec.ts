import { parseDateTime } from './dateTime';

describe('parseDateTime', () => {
  it.each([
    ['2026-11-05T12:00:00Z', '2026-11-05T12:00:00.000Z'],
    ['2026-11-05T12:00:00.5Z', '2026-11-05T12:00:00.500Z'],
    ['2026-11-05T12:00:00.123456789Z', '2026-11-05T12:00:00.123Z'],
    ['2026-11-05T12:00:00+02:00', '2026-11-05T10:00:00.000Z'],
    ['2026-11-05T12:00:00-08:00', '2026-11-05T20:00:00.000Z'],
    ['2028-02-29T00:00:00Z', '2028-02-29T00:00:00.000Z'],
    ['2026-12-31T23:59:59Z', '2026-12-31T23:59:59.000Z'],
    ['2000-02-29T00:00:00Z', '2000-02-29T00:00:00.000Z'],
    ['2400-02-29T00:00:00Z', '2400-02-29T00:00:00.000Z'],
    // Year 0 is a leap year; Date.UTC alone would read it as 1900, which is not.
    ['0000-02-29T00:00:00Z', '0000-02-29T00:00:00.000Z'],
  ])('reads %s', (text, iso) => {
    expect(parseDateTime(text)?.toISOString()).toBe(iso);
  });

  it.each([
    ['an impossible day that V8 would roll forward', '2026-02-30T00:00:00Z'],
    ['29 February in a common year', '2026-02-29T00:00:00Z'],
    ['29 February in a century year that is not a leap year', '2100-02-29T00:00:00Z'],
    ['30 February in a leap year', '2028-02-30T00:00:00Z'],
    ['29 February in year 1, which is not a leap year', '0001-02-29T00:00:00Z'],
    ['day 31 of a 30-day month', '2026-04-31T00:00:00Z'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['day 0', '2026-01-00T00:00:00Z'],
    ['hour 24', '2026-01-01T24:00:00Z'],
    ['second 60', '2026-01-01T00:00:60Z'],
    ['no time zone', '2026-01-01T00:00:00'],
    ['a space instead of T', '2026-01-01 00:00:00Z'],
    ['a date only', '2026-01-01'],
    ['an offset of 24 hours', '2026-01-01T00:00:00+24:00'],
    ['an offset of 60 minutes', '2026-01-01T00:00:00+01:60'],
    ['a lower-case t and z', '2026-01-01t00:00:00z'],
    ['a two-digit year', '26-01-01T00:00:00Z'],
    ['an empty fraction', '2026-01-01T00:00:00.Z'],
    ['an empty string', ''],
  ])('refuses %s', (_name, text) => {
    expect(parseDateTime(text)).toBeNull();
  });

  it.each([
    [1, 31],
    [2, 28],
    [3, 31],
    [4, 30],
    [5, 31],
    [6, 30],
    [7, 31],
    [8, 31],
    [9, 30],
    [10, 31],
    [11, 30],
    [12, 31],
  ])('month %i has %i days in a common year: the last is read and the next is refused', (month, days) => {
    const stamp = (day: number) =>
      `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00Z`;

    expect(parseDateTime(stamp(days))).not.toBeNull();
    expect(parseDateTime(stamp(days + 1))).toBeNull();
  });

  it.each([undefined, null, 0, 1_700_000_000_000, {}, [], new Date(0)])(
    'refuses the non-string %p',
    (value) => {
      expect(parseDateTime(value)).toBeNull();
    },
  );
});

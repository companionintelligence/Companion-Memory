import { findDateField, parseFlexibleDate } from '../dates';

describe('parseFlexibleDate', () => {
  it('reads ISO and locale strings, and nothing else, by default', () => {
    expect(parseFlexibleDate('2024-05-15T01:19:41Z')?.toISOString()).toBe('2024-05-15T01:19:41.000Z');
    expect(parseFlexibleDate('  2024-05-15T01:19:41Z  ')?.toISOString()).toBe('2024-05-15T01:19:41.000Z');
    expect(parseFlexibleDate('')).toBeUndefined();
    expect(parseFlexibleDate('   ')).toBeUndefined();
    expect(parseFlexibleDate('not a date')).toBeUndefined();
    expect(parseFlexibleDate(null)).toBeUndefined();
    expect(parseFlexibleDate(undefined)).toBeUndefined();
    expect(parseFlexibleDate({})).toBeUndefined();
    // A number is not a date unless the caller says how to read it.
    expect(parseFlexibleDate(1716000000)).toBeUndefined();
    expect(parseFlexibleDate('1716000000')).toBeUndefined();
  });

  it("reads epochs under 'auto': milliseconds at or above 1e12, seconds below", () => {
    expect(parseFlexibleDate(1716000000, { epoch: 'auto' })?.toISOString()).toBe('2024-05-18T02:40:00.000Z');
    expect(parseFlexibleDate(1716000000000, { epoch: 'auto' })?.toISOString()).toBe(
      '2024-05-18T02:40:00.000Z',
    );
    expect(parseFlexibleDate(1716000000.5, { epoch: 'auto' })?.toISOString()).toBe(
      '2024-05-18T02:40:00.500Z',
    );
  });

  it("reads every number as seconds under 's'", () => {
    expect(parseFlexibleDate(1716000000, { epoch: 's' })?.toISOString()).toBe('2024-05-18T02:40:00.000Z');
    // Chrome's ADD_DATE is whole seconds; a millisecond stamp would be year 56,000-odd and is still read as told.
    expect(parseFlexibleDate(1716000000000, { epoch: 's' })?.getUTCFullYear()).toBeGreaterThan(50_000);
  });

  it('never turns a zero, negative or non-finite epoch into 1970', () => {
    for (const epoch of ['auto', 's'] as const) {
      expect(parseFlexibleDate(0, { epoch })).toBeUndefined();
      expect(parseFlexibleDate(-5, { epoch })).toBeUndefined();
      expect(parseFlexibleDate(Number.NaN, { epoch })).toBeUndefined();
      expect(parseFlexibleDate(Number.POSITIVE_INFINITY, { epoch })).toBeUndefined();
    }
  });

  it('reads an all-digits string as an epoch only when asked', () => {
    expect(parseFlexibleDate('1716000000', { numericStrings: true })?.toISOString()).toBe(
      '2024-05-18T02:40:00.000Z',
    );
    expect(parseFlexibleDate('1716000000000', { numericStrings: true })?.toISOString()).toBe(
      '2024-05-18T02:40:00.000Z',
    );
    // A decimal string is not an integer epoch; the caller converts if it means one.
    expect(parseFlexibleDate('1716000000.5', { numericStrings: true })).toBeUndefined();
    expect(parseFlexibleDate('0', { numericStrings: true })).toBeUndefined();
  });

  it('pins a zone-less stamp to UTC only when asked, and leaves zoned stamps alone', () => {
    expect(parseFlexibleDate('2022-08-03 17:55:02', { naiveUtc: true })?.toISOString()).toBe(
      '2022-08-03T17:55:02.000Z',
    );
    expect(parseFlexibleDate('2022-08-03 17:55:02.250', { naiveUtc: true })?.toISOString()).toBe(
      '2022-08-03T17:55:02.250Z',
    );
    expect(parseFlexibleDate('2022-08-03T17:55:02+02:00', { naiveUtc: true })?.toISOString()).toBe(
      '2022-08-03T15:55:02.000Z',
    );
    // Without the option the same string is local time — whatever that is here — so only its validity is pinned.
    expect(parseFlexibleDate('2022-08-03 17:55:02')).toBeInstanceOf(Date);
  });
});

describe('findDateField', () => {
  const parse = (v: unknown) => parseFlexibleDate(v, { epoch: 'auto' });

  it('returns the first date-keyed value that parses, in key order', () => {
    expect(
      findDateField(
        { id: 1716000000, when: 'garbage', createdAt: 1716000000, date: '2020-01-01' },
        /date|time|created|when/i,
        parse,
      )?.toISOString(),
    ).toBe('2024-05-18T02:40:00.000Z');
  });

  it('is undefined when no date-keyed value parses', () => {
    expect(findDateField({ id: 1, when: 'garbage' }, /date|time|when/i, parse)).toBeUndefined();
    expect(findDateField({}, /date/i, parse)).toBeUndefined();
  });
});

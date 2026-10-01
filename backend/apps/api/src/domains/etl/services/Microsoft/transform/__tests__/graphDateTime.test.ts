import { graphDateTimeToInstant } from '../graphDateTime';

/**
 * Graph's `dateTimeTimeZone`: `dateTime` has NO offset, the zone is in `timeZone`
 * (https://learn.microsoft.com/en-us/graph/api/resources/datetimetimezone).
 *
 * Every expectation is a literal UTC instant, so none of this depends on the
 * zone of the machine running it — which is the point: `new Date` on an
 * offset-less string reads it in that zone, and a fixture ending `Z` hides that.
 * Run the file under another zone to see it hold:
 *
 *   TZ=America/Los_Angeles yarn workspace @ci/be-api jest graphDateTime
 */
const iso = (instant: Date | undefined) => instant?.toISOString();

describe('graphDateTimeToInstant — UTC, the zone Graph answers in unless asked otherwise', () => {
  it('reads the wall clock as the instant (the delta-query docs example, verbatim)', () => {
    expect(iso(graphDateTimeToInstant({ dateTime: '2016-12-09T20:30:00.0000000', timeZone: 'UTC' }))).toBe(
      '2016-12-09T20:30:00.000Z',
    );
  });

  it.each(['UTC', 'utc', ' UTC ', undefined])('treats a timeZone of %p as UTC', (timeZone) => {
    expect(iso(graphDateTimeToInstant({ dateTime: '2026-09-23T19:00:00.0000000', timeZone }))).toBe(
      '2026-09-23T19:00:00.000Z',
    );
  });

  it('keeps the milliseconds of the 100-nanosecond ticks Graph sends, truncating the rest', () => {
    const at = (dateTime: string) => iso(graphDateTimeToInstant({ dateTime, timeZone: 'UTC' }));

    expect(at('2026-09-23T19:00:00.5000000')).toBe('2026-09-23T19:00:00.500Z');
    expect(at('2026-09-23T19:00:00.1239999')).toBe('2026-09-23T19:00:00.123Z');
    expect(at('2026-09-23T19:00:00.5')).toBe('2026-09-23T19:00:00.500Z');
    expect(at('2026-09-23T19:00:00')).toBe('2026-09-23T19:00:00.000Z');
  });

  it('does not move a midnight, which is how Graph sends an all-day event', () => {
    expect(iso(graphDateTimeToInstant({ dateTime: '2026-09-23T00:00:00.0000000', timeZone: 'UTC' }))).toBe(
      '2026-09-23T00:00:00.000Z',
    );
  });
});

describe('graphDateTimeToInstant — a zone Graph names', () => {
  // [zone, wall clock, the instant it is]. Between them these cover both hemispheres,
  // a half-hour offset, both sides of a US and an Australian DST change, and
  // offsets either side of UTC — so no machine zone can agree with all of them.
  it.each([
    ['America/Los_Angeles', '2026-09-23T12:00:00.0000000', '2026-09-23T19:00:00.000Z'], // PDT, UTC-7
    ['America/Los_Angeles', '2026-01-15T12:00:00.0000000', '2026-01-15T20:00:00.000Z'], // PST, UTC-8
    ['America/Los_Angeles', '2026-03-08T01:30:00.0000000', '2026-03-08T09:30:00.000Z'], // PST, 30 min before spring-forward
    ['America/Los_Angeles', '2026-03-08T03:30:00.0000000', '2026-03-08T10:30:00.000Z'], // PDT, 30 min after it
    ['America/Los_Angeles', '2026-11-01T00:30:00.0000000', '2026-11-01T07:30:00.000Z'], // PDT, before fall-back
    ['America/Los_Angeles', '2026-11-01T03:30:00.0000000', '2026-11-01T11:30:00.000Z'], // PST, after it
    ['America/New_York', '2026-09-23T12:00:00.0000000', '2026-09-23T16:00:00.000Z'], // EDT, UTC-4
    ['Europe/London', '2026-09-23T12:00:00.0000000', '2026-09-23T11:00:00.000Z'], // BST, UTC+1
    ['Asia/Kolkata', '2026-09-23T12:00:00.0000000', '2026-09-23T06:30:00.000Z'], // UTC+5:30
    ['Asia/Tokyo', '2026-09-23T12:00:00.0000000', '2026-09-23T03:00:00.000Z'], // UTC+9
    ['Australia/Sydney', '2026-09-23T12:00:00.0000000', '2026-09-23T02:00:00.000Z'], // AEST, UTC+10
    ['Australia/Sydney', '2026-12-15T12:00:00.0000000', '2026-12-15T01:00:00.000Z'], // AEDT, UTC+11
    ['Pacific/Kiritimati', '2026-09-23T12:00:00.0000000', '2026-09-22T22:00:00.000Z'], // UTC+14
    ['Etc/GMT+12', '2026-09-23T12:00:00.0000000', '2026-09-24T00:00:00.000Z'], // UTC-12 (IANA's inverted sign)
  ])('reads %s %s as %s', (timeZone, dateTime, expected) => {
    expect(iso(graphDateTimeToInstant({ dateTime, timeZone }))).toBe(expected);
  });

  it('carries the milliseconds through a zone conversion', () => {
    expect(
      iso(
        graphDateTimeToInstant({ dateTime: '2026-09-23T12:00:00.2500000', timeZone: 'America/Los_Angeles' }),
      ),
    ).toBe('2026-09-23T19:00:00.250Z');
  });

  it('puts an all-day event at midnight in its own zone', () => {
    expect(
      iso(
        graphDateTimeToInstant({ dateTime: '2026-09-23T00:00:00.0000000', timeZone: 'America/Los_Angeles' }),
      ),
    ).toBe('2026-09-23T07:00:00.000Z');
  });
});

describe('graphDateTimeToInstant — a dateTime that carries its own offset', () => {
  it.each([
    ['2026-09-23T19:00:00Z', '2026-09-23T19:00:00.000Z'],
    ['2026-09-23T19:00:00z', '2026-09-23T19:00:00.000Z'],
    ['2026-09-23T19:00:00.0000000Z', '2026-09-23T19:00:00.000Z'],
    ['2026-09-23T19:00:00+02:00', '2026-09-23T17:00:00.000Z'],
    ['2026-09-23T19:00:00-07:00', '2026-09-24T02:00:00.000Z'],
  ])('reads %s as %s whatever timeZone says', (dateTime, expected) => {
    expect(iso(graphDateTimeToInstant({ dateTime, timeZone: 'Asia/Tokyo' }))).toBe(expected);
    expect(iso(graphDateTimeToInstant({ dateTime }))).toBe(expected);
  });
});

describe('graphDateTimeToInstant — a zone this runtime does not know', () => {
  // Graph accepts any Windows zone name, and a few of its documented IANA ids
  // are spelled in ways Intl rejects.
  it.each([
    'Pacific Standard Time',
    'Customized Time Zone',
    'tzone://Microsoft/Custom',
    'Asia/Toshkent (Tashkent)',
  ])('reads the wall clock of %p as UTC and says so', (timeZone) => {
    const onUnrecognizedZone = jest.fn();

    expect(
      iso(
        graphDateTimeToInstant({ dateTime: '2026-09-23T12:00:00.0000000', timeZone }, { onUnrecognizedZone }),
      ),
    ).toBe('2026-09-23T12:00:00.000Z');
    expect(onUnrecognizedZone).toHaveBeenCalledTimes(1);
    expect(onUnrecognizedZone).toHaveBeenCalledWith(timeZone);
  });

  it('does not report a zone it does know', () => {
    const onUnrecognizedZone = jest.fn();

    graphDateTimeToInstant(
      { dateTime: '2026-09-23T12:00:00.0000000', timeZone: 'America/Denver' },
      { onUnrecognizedZone },
    );
    graphDateTimeToInstant(
      { dateTime: '2026-09-23T12:00:00.0000000', timeZone: 'UTC' },
      { onUnrecognizedZone },
    );
    graphDateTimeToInstant(
      { dateTime: '2026-09-23T12:00:00Z', timeZone: 'Pacific Standard Time' },
      { onUnrecognizedZone },
    );

    expect(onUnrecognizedZone).not.toHaveBeenCalled();
  });

  it('needs no callback', () => {
    expect(
      iso(
        graphDateTimeToInstant({
          dateTime: '2026-09-23T12:00:00.0000000',
          timeZone: 'Pacific Standard Time',
        }),
      ),
    ).toBe('2026-09-23T12:00:00.000Z');
  });
});

describe('graphDateTimeToInstant — nothing to read', () => {
  it.each([undefined, null, {}, { timeZone: 'UTC' }, { dateTime: '' }, { dateTime: '   ' }])(
    'returns undefined for %p',
    (value) => {
      expect(graphDateTimeToInstant(value)).toBeUndefined();
    },
  );

  it.each([
    'next tuesday',
    '2026-09-23', // a date, not a date-time
    '2026-09-23T19:00', // no seconds
    '2026-09-23 19:00:00', // not ISO: JavaScript would read it in the local zone
    '2026-13-01T00:00:00.0000000', // no such month
    '2026-09-23T25:00:00.0000000', // no such hour
  ])('throws a RangeError for %p rather than guess', (dateTime) => {
    expect(() => graphDateTimeToInstant({ dateTime, timeZone: 'UTC' })).toThrow(RangeError);
    expect(() => graphDateTimeToInstant({ dateTime, timeZone: 'UTC' })).toThrow(/Unparseable Graph dateTime/);
  });
});

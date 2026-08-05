import {
  isValidTimezone,
  isoWeekKey,
  localDateInTZ,
  localHourInTZ,
  todayInTZ,
  utcDayBounds,
  utcToZonedWallTime,
  zonedWallTimeToUTC,
} from '../zoned';

const LA = 'America/Los_Angeles';
const NY = 'America/New_York';
const SYDNEY = 'Australia/Sydney';
const KATHMANDU = 'Asia/Kathmandu'; // UTC+05:45 — a non-hour offset
const UTC = 'UTC';

describe('zonedWallTimeToUTC', () => {
  it('maps a wall clock to the right instant in a western zone', () => {
    // 2026-01-15 is PST (UTC-8), so 09:00 local === 17:00Z.
    expect(zonedWallTimeToUTC('2026-01-15', '09:00', LA).toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  it('maps a wall clock to the right instant in an eastern zone', () => {
    // 2026-01-15 is AEDT (UTC+11), so 09:00 local === 22:00Z the previous day.
    expect(zonedWallTimeToUTC('2026-01-15', '09:00', SYDNEY).toISOString()).toBe('2026-01-14T22:00:00.000Z');
  });

  it('handles a non-hour offset', () => {
    // UTC+05:45 year-round.
    expect(zonedWallTimeToUTC('2026-01-15', '09:00', KATHMANDU).toISOString()).toBe(
      '2026-01-15T03:15:00.000Z',
    );
  });

  it('is the identity for UTC', () => {
    expect(zonedWallTimeToUTC('2026-01-15', '09:00', UTC).toISOString()).toBe('2026-01-15T09:00:00.000Z');
  });

  // The two-pass settle exists for exactly these two days. A single-pass
  // implementation gets the hour wrong on one side of each transition.
  describe('DST — spring forward', () => {
    // US: 2026-03-08, 02:00 PST -> 03:00 PDT.
    it('uses the pre-transition offset before the gap', () => {
      expect(zonedWallTimeToUTC('2026-03-08', '01:00', LA).toISOString()).toBe(
        '2026-03-08T09:00:00.000Z', // UTC-8
      );
    });

    it('uses the post-transition offset after the gap', () => {
      expect(zonedWallTimeToUTC('2026-03-08', '09:00', LA).toISOString()).toBe(
        '2026-03-08T16:00:00.000Z', // UTC-7
      );
    });

    it('resolves a wall time inside the non-existent hour without throwing', () => {
      // 02:30 never happens on this date. Any answer is a compromise; what
      // matters is that it is deterministic, is inside the transition, and does
      // not throw or silently land a day away.
      const result = zonedWallTimeToUTC('2026-03-08', '02:30', LA);

      expect(Number.isNaN(result.getTime())).toBe(false);
      expect(result.toISOString()).toBe('2026-03-08T09:30:00.000Z');
    });

    it('handles the southern-hemisphere transition too', () => {
      // Sydney: 2026-10-04, 02:00 AEST -> 03:00 AEDT.
      expect(zonedWallTimeToUTC('2026-10-03', '09:00', SYDNEY).toISOString()).toBe(
        '2026-10-02T23:00:00.000Z', // UTC+10
      );
      expect(zonedWallTimeToUTC('2026-10-05', '09:00', SYDNEY).toISOString()).toBe(
        '2026-10-04T22:00:00.000Z', // UTC+11
      );
    });
  });

  describe('DST — fall back', () => {
    // US: 2026-11-01, 02:00 PDT -> 01:00 PST.
    it('uses the pre-transition offset before the repeat', () => {
      expect(zonedWallTimeToUTC('2026-11-01', '00:30', LA).toISOString()).toBe(
        '2026-11-01T07:30:00.000Z', // UTC-7
      );
    });

    it('uses the post-transition offset after the repeat', () => {
      expect(zonedWallTimeToUTC('2026-11-01', '09:00', LA).toISOString()).toBe(
        '2026-11-01T17:00:00.000Z', // UTC-8
      );
    });

    it('resolves the ambiguous repeated hour deterministically', () => {
      // 01:30 happens twice on this date. The two-pass settle lands on the
      // FIRST (daylight, UTC-7) occurrence: both passes read an offset from an
      // instant that is still before the 09:00Z transition. Pinned here so a
      // refactor cannot silently flip which of the two hours a user gets.
      expect(zonedWallTimeToUTC('2026-11-01', '01:30', LA).toISOString()).toBe('2026-11-01T08:30:00.000Z');
    });
  });
});

describe('utcToZonedWallTime', () => {
  it('reads back the wall time it was built from', () => {
    for (const [date, time, tz] of [
      ['2026-01-15', '09:00', LA],
      ['2026-07-15', '09:00', LA],
      ['2026-01-15', '09:00', SYDNEY],
      ['2026-01-15', '09:00', KATHMANDU],
      ['2026-03-09', '09:00', LA], // day after spring forward
      ['2026-11-02', '09:00', LA], // day after fall back
    ] as const) {
      expect(utcToZonedWallTime(zonedWallTimeToUTC(date, time, tz), tz)).toBe(time);
    }
  });

  it('renders local midnight as 00:00, never 24:00', () => {
    expect(utcToZonedWallTime(zonedWallTimeToUTC('2026-01-15', '00:00', LA), LA)).toBe('00:00');
    expect(utcToZonedWallTime(zonedWallTimeToUTC('2026-01-15', '00:00', SYDNEY), SYDNEY)).toBe('00:00');
  });
});

describe('localDateInTZ', () => {
  it('returns the user-local date, not the server-local one', () => {
    // 2026-01-15T02:00Z is still the 14th in Los Angeles and already the 15th
    // in Sydney. This is the bug that makes a block land on the wrong day.
    const instant = new Date('2026-01-15T02:00:00.000Z');

    expect(localDateInTZ(instant, LA)).toBe('2026-01-14');
    expect(localDateInTZ(instant, UTC)).toBe('2026-01-15');
    expect(localDateInTZ(instant, SYDNEY)).toBe('2026-01-15');
  });

  it('is stable either side of local midnight', () => {
    // 07:59Z is 23:59 on the 14th in LA (PST); 08:00Z is 00:00 on the 15th.
    expect(localDateInTZ(new Date('2026-01-15T07:59:00.000Z'), LA)).toBe('2026-01-14');
    expect(localDateInTZ(new Date('2026-01-15T08:00:00.000Z'), LA)).toBe('2026-01-15');
  });
});

describe('localHourInTZ', () => {
  it('reports the user-local hour', () => {
    const instant = new Date('2026-01-15T17:00:00.000Z');

    expect(localHourInTZ(instant, LA)).toBe(9);
    expect(localHourInTZ(instant, UTC)).toBe(17);
    expect(localHourInTZ(instant, NY)).toBe(12);
  });

  it('reports 0 at local midnight', () => {
    expect(localHourInTZ(new Date('2026-01-15T08:00:00.000Z'), LA)).toBe(0);
  });
});

describe('utcDayBounds', () => {
  it('spans exactly 24h on an ordinary day', () => {
    const { start, end } = utcDayBounds('2026-01-15', LA);

    expect(start.toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(end.toISOString()).toBe('2026-01-16T08:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  // These two are the reason `end` is the NEXT day's local midnight rather than
  // `start + 24h`: a local day is not always 24 hours long.
  it('spans 23h on the spring-forward day', () => {
    const { start, end } = utcDayBounds('2026-03-08', LA);

    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('spans 25h on the fall-back day', () => {
    const { start, end } = utcDayBounds('2026-11-01', LA);

    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it('produces a half-open range that tiles consecutive days without gaps', () => {
    const first = utcDayBounds('2026-03-07', LA);
    const second = utcDayBounds('2026-03-08', LA);
    const third = utcDayBounds('2026-03-09', LA);

    expect(first.end.getTime()).toBe(second.start.getTime());
    expect(second.end.getTime()).toBe(third.start.getTime());
  });

  it('handles month and year rollover', () => {
    expect(utcDayBounds('2026-12-31', UTC).end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(utcDayBounds('2026-01-31', UTC).end.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('todayInTZ', () => {
  it('reads the clock in the user zone', () => {
    const now = new Date('2026-01-15T02:00:00.000Z');

    expect(todayInTZ(LA, now)).toBe('2026-01-14');
    expect(todayInTZ(SYDNEY, now)).toBe('2026-01-15');
  });
});

describe('isoWeekKey', () => {
  it('starts weeks on Monday', () => {
    // 2026-01-15 is a Thursday; its Monday is 2026-01-12.
    expect(isoWeekKey('2026-01-15')).toBe(isoWeekKey('2026-01-12'));
    // The preceding Sunday belongs to the previous week.
    expect(isoWeekKey('2026-01-11')).not.toBe(isoWeekKey('2026-01-12'));
  });

  it('applies the Thursday rule at a year boundary', () => {
    // 2026-01-01 is a Thursday, so that week belongs to 2026 as W01.
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01');
    // The Monday of that same week is in December 2025 but still 2026-W01.
    expect(isoWeekKey('2025-12-29')).toBe('2026-W01');
  });

  it('is unaffected by DST (noon-UTC pivot)', () => {
    // A week containing a DST transition must still be exactly one key for all
    // seven of its days. Spring forward falls on Sun 2026-03-08, whose ISO week
    // runs Mon 2026-03-02 .. Sun 2026-03-08.
    const springWeek = ['02', '03', '04', '05', '06', '07', '08'].map((d) => isoWeekKey(`2026-03-${d}`));

    expect(new Set(springWeek).size).toBe(1);

    // Fall back is Sun 2026-11-01; its week runs Mon 2026-10-26 .. Sun 2026-11-01.
    const fallWeek = [
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ].map(isoWeekKey);

    expect(new Set(fallWeek).size).toBe(1);

    // And the Monday after each transition starts a new week.
    expect(isoWeekKey('2026-03-09')).not.toBe(isoWeekKey('2026-03-08'));
    expect(isoWeekKey('2026-11-02')).not.toBe(isoWeekKey('2026-11-01'));
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA names', () => {
    expect(isValidTimezone(LA)).toBe(true);
    expect(isValidTimezone(UTC)).toBe(true);
  });

  it('rejects nonsense', () => {
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

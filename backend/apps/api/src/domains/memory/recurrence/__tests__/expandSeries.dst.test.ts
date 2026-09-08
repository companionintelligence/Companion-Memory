import { wallClockInTZ } from '@ci/common/time/zoned';

import { expandSeries } from '../expandSeries';
import type { RecurrenceSpec } from '../types';

const PACIFIC = 'America/Los_Angeles';
const HOUR_MS = 3_600_000;

/**
 * A spec built straight from wall-clock fields, bypassing `parseRecurrence`.
 *
 * These tests are about the ARITHMETIC — whether 09:00 stays 09:00 when the
 * offset moves under it — so they state the floating DTSTART directly rather
 * than routing a fixture row through the parser and testing two things at once.
 */
function spec(over: Partial<RecurrenceSpec> & { dtstartFloating: Date; rruleLine: string }): RecurrenceSpec {
  return {
    durationMs: 30 * 60_000,
    wholeLocalDays: null,
    timeZone: PACIFIC,
    timeZoneSource: 'series',
    exdates: [],
    rdates: [],
    isAllDay: false,
    ...over,
  };
}

const floating = (y: number, m: number, d: number, hh = 0, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm, 0));

const localTimesOf = (starts: Date[], zone = PACIFIC) =>
  starts.map((start) => {
    const wall = wallClockInTZ(start, zone);

    return `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
  });

describe('expandSeries — DST', () => {
  it('keeps a weekly 09:00 Pacific standup at 09:00 across the spring transition', () => {
    // 2027-03-14 is the US spring-forward Sunday; the Mondays either side of it
    // are 2027-03-08 and 2027-03-15.
    const { starts } = expandSeries(
      spec({ dtstartFloating: floating(2027, 3, 1, 9), rruleLine: 'FREQ=WEEKLY;BYDAY=MO' }),
      { from: new Date('2027-03-01T00:00:00Z'), to: new Date('2027-03-30T00:00:00Z') },
    );

    expect(localTimesOf(starts)).toEqual(['09:00', '09:00', '09:00', '09:00', '09:00']);

    const across = starts.filter((start) => start >= new Date('2027-03-08T00:00:00Z'));
    // 167 hours, not 168: the wall clock is what repeats weekly, and the week
    // containing the transition is an hour shorter. Adding 7*24h would move the
    // standup to 08:00 for the rest of the year.
    expect(across[1].getTime() - across[0].getTime()).toBe(167 * HOUR_MS);
  });

  it('keeps a weekly 09:00 Pacific standup at 09:00 across the autumn transition', () => {
    // 2026-11-01 is the fall-back Sunday; the Mondays either side are 10-26 and 11-02.
    const { starts } = expandSeries(
      spec({ dtstartFloating: floating(2026, 10, 19, 9), rruleLine: 'FREQ=WEEKLY;BYDAY=MO' }),
      { from: new Date('2026-10-19T00:00:00Z'), to: new Date('2026-11-16T00:00:00Z') },
    );

    expect(localTimesOf(starts)).toEqual(['09:00', '09:00', '09:00', '09:00']);

    const across = starts.filter((start) => start >= new Date('2026-10-26T00:00:00Z'));
    expect(across[1].getTime() - across[0].getTime()).toBe(169 * HOUR_MS);
  });

  it('resolves a nonexistent 02:30 to 03:30, exactly once', () => {
    const { starts } = expandSeries(
      spec({ dtstartFloating: floating(2027, 3, 12, 2, 30), rruleLine: 'FREQ=DAILY' }),
      { from: new Date('2027-03-14T00:00:00Z'), to: new Date('2027-03-15T00:00:00Z') },
    );
    const onTheDay = starts.filter(
      (start) => start >= new Date('2027-03-14T08:00:00Z') && start < new Date('2027-03-15T08:00:00Z'),
    );

    // 02:30 does not exist on 2027-03-14 in Pacific. One occurrence, shifted
    // forward past the gap — not two, and not none.
    expect(onTheDay).toHaveLength(1);
    expect(localTimesOf(onTheDay)).toEqual(['03:30']);
  });

  it('resolves an ambiguous 01:30 to the earlier offset, exactly once', () => {
    const { starts } = expandSeries(
      spec({ dtstartFloating: floating(2026, 10, 30, 1, 30), rruleLine: 'FREQ=DAILY' }),
      { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-02T00:00:00Z') },
    );
    const onTheDay = starts.filter(
      (start) => start >= new Date('2026-11-01T07:00:00Z') && start < new Date('2026-11-02T08:00:00Z'),
    );

    expect(onTheDay).toHaveLength(1);
    // 01:30 happens twice that day; the first pass is 08:30Z (still PDT).
    expect(onTheDay[0].toISOString()).toBe('2026-11-01T08:30:00.000Z');
  });

  it('preserves a 30-minute duration across a transition', () => {
    const series = spec({ dtstartFloating: floating(2027, 3, 8, 9), rruleLine: 'FREQ=WEEKLY;BYDAY=MO' });
    const { starts } = expandSeries(series, {
      from: new Date('2027-03-08T00:00:00Z'),
      to: new Date('2027-03-23T00:00:00Z'),
    });

    for (const start of starts) {
      const wall = wallClockInTZ(new Date(start.getTime() + 30 * 60_000), PACIFIC);
      expect(`${wall.hour}:${wall.minute}`).toBe('9:30');
    }
  });

  it('holds an all-day series at UTC midnight across both transitions', () => {
    // All-day rows are stored at UTC midnight by the Google transform, so the
    // expander pins them to UTC. Every occurrence must stay exactly one whole
    // day, or PlannedBlockService stops recognising PTO rows as all-day and a
    // holiday calendar blacks out the workday.
    const { starts } = expandSeries(
      spec({
        dtstartFloating: floating(2026, 10, 28),
        rruleLine: 'FREQ=DAILY',
        timeZone: 'UTC',
        timeZoneSource: 'utc-allday',
        isAllDay: true,
        durationMs: null,
        wholeLocalDays: 1,
      }),
      { from: new Date('2026-10-28T00:00:00Z'), to: new Date('2026-11-05T00:00:00Z') },
    );

    expect(starts).toHaveLength(8);

    for (const start of starts) {
      expect(start.getTime() % 86_400_000).toBe(0);
    }
  });
});

import { wallClockInTZ } from '@ci/common/time/zoned';

import { DEFAULT_LIMITS, expandSeries } from '../expandSeries';
import type { RecurrenceSpec } from '../types';

const PACIFIC = 'America/Los_Angeles';

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

const floating = (y: number, m: number, d: number, hh = 9, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm, 0));

/** Local `YYYY-MM-DD` of each occurrence, which is what a rule test is actually about. */
const localDatesOf = (starts: Date[]) =>
  starts.map((start) => {
    const wall = wallClockInTZ(start, PACIFIC);

    return `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`;
  });

describe('expandSeries — rule semantics', () => {
  it('expands a weekly series across a window', () => {
    const { starts, truncated } = expandSeries(
      spec({ dtstartFloating: floating(2026, 9, 7), rruleLine: 'FREQ=WEEKLY;BYDAY=MO' }),
      { from: new Date('2026-09-07T00:00:00Z'), to: new Date('2026-10-05T00:00:00Z') },
    );

    expect(localDatesOf(starts)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    expect(truncated).toBe(false);
  });

  it('stops a COUNT-bounded series at its last occurrence', () => {
    const { starts } = expandSeries(
      spec({ dtstartFloating: floating(2026, 9, 7), rruleLine: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' }),
      { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') },
    );

    expect(localDatesOf(starts)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
  });

  it('counts occurrences BEFORE exclusion, so an EXDATE does not extend a COUNT series', () => {
    // RFC 5545 §3.8.5.3: COUNT limits the rule's own output; EXDATE removes
    // from that output. Applying the cancellation first and then counting would
    // silently hand the user a fourth standup they never scheduled.
    const { starts } = expandSeries(
      spec({
        dtstartFloating: floating(2026, 9, 7),
        rruleLine: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
        exdates: [new Date('2026-09-14T16:00:00Z')],
      }),
      { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') },
    );

    expect(localDatesOf(starts)).toEqual(['2026-09-07', '2026-09-21']);
  });

  it('handles BYSETPOS, negative BYDAY, BYMONTHDAY=31 and WKST', () => {
    const lastThursday = expandSeries(
      spec({ dtstartFloating: floating(2026, 9, 24), rruleLine: 'FREQ=MONTHLY;BYDAY=TH;BYSETPOS=-1' }),
      { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') },
    );
    expect(localDatesOf(lastThursday.starts)).toEqual(['2026-09-24', '2026-10-29', '2026-11-26']);

    const lastFriday = expandSeries(
      spec({ dtstartFloating: floating(2026, 9, 25), rruleLine: 'FREQ=MONTHLY;BYDAY=-1FR' }),
      { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') },
    );
    expect(localDatesOf(lastFriday.starts)).toEqual(['2026-09-25', '2026-10-30', '2026-11-27']);

    // September, November and April have no 31st; those months are skipped
    // rather than rolled into the 1st of the next.
    const thirtyFirst = expandSeries(
      spec({ dtstartFloating: floating(2026, 8, 31), rruleLine: 'FREQ=MONTHLY;BYMONTHDAY=31' }),
      { from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') },
    );
    expect(localDatesOf(thirtyFirst.starts)).toEqual(['2026-08-31', '2026-10-31']);

    // WKST decides which calendar week a BYDAY belongs to, and therefore which
    // weeks a biweekly rule skips. Same rule, two week starts, different answer.
    const window = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-06T00:00:00Z') };
    const mondayStart = expandSeries(
      spec({
        dtstartFloating: floating(2026, 9, 6),
        rruleLine: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=MO',
      }),
      window,
    );
    const sundayStart = expandSeries(
      spec({
        dtstartFloating: floating(2026, 9, 6),
        rruleLine: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU',
      }),
      window,
    );
    expect(localDatesOf(mondayStart.starts)).not.toEqual(localDatesOf(sundayStart.starts));
  });

  it('converges every EXDATE spelling on the same occurrence', () => {
    // A TZID-local EXDATE and its UTC equivalent must cancel the SAME meeting;
    // a Takeout .ics writes the first spelling and the API sync writes the
    // second, and a series touched by both would otherwise keep one copy.
    const local = expandSeries(
      spec({
        dtstartFloating: floating(2026, 9, 7),
        rruleLine: 'FREQ=WEEKLY;BYDAY=MO',
        exdates: [new Date('2026-09-14T16:00:00Z')],
      }),
      { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') },
    );

    expect(localDatesOf(local.starts)).toEqual(['2026-09-07', '2026-09-21', '2026-09-28']);
  });

  it('adds an RDATE that the rule itself would never produce', () => {
    const { starts } = expandSeries(
      spec({
        dtstartFloating: floating(2026, 9, 7),
        rruleLine: 'FREQ=WEEKLY;BYDAY=MO',
        rdates: [new Date('2026-09-16T16:00:00Z')],
      }),
      { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-25T00:00:00Z') },
    );

    expect(localDatesOf(starts)).toEqual(['2026-09-07', '2026-09-14', '2026-09-16', '2026-09-21']);
  });

  it('does not double an RDATE that merely restates a rule occurrence', () => {
    const { starts } = expandSeries(
      spec({
        dtstartFloating: floating(2026, 9, 7),
        rruleLine: 'FREQ=WEEKLY;BYDAY=MO',
        rdates: [new Date('2026-09-14T16:00:00Z')],
      }),
      { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-25T00:00:00Z') },
    );

    expect(localDatesOf(starts)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);
  });
});

describe('expandSeries — bounds', () => {
  it('bounds an unbounded series by the window, not by the rule', () => {
    // No COUNT, no UNTIL: infinite by construction. The window is what stops it.
    const { starts, truncated } = expandSeries(
      spec({ dtstartFloating: floating(2015, 1, 1), rruleLine: 'FREQ=DAILY' }),
      { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-12-02T00:00:00Z') },
    );

    expect(starts).toHaveLength(92);
    expect(truncated).toBe(false);
  });

  it('caps one series at maxOccurrencesPerSeries', () => {
    const { starts, truncated, limit } = expandSeries(
      spec({ dtstartFloating: floating(2026, 9, 1), rruleLine: 'FREQ=HOURLY' }),
      { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') },
      { maxOccurrencesPerSeries: 10 },
    );

    expect(starts).toHaveLength(10);
    expect(truncated).toBe(true);
    expect(limit).toBe('maxOccurrencesPerSeries');
  });

  it('gives up on an unsatisfiable rule instead of walking to year 9999', () => {
    // 30 February never happens. rrule only checks UNTIL and the caller's
    // callback on dates it PRODUCES, so a rule producing nothing is bounded by
    // nothing but its year-9999 backstop — measured at 4.7 seconds for
    // FREQ=DAILY, synchronously, on the calendar read path.
    const started = Date.now();
    const { starts, truncated } = expandSeries(
      spec({ dtstartFloating: floating(2026, 1, 1), rruleLine: 'FREQ=DAILY;BYMONTHDAY=30;BYMONTH=2' }),
      { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') },
    );

    expect(starts).toEqual([]);
    expect(truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('reaches a window a decade after DTSTART without exhausting the iteration cap', () => {
    const { starts, truncated } = expandSeries(
      spec({ dtstartFloating: floating(2015, 1, 1), rruleLine: 'FREQ=DAILY' }),
      { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-12-02T00:00:00Z') },
    );

    expect(starts).toHaveLength(92);
    expect(truncated).toBe(false);
    // ~4,300 generated dates to walk from 2015 to the window — comfortably
    // inside the cap, which is what makes the cap a backstop and not a bug.
    expect(DEFAULT_LIMITS.maxIterations).toBeGreaterThan(4_300);
  });
});

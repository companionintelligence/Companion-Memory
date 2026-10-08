import { RRule } from 'rrule';

import { wallClockToUTC } from '@ci/common/time/zoned';

import { DEFAULT_LIMITS, expandSeries } from '../expandSeries';
import type { ExpansionWindow, RecurrenceSpec } from '../types';

const PACIFIC = 'America/Los_Angeles';
const WINDOW_PAD_MS = 26 * 3_600_000;

function spec(dtstartFloating: Date, rruleLine: string): RecurrenceSpec {
  return {
    dtstartFloating,
    durationMs: 30 * 60_000,
    wholeLocalDays: null,
    timeZone: PACIFIC,
    timeZoneSource: 'series',
    rruleLine,
    exdates: [],
    rdates: [],
    isAllDay: false,
  };
}

const floating = (y: number, m: number, d: number, hh = 9) => new Date(Date.UTC(y, m - 1, d, hh, 0, 0));

function elapsedMs(run: () => unknown): number {
  const started = process.hrtime.bigint();
  run();

  return Number(process.hrtime.bigint() - started) / 1e6;
}

/**
 * The expansion with no period budget at all: rrule's own `between`, then the
 * same floating-to-real conversion and window test `expandSeries` applies. Only
 * used for rules that produce dates, which `between` stops on by itself.
 */
function referenceStarts(s: RecurrenceSpec, window: ExpansionWindow): number[] {
  const toFloating = (instant: Date) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: s.timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(instant);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);

    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  };

  const rule = new RRule({ ...RRule.parseString(s.rruleLine), dtstart: s.dtstartFloating });
  const dates = rule.between(
    new Date(toFloating(window.from) - WINDOW_PAD_MS),
    new Date(toFloating(window.to) + WINDOW_PAD_MS),
    true,
  );

  return dates
    .map((d) =>
      wallClockToUTC(
        {
          year: d.getUTCFullYear(),
          month: d.getUTCMonth() + 1,
          day: d.getUTCDate(),
          hour: d.getUTCHours(),
          minute: d.getUTCMinutes(),
          second: d.getUTCSeconds(),
        },
        s.timeZone,
      ).getTime(),
    )
    .filter((start) => start < window.to.getTime() && start + (s.durationMs ?? 0) >= window.from.getTime())
    .sort((a, b) => a - b);
}

const AUTUMN = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') };

describe('expandSeries — walks that produce nothing', () => {
  it('stops a rule whose filters never hold at the window, not at year 9999', () => {
    // Not caught by the BYMONTH/BYMONTHDAY pre-check: day 200 is never in January.
    let result: ReturnType<typeof expandSeries> | undefined;
    const ms = elapsedMs(() => {
      result = expandSeries(spec(floating(2026, 1, 1), 'FREQ=DAILY;BYMONTH=1;BYYEARDAY=200'), AUTUMN);
    });

    expect(result).toEqual({ starts: [], truncated: false, limit: undefined });
    // About 5 s per series before; a year of daily periods is a few
    // milliseconds. The bound is loose so a loaded machine cannot flake it.
    expect(ms).toBeLessThan(2_000);
  });

  it('caps the walk for a series that starts centuries before the window', () => {
    // Reaching the window from 1700 is 120,000 daily periods, and the walk to
    // year 9999 without any bound took about a minute. The ceiling stops it
    // first and says so; a small one keeps the test quick.
    let result: ReturnType<typeof expandSeries> | undefined;
    const ms = elapsedMs(() => {
      result = expandSeries(spec(floating(1700, 1, 1), 'FREQ=DAILY;BYMONTH=1;BYYEARDAY=200'), AUTUMN, {
        maxPeriods: 2_000,
      });
    });

    expect(result).toEqual({ starts: [], truncated: true, limit: 'maxPeriods' });
    expect(ms).toBeLessThan(3_000);
  });

  it.each([
    ['an hourly BYHOUR the start hour never reaches', 'FREQ=HOURLY;INTERVAL=24;BYHOUR=5'],
    ['an hour that does not exist', 'FREQ=HOURLY;BYHOUR=24'],
    ['a negative INTERVAL', 'FREQ=DAILY;INTERVAL=-1'],
    ['a sub-hourly step', 'FREQ=MINUTELY;BYHOUR=24'],
  ])('returns at once for %s, which rrule would never return from', (_label, rule) => {
    let result: ReturnType<typeof expandSeries> | undefined;
    const ms = elapsedMs(() => {
      result = expandSeries(spec(floating(2026, 9, 1), rule), AUTUMN);
    });

    expect(result).toEqual({ starts: [], truncated: true, limit: 'maxPeriods' });
    // rrule would never return from any of these; returning at all is the test.
    expect(ms).toBeLessThan(1_000);
  });
});

describe('expandSeries — the period budget never cuts an ordinary series short', () => {
  const rules = [
    'FREQ=DAILY',
    'FREQ=DAILY;INTERVAL=3',
    'FREQ=WEEKLY;BYDAY=MO,WE,FR',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;WKST=SU',
    'FREQ=WEEKLY;INTERVAL=5;BYDAY=SU',
    'FREQ=MONTHLY;BYDAY=-1FR',
    'FREQ=MONTHLY;BYMONTHDAY=31',
    'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
    'FREQ=MONTHLY;INTERVAL=13;BYMONTHDAY=15',
    'FREQ=YEARLY',
    'FREQ=YEARLY;INTERVAL=4',
    'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
    // One date every four years from a daily walk: the sparsest shape the
    // window bound has to get right.
    'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29',
    // UNTIL with COUNT. Across the starts below each one ends on COUNT for
    // some and on UNTIL for others, and the leap-day one's third and last
    // date is 29 February 2028, inside a window, from the 2020 start.
    'FREQ=DAILY;UNTIL=20261115;COUNT=4000',
    'FREQ=WEEKLY;BYDAY=TU,TH;COUNT=600;UNTIL=20280301T000000',
    'FREQ=MONTHLY;BYMONTHDAY=31;UNTIL=20280215T000000;COUNT=40',
    'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;COUNT=3;UNTIL=20400101',
  ];
  const starts = [
    floating(2015, 3, 4),
    floating(2020, 2, 29),
    floating(2026, 8, 30, 23),
    floating(2027, 1, 1),
  ];
  const windows: ExpansionWindow[] = [
    AUTUMN,
    { from: new Date('2026-11-30T00:00:00Z'), to: new Date('2026-12-07T00:00:00Z') },
    { from: new Date('2028-02-01T00:00:00Z'), to: new Date('2028-03-15T00:00:00Z') },
    { from: new Date('2026-12-31T20:00:00Z'), to: new Date('2027-01-01T20:00:00Z') },
  ];

  it('expands every rule, start and window exactly as rrule does unbudgeted', () => {
    for (const rule of rules) {
      for (const dtstart of starts) {
        for (const window of windows) {
          const s = spec(dtstart, rule);
          const result = expandSeries(s, window);

          expect({
            rule,
            dtstart,
            window,
            starts: result.starts.map((d) => d.getTime()),
            truncated: result.truncated,
          }).toEqual({
            rule,
            dtstart,
            window,
            starts: referenceStarts(s, window),
            truncated: false,
          });
        }
      }
    }
  });

  it('expands an hourly series inside a week the same way', () => {
    const week = { from: new Date('2026-09-14T00:00:00Z'), to: new Date('2026-09-21T00:00:00Z') };

    for (const rule of [
      'FREQ=HOURLY;INTERVAL=7',
      'FREQ=HOURLY;BYHOUR=9,17',
      'FREQ=HOURLY;INTERVAL=5;BYHOUR=1,9',
    ]) {
      const s = spec(floating(2026, 9, 1), rule);

      expect({ rule, starts: expandSeries(s, week).starts.map((d) => d.getTime()) }).toEqual({
        rule,
        starts: referenceStarts(s, week),
      });
    }
  });

  it('keeps the period ceiling at the iteration ceiling', () => {
    expect(DEFAULT_LIMITS.maxPeriods).toBe(DEFAULT_LIMITS.maxIterations);
  });
});

describe('expandSeries — UNTIL with COUNT ends at whichever comes first', () => {
  // A Monday 09:00 standup in Los Angeles from 28 September 2026. Its Mondays
  // are 16:00Z until the clocks change on 1 November.
  const MONDAYS = [
    '2026-09-28T16:00:00.000Z',
    '2026-10-05T16:00:00.000Z',
    '2026-10-12T16:00:00.000Z',
    '2026-10-19T16:00:00.000Z',
  ];

  it.each([
    ['UNTIL ends it, written first', 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T235959;COUNT=10', MONDAYS],
    ['UNTIL ends it, written last', 'FREQ=WEEKLY;BYDAY=MO;COUNT=10;UNTIL=20261019T235959', MONDAYS],
    [
      'COUNT ends it, written first',
      'FREQ=WEEKLY;BYDAY=MO;COUNT=3;UNTIL=20261231T235959',
      MONDAYS.slice(0, 3),
    ],
    [
      'COUNT ends it, written last',
      'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231T235959;COUNT=3',
      MONDAYS.slice(0, 3),
    ],
  ])('%s, exactly as rrule does unbudgeted', (_label, rule, expected) => {
    const s = spec(floating(2026, 9, 28), rule);
    const result = expandSeries(s, AUTUMN);

    expect(result.starts.map((d) => d.toISOString())).toEqual(expected);
    expect(result.starts.map((d) => d.getTime())).toEqual(referenceStarts(s, AUTUMN));
    expect(result.truncated).toBe(false);
  });

  it('counts the dates before the window toward COUNT', () => {
    // Ten Mondays from 7 September: the last two are 2 and 9 November (17:00Z
    // once the clocks have changed), so a November window holds only those
    // two, however far UNTIL reaches.
    const s = spec(floating(2026, 9, 7), 'FREQ=WEEKLY;BYDAY=MO;COUNT=10;UNTIL=20271231T235959');
    const november = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') };

    expect(expandSeries(s, november).starts.map((d) => d.toISOString())).toEqual([
      '2026-11-02T17:00:00.000Z',
      '2026-11-09T17:00:00.000Z',
    ]);
    expect(expandSeries(s, november).starts.map((d) => d.getTime())).toEqual(referenceStarts(s, november));
  });

  it('stops a rule that never produces a date at the window, whatever UNTIL and COUNT say', () => {
    // Neither part is ever consulted: rrule checks both only on a date it
    // produces, and this rule produces none. Unbounded, it walks to year 9999.
    let result: ReturnType<typeof expandSeries> | undefined;
    const ms = elapsedMs(() => {
      result = expandSeries(
        spec(floating(2026, 1, 1), 'FREQ=DAILY;BYMONTH=1;BYYEARDAY=200;COUNT=5;UNTIL=99991231'),
        AUTUMN,
      );
    });

    expect(result).toEqual({ starts: [], truncated: false, limit: undefined });
    expect(ms).toBeLessThan(2_000);
  });

  it('holds such a rule to the default period ceiling when the window is out of reach', () => {
    // From 1700 the window is about 119,000 daily periods away, past the
    // 50,000-period ceiling, so the ceiling stops it and says so.
    let result: ReturnType<typeof expandSeries> | undefined;
    const ms = elapsedMs(() => {
      result = expandSeries(
        spec(floating(1700, 1, 1), 'FREQ=DAILY;BYMONTH=1;BYYEARDAY=200;UNTIL=99991231;COUNT=999999999'),
        AUTUMN,
      );
    });

    expect(DEFAULT_LIMITS.maxPeriods).toBe(50_000);
    expect(result).toEqual({ starts: [], truncated: true, limit: 'maxPeriods' });
    expect(ms).toBeLessThan(5_000);
  });

  it('holds a rule that produces a date every period to the iteration ceiling', () => {
    // The largest COUNT the rule check accepts and the last UNTIL rrule
    // parses: neither ends this walk before 50,000 dates do.
    let result: ReturnType<typeof expandSeries> | undefined;
    const ms = elapsedMs(() => {
      result = expandSeries(spec(floating(1700, 1, 1), 'FREQ=DAILY;COUNT=999999999;UNTIL=99991231'), AUTUMN);
    });

    expect(result).toEqual({ starts: [], truncated: true, limit: 'maxIterations' });
    expect(ms).toBeLessThan(5_000);
  });

  it('refuses an hourly BYHOUR the start hour never reaches, UNTIL and COUNT or not', () => {
    const ms = elapsedMs(() => {
      expect(
        expandSeries(
          spec(floating(2026, 9, 1), 'FREQ=HOURLY;INTERVAL=24;BYHOUR=5;COUNT=3;UNTIL=20261231'),
          AUTUMN,
        ),
      ).toEqual({ starts: [], truncated: true, limit: 'maxPeriods' });
    });

    expect(ms).toBeLessThan(1_000);
  });
});

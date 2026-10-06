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

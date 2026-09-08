import { RRule, type Options as RRuleOptions } from 'rrule';

import { wallClockInTZ, wallClockToUTC } from '@ci/common/time/zoned';

import type { ExpansionLimits, ExpansionWindow, RecurrenceSpec } from './types';

export const DEFAULT_LIMITS: ExpansionLimits = {
  maxOccurrencesPerSeries: 512,
  maxIterations: 50_000,
  maxTotalOccurrences: 1000,
};

/**
 * How far outside the real window the FLOATING search runs.
 *
 * The window is a pair of instants; the rule is walked in wall clocks. Mapping
 * one to the other is off by the zone's offset, which is up to 14 hours and
 * changes under the window's own feet at a DST boundary. 26 hours covers both
 * with room to spare, and the precise `[from, to)` overlap test below is what
 * actually decides membership — the pad only has to be generous.
 */
const WINDOW_PAD_MS = 26 * 3_600_000;

/** Longest each month can be, so an impossible BYMONTH/BYMONTHDAY pair is visible without iterating. */
const LONGEST_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface SeriesExpansion {
  /** Real instants, window-filtered, EXDATE-cancelled, RDATE-added, ascending. */
  starts: Date[];
  truncated: boolean;
  /** Which ceiling stopped it, when one did. */
  limit?: keyof ExpansionLimits;
}

/** The instant a wall clock in the floating domain actually happens at. */
function realInstantOf(floating: Date, zone: string): Date {
  return wallClockToUTC(
    {
      year: floating.getUTCFullYear(),
      month: floating.getUTCMonth() + 1,
      day: floating.getUTCDate(),
      hour: floating.getUTCHours(),
      minute: floating.getUTCMinutes(),
      second: floating.getUTCSeconds(),
    },
    zone,
  );
}

/** An instant's wall clock in the series zone, as the fake-UTC epoch ms the rule is walked in. */
function floatingMsOf(instant: Date, zone: string): number {
  const wall = wallClockInTZ(instant, zone);

  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/**
 * When one occurrence ends — null for a series whose master has no `end_time`.
 *
 * Exported because the window filter here and the {@link OccurrenceSpec} built
 * by expandAll must agree to the millisecond; two copies of this arithmetic
 * would drift the moment one of them learned about DST and the other did not.
 */
export function occurrenceEnd(spec: RecurrenceSpec, start: Date): Date | null {
  if (spec.wholeLocalDays !== null) {
    const wall = wallClockInTZ(start, spec.timeZone);

    return wallClockToUTC({ ...wall, day: wall.day + spec.wholeLocalDays }, spec.timeZone);
  }

  return spec.durationMs === null ? null : new Date(start.getTime() + spec.durationMs);
}

/**
 * True when the rule's own BYMONTH/BYMONTHDAY pair can never both hold.
 *
 * This is a guard against a measured denial of service, not a tidiness check.
 * rrule only tests `UNTIL` (and the caller's callback) on dates it actually
 * PRODUCES, so a rule that produces nothing — `FREQ=DAILY;BYMONTHDAY=30;
 * BYMONTH=2` is the canonical one — is stopped by nothing but the library's
 * year-9999 backstop. Measured on this box: 4.7 seconds for one such series,
 * synchronously, on the calendar read path. `FREQ=MONTHLY` costs 200ms.
 *
 * Rules that produce dates need no static check: the iteration cap below sees
 * every one of them.
 */
function neverMatches(options: {
  bymonth?: number[] | null;
  bymonthday?: number[] | null;
  bynmonthday?: number[] | null;
}): boolean {
  const months = options.bymonth ?? [];
  const monthDays = options.bymonthday ?? [];
  const negativeMonthDays = options.bynmonthday ?? [];

  if (months.length === 0 || (monthDays.length === 0 && negativeMonthDays.length === 0)) {
    return false;
  }

  const longest = Math.max(...months.map((month) => LONGEST_MONTH_DAYS[month - 1] ?? 31));

  return !monthDays.some((day) => day <= longest) && !negativeMonthDays.some((day) => -day <= longest);
}

/**
 * Every occurrence of one series overlapping `window`.
 *
 * The rule is walked entirely in the series' own wall clock — rrule is never
 * given a `tzid` and never sees a real instant — because that is the only way
 * "every Monday at 09:00" stays 09:00 across a DST transition. Adding 7×24h
 * instead moves the standup to 08:00 for half the year.
 *
 * `all()` rather than `between()`: `between` only invokes the callback for
 * dates already inside the range, so a series anchored in 2015 would burn
 * thousands of iterations before this function got a say. With `all()` the
 * iteration cap sees every generated date and can stop the walk itself.
 */
export function expandSeries(
  spec: RecurrenceSpec,
  window: ExpansionWindow,
  limits: Partial<ExpansionLimits> = {},
): SeriesExpansion {
  const caps = { ...DEFAULT_LIMITS, ...limits };
  let rule: RRule;

  try {
    const options: Partial<RRuleOptions> = {
      ...RRule.parseString(spec.rruleLine),
      dtstart: spec.dtstartFloating,
    };

    rule = new RRule(options);
  } catch {
    // A rule this appliance cannot parse is not a reason to fail the whole
    // calendar read; the series simply shows its master row and nothing else.
    return { starts: [], truncated: false };
  }

  if (neverMatches(rule.options)) {
    return { starts: [], truncated: true, limit: 'maxIterations' };
  }

  const floatingFrom = floatingMsOf(window.from, spec.timeZone) - WINDOW_PAD_MS;
  const floatingTo = floatingMsOf(window.to, spec.timeZone) + WINDOW_PAD_MS;
  const floating: Date[] = [];
  let truncated = false;
  let limit: keyof ExpansionLimits | undefined;

  rule.all((date, index) => {
    if (index >= caps.maxIterations) {
      truncated = true;
      limit = 'maxIterations';

      return false;
    }

    const at = date.getTime();

    if (at > floatingTo) {
      return false;
    }

    if (at >= floatingFrom) {
      if (floating.length >= caps.maxOccurrencesPerSeries) {
        truncated = true;
        limit = 'maxOccurrencesPerSeries';

        return false;
      }

      floating.push(date);
    }

    return true;
  });

  // Keyed by instant so an RDATE that merely restates a rule occurrence does not
  // double it, and so EXDATE cancels by the one spelling every TZID converges on.
  const instants = new Map<number, Date>();

  for (const date of floating) {
    const real = realInstantOf(date, spec.timeZone);
    instants.set(real.getTime(), real);
  }

  for (const rdate of spec.rdates) {
    instants.set(rdate.getTime(), rdate);
  }

  for (const exdate of spec.exdates) {
    instants.delete(exdate.getTime());
  }

  const starts = [...instants.values()]
    .filter((start) => {
      const end = occurrenceEnd(spec, start);

      // Interval overlap, matching findInRange's own predicate exactly: an
      // occurrence that began before the window and runs into it belongs on the
      // calendar, and an open-ended one counts as an instant at its start.
      return start.getTime() < window.to.getTime() && (end ?? start).getTime() >= window.from.getTime();
    })
    .sort((left, right) => left.getTime() - right.getTime());

  return { starts, truncated, limit };
}

import { RRule, type Options as RRuleOptions } from 'rrule';

import { wallClockInTZ, wallClockToUTC } from '@ci/common/time/zoned';

import { hourlyRuleCanAdvance } from './ruleChecks';
import type { ExpansionLimits, ExpansionWindow, RecurrenceSpec } from './types';

export const DEFAULT_LIMITS: ExpansionLimits = {
  maxOccurrencesPerSeries: 512,
  maxIterations: 50_000,
  // The same ceiling as maxIterations: a rule that produces nothing may walk no
  // further than one that produces a date every period was already allowed to.
  maxPeriods: 50_000,
  maxTotalOccurrences: 1000,
};

/** rrule's parsed options; the package does not export the type by name. */
type ParsedOptions = RRule['options'];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The least a single period moves rrule's counter forward, per FREQ, at
 * INTERVAL=1. A year is at least 365 days, a month at least 28, a week's step
 * at least 7 days after the first (which can be shorter, hence the slack in
 * {@link periodsToPass}), a day exactly one, and an hourly step at least an hour.
 */
const MIN_PERIOD_MS: Record<number, number> = {
  [RRule.YEARLY]: 365 * DAY_MS,
  [RRule.MONTHLY]: 28 * DAY_MS,
  [RRule.WEEKLY]: 7 * DAY_MS,
  [RRule.DAILY]: DAY_MS,
  [RRule.HOURLY]: HOUR_MS,
};

/**
 * Periods after which rrule's counter is certainly past `floatingTo`, so every
 * date the rule can put at or before it has already been produced. The `+ 3`
 * covers the period DTSTART falls in (a year or month starts before DTSTART, a
 * first week can be short) and the one `floatingTo` falls in.
 */
function periodsToPass(options: ParsedOptions, floatingTo: number): number {
  const span = Math.max(0, floatingTo - options.dtstart.getTime());

  return Math.ceil(span / (MIN_PERIOD_MS[options.freq] * options.interval)) + 3;
}

class PeriodBudgetSpent extends Error {}

/**
 * Make rrule stop after `periods` periods even when it produces no dates.
 *
 * rrule checks `UNTIL`, `COUNT` and the caller's callback only on dates it
 * produces, and offers no hook per period. What it does do is read
 * `options.interval` on every period: rrule 2.8.1's `iter()` reads it once on
 * entry, then twice per period (the zero-interval check after the period's
 * dates, and `DateTime.add` stepping the counter). A getter that counts those
 * reads and throws once they pass the budget ends the walk from inside. The
 * tests pin this against the installed rrule: a rule that produces nothing must
 * come back fast, and every ordinary rule must expand exactly as before.
 */
function limitPeriods(options: ParsedOptions, periods: number): void {
  const interval = options.interval;
  const allowedReads = 1 + 2 * periods;
  let reads = 0;

  Object.defineProperty(options, 'interval', {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;

      if (reads > allowedReads) {
        throw new PeriodBudgetSpent();
      }

      return interval;
    },
  });
}

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

  // Shapes rrule never returns from, re-checked on its own parsed options so
  // that no caller can reach the walk with one: a step that does not move the
  // counter forward, a sub-hourly step (refused upstream by parseRecurrence),
  // and an hourly step that never lands on a BYHOUR hour. See ruleChecks.ts.
  const { freq, interval, byhour } = rule.options;

  if (
    !Number.isInteger(interval) ||
    interval < 1 ||
    freq > RRule.HOURLY ||
    (freq === RRule.HOURLY &&
      byhour !== null &&
      byhour.length > 0 &&
      !hourlyRuleCanAdvance(interval, byhour, spec.dtstartFloating.getUTCHours()))
  ) {
    return { starts: [], truncated: true, limit: 'maxPeriods' };
  }

  const floatingFrom = floatingMsOf(window.from, spec.timeZone) - WINDOW_PAD_MS;
  const floatingTo = floatingMsOf(window.to, spec.timeZone) + WINDOW_PAD_MS;
  const floating: Date[] = [];
  let truncated = false;
  let limit: keyof ExpansionLimits | undefined;

  // Bound the walk by the window, not only by produced dates. When the window
  // is the nearer bound, stopping there loses nothing: every in-window date has
  // been produced by then. Only the absolute ceiling makes a result partial.
  const windowPeriods = periodsToPass(rule.options, floatingTo);
  const periods = Math.min(windowPeriods, caps.maxPeriods);

  limitPeriods(rule.options, periods);

  try {
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
  } catch (error) {
    if (!(error instanceof PeriodBudgetSpent)) {
      throw error;
    }

    // Spent on the window bound: complete, nothing was cut off.
    if (windowPeriods > caps.maxPeriods) {
      truncated = true;
      limit = 'maxPeriods';
    }
  }

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

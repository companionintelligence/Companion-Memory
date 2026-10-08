/**
 * Which RRULEs this appliance is willing to store and to expand.
 *
 * rrule (2.8.1) checks `UNTIL`, `COUNT` and the caller's callback only on dates
 * it PRODUCES, so a rule that never produces one is stopped by nothing the
 * caller controls. Three shapes never produce one:
 *
 *  - `FREQ=HOURLY` with a `BYHOUR` the start hour can never step onto (`24`,
 *    `-1`, or `INTERVAL=24;BYHOUR=5` from a 09:00 start). rrule's hour step is a
 *    bare `for (;;)` waiting for an hour in `BYHOUR`: a synchronous infinite loop
 *    on the API's event loop.
 *  - A zero or negative `INTERVAL`. rrule walks backwards and its only stop is a
 *    year ABOVE 9999, so that is an infinite loop too.
 *  - Filters that can never all hold (`BYMONTH=1;BYYEARDAY=200`). Those do end,
 *    at year 9999, after seconds; `expandSeries` bounds that walk.
 *
 * Everything here is RFC 5545 section 3.3.10 plus the two loop guards, read off
 * the rule text before rrule ever sees it, with one rule relaxed: `UNTIL` and
 * `COUNT` may appear together (see {@link checkRecurrenceRule}). Rule parts rrule
 * accepts but RFC 5545 does not (`BYEASTER`, and `DTSTART`/`TZID` inside the
 * rule) are refused: they change how the walk runs, and no source this appliance
 * syncs writes them.
 */

/** The largest `INTERVAL` accepted. Larger steps are harmless to the walk but meaningless on a calendar. */
export const MAX_RULE_INTERVAL = 1_000;

const FREQUENCIES = new Set(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const WEEKDAYS = new Set(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

/** `[min, max, signed]` for each numeric list part: a signed part takes ±min..max and never 0. */
const NUMERIC_LISTS: Record<string, [number, number, boolean]> = {
  BYSECOND: [0, 60, false],
  BYMINUTE: [0, 59, false],
  BYHOUR: [0, 23, false],
  BYMONTH: [1, 12, false],
  BYMONTHDAY: [1, 31, true],
  BYYEARDAY: [1, 366, true],
  BYWEEKNO: [1, 53, true],
  BYSETPOS: [1, 366, true],
};

const RULE_PARTS = new Set([
  'FREQ',
  'UNTIL',
  'COUNT',
  'INTERVAL',
  'BYDAY',
  'WKST',
  ...Object.keys(NUMERIC_LISTS),
]);

export type RuleCheck =
  { ok: true; freq: string; interval: number; byhour: number[] | null } | { ok: false; reason: string };

function numberList(name: string, value: string): number[] | string {
  const [min, max, signed] = NUMERIC_LISTS[name];
  const pattern = signed ? /^[+-]?\d{1,3}$/ : /^\d{1,2}$/;
  const out: number[] = [];

  for (const item of value.split(',')) {
    const n = Number(item);
    const magnitude = Math.abs(n);

    if (
      !pattern.test(item) ||
      magnitude < min ||
      magnitude > max ||
      (signed && n === 0) ||
      (!signed && n < 0)
    ) {
      return `${name} value "${item}" is outside ${signed ? `±${min}..${max}` : `${min}..${max}`}`;
    }

    out.push(n);
  }

  return out;
}

/**
 * Whether the rule text (the RRULE value, `RRULE:` prefix optional) is well
 * formed and inside RFC 5545's ranges. An hourly rule's `BYHOUR` also depends on
 * the hour it starts from, which this text does not say; callers check that
 * with {@link hourlyRuleCanAdvance}.
 */
export function checkRecurrenceRule(ruleText: string): RuleCheck {
  const text = ruleText.trim().replace(/^RRULE:/i, '');
  const seen = new Map<string, string>();

  for (const part of text.split(';')) {
    const eq = part.indexOf('=');

    if (eq <= 0 || eq === part.length - 1 || part.indexOf('=', eq + 1) !== -1) {
      return { ok: false, reason: `malformed rule part "${part}"` };
    }

    const name = part.slice(0, eq).toUpperCase();

    if (!RULE_PARTS.has(name)) {
      return { ok: false, reason: `unsupported rule part ${name}` };
    }

    if (seen.has(name)) {
      return { ok: false, reason: `${name} appears more than once` };
    }

    seen.set(name, part.slice(eq + 1));
  }

  const freq = seen.get('FREQ')?.toUpperCase();

  if (!freq || !FREQUENCIES.has(freq)) {
    return { ok: false, reason: freq ? `unknown FREQ ${freq}` : 'no FREQ' };
  }

  // RFC 5545 forbids UNTIL and COUNT in one rule, but calendars do write both,
  // and rrule ends such a series at whichever comes first. It checks both on
  // each date it produces, in the same loop as either one alone, so the pair
  // adds no walk of its own: expandSeries' window and period bounds still stop
  // it. Each part is still checked on its own below.
  const until = seen.get('UNTIL');

  if (until !== undefined && !/^\d{8}(T\d{6}Z?)?$/i.test(until)) {
    return { ok: false, reason: `UNTIL "${until}" is not a DATE or DATE-TIME` };
  }

  const count = seen.get('COUNT');

  if (count !== undefined && (!/^\d{1,9}$/.test(count) || Number(count) < 1)) {
    return { ok: false, reason: `COUNT "${count}" is not a positive integer` };
  }

  const intervalText = seen.get('INTERVAL') ?? '1';
  const interval = Number(intervalText);

  if (!/^\d{1,9}$/.test(intervalText) || interval < 1 || interval > MAX_RULE_INTERVAL) {
    return { ok: false, reason: `INTERVAL "${intervalText}" is outside 1..${MAX_RULE_INTERVAL}` };
  }

  let byhour: number[] | null = null;

  for (const name of Object.keys(NUMERIC_LISTS)) {
    const value = seen.get(name);

    if (value === undefined) {
      continue;
    }

    const parsed = numberList(name, value);

    if (typeof parsed === 'string') {
      return { ok: false, reason: parsed };
    }

    if (name === 'BYHOUR') {
      byhour = parsed;
    }
  }

  const byday = seen.get('BYDAY');

  if (byday !== undefined) {
    for (const item of byday.split(',')) {
      const match = /^([+-]?\d{1,2})?([A-Z]{2})$/i.exec(item);
      const ordinal = match?.[1] ? Math.abs(Number(match[1])) : null;

      if (
        !match ||
        !WEEKDAYS.has(match[2].toUpperCase()) ||
        ordinal === 0 ||
        (ordinal !== null && ordinal > 53)
      ) {
        return { ok: false, reason: `BYDAY value "${item}" is not a weekday with an optional ±1..53` };
      }
    }
  }

  const wkst = seen.get('WKST');

  if (wkst !== undefined && !WEEKDAYS.has(wkst.toUpperCase())) {
    return { ok: false, reason: `WKST "${wkst}" is not a weekday` };
  }

  return { ok: true, freq, interval, byhour };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Whether rrule's hourly step can ever land on an hour in `byhour`.
 *
 * Each step adds `interval` hours mod 24, so from `startHour` it visits exactly
 * the hours congruent to it modulo gcd(interval, 24), and nothing else ever. A
 * `null` start hour asks the zone-independent question instead: is some hour in
 * `byhour` reachable from EVERY start hour? That is what a rule must satisfy to
 * be stored, because the zone it is walked in (and so its start hour) can change
 * after it is stored: the owner moves, or the series' zone is set later.
 */
export function hourlyRuleCanAdvance(
  interval: number,
  byhour: readonly number[],
  startHour: number | null,
): boolean {
  const step = gcd(interval % 24 || 24, 24);
  const hours = byhour.filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);

  if (startHour === null) {
    // Every residue class modulo `step` must hold some hour, or a start hour in
    // the missing class never stops stepping.
    const classes = new Set(hours.map((hour) => hour % step));

    return hours.length > 0 && classes.size === step;
  }

  return hours.some((hour) => (((hour - startHour) % step) + step) % step === 0);
}

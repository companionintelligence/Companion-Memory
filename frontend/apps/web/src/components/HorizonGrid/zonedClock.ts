/**
 * ═══ ONE CLOCK FOR THE SCHEDULE SURFACE: THE PROFILE ZONE ═══
 *
 * The schedule surface draws in the OWNER'S PROFILE ZONE (`ci.users.timezone`),
 * not in the browser's. That is the single source of truth every function in
 * HorizonGrid resolves a day boundary or a wall-clock minute against, and it is
 * the same zone the backend places planned blocks in — `PlanningTimeService`
 * resolves it and `common/time/zoned.ts` does the arithmetic there.
 *
 * ═══ WHAT THIS USED TO DO ═══
 * Every helper read the clock with `Date#getHours()` / `setHours()`, which is
 * the BROWSER's zone. The placer books 09:00 in the profile zone; a browser
 * eight hours west drew that chip at 01:00 and the owner concluded the planner
 * was broken. The data was right and only the rendering was wrong — the hardest
 * kind of bug to report, because nothing on screen is inconsistent with itself.
 *
 * The two directions are not symmetric, so they get different machinery:
 *
 *  - READING an instant (which day is this, what minute of it) is a formatting
 *    question — `Intl.DateTimeFormat` with `timeZone` answers it exactly.
 *  - WRITING a wall time (the user dropped a chip at 15:00 on Thursday) has no
 *    single answer across a DST transition, so it uses the same two-pass
 *    algorithm as the backend's `zonedWallTimeToUTC`: guess with the offset at
 *    the naive instant, then re-read the offset at that guess and settle.
 *
 * Nothing here has a default zone — a day boundary with no zone named is the
 * bug. The geometry helpers that wrap these take a trailing `zone` argument
 * defaulting to the browser's, so a caller outside the schedule surface with no
 * profile zone to offer keeps exactly the reading it had.
 */

import { detectBrowserTimeZone } from '@/lib/timezone';

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Cached, because the grid asks for ~2000 readings per render (96 rhythm slots
 * × 7 days, twice each for the two-pass write) and constructing an
 * `Intl.DateTimeFormat` is the expensive half of that by an order of magnitude.
 *
 * A reader, not a label: nobody sees this output, `zonedParts` turns it back
 * into numbers. So it is pinned to a 0–23 hour whatever the person's time
 * format — `hourCycle: 'h23'` rather than `hour12: false`, which some engines
 * resolve to the 1–24 cycle (hence the "24" guard in `zonedParts`, kept for
 * engines older than the option). The labels the grid shows go through
 * `useDateTimeFormat()` instead.
 */
function formatter(zone: string): Intl.DateTimeFormat {
  let cached = formatters.get(zone);

  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, cached);
  }

  return cached;
}

/** The calendar fields an instant shows on a clock in `zone`. */
export function zonedParts(instant: Date, zone: string): ZonedParts {
  const read: Record<string, number> = {};

  for (const part of formatter(zone).formatToParts(instant)) {
    if (part.type !== 'literal') {
      read[part.type] = Number(part.value);
    }
  }

  return {
    year: read.year,
    month: read.month,
    day: read.day,
    // Some engines render local midnight as hour "24".
    hour: read.hour === 24 ? 0 : read.hour,
    minute: read.minute,
    second: read.second,
  };
}

/** Milliseconds the zone is ahead of UTC at an instant (local = utc + offset). */
function offsetMsAt(utcMs: number, zone: string): number {
  const p = zonedParts(new Date(utcMs), zone);

  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

/**
 * The UTC instant a wall clock in `zone` reads as.
 *
 * Month/day/hour overflow the way `Date.UTC` does, so `day + 1` on the 31st and
 * `hour = 24` both mean what they look like they mean — the callers below rely
 * on that rather than doing their own calendar arithmetic.
 */
export function zonedWallTimeToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstGuess = naive - offsetMsAt(naive, zone);

  return new Date(naive - offsetMsAt(firstGuess, zone));
}

/** `YYYY-MM-DD` an instant falls on in `zone`. Sorts and compares as a date. */
export function zonedDayKey(instant: Date, zone: string): string {
  const p = zonedParts(instant, zone);

  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Minutes since local midnight — where a chip sits down the day column. */
export function zonedMinutesOfDay(instant: Date, zone: string): number {
  const p = zonedParts(instant, zone);

  return p.hour * 60 + p.minute;
}

/** Day of the month in `zone` — the number a day header shows. */
export function zonedDayOfMonth(instant: Date, zone: string): number {
  return zonedParts(instant, zone).day;
}

/**
 * The instant `minutes` of WALL CLOCK into the day `dayStart` falls on.
 *
 * Deliberately not `dayStart.getTime() + minutes * 60_000`: chips are positioned
 * by wall clock, so on a DST transition day absolute-millisecond arithmetic
 * disagrees with what the user is looking at — on a 23-hour day the visual noon
 * guide would book 13:00 and the right-hand end of the row would land on the
 * following date.
 */
export function instantAtDayMinutes(dayStart: Date, minutes: number, zone: string): Date {
  const whole = Math.floor(minutes);
  const p = zonedParts(dayStart, zone);
  const at = zonedWallTimeToInstant(p.year, p.month, p.day, Math.floor(whole / 60), whole % 60, 0, zone);

  // The sub-minute remainder is a fraction of a pointer position rather than a
  // crossing, so adding it as elapsed time cannot straddle a transition.
  return new Date(at.getTime() + Math.round((minutes - whole) * 60_000));
}

/** Local midnight of the day an instant falls on, as a UTC instant. */
export function zonedStartOfDay(instant: Date, zone: string): Date {
  return instantAtDayMinutes(instant, 0, zone);
}

/** Same instant `days` calendar days later in `zone` — 23- and 25-hour days included. */
export function zonedAddDays(instant: Date, days: number, zone: string): Date {
  const p = zonedParts(instant, zone);
  const moved = zonedWallTimeToInstant(p.year, p.month, p.day + days, p.hour, p.minute, p.second, zone);
  // `zonedParts` has no millisecond field, so carry the sub-second remainder
  // across by hand rather than silently truncating a caller's instant.
  const millis = ((instant.getTime() % 1000) + 1000) % 1000;

  return new Date(moved.getTime() + millis);
}

/** True when two instants land on the same calendar date in `zone`. */
export function zonedSameDay(a: Date, b: Date, zone: string): boolean {
  return zonedDayKey(a, zone) === zonedDayKey(b, zone);
}

/**
 * The zone the surface should draw in.
 *
 * A profile zone the platform's Intl database does not recognise would make
 * every reading above throw, taking the whole grid down over a bad string in a
 * settings row — so an unusable one falls back to the browser zone exactly like
 * an absent one.
 */
export function resolveTimeZone(profileZone: string | null | undefined): string {
  if (profileZone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: profileZone });

      return profileZone;
    } catch {
      // fall through to the browser zone
    }
  }

  return detectBrowserTimeZone();
}

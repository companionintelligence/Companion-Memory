/**
 * Timezone helpers that map wall-clock times in an IANA zone to UTC instants,
 * using the platform Intl database (no external dependency, no Temporal).
 *
 * Ported from CI-Planning's `server/src/lib/tz.ts`. Two deliberate changes:
 *
 *  1. Instants are `Date`, not ISO strings. CI-Planning stored timestamps as
 *     TEXT and compared them as strings; `ci` columns are `timestamptz`, which
 *     TypeORM hydrates as `Date`. Any helper still string-matching a timestamp
 *     would silently stop firing.
 *  2. `sqliteUtcToISO` is gone. It existed solely to repair SQLite's zone-less
 *     `CURRENT_TIMESTAMP` spelling; against Postgres it would be a no-op that
 *     hides a real bug.
 *
 * Everything here is pure — no DB, no clock except where a function's whole job
 * is to read the clock. `PlanningTimeService` is the shell that resolves a
 * user's zone and delegates.
 *
 * Scheduling preferences ("work 09:00–18:00") are *local wall-clock* times, so
 * turning one into a concrete instant needs the user's zone. Doing it with a
 * naive `${date}T${time}Z` pins the workday to UTC — wrong everywhere but
 * London in winter (a 09:00 start lands at 02:00 for a US/Pacific user).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let cached = formatters.get(tz);

  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, cached);
  }

  return cached;
}

/** Milliseconds the zone is ahead of UTC at a given instant (local = utc + offset). */
function offsetMsAt(utcMs: number, tz: string): number {
  const parts = formatter(tz).formatToParts(new Date(utcMs));
  const p: Record<string, number> = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      p[part.type] = Number(part.value);
    }
  }

  // Some engines render local midnight as hour "24".
  if (p.hour === 24) {
    p.hour = 0;
  }

  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);

  return asIfUTC - utcMs;
}

/** True when `tz` is a zone name this platform's Intl database recognises. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });

    return true;
  } catch {
    return false;
  }
}

/** The server process's IANA zone (honours the TZ env var), falling back to UTC. */
export function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * The UTC instant for a wall-clock `HH:MM` on calendar `date` (`YYYY-MM-DD`) in
 * `tz`. Two-pass, so it stays correct across DST transitions: the first guess
 * uses the offset at the naive instant, the second re-reads the offset at that
 * guess and settles.
 */
export function zonedWallTimeToUTC(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  // Wall clock treated as if it were UTC.
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const firstGuess = naive - offsetMsAt(naive, tz);
  const utc = naive - offsetMsAt(firstGuess, tz);

  return new Date(utc);
}

/** The digit fields of one wall clock — what an IANA zone's clock reads at some instant. */
export interface WallClock {
  year: number;
  /** 1-12, NOT the 0-based month `Date` uses. */
  month: number;
  day: number;
  /** 0-23. */
  hour: number;
  minute: number;
  second: number;
}

/**
 * The wall clock an instant reads as in `tz`, to the second.
 *
 * {@link utcToZonedWallTime} answers `HH:MM` and throws the date away, which is
 * enough for a workday boundary but not for recurrence expansion: an RRULE is
 * walked over whole local DATES, and a 23:30-local series sits on a different
 * local day than its UTC instant does. The seconds matter too — a RECURRENCE-ID
 * is a `YYYYMMDDTHHMMSS` stamp, and truncating it would key two overrides the
 * same.
 */
export function wallClockInTZ(instant: Date, tz: string): WallClock {
  const parts = formatter(tz).formatToParts(instant);
  const field: Record<string, number> = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      field[part.type] = Number(part.value);
    }
  }

  return {
    year: field.year,
    month: field.month,
    day: field.day,
    // Some engines render local midnight as hour "24".
    hour: field.hour === 24 ? 0 : field.hour,
    minute: field.minute,
    second: field.second,
  };
}

/**
 * The UTC instant at which `tz`'s wall clock reads `w`.
 *
 * The seconds-capable sibling of {@link zonedWallTimeToUTC}, which takes
 * `HH:MM` strings and so cannot express a RECURRENCE-ID.
 *
 * It is also explicit about the two DST edges every weekly series walks into
 * twice a year, where {@link zonedWallTimeToUTC}'s fixed two passes settle on
 * whichever offset the second probe happened to land in:
 *
 *  - **Ambiguous** (the local hour repeats, autumn): the FIRST pass wins —
 *    01:30 on a fall-back day is the one still on summer time. Every calendar
 *    client resolves it that way, and picking the second pass would move a
 *    standing 01:30 meeting an hour later on exactly one day a year.
 *  - **Nonexistent** (the local hour is skipped, spring): the clock shifts
 *    FORWARD by the gap — a daily 02:30 series lands at 03:30 that day. The
 *    alternative is 01:30, which reads as the series jumping *backwards*, and
 *    the alternative to both is dropping the day entirely.
 *
 * Neither case has a "correct" answer in RFC 5545; what matters is that the
 * series keeps exactly one occurrence that day and nobody has to explain a
 * missing standup.
 */
export function wallClockToUTC(w: WallClock, tz: string): Date {
  // Wall clock treated as if it were UTC.
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const offsetA = offsetMsAt(naive, tz);
  const candidateA = naive - offsetA;

  // Self-consistent: the zone really is at `offsetA` when its clock reads `w`.
  if (offsetMsAt(candidateA, tz) === offsetA) {
    return new Date(candidateA);
  }

  const offsetB = offsetMsAt(candidateA, tz);
  const candidateB = naive - offsetB;

  if (offsetMsAt(candidateB, tz) === offsetB) {
    return new Date(candidateB);
  }

  // Neither offset reproduces itself, so no instant in this zone reads `w`:
  // the wall clock falls in a spring-forward gap. The SMALLER offset yields the
  // LATER instant, which is the forward shift described above.
  return new Date(naive - Math.min(offsetA, offsetB));
}

/**
 * The wall-clock `HH:MM` of a UTC instant in `tz`.
 *
 * Used to read a recurring block template's time-of-day so each materialized
 * instance lands at the same local wall time on its own day (re-applied via
 * {@link zonedWallTimeToUTC}, which is DST-correct).
 */
export function utcToZonedWallTime(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const p: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      p[part.type] = part.value;
    }
  }

  // Some engines render midnight as hour "24".
  const hh = p.hour === '24' ? '00' : p.hour;

  return `${hh}:${p.minute}`;
}

/**
 * The local calendar date (`YYYY-MM-DD`) of a UTC instant in `tz`.
 *
 * Required so a block's start instant maps to the right `scheduled_for` for a
 * user whose zone differs from the server's — including near local midnight and
 * across DST.
 */
export function localDateInTZ(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const p: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      p[part.type] = part.value;
    }
  }

  return `${p.year}-${p.month}-${p.day}`;
}

/** The local hour (0–23) of a UTC instant in `tz`. Used by the owner-local job enqueuer. */
export function localHourInTZ(instant: Date, tz: string): number {
  return Number(utcToZonedWallTime(instant, tz).slice(0, 2));
}

/**
 * Today's calendar date (`YYYY-MM-DD`) in `tz`.
 *
 * Every day-boundary rule in planning means the USER's day, not the server's:
 * `scheduled_for` is user-local, habits roll over at the user's midnight, and
 * the nightly jobs are described in the user's terms. Anchoring any of that on
 * the server zone mis-windows the day for a user elsewhere — and the deployed
 * shape is a UTC container with a non-UTC user, so that is the DEFAULT
 * configuration, not an exotic one.
 */
export function todayInTZ(tz: string, now: Date = new Date()): string {
  return localDateInTZ(now, tz);
}

/**
 * ISO-8601 week key — `YYYY-Www` — for a local calendar date (`YYYY-MM-DD`).
 *
 * Monday-start, Thursday rule: a week belongs to the year containing its
 * Thursday. Uses a noon-UTC pivot so the arithmetic is DST-safe.
 */
export function isoWeekKey(dateStr: string): string {
  const addDays = (d: string, n: number): string => {
    const dt = new Date(`${d}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + n);

    return dt.toISOString().slice(0, 10);
  };

  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  const thursday = addDays(dateStr, dow === 0 ? -3 : 4 - dow);
  const year = Number(thursday.slice(0, 4));
  const jan4 = `${year}-01-04`;
  const jan4Dow = new Date(`${jan4}T12:00:00Z`).getUTCDay();
  const week1Monday = addDays(jan4, -(jan4Dow === 0 ? 6 : jan4Dow - 1));
  const monday = addDays(dateStr, -(dow === 0 ? 6 : dow - 1));
  const days = Math.round(
    (new Date(`${monday}T12:00:00Z`).getTime() - new Date(`${week1Monday}T12:00:00Z`).getTime()) / 86_400_000,
  );

  return `${year}-W${String(Math.floor(days / 7) + 1).padStart(2, '0')}`;
}

/**
 * `[start, end)` UTC bounds of the local calendar day `date` in `tz`.
 *
 * `end` is the NEXT day's local midnight, not `start + 24h` — on a DST
 * transition the local day is 23 or 25 hours long.
 */
export function utcDayBounds(date: string, tz: string): { start: Date; end: Date } {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);

  return {
    start: zonedWallTimeToUTC(date, '00:00', tz),
    end: zonedWallTimeToUTC(next, '00:00', tz),
  };
}

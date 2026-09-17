import { isValidTimezone, wallClockInTZ, wallClockToUTC, type WallClock } from '@ci/common/time/zoned';

import { FEDERATED_SYSTEMS } from '../identity/registry';

import type { ExpansionDiagnostic, RecurrenceSpec } from './types';

const DAY_MS = 86_400_000;

/**
 * The columns an expandable series is read through — structural, so both the
 * TypeORM entity and the composed egress `Event` satisfy it. Declared here
 * rather than imported so this file (and its tests) need no Nest, no TypeORM
 * and no database.
 */
export interface RecurringSeriesRow {
  id: string;
  startTime: Date;
  endTime: Date | null;
  isAllDay: boolean;
  metadata: Record<string, unknown> | null;
  recurrencePattern: Record<string, unknown> | null;
  sourceSystem: string | null;
  sourceId: string | null;
}

/** The RRULE plus its companion date lists, as stored — still raw ICS text. */
export interface SeriesRuleLines {
  rrule: string;
  exdate: string[];
  rdate: string[];
}

/** `EXDATE;TZID=America/Los_Angeles` -> `EXDATE`. */
function propertyOf(line: string): string {
  const colon = line.indexOf(':');
  const head = colon === -1 ? line : line.slice(0, colon);
  const semi = head.indexOf(';');

  return (semi === -1 ? head : head.slice(0, semi)).trim().toUpperCase();
}

function valueOf(line: string): string {
  const colon = line.indexOf(':');

  return colon === -1 ? line.trim() : line.slice(colon + 1).trim();
}

function paramOf(line: string, name: string): string | null {
  const colon = line.indexOf(':');
  const head = colon === -1 ? line : line.slice(0, colon);
  const match = head.match(new RegExp(`;${name}=([^;:]+)`, 'i'));

  return match ? match[1] : null;
}

function asLines(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.split(/\r?\n/);
  }

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .flatMap((entry) => entry.split(/\r?\n/));
  }

  return [];
}

/**
 * The rule text for a series, from wherever this row happens to carry it.
 *
 * `metadata.recurrenceRule` is read FIRST because it is the only place the data
 * actually is today: `TransformGoogleCalendar` writes `rawEvent.recurrence`
 * there verbatim (RRULE + EXDATE + RDATE) and explicitly does NOT write
 * `recurrence_pattern`. Gating on that column instead would make every read
 * below a no-op against every row in the database — the same silent
 * nothing-happened this whole module exists to end.
 *
 * `recurrence_pattern.rrule` is the second leg, for producers that fill the
 * column (and for the .ics import lane once it carries the rule text through).
 */
export function seriesRuleOf(row: RecurringSeriesRow): SeriesRuleLines | null {
  const pattern = row.recurrencePattern ?? {};
  const lines = [
    ...asLines(row.metadata?.recurrenceRule),
    ...asLines(pattern.rrule),
    ...asLines(pattern.exdate),
    ...asLines(pattern.rdate),
  ]
    .map((line) => line.trim())
    .filter(Boolean);

  let rrule: string | null = null;
  const exdate: string[] = [];
  const rdate: string[] = [];

  for (const line of lines) {
    const property = propertyOf(line);

    if (property === 'EXDATE') {
      exdate.push(line);
    } else if (property === 'RDATE') {
      rdate.push(line);
    } else if (property === 'RRULE') {
      // More than one RRULE per component was removed in RFC 5545 and no
      // producer here emits it; the first wins rather than the last so the
      // choice is at least deterministic.
      rrule ??= valueOf(line);
    } else if (rrule === null && /(^|;)FREQ=/i.test(line)) {
      // A bare rule value, which is how `recurrence_pattern.rrule` is spelled.
      rrule = line;
    }
  }

  return rrule ? { rrule, exdate, rdate } : null;
}

/**
 * One ICS date value to a real instant.
 *
 * The three spellings RFC 5545 allows must land on the same millisecond or
 * EXDATE stops cancelling anything: `20260914T160000Z` (UTC), `20260914T090000`
 * with a `TZID` parameter, and `20260914` for a DATE-valued list. A floating
 * value with no TZID is read in the series' own zone, which is the only zone
 * the producer could have meant.
 */
function icsValueToInstant(value: string, zone: string): Date | null {
  const stamp = value.trim();
  const utc = stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);

  if (utc) {
    return new Date(
      Date.UTC(
        Number(utc[1]),
        Number(utc[2]) - 1,
        Number(utc[3]),
        Number(utc[4]),
        Number(utc[5]),
        Number(utc[6]),
      ),
    );
  }

  const local = stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);

  if (local) {
    return wallClockToUTC(
      {
        year: Number(local[1]),
        month: Number(local[2]),
        day: Number(local[3]),
        hour: Number(local[4]),
        minute: Number(local[5]),
        second: Number(local[6]),
      },
      zone,
    );
  }

  const dateOnly = stamp.match(/^(\d{4})(\d{2})(\d{2})$/);

  if (dateOnly) {
    return wallClockToUTC(
      {
        year: Number(dateOnly[1]),
        month: Number(dateOnly[2]),
        day: Number(dateOnly[3]),
        hour: 0,
        minute: 0,
        second: 0,
      },
      zone,
    );
  }

  return null;
}

/** Every instant named by a set of EXDATE / RDATE lines, TZID parameters honoured. */
function instantsOf(lines: string[], seriesZone: string): Date[] {
  const out: Date[] = [];

  for (const line of lines) {
    const tzid = paramOf(line, 'TZID');
    const zone = tzid && isValidTimezone(tzid) ? tzid : seriesZone;

    for (const value of valueOf(line).split(',')) {
      const instant = icsValueToInstant(value, zone);

      if (instant) {
        out.push(instant);
      }
    }
  }

  return out;
}

/**
 * Rewrite a UTC `UNTIL` into the series' own wall clock.
 *
 * This is the single most-missed RRULE bug and it is invisible until someone
 * notices a series stopping on the wrong day: `UNTIL` is an absolute instant
 * (`20261101T060000Z`), but the rule is walked in a FLOATING domain where every
 * date is a wall clock wearing a fake `Z`. Left alone, rrule compares the two
 * directly and the series ends off by the zone's whole offset — seven hours,
 * i.e. up to a full extra or missing occurrence at the tail.
 *
 * An `UNTIL` with no `Z` is already floating (rrule parses it as fake UTC, the
 * same domain), so it is left exactly as written.
 */
function floatUntil(rule: string, zone: string): string {
  return rule.replace(/UNTIL=(\d{8}T\d{6})Z/i, (whole, stamp: string) => {
    const instant = icsValueToInstant(`${stamp}Z`, zone);

    if (!instant) {
      return whole;
    }

    const wall = wallClockInTZ(instant, zone);
    const pad = (value: number, width = 2) => String(value).padStart(width, '0');

    return `UNTIL=${pad(wall.year, 4)}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}${pad(wall.second)}`;
  });
}

/** A wall clock rendered as the fake-UTC `Date` the floating domain is made of. */
function floatingDateOf(wall: WallClock): Date {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second));
}

function zoneStringOf(source: unknown): string | null {
  return typeof source === 'string' && isValidTimezone(source) ? source : null;
}

export interface ParseRecurrenceOptions {
  /** Zone to expand in when the series names none — resolved from `ci.users.timezone`. */
  fallbackTimeZone: string;
  /** Where {@link fallbackTimeZone} came from, so the occurrence can say so. */
  fallbackTimeZoneSource?: 'user' | 'server';
  onDiagnostic?: (diagnostic: ExpansionDiagnostic) => void;
}

/**
 * A stored series master reduced to an expandable {@link RecurrenceSpec}, or
 * null when this row must not be expanded.
 *
 * Three refusals, each preventing a specific double-booking:
 *
 *  1. **Not a federated `calendar` identity.** Occurrences are suppressed by
 *     computing the `source_id` a real override WOULD carry (`<uid>#<instant>`)
 *     and looking for it. A row keyed under a platform system
 *     (`platformIdentity('google_calendar', …)`, which is the UID-less
 *     fallback) has no UID to build that key from, so every occurrence the user
 *     ever edited or deleted individually would come back — weekly, forever.
 *  2. **No parseable RRULE.** `is_recurring` alone is NOT the gate:
 *     `TransformGoogleCalendar` sets it for single-occurrence OVERRIDES too
 *     (`!!event.recurringEventId`), and `TransformOutlookCalendar` sets it from
 *     `seriesMasterId` on instances Microsoft already expanded server-side.
 *     Expanding either double-books the same hour.
 *  3. **Sub-daily frequency.** `SECONDLY`/`MINUTELY` are legal RFC 5545 and
 *     produce up to 86,400 occurrences per day; nothing this appliance ingests
 *     writes one, and the cap would be hit by a single series.
 */
export function parseRecurrence(
  row: RecurringSeriesRow,
  opts: ParseRecurrenceOptions,
): RecurrenceSpec | null {
  const diagnose = opts.onDiagnostic ?? (() => {});

  if (row.sourceSystem !== FEDERATED_SYSTEMS.calendar || !row.sourceId?.trim()) {
    diagnose({ kind: 'unfederated-identity', seriesId: row.id });

    return null;
  }

  const lines = seriesRuleOf(row);

  if (!lines) {
    return null;
  }

  const freq = lines.rrule.match(/(?:^|;)FREQ=([A-Z]+)/i)?.[1]?.toUpperCase();

  if (!freq) {
    diagnose({ kind: 'unparseable', seriesId: row.id, reason: 'no FREQ' });

    return null;
  }

  if (freq === 'SECONDLY' || freq === 'MINUTELY') {
    diagnose({ kind: 'sub-daily-rejected', seriesId: row.id, freq });

    return null;
  }

  // All-day series are pinned to UTC, not to the owner's zone, because that is
  // how they are STORED: `TransformGoogleCalendar` runs Google's bare
  // `start.date` through `new Date('2026-09-08')`, i.e. UTC midnight for
  // everyone. Expanding them in a user zone would move every occurrence off
  // midnight, and `PlannedBlockService.spansWholeLocalDays` — whose UTC-midnight
  // leg is what catches PTO and holiday rows — would stop recognising them. A
  // holiday calendar would then black out the workday.
  const seriesZone = zoneStringOf(row.metadata?.recurrenceTimeZone);
  const patternZone = zoneStringOf(row.recurrencePattern?.timeZone);
  const [timeZone, timeZoneSource]: [string, RecurrenceSpec['timeZoneSource']] = row.isAllDay
    ? ['UTC', 'utc-allday']
    : seriesZone
      ? [seriesZone, 'series']
      : patternZone
        ? [patternZone, 'pattern']
        : [opts.fallbackTimeZone, opts.fallbackTimeZoneSource ?? 'user'];

  const spanMs = row.endTime ? row.endTime.getTime() - row.startTime.getTime() : null;
  // A span of whole days is re-derived from the local calendar each occurrence
  // instead of being added as milliseconds: a local day is 23 or 25 hours twice
  // a year, and a fixed 86,400,000 would slide an all-day event off midnight
  // (and a multi-day trip off its last local day) on exactly those days.
  const wholeLocalDays =
    spanMs !== null && spanMs >= DAY_MS && spanMs % DAY_MS === 0 ? Math.round(spanMs / DAY_MS) : null;

  return {
    dtstartFloating: floatingDateOf(wallClockInTZ(row.startTime, timeZone)),
    durationMs: wholeLocalDays === null ? spanMs : null,
    wholeLocalDays,
    timeZone,
    timeZoneSource,
    rruleLine: floatUntil(lines.rrule, timeZone),
    exdates: instantsOf(lines.exdate, timeZone),
    rdates: instantsOf(lines.rdate, timeZone),
    isAllDay: row.isAllDay,
  };
}

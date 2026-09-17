import { FEDERATED_SYSTEMS } from './registry';
import { asSourceId, asSourceSystem, type SourceIdentity } from './types';

/**
 * The `calendar` federated kind: RFC 5545 events keyed on iCalUID, globally
 * unique by the standard — the same invite converges whether it arrived via
 * the Google Calendar API, the Graph API, or a Takeout/exported .ics file.
 *
 * Recurring-series overrides repeat the master's UID and are distinguished
 * only by RECURRENCE-ID (RFC 5545 §3.8.4.4), so the id is
 * `<uid>#<recurrence-id>` for an override and the bare UID for the master —
 * the exact format the ICS importer already established (datasources/
 * calendar.ts), which this module now owns.
 */

/**
 * The digit fields of one `Intl` render of an instant in some zone, as a UTC
 * millisecond value — the probe half of {@link utcInstantOfZonedTime}.
 */
function zonedWallClockOf(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);

  return Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
}

/**
 * The UTC instant at which a wall clock in `timeZone` reads the given local
 * fields. Guess-and-correct through `Intl` (twice, for the DST edge where the
 * first correction lands in the other offset); no timezone library needed —
 * the runtime's own IANA data answers.
 */
function utcInstantOfZonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = wanted;

  for (let i = 0; i < 2; i += 1) {
    instant += wanted - zonedWallClockOf(instant, timeZone);
  }

  return new Date(instant);
}

/**
 * Normalize a raw ICS RECURRENCE-ID value to the canonical suffix spelling —
 * UTC basic (`YYYYMMDDTHHMMSSZ`) — so an override imported from a Takeout
 * .ics converges with the API-synced copy of the same override.
 *
 * Takeout writes RECURRENCE-ID in local time with a TZID parameter
 * (`RECURRENCE-ID;TZID=America/Los_Angeles:20221006T010000`) while the ETL
 * derives the UTC instant (`20221006T080000Z`); left unnormalized, the same
 * override carried two identities — the design doc's §3.5 caveat, measured at
 * 42 duplicate rows on a real Takeout + connection run.
 *
 * Left as-is (each a deliberate non-guess):
 *  - already-UTC values (nothing to do),
 *  - date-only values (all-day overrides — the ETL spells those `YYYYMMDD` too),
 *  - floating local times with NO TZID (RFC 5545 floating time has no zone to
 *    convert through; inventing one could collide two genuinely different
 *    overrides),
 *  - values whose TZID the runtime does not recognize (a custom VTIMEZONE id —
 *    a non-converging local id beats a wrongly-converted one).
 */
export function normalizeIcsRecurrenceId(raw: string, tzid?: string | null): string {
  const value = raw.trim();
  const local = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);

  if (!local || !tzid) {
    return value;
  }

  try {
    const instant = utcInstantOfZonedTime(
      Number(local[1]),
      Number(local[2]),
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6]),
      tzid,
    );

    return icsRecurrenceInstant(instant);
  } catch {
    return value; // unknown TZID — keep the local spelling rather than guess
  }
}

/**
 * Format an override's original-start instant as an ICS UTC-basic timestamp
 * (`YYYYMMDDTHHMMSSZ`) — the RECURRENCE-ID spelling for a UTC DATE-TIME, used
 * to key API-side instances the way the .ics side keys them. Cross-format
 * caveat (design doc §3.5): the .ics side converges by funneling TZID-local
 * values through {@link normalizeIcsRecurrenceId}; only a floating local time
 * or an unrecognized TZID still spells the same instant differently.
 */
export function icsRecurrenceInstant(originalStart: Date): string {
  return originalStart
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

/**
 * Identity for one calendar event. `recurrenceId` is the raw RECURRENCE-ID
 * value from an .ics, or {@link icsRecurrenceInstant} of the API instance's
 * originalStartTime; omit it for series masters and non-recurring events.
 * Returns null when the UID is missing — callers fall back to a
 * platform-scoped id of their own pipeline's stable material, never an
 * ad-hoc string in the `calendar` namespace.
 */
export function calendarEventIdentity(
  icalUid: string | null | undefined,
  recurrenceId?: string | null,
): SourceIdentity | null {
  const uid = icalUid?.trim();
  if (!uid) {
    return null;
  }

  const suffix = recurrenceId?.trim();

  return {
    system: asSourceSystem(FEDERATED_SYSTEMS.calendar),
    id: asSourceId(suffix ? `${uid}#${suffix}` : uid),
  };
}

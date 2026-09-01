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
 * Format an override's original-start instant as an ICS UTC-basic timestamp
 * (`YYYYMMDDTHHMMSSZ`) — the RECURRENCE-ID spelling for a UTC DATE-TIME, used
 * to key API-side instances the way the .ics side keys them. Cross-format
 * caveat (design doc §3.5): an .ics whose RECURRENCE-ID is date-only or
 * TZID-local spells the same instant differently; masters and non-recurring
 * events (the vast majority) are unaffected.
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

/**
 * IANA timezone helpers for the settings timezone picker.
 *
 * The project's TS lib is ES2020, which doesn't type `Intl.supportedValuesOf`
 * (ES2022+). It exists at runtime in every browser we support, so we reach it
 * through a narrow cast and fall back to a curated list on the rare engine that
 * lacks it — the dropdown is always populated.
 */
type IntlWithSupportedValues = typeof Intl & {
  supportedValuesOf?: (key: 'timeZone') => string[];
};

// Enough coverage to be usable if the runtime lacks Intl.supportedValuesOf.
const FALLBACK_TIME_ZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Phoenix',
  'America/Toronto',
  'America/Mexico_City',
  'America/Bogota',
  'America/Lima',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Athens',
  'Europe/Moscow',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/** All IANA timezone names the runtime knows, sorted; a curated fallback otherwise. */
export function getAvailableTimeZones(): string[] {
  try {
    const zones = (Intl as IntlWithSupportedValues).supportedValuesOf?.('timeZone');
    if (zones && zones.length > 0) {
      return [...zones].sort();
    }
  } catch {
    // fall through to the curated list
  }

  return [...FALLBACK_TIME_ZONES].sort();
}

/** The browser's current IANA timezone, or 'UTC' if it can't be resolved. */
export function detectBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Human label for a zone, e.g. "America/New York (GMT-4)". Falls back gracefully. */
export function formatTimeZoneLabel(zone: string): string {
  const pretty = zone.replace(/_/g, ' ');
  try {
    const offset = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value;

    return offset ? `${pretty} (${offset})` : pretty;
  } catch {
    return pretty;
  }
}

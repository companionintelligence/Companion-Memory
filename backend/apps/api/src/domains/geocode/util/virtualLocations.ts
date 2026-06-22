/**
 * Virtual / non-physical "locations" that calendar events carry in the location
 * field — video-call URLs, "TBD", phone numbers. These can never forward-geocode
 * to a meaningful Point, so they are NEVER sent to Google (billing + negative-
 * cache noise) and are tagged metadata.location_source = 'virtual' instead.
 */

/** Exact-match denylist tokens (compared against the canonical, lowercased form). */
const VIRTUAL_LOCATION_TOKENS = new Set<string>([
  'zoom',
  'teams',
  'microsoft teams',
  'meet',
  'google meet',
  'google hangouts',
  'hangouts',
  'discord',
  'slack',
  'webex',
  'skype',
  'online',
  'virtual',
  'remote',
  'tbd',
  'tba',
  'n/a',
  'na',
  'none',
  'phone',
  'phone call',
  'call',
  'conference call',
  'video call',
  'web conference',
]);

/**
 * Substring / pattern signals that the location is a meeting link or other
 * non-geocodable virtual venue, even when embedded in a longer string
 * (e.g. "Zoom: https://zoom.us/j/123").
 */
const VIRTUAL_LOCATION_PATTERNS: RegExp[] = [
  /\bzoom\.us\b/i,
  /\bmeet\.google\.com\b/i,
  /\bteams\.microsoft\.com\b/i,
  /\bteams\.live\.com\b/i,
  /\bwebex\.com\b/i,
  /\bdiscord\.(gg|com)\b/i,
  /\bhangouts\.google\.com\b/i,
  /\bgoto(meeting|webinar)\b/i,
  /\bhttps?:\/\//i,
];

/**
 * True if `location` is a virtual / non-physical venue that must not be sent to
 * the geocoder. `value` should be the raw location string; this lowercases and
 * trims internally.
 */
export function isVirtualLocation(location: string | null | undefined): boolean {
  if (!location) {
    return false;
  }

  const normalized = location.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  if (VIRTUAL_LOCATION_TOKENS.has(normalized)) {
    return true;
  }

  return VIRTUAL_LOCATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

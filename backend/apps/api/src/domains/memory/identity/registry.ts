import { asSourceId, asSourceSystem, type SourceId, type SourceIdentity, type SourceSystem } from './types';

/**
 * The canonical `source_system` vocabulary — the single source of truth both
 * pipelines (connection ETL and import-tools) and every internal producer
 * stamp from. See docs/design/cross-pipeline-identity.md §3.2.
 *
 * Federated kinds: the id is globally unique by an interchange standard, so
 * `source_system` names the KIND and the same datum converges no matter which
 * platform delivered it.
 */
export const FEDERATED_SYSTEMS = {
  /** RFC 5322 mail — id is the normalized Message-ID. */
  email: 'email',
  /** RFC 5545 events — id is iCalUID, `#<RECURRENCE-ID>`-suffixed for overrides. */
  calendar: 'calendar',
  /** Raw bytes — id is `sha256:<hex>` of the content. */
  file: 'file',
} as const;

/**
 * Platform kinds: the id is unique only within one platform's namespace, so
 * `source_system` is the canonical platform name — ONE name per platform,
 * shared verbatim by the connection transforms and the importer datasources.
 *
 * Sub-kind suffixes that used to live in `source_system` (`reddit_comments`,
 * `github_events`, …) belong in the `source_id` prefix or the row's own type
 * column instead; SYSTEM_ALIASES maps the legacy spellings here.
 *
 * The set is deliberately permissive about members with no current overlap
 * (an importer with no connection, or vice versa): registering the name IS the
 * contract a future counterpart must meet.
 */
export const PLATFORM_SYSTEMS: readonly string[] = [
  // Connections (domains/etl/services/*)
  'facebook',
  'facebook_messenger',
  'github',
  'gmail', // non-mail Gmail records and Message-ID-less fallbacks; mail keys on FEDERATED_SYSTEMS.email
  'google_calendar', // UID-less fallbacks only; UID-bearing events key on FEDERATED_SYSTEMS.calendar
  'google_drive',
  'microsoft',
  'outlook_calendar', // UID-less fallbacks only; UID-bearing events key on FEDERATED_SYSTEMS.calendar
  'onedrive',
  'outlook_mail', // Message-ID-less fallbacks; mail keys on FEDERATED_SYSTEMS.email
  'reddit',
  'signal',
  'slack',
  'spotify',
  'steam',
  'youtube',
  // Importer datasources with no connection counterpart (registry names)
  'amazon',
  'amazon_music',
  'apple_contacts',
  'apple_health',
  'apple_music',
  'apple_photos',
  'audible',
  'bluebubbles',
  'chatgpt',
  'chromium', // every Chromium-family browser (Chrome/Brave/Edge/Arc/Opera): History SQLite, Takeout Chrome, AND the browser extension — see identity/browser.ts
  'claude',
  'coinbase',
  'contact_list',
  'discord',
  'evernote',
  'firefox', // places.sqlite importer AND the Firefox build of the browser extension — see identity/browser.ts
  'fitbit',
  'flickr',
  'flighty',
  'garmin',
  'gemini',
  'generic',
  'geojson',
  'goodreads',
  'google_fit',
  'google_keep',
  'google_location',
  'google_maps_places',
  'google_my_activity',
  'google_photos',
  'google_purchases',
  'google_voice',
  'gpx',
  'grok',
  'imessage',
  'instagram',
  'kindle',
  'kindle_reading',
  'kmlgx',
  'last_fm',
  'letterboxd',
  'linkedin',
  'lyft',
  'mastodon',
  'microsoft_account',
  'myfitnesspal',
  'netflix',
  'nmea',
  'notion',
  'oura',
  'paypal',
  'photos',
  'prime_video',
  'remember_the_milk',
  'robinhood',
  'roblox',
  'sms_backup_restore',
  'snapchat',
  'strava',
  'telegram',
  'tiktok',
  'timeline',
  'twitter',
  'uber',
  'vcard',
  'venmo',
  'whatsapp',
  'withings',
  // Browser extension only (external ingest; no importer reads Safari history)
  'safari',
  // Internal producers (not user-facing platforms, but they mint rows too)
  'attachment_extract',
  'capture',
  'companion-scan',
  'communications:participant',
  'context_prompt',
  'csv',
  'cv-server',
  'graph-enrichment:person',
  'graph_llm',
  'json',
  'object_identity',
  'planning',
  'self',
  'unknown',
] as const;

/**
 * Legacy / drifted spellings → canonical name. Both pipelines historically
 * invented their own `source_system` strings; a wiped re-import lands
 * everything under the canonical vocabulary, and this map keeps any straggler
 * call site (or replayed payload) from re-introducing the drift.
 */
export const SYSTEM_ALIASES: Readonly<Record<string, string>> = {
  github_events: 'github',
  reddit_posts: 'reddit',
  reddit_comments: 'reddit',
  reddit_saved: 'reddit',
  ics: FEDERATED_SYSTEMS.calendar,
  chrome: 'chromium',
  chrome_history: 'chromium',
  google_chrome: 'chromium',
  brave: 'chromium',
  edge: 'chromium',
  arc: 'chromium',
  opera: 'chromium',
  x: 'twitter',
  Amazon: 'amazon',
};

const REGISTERED: ReadonlySet<string> = new Set([...Object.values(FEDERATED_SYSTEMS), ...PLATFORM_SYSTEMS]);

/** Is this exact string a registry-canonical `source_system`? */
export function isRegisteredSystem(value: string): boolean {
  return REGISTERED.has(value);
}

/**
 * Resolve a raw system string (a transform literal, an importer datasource
 * name, an external ingest payload) to its canonical form. Unknown values pass
 * through unchanged — the registry-completeness test is what keeps the
 * codebase's own literals inside the vocabulary; refusing at runtime would
 * turn an unregistered capture source into data loss.
 */
export function canonicalSystem(raw: string): SourceSystem {
  return asSourceSystem(SYSTEM_ALIASES[raw] ?? raw);
}

/**
 * Identity for a platform-scoped record: canonical platform name + the
 * platform's native id. The workhorse constructor for every record kind that
 * has no interchange-standard key. `parts` are joined with `:` — use a leading
 * kind tag when one platform has several record kinds sharing a namespace,
 * e.g. `platformIdentity('reddit', 'comment', 't1_abc')`.
 */
export function platformIdentity(system: string, ...parts: [string, ...string[]]): SourceIdentity {
  return { system: canonicalSystem(system), id: asSourceId(parts.join(':')) };
}

/**
 * Adopt an identity that crosses the API boundary already formed (bulk ingest,
 * capture callbacks, GraphQL mutations). External producers own their
 * namespace; we canonicalize the system spelling and take the id verbatim.
 * This is the ONE constructor for out-of-process input — internal code calls
 * a specific builder instead.
 */
export function adoptIngestIdentity(
  system: string | null | undefined,
  id: string | null | undefined,
): Partial<SourceIdentity> {
  return {
    system: system != null ? canonicalSystem(system) : undefined,
    id: id != null ? asSourceId(id) : undefined,
  };
}

/**
 * A fallback id for a datum whose natural key is missing (Message-ID-less
 * mail, UID-less VEVENTs). Explicitly marked: fallbacks are NOT expected to
 * converge across pipelines (see design doc §3.5) — the marker makes the
 * residual-duplicate population queryable.
 */
export function fallbackId(hashHex: string): SourceId {
  return asSourceId(`fallback:${hashHex}`);
}

export type { SourceId, SourceIdentity, SourceSystem };

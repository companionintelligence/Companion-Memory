/**
 * Human-readable labels for known connector / `source_system` values.
 *
 * Shared by the per-item {@link SourceBadge} and the Stats page's provenance
 * breakdown so a connector is named the same way everywhere. Keys are the raw
 * lowercase values connectors emit; lookup is case-insensitive because
 * importers also write these as free text (`properties.Source: "LinkedIn"`).
 */
const CONNECTOR_LABELS: Readonly<Record<string, string>> = {
  gmail: 'Gmail',
  google_voice: 'Voice',
  google_calendar: 'Calendar',
  google_contacts: 'Contacts',
  google_photos: 'Photos',
  imessage: 'iMessage',
  apple_calendar: 'Calendar',
  apple_contacts: 'Contacts',
  whatsapp: 'WhatsApp',
  spotify: 'Spotify',
  twitter: 'Twitter',
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  amazon: 'Amazon',
  venmo: 'Venmo',
  paypal: 'PayPal',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  firefox: 'Firefox',
  chromium: 'Chrome',
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  github_events: 'GitHub',
  reddit: 'Reddit',
  reddit_posts: 'Reddit',
  reddit_comments: 'Reddit',
  reddit_saved: 'Reddit',
  signal: 'Signal',
  slack: 'Slack',
  dropbox: 'Dropbox',
  // Communication `type` values (CommunicationType.type, not a connector).
  email: 'Email',
  sms: 'SMS',
  mms: 'MMS',
  call: 'Call',
  voice: 'Voice',
};

/** Words left lowercase when they are not the first token. */
const LOWERCASE_WORDS = new Set(['and', 'of', 'the', 'or']);

/**
 * Title-case a raw key: `github_api` → `Github Api`, `apple:contacts` → `Apple Contacts`.
 *
 * A token is only re-cased when it is entirely lowercase, so a value that
 * already reads as prose survives intact (`LinkedIn` does not become `Linkedin`).
 */
export function titleCaseSourceKey(source: string): string {
  return source
    .split(/[:_\-\s]+/)
    .filter(Boolean)
    .map((word, index) => {
      if (index > 0 && LOWERCASE_WORDS.has(word)) {
        return word;
      }

      return word === word.toLowerCase() ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(' ');
}

/**
 * Friendly name for a connector value, falling back to a title-cased version of
 * the raw key. The map is a set of overrides, never a whitelist — connector
 * names are unvalidated free text, so unknown values must still render.
 */
export function labelForSource(source: string): string {
  return CONNECTOR_LABELS[source.toLowerCase()] ?? titleCaseSourceKey(source);
}

/**
 * How an exact-match filter value (a `source_system`, an event type) is SHOWN
 * in the How and Activity pickers: each word capitalised, underscores as
 * spaces — `amazon_music` → `Amazon Music`. Display only: the raw value is
 * what the URL carries and what the backend matches, so nothing that sends or
 * compares a value may go through this.
 *
 * Deliberately not {@link labelForSource}: that names a connector for a
 * badge (`google_photos` → `Photos`, four reddit endpoints → `Reddit`), and a
 * picker listing distinct values cannot show two of them under one name.
 */
export function filterValueLabel(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * {@link filterValueLabel} for a source, spelled the brand's way where that
 * is only a difference in letter case (`youtube` → `YouTube`, `imessage` →
 * `iMessage`). A known label that says something else (`chromium` → `Chrome`)
 * is not used, so every source keeps a label of its own.
 */
export function sourceFilterLabel(source: string): string {
  const label = filterValueLabel(source);
  const known = CONNECTOR_LABELS[source.toLowerCase()];

  return known != null && known.toLowerCase() === label.toLowerCase() ? known : label;
}

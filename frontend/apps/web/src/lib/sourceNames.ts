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
  firefox: 'Firefox',
  chromium: 'Chrome',
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  github_events: 'GitHub',
  signal: 'Signal',
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

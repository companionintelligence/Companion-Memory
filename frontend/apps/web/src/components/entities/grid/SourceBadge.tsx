import { Badge } from '@ci/shadcn';

/** Human-readable labels for known connector / source_system values. */
const SOURCE_LABELS: Record<string, string> = {
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
  // Communication `type` values (CommunicationType.type, not a connector).
  email: 'Email',
  sms: 'SMS',
  mms: 'MMS',
  call: 'Call',
  voice: 'Voice',
};

function labelFor(source: string): string {
  if (SOURCE_LABELS[source]) {
    return SOURCE_LABELS[source];
  }

  // Fall back to a title-cased version of the raw key (e.g. "github_api" → "Github Api").
  return source
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

interface Props {
  source?: string | null;
  /** Shown when no source_system is present (e.g. a generic type label). */
  fallback?: string;
}

/**
 * Compact connector badge for gallery/list cards — turns a raw `source_system`
 * (`google_voice`, `imessage`, …) into a friendly label so users can tell at a
 * glance where a memory came from.
 */
export function SourceBadge({ source, fallback }: Props) {
  const text = source ? labelFor(source) : fallback;

  if (!text) {
    return null;
  }

  return (
    <Badge variant="secondary" className="shrink-0 text-xs font-normal">
      {text}
    </Badge>
  );
}

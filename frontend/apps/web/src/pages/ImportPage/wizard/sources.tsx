import type { ReactElement } from 'react';

import {
  BookOpen,
  Bookmark,
  Calendar,
  Contact,
  Files,
  FileText,
  Gamepad2,
  GitBranch,
  GitCommit,
  Globe,
  HeartPulse,
  Image,
  ListMusic,
  Mail,
  MapPin,
  MessageSquare,
  Music,
  Plane,
  Play,
  ShoppingBag,
  Video,
} from '@ci/shadcn/icons';

import type { TrackedObject } from '@/components/connect/SourceCard';

import type { CatalogSource, ImportSourceGuide } from '../useImportApi';

/**
 * Presentation glue for the import wizard — the FRONTEND half of the catalog.
 *
 * The export instructions themselves are authored in the backend
 * (`sources/guides.ts`, served by `GET /import/sources/catalog`); this module
 * keeps only what presentation needs: brand glyphs, per-service logos, the
 * ecosystem groupings the picker renders as sections, and the two multi-service
 * "bundles" whose single download covers several importers. Both the picker and
 * the export cards read the same normalized {@link ImportSourceGuide} shape, so
 * a source's instructions are authored once and shown identically everywhere.
 */

// ---------------------------------------------------------------------------
// Ecosystem glyphs — simple universal shapes, no trademarks.
// ---------------------------------------------------------------------------

const glyph = (path: ReactElement): ReactElement => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {path}
  </svg>
);

export const ECOSYSTEM_ICONS: Record<string, ReactElement> = {
  google: glyph(
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>,
  ),
  apple: glyph(
    <>
      <path d="M12 6c1-2 3-2.5 4.5-2-0.3 1.6-1.4 2.8-3 3" />
      <path d="M16.5 8.5c2 0 3.5 1.5 3.5 4 0 3.5-2.5 7.5-4.5 7.5-1 0-1.5-.6-2.5-.6s-1.7.6-2.7.6C8.3 20 5.5 16 5.5 12.5c0-2.5 1.8-4 3.7-4 1 0 1.9.6 2.6.6.7 0 1.7-.6 2.7-.6z" />
    </>,
  ),
  meta: glyph(
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />,
  ),
  x: glyph(<path d="M4 4l16 16M20 4L4 20" />),
  music: glyph(
    <>
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
      <path d="M9 18V5l12-2v13" />
    </>,
  ),
  browser: glyph(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20z" />
    </>,
  ),
  social: glyph(
    <>
      <path d="M17 8h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2v4l-4-4H9a2 2 0 0 1-2-2v-1" />
      <path d="M13 2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2v4l4-4h2a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z" />
    </>,
  ),
  wearable: glyph(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />),
  reading: glyph(
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </>,
  ),
  travel: glyph(
    <path d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />,
  ),
  ai: glyph(
    <>
      <rect x="4" y="7" width="16" height="12" rx="2" />
      <path d="M12 7V4M9 2h6M9 12h.01M15 12h.01M9 16h6" />
    </>,
  ),
  microsoft: glyph(
    <>
      <rect x="3" y="3" width="8" height="8" />
      <rect x="13" y="3" width="8" height="8" />
      <rect x="3" y="13" width="8" height="8" />
      <rect x="13" y="13" width="8" height="8" />
    </>,
  ),
  amazon: glyph(
    <>
      <circle cx="9" cy="21" r="1" />
      <circle cx="20" cy="21" r="1" />
      <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
    </>,
  ),
  messaging: glyph(
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />,
  ),
  gaming: glyph(
    <>
      <line x1="6" y1="11" x2="10" y2="11" />
      <line x1="8" y1="9" x2="8" y2="13" />
      <line x1="15" y1="12" x2="15.01" y2="12" />
      <line x1="18" y1="10" x2="18.01" y2="10" />
      <rect x="2" y="6" width="20" height="12" rx="6" />
    </>,
  ),
  streaming: glyph(
    <>
      <rect x="2" y="4" width="20" height="15" rx="2" />
      <path d="M10 9l5 3-5 3z" />
    </>,
  ),
  finance: glyph(
    <>
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </>,
  ),
  productivity: glyph(
    <>
      <rect x="3" y="5" width="6" height="6" rx="1" />
      <path d="M3 17h6M3 21h6M13 5h8M13 9h8M13 15h8M13 19h8" />
    </>,
  ),
  misc: glyph(
    <>
      <circle cx="12" cy="12" r="2" />
      <circle cx="4" cy="12" r="2" />
      <circle cx="20" cy="12" r="2" />
    </>,
  ),
};

// ---------------------------------------------------------------------------
// Per-service brand logos, keyed by catalog source id.
// ---------------------------------------------------------------------------

/**
 * Files under `public/import-logos/`. A source with no entry (or whose file
 * fails to load) falls back to its ecosystem glyph — the grid must never show
 * a broken-image icon over something as prominent as a service button.
 */
export const SERVICE_LOGO: Record<string, string> = {
  // Google
  gmail: 'gmail.svg',
  google_photos: 'google_photos.svg',
  google_location: 'google_location.svg',
  google_calendar: 'google_calendar.svg',
  google_contacts: 'google_contacts.svg',
  youtube: 'youtube.svg',
  googlevoice: 'googlevoice.svg',
  // Apple
  imessage: 'imessage.svg',
  apple_photos: 'apple_photos.svg',
  apple_contacts: 'apple_contacts.png',
  apple_calendar: 'apple_calendar.svg',
  apple_health: 'apple_health.png',
  apple_music: 'apple_music.svg',
  apple_tv_plus: 'apple_tv_plus.svg',
  // Meta / X / Social
  facebook: 'facebook.svg',
  instagram: 'instagram.svg',
  whatsapp: 'whatsapp.svg',
  twitter: 'twitter.svg',
  snapchat: 'snapchat.svg',
  pinterest: 'pinterest.svg',
  tiktok: 'tiktok.svg',
  reddit: 'reddit.svg',
  flickr: 'flickr.svg',
  mastodon: 'mastodon.svg',
  tumblr: 'tumblr.svg',
  smugmug: 'smugmug.svg',
  imgur: 'imgur.svg',
  // Messaging
  telegram: 'telegram.svg',
  discord: 'discord.svg',
  signal: 'signal.svg',
  // Browsers
  // chromium.svg carries real color; chrome.svg is a monochrome mark whose
  // four-color logo cannot be restored with a single fill.
  chromium: 'chromium.svg',
  firefox: 'firefox.svg',
  // Music
  spotify: 'spotify.svg',
  deezer: 'deezer.svg',
  last_fm: 'lastfm.svg',
  soundcloud: 'soundcloud.svg',
  pandora: 'pandora.svg',
  // Streaming
  netflix: 'netflix.svg',
  disney_plus: 'disneyplus.svg',
  hulu: 'hulu.svg',
  hbo_max: 'hbo.svg',
  paramount_plus: 'paramountplus.svg',
  peacock: 'peacocktv.svg',
  crunchyroll: 'crunchyroll.svg',
  // AI assistants
  chatgpt: 'openai.svg',
  claude: 'anthropic.svg',
  gemini: 'gemini.svg',
  perplexity: 'perplexity.svg',
  grok: 'xai.svg',
  // Microsoft
  linkedin: 'linkedin.svg',
  microsoft_account: 'microsoft.svg',
  outlook_mail: 'outlook.svg',
  outlook_calendar: 'outlook.svg',
  outlook_contacts: 'outlook.svg',
  onedrive: 'onedrive.svg',
  // Fitness & wearables
  strava: 'strava.svg',
  fitbit: 'fitbit.svg',
  garmin: 'garmin.svg',
  myfitnesspal: 'myfitnesspal.svg',
  withings: 'withings.svg',
  oura: 'ouraring.svg',
  // Reading
  kindle: 'amazon.svg',
  goodreads: 'goodreads.svg',
  letterboxd: 'letterboxd.svg',
  // Travel
  flighty: 'flighty.png',
  uber: 'uber.svg',
  lyft: 'lyft.svg',
  airbnb: 'airbnb.svg',
  // Gaming
  roblox: 'roblox.svg',
  steam: 'steam.svg',
  twitch: 'twitch.svg',
  // Amazon — the members share the house mark; no per-service logos ship.
  prime_video: 'amazon.svg',
  audible: 'amazon.svg',
  kindle_reading: 'amazon.svg',
  amazon_music: 'amazon.svg',
  // Finance & shopping
  instacart: 'instacart.svg',
  walmart: 'walmart.svg',
  amazon: 'amazon.svg',
  paypal: 'paypal.svg',
  coinbase: 'coinbase.svg',
  venmo: 'venmo.svg',
  robinhood: 'robinhood.svg',
  // Productivity
  notion: 'notion.svg',
  evernote: 'evernote.svg',
  // Storage / other
  dropbox: 'dropbox.svg',
  backblaze: 'backblaze.svg',
  synology: 'synology.svg',
  yahoo_mail: 'yahoo.svg',
};

/** Absolute path for a source's logo, or null when it has none. */
export function serviceLogoUrl(sourceId: string): string | null {
  const file = SERVICE_LOGO[sourceId];

  return file == null ? null : `/import-logos/${file}`;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export const ECOSYSTEM_LABELS: Record<string, string> = {
  google: 'Google',
  apple: 'Apple',
  meta: 'Meta',
  amazon: 'Amazon',
  x: 'Twitter / X',
  music: 'Music',
  browser: 'Browsers',
  wearable: 'Fitness & wearables',
  reading: 'Reading',
  travel: 'Travel',
  social: 'Social',
  messaging: 'Messaging',
  microsoft: 'Microsoft',
  finance: 'Finance',
  productivity: 'Productivity',
  ai: 'AI assistants',
  gaming: 'Gaming',
  streaming: 'Streaming',
  misc: 'Other',
};

export const ECOSYSTEM_ORDER = [
  'google',
  'apple',
  'meta',
  'amazon',
  'x',
  'ai',
  'music',
  'streaming',
  'browser',
  'wearable',
  'reading',
  'travel',
  'social',
  'messaging',
  'gaming',
  'microsoft',
  'finance',
  'productivity',
  'misc',
];

/**
 * Picker sections gather one or more ecosystems under a single heading.
 *
 * `hue` is the heading's accent (an OKLCH hue, 0–360), fixed per section so a
 * colour stays with its group whatever the search filter hides. The headings
 * used to be small muted text and vanished between the brand logos below
 * them; a distinct hue per section is what lets the eye find the group
 * boundaries again. Neighbouring sections get well-separated hues.
 */
export const PICKER_SECTIONS: ReadonlyArray<{
  key: string;
  label: string;
  icon: string;
  hue: number;
  ecosystems: readonly string[];
}> = [
  { key: 'google', label: 'Google', icon: 'google', hue: 255, ecosystems: ['google'] },
  { key: 'apple', label: 'Apple', icon: 'apple', hue: 300, ecosystems: ['apple'] },
  { key: 'microsoft', label: 'Microsoft', icon: 'microsoft', hue: 200, ecosystems: ['microsoft'] },
  { key: 'amazon', label: 'Amazon', icon: 'amazon', hue: 55, ecosystems: ['amazon'] },
  { key: 'ai', label: 'AI assistants', icon: 'ai', hue: 330, ecosystems: ['ai'] },
  { key: 'social', label: 'Social', icon: 'social', hue: 20, ecosystems: ['meta', 'x', 'social'] },
  { key: 'messaging', label: 'Messaging', icon: 'messaging', hue: 150, ecosystems: ['messaging'] },
  { key: 'music', label: 'Music', icon: 'music', hue: 350, ecosystems: ['music'] },
  { key: 'streaming', label: 'Streaming', icon: 'streaming', hue: 280, ecosystems: ['streaming'] },
  { key: 'gaming', label: 'Gaming', icon: 'gaming', hue: 120, ecosystems: ['gaming'] },
  { key: 'browser', label: 'Browsers', icon: 'browser', hue: 230, ecosystems: ['browser'] },
  { key: 'wearable', label: 'Fitness & wearables', icon: 'wearable', hue: 30, ecosystems: ['wearable'] },
  { key: 'reading', label: 'Reading', icon: 'reading', hue: 80, ecosystems: ['reading'] },
  { key: 'travel', label: 'Travel', icon: 'travel', hue: 180, ecosystems: ['travel'] },
  { key: 'finance', label: 'Finance', icon: 'finance', hue: 140, ecosystems: ['finance'] },
  {
    key: 'productivity',
    label: 'Productivity',
    icon: 'productivity',
    hue: 265,
    ecosystems: ['productivity'],
  },
  { key: 'misc', label: 'Other', icon: 'misc', hue: 210, ecosystems: ['misc'] },
];

/**
 * Flat ecosystem order for the export sequence: section order first, then any
 * ecosystem not placed in a section — keeps the picker and the export cards
 * walking the same path.
 */
export const ORDERED_ECOS: readonly string[] = (() => {
  const seen = new Set<string>();
  const order: string[] = [];

  for (const section of PICKER_SECTIONS) {
    for (const eco of section.ecosystems) {
      if (!seen.has(eco)) {
        seen.add(eco);
        order.push(eco);
      }
    }
  }

  for (const eco of ECOSYSTEM_ORDER) {
    if (!seen.has(eco)) {
      seen.add(eco);
      order.push(eco);
    }
  }

  return order;
})();

/** "Gmail (Google Takeout)" → "Gmail", for compact service buttons. */
export function shortTitle(title: string): string {
  return title.replace(/\s*\(.*?\)\s*/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Bundles — platforms whose ONE download covers several services.
// ---------------------------------------------------------------------------

/**
 * A bundle collapses to a single picker button and a single export card; the
 * drop is one archive and the PARSE detects every member inside it — no
 * fan-out is needed here, detection is the backend's job.
 */
export interface Bundle {
  id: string;
  ecosystem: string;
  title: string;
  blurb: string;
  url?: string;
  steps: string[];
  /** Catalog source ids this single download covers. */
  members: string[];
  /** Loose addenda rendered under the steps, like a catalog source's notes. */
  notes?: string[];
  logo: string;
}

export const BUNDLES: readonly Bundle[] = [
  {
    id: 'google',
    ecosystem: 'google',
    title: 'Google (Takeout)',
    blurb:
      'One Takeout export covers Gmail, Photos, Location, Calendar, Contacts, YouTube, Voice, plus My Activity, Maps, Keep, Fit and Purchases.',
    url: 'https://takeout.google.com/',
    steps: [
      'Open Google Takeout and sign in.',
      'Click “Deselect all”, then tick the products you want: Mail, Google Photos, Location History, Calendar, Contacts, YouTube, Voice, My Activity, Maps, Keep, Fit, and Purchases & Reservations.',
      '“Next step” → “Export once” → “.zip” → “50 GB” → “Create export”.',
      'You’ll get an email in 1–48 hours. Download the zip.',
      'Upload the zip here — every product inside it gets imported.',
    ],
    notes: [
      'Takeout exports any single file larger than your chosen part size — a long video, typically — as a loose file NEXT TO the zip parts, not inside them. A handful of loose files upload fine; for a large Photos library with many of them, prefer the appliance\u2019s import inbox: move the whole Takeout folder into the inbox directory and import it from the Inbox panel as one unit.',
    ],
    members: [
      'gmail',
      'google_photos',
      'google_location',
      'google_calendar',
      'google_contacts',
      'youtube',
      'googlevoice',
      'google_my_activity',
      'google_maps_places',
      'google_keep',
      'google_purchases',
      'google_fit',
    ],
    logo: 'google.svg',
  },
  {
    id: 'meta',
    ecosystem: 'meta',
    title: 'Meta (Facebook, Instagram)',
    blurb:
      'Meta Accounts Center exports your Facebook and Instagram data — each profile arrives as its own archive. WhatsApp exports separately.',
    url: 'https://accountscenter.facebook.com/info_and_permissions/dyi/?entry_point=download_your_information&target_id',
    steps: [
      'Open Meta Accounts Center → “Download your information”. Instagram must be linked to the Facebook account you’re signed in with (Accounts Center → Manage Accounts → “Add accounts”).',
      'Request each profile you want — Facebook and Instagram export as separate archives, one request each.',
      'Set Date range to “All time”, Format to “JSON”, and Media quality to “High”.',
      'Click “Create files”. You’ll get an email when each download is ready (minutes to a few hours).',
      'Upload every archive here — each one imports on its own. (WhatsApp is a separate export.)',
    ],
    // WhatsApp is deliberately NOT a member — its export is separate, so it
    // keeps its own picker button and export card.
    members: ['facebook', 'instagram'],
    logo: 'meta.svg',
  },
  {
    id: 'amazon',
    ecosystem: 'amazon',
    title: 'Amazon (Privacy Central)',
    blurb:
      'One "Request All Your Data" archive covers your orders, Prime Video, Audible, Kindle reading, and Amazon Music. Each is also requestable on its own.',
    url: 'https://www.amazon.com/hz/privacy-central/data-requests/preview.html',
    steps: [
      'Open Amazon Privacy Central (link below) and sign in.',
      'Click "Request Your Data" and choose "Request All Your Data" — or a single category; a category export imports on its own too.',
      'Confirm the request by email. A single-category export usually arrives within days; the full archive can take up to 30.',
      'Download the zip from the email link.',
      'Upload the zip here — every Amazon source inside it gets imported.',
    ],
    members: ['amazon', 'prime_video', 'audible', 'kindle_reading', 'amazon_music'],
    logo: 'amazon.svg',
  },
];

export const BUNDLE_BY_ECO: Record<string, Bundle> = Object.fromEntries(
  BUNDLES.map((bundle) => [bundle.ecosystem, bundle]),
);

// ---------------------------------------------------------------------------
// Selection — pure derivations the picker and the export sequence share.
// ---------------------------------------------------------------------------

/**
 * What each CATEGORY of source puts in your memory.
 *
 * This replaced a keyword matcher run over each guide's authored
 * `whatImported` prose, which failed in both directions at once. Only 17 of the
 * 100 catalog entries carry `whatImported` at all, so 83% of the grid showed a
 * bare name; and where the prose did exist the matcher inferred nonsense from
 * it — GPX, a GPS track format, advertised "Listening, Orders, Files" (from
 * "Track points", "in route order" and "the file includes them") while failing
 * to mention Places, because "lat/lon" is not the word "coordinates".
 *
 * Every catalog entry has a `category`, and the backend's category vocabulary
 * is already the list of things an import produces. Keying off it gives all 100
 * sources an accurate list from one reviewable table, and nothing has to be
 * inferred from a sentence written for a human.
 *
 * Two entries only where a category genuinely yields two distinct kinds.
 */
const OBJECTS_BY_CATEGORY: Readonly<Record<string, readonly TrackedObject[]>> = {
  mail: [{ icon: Mail, label: 'Mail' }],
  messages: [{ icon: MessageSquare, label: 'Messages' }],
  photos: [
    { icon: Image, label: 'Photos' },
    { icon: Video, label: 'Videos' },
  ],
  video: [{ icon: Play, label: 'Watch history' }],
  audio: [
    { icon: Music, label: 'Listening' },
    { icon: ListMusic, label: 'Playlists' },
  ],
  location: [{ icon: MapPin, label: 'Places' }],
  calendar: [{ icon: Calendar, label: 'Calendar' }],
  contacts: [{ icon: Contact, label: 'Contacts' }],
  health: [{ icon: HeartPulse, label: 'Health & activity' }],
  social: [
    { icon: MessageSquare, label: 'Posts' },
    { icon: Image, label: 'Photos' },
  ],
  browser: [
    { icon: Globe, label: 'Browsing' },
    { icon: Bookmark, label: 'Bookmarks' },
  ],
  reading: [{ icon: BookOpen, label: 'Books & highlights' }],
  travel: [{ icon: Plane, label: 'Trips' }],
  ai: [{ icon: MessageSquare, label: 'Conversations' }],
  productivity: [{ icon: FileText, label: 'Notes & pages' }],
  gaming: [{ icon: Gamepad2, label: 'Games & playtime' }],
  finance: [{ icon: ShoppingBag, label: 'Orders & payments' }],
  code: [
    { icon: GitBranch, label: 'Repositories' },
    { icon: GitCommit, label: 'Commits' },
  ],
  misc: [{ icon: Files, label: 'Files' }],
};

/** Vocabulary order, so a bundle and its members always agree on ordering. */
const OBJECT_ORDER: readonly string[] = Object.values(OBJECTS_BY_CATEGORY)
  .flat()
  .map((object) => object.label)
  .filter((label, index, all) => all.indexOf(label) === index);

/**
 * The kinds of thing importing this source puts in your memory.
 *
 * Empty for a category the backend grew that this table has not been taught —
 * the tile then shows its name alone rather than claiming something wrong,
 * which is the failure mode the old prose matcher had.
 */
export function objectsFor(category: string | undefined): TrackedObject[] {
  if (!category) {
    return [];
  }

  return [...(OBJECTS_BY_CATEGORY[category] ?? [])];
}

/** A bundle button covers several sources, so it claims the union of theirs. */
export function mergeObjects(all: readonly TrackedObject[][]): TrackedObject[] {
  const seen = new Set<string>();
  const merged: TrackedObject[] = [];

  // Vocabulary order, not encounter order, so a bundle and its members agree.
  for (const label of OBJECT_ORDER) {
    for (const objects of all) {
      const match = objects.find((object) => object.label === label);

      if (match && !seen.has(label)) {
        seen.add(label);
        merged.push(match);
      }
    }
  }

  return merged;
}

/** One toggle button in the pick grid: a bundle (`b:<id>`) or a service. */
export interface PickItem {
  key: string;
  label: string;
  logo: string | null;
  ecosystem: string;
  ready: boolean;
  /** What importing it puts in your memory — see {@link objectsFor}. */
  objects: TrackedObject[];
  /**
   * Importer names this button covers — one for a service, several for a
   * bundle. A run records which importers it fed, so this is what lets a tile
   * say whether it has been imported before and how much it brought.
   */
  importers: string[];
  /**
   * The services a bundle tile stands for, display-named ("Facebook",
   * "Instagram"). Rendered on the tile so someone scanning the grid for a
   * service finds it under the bundle's brand instead of concluding it is
   * unsupported. Absent on single-service tiles.
   */
  memberNames?: string[];
}

export interface PickSection {
  key: string;
  label: string;
  icon: ReactElement | null;
  /** Heading accent, an OKLCH hue — see PICKER_SECTIONS. */
  hue: number;
  items: PickItem[];
}

/**
 * Bundle members that ALSO get their own tile and export card.
 *
 * Normally a member is reachable only through its bundle — that is what keeps
 * Social from being eleven near-duplicate buttons. But the catalog already
 * carries standalone cards for sources a bundle covers when the service is a
 * household name someone will scan for by its own name (Gemini rides Google
 * Takeout, Grok rides the X archive). Instagram is that case inside Meta: its
 * card leads with the Accounts Center flow the bundle teaches and keeps the
 * instagram.com/download request as the secondary path. The member stays in
 * the bundle too, so the bundle keeps declaring (and crediting) it.
 */
const STANDALONE_MEMBERS = new Set(['instagram']);

/**
 * What the picker shows per section: the ecosystem's bundle button (when one
 * exists) plus a button for every catalog source NOT covered by that bundle —
 * so Social reads as Meta · WhatsApp · Twitter/X · Reddit, not eleven near-
 * duplicate buttons. Within a section, ready importers come first and each
 * half sorts alphabetically — A→Z is predictable to scan, but a tile that can
 * actually import today still outranks a "coming soon" one. Members named in
 * {@link STANDALONE_MEMBERS} get their own button as well.
 */
export function pickableSections(catalog: readonly CatalogSource[]): PickSection[] {
  const byEcosystem = new Map<string, CatalogSource[]>();

  for (const source of catalog) {
    const bucket = byEcosystem.get(source.ecosystem) ?? [];

    bucket.push(source);
    byEcosystem.set(source.ecosystem, bucket);
  }

  const itemsFor = (ecosystems: readonly string[]): PickItem[] => {
    const items: PickItem[] = [];

    for (const eco of ecosystems) {
      const bundle = BUNDLE_BY_ECO[eco];

      if (bundle) {
        items.push({
          key: `b:${bundle.id}`,
          label: ECOSYSTEM_LABELS[eco] ?? bundle.title,
          logo: `/import-logos/${bundle.logo}`,
          ecosystem: eco,
          ready: true,
          objects: mergeObjects(
            (byEcosystem.get(eco) ?? [])
              .filter((source) => bundle.members.includes(source.id))
              .map((source) => objectsFor(source.category)),
          ),
          importers: [
            ...new Set(
              (byEcosystem.get(eco) ?? [])
                .filter((source) => bundle.members.includes(source.id))
                .map((source) => source.importer),
            ),
          ],
          memberNames: (byEcosystem.get(eco) ?? [])
            .filter((source) => bundle.members.includes(source.id))
            .map((source) => shortTitle(source.title)),
        });
      }

      for (const source of byEcosystem.get(eco) ?? []) {
        if (bundle?.members.includes(source.id) && !STANDALONE_MEMBERS.has(source.id)) {
          continue; // reachable through the bundle button
        }

        items.push({
          key: source.id,
          label: shortTitle(source.title),
          logo: serviceLogoUrl(source.id),
          ecosystem: eco,
          ready: source.importerReady,
          objects: objectsFor(source.category),
          importers: [source.importer],
        });
      }
    }

    return items.sort((a, b) => Number(b.ready) - Number(a.ready) || a.label.localeCompare(b.label));
  };

  const covered = new Set<string>();
  const sections: PickSection[] = [];

  for (const section of PICKER_SECTIONS) {
    const present = section.ecosystems.filter((eco) => byEcosystem.has(eco));

    if (present.length === 0) {
      continue;
    }

    present.forEach((eco) => covered.add(eco));

    const items = itemsFor(present);

    if (items.length > 0) {
      sections.push({
        key: section.key,
        label: section.label,
        icon: ECOSYSTEM_ICONS[section.icon] ?? null,
        hue: section.hue,
        items,
      });
    }
  }

  // An ecosystem the backend grew that no section claims still gets a group —
  // new sources must never be invisible for want of frontend bookkeeping.
  for (const eco of [...ECOSYSTEM_ORDER, ...byEcosystem.keys()]) {
    if (covered.has(eco) || !byEcosystem.has(eco)) {
      continue;
    }

    covered.add(eco);

    const items = itemsFor([eco]);

    if (items.length > 0) {
      sections.push({
        key: eco,
        label: ECOSYSTEM_LABELS[eco] ?? eco,
        icon: ECOSYSTEM_ICONS[eco] ?? null,
        // Unclaimed ecosystems share the 'Other' accent.
        hue: 210,
        items,
      });
    }
  }

  return sections;
}

/** One export card: a bundle, or a single picked service. */
export type ExportEntry =
  | { kind: 'bundle'; key: string; bundle: Bundle; importers: readonly string[] }
  | { kind: 'service'; key: string; source: CatalogSource; importers: readonly string[] };

/**
 * The ordered export sequence for a selection — a bundle is one card, every
 * picked service not covered by a bundle is one card, walked in the same
 * ecosystem order the picker displays.
 */
export function exportEntries(catalog: readonly CatalogSource[], picked: ReadonlySet<string>): ExportEntry[] {
  const byEcosystem = new Map<string, CatalogSource[]>();

  for (const source of catalog) {
    const bucket = byEcosystem.get(source.ecosystem) ?? [];

    bucket.push(source);
    byEcosystem.set(source.ecosystem, bucket);
  }

  const entries: ExportEntry[] = [];

  for (const eco of new Set([...ORDERED_ECOS, ...byEcosystem.keys()])) {
    const bundle = BUNDLE_BY_ECO[eco];

    if (bundle && picked.has(`b:${bundle.id}`)) {
      // Every member importer, deduplicated — what a drop on this card DECLARES
      // it is for. The run records it, and the picker's "imported ✓" credits
      // only declared ∩ detected, so a stray file inside the archive that some
      // other service's recognizer claims never lights that service's tile.
      const importers = [
        ...new Set(
          (byEcosystem.get(eco) ?? [])
            .filter((source) => bundle.members.includes(source.id))
            .map((source) => source.importer),
        ),
      ];

      entries.push({ kind: 'bundle', key: `b:${bundle.id}`, bundle, importers });
    }

    for (const source of byEcosystem.get(eco) ?? []) {
      // A standalone member is pickable on its own, so it exports on its own
      // too; a plain member is only ever reachable through its bundle's card.
      const coveredByBundle = bundle?.members.includes(source.id) && !STANDALONE_MEMBERS.has(source.id);

      if (!coveredByBundle && picked.has(source.id)) {
        entries.push({ kind: 'service', key: source.id, source, importers: [source.importer] });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Normalizers — one shape for <SourceGuide>, whatever it came from.
// ---------------------------------------------------------------------------

/** A catalog source already IS a guide, structurally. */
export function sourceToGuide(source: CatalogSource): ImportSourceGuide {
  return source;
}

/** A bundle's combined steps stand alone as its guide. */
export function bundleToGuide(bundle: Bundle): ImportSourceGuide {
  return {
    title: bundle.title,
    blurb: bundle.blurb,
    ecosystem: bundle.ecosystem,
    category: 'misc',
    wait: 'days',
    // The whole point of a bundle: every member arrives in the one archive.
    acquisition: 'one-download',
    url: bundle.url,
    steps: bundle.steps,
    notes: bundle.notes,
  };
}

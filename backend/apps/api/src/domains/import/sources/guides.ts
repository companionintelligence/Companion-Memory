/**
 * The export guides: where a person's data actually lives, and how to get it out.
 *
 * Ported from CI-Import-Tools' `wizard.ts`. This is the part of that file worth
 * carrying — roughly a hundred authored records saying "click here on
 * facebook.com, wait about a day, you will get a zip that looks like this". It
 * is the difference between an import surface that lists what it supports and
 * one that tells someone how to obtain it, at the moment they are looking for it.
 *
 * Intentionally code-as-data: a flat array of records. Adding a source is one
 * append. A source may exist here before its importer does — the guide still
 * shows, it just does not ingest anything yet.
 *
 * ## Adapted for uploads
 *
 * Upstream ended each guide by telling people to unzip their export into
 * `data/inbox/<folder>/`, because the standalone app watched a directory. Here
 * they upload the file or unzipped folder and the unpack stage expands it, so
 * every step that named an inbox path is replaced by {@link UPLOAD_STEP}.
 * Everything BEFORE it — which button on which settings page, how long the wait
 * runs, what the archive contains — is untouched, and is the part that took
 * real work to write.
 *
 * ## What did NOT come across
 *
 * The `data/inbox/` machinery itself: the readiness scanner, the boot-time purge
 * of abandoned drops, the dangling-media sweep. The uploads staging directory
 * and `ci_import.staged_sources` replace all of it.
 *
 * `inboxPath` and `signature` survive as DATA because they describe the SHAPE of
 * an export — which files it resolves to, and how to tell two sources sharing a
 * folder apart. Nothing scans a filesystem for them.
 */

/**
 * How every guide ends now.
 *
 * One sentence, identical everywhere, because the answer is identical
 * everywhere: the unpack stage expands a zip, and a dropped folder is already
 * a tree, so unzipping first is work the person does not need to do.
 */
export const UPLOAD_STEP = 'Upload the downloaded file or folder here — a zip does not need unzipping first.';

/** Roughly how soon the user can expect the export to be downloadable. */
export type WaitClass =
  | 'instant' // files already on the user's machine; no waiting
  | 'minutes' // export-then-download in the same session
  | 'hours' // typically delivered the same day
  | 'days' // 1–7 days (Google Takeout, FB, Twitter)
  | 'weeks'; // 7+ days (Spotify, some Discord)

/** Mental-model grouping the wizard surfaces as the first step. */
export type Ecosystem =
  | 'google'
  | 'apple'
  | 'meta'
  | 'microsoft'
  | 'amazon'
  | 'x'
  | 'browser'
  | 'wearable'
  | 'music'
  | 'messaging'
  | 'reading'
  | 'finance'
  | 'travel'
  | 'social'
  | 'productivity'
  | 'ai'
  | 'gaming'
  | 'streaming'
  | 'misc';

/** Domain of the resulting data — for sorting + UI grouping. */
export type Category =
  | 'mail'
  | 'messages'
  | 'photos'
  | 'video'
  | 'audio'
  | 'calendar'
  | 'contacts'
  | 'location'
  | 'health'
  | 'browser'
  | 'social'
  | 'reading'
  | 'finance'
  | 'code'
  | 'travel'
  | 'productivity'
  | 'ai'
  | 'gaming'
  | 'misc';

/** v1 / v2 / v3 wizard inclusion. */
export type Tier = 1 | 2 | 3;

/** How export bytes get to the local machine. */
export type AcquisitionKind =
  | 'web-export' // login to a web dashboard, request export, download a zip
  | 'app-export' // export from a native app (Photos, Mail, Calendar, etc.)
  | 'local-file' // bytes already on disk (chat.db, History sqlite, etc.)
  | 'api' // API key / OAuth, no file involved
  | 'manual-upload'; // user just drops files they collected themselves

/** A single export the wizard can guide the user through. */
export interface WizardSource {
  /** Stable machine name. Matches the importer name when one exists. */
  id: string;
  /** Human title for cards. */
  title: string;
  /** One-sentence pitch. */
  blurb: string;
  ecosystem: Ecosystem;
  category: Category;
  tier: Tier;
  acquisition: AcquisitionKind;
  wait: WaitClass;
  /** Deep link to the export page when possible. */
  url?: string;
  /**
   * Optional heading for the primary steps list. Defaults to "How to export"
   * in the UI. Set this when a source has more than one acquisition path and
   * the primary one needs a label to distinguish it from `altPath`.
   */
  stepsTitle?: string;
  /**
   * Step-by-step instructions the wizard renders as an ordered list. Each entry
   * is rendered as inline markdown, so a single step can carry a nested bullet
   * list — join the lines with `\n` and separate the lead-in from the bullets
   * with a blank line. Use that for per-OS variants so they stay one numbered
   * step instead of three. Backtick any path containing `\`, `{}` or `<>`;
   * outside a code span markdown eats the backslashes.
   */
  steps: string[];
  /**
   * An optional second acquisition path, rendered as its own section below the
   * primary steps. Use when a source offers two exports with different
   * tradeoffs — e.g. a quick partial download vs. a slower full data request.
   */
  altPath?: {
    /** Heading for this path's section. */
    title: string;
    /** Deep link to this path's export page, if different from `url`. */
    url?: string;
    /** Step-by-step instructions for this path. */
    steps: string[];
  };
  /**
   * What the importer actually consumes — the file/format the export resolves
   * to once unzipped (e.g. "Spotify `StreamingHistory*.json` / `endsong_*.json`
   * array", "iMessage `chat.db` SQLite"). This is the ONE place the recognized
   * format is stated; both the wizard Export step and the Docs page render it,
   * so it must match the importer's `recognize()` in `backend/src/datasources/`.
   */
  expectedFormat?: string;
  /**
   * What ends up in your timeline from this source — short bullets surfaced in
   * the shared guide so users know what the import captures (and what it won't).
   */
  whatImported?: string[];
  /**
   * Gotchas worth calling out before the user spends an hour exporting — the
   * "Caveats" section of the shared guide.
   */
  caveats?: string[];
  /**
   * Extra importer names this one export also feeds, beyond `importer`. Used
   * when a single archive is parsed by more than one importer (e.g. an Apple
   * Contacts export resolves to both `vcard` and the `apple_contacts` .abcddb
   * importer). The docs-coverage test reads this so every registered importer
   * is reachable from exactly one authored guide.
   */
  alsoImporters?: string[];
  /**
   * This source's drop folder inside the import inbox, relative to its root.
   * The inbox creates the TOP-LEVEL segment (when the importer is ready) —
   * `google-takeout/Mail` yields a `google-takeout/` folder shared by every
   * Takeout source — and a unit imported from inside it declares this
   * source's importers on the run, the same `declared_sources` a wizard card
   * sets, so the usage roll-up credits what was dropped there instead of only
   * the dominant detected source. See `sources/inboxFolders.ts`. Absent for
   * `api` sources.
   */
  inboxPath?: string;
  /**
   * File-name signatures that distinguish this source's bytes inside
   * `inboxPath`. Multiple sources can share an `inboxPath` (e.g. `chromium`
   * and `firefox` both land in `browser/`), so "is the folder non-empty?"
   * isn't a safe readiness check. When `signature` is present, the inbox
   * scanner only marks the source "ready" if at least one matching file
   * exists. When `signature` is omitted the source owns its `inboxPath`
   * exclusively and any file there counts.
   *
   * Patterns are case-insensitive. Supports exact-name match, `*.ext`, and
   * very small glob (`foo*`, `prefix-*.zip`).
   */
  signature?: string[];
  /** Name of the importer in `backend/src/datasources/` (id by default). */
  importer?: string;
  /**
   * What to record as the origin of these files — `items.data_source`, and
   * `source_system` in CI-Server. Defaults to `importer`, which is right when
   * the importer IS the source. Set it when several sources share one parser:
   * OneDrive, Dropbox, Backblaze, Koofr and Synology all run through `generic`,
   * so without this every one of them was provenance 'generic' in CI-Server and
   * a OneDrive tax document was indistinguishable from a photo dragged off a
   * NAS. The catch-all local-media drop is the one that keeps 'generic' — a
   * folder someone dropped has no truer name.
   *
   * Unlike `importer` this need not name a registered data source — nothing
   * looks an importer up by it. Changing it for an existing source
   * re-identifies that source's rows (dedup is keyed on data_source), so it is
   * a one-time decision per source. The calendar/vcard/email importers are
   * shared the same way and could use this too; they haven't been given one.
   */
  provenance?: string;
  /** True once an actual parser exists (not just a stub). */
  importerReady: boolean;
  /**
   * Notes for the user — things that surprise people. Rendered as small
   * print under the card.
   */
  notes?: string[];
}

/**
 * The catalog. Sorted by tier then ecosystem so the wizard's "what do you
 * want to back up?" picker reads naturally. Treat this list as roadmap.md
 * section 2 made executable — keep them in sync.
 */
export const WIZARD_SOURCES: WizardSource[] = [
  // ===========================================================================
  // Tier 1 — Google
  // ===========================================================================
  {
    id: 'gmail',
    title: 'Gmail (Google Takeout)',
    blurb: 'All of your Gmail as .mbox files — the biggest payload in most lives.',
    ecosystem: 'google',
    category: 'mail',
    tier: 1,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://takeout.google.com/settings/takeout/custom/gmail',
    steps: [
      'Open the link and sign in to your Google account.',
      'Confirm only "Mail" is selected (deselect everything else for a faster export).',
      'Click "Next step" → choose "Export once" → "Send download link via email" → ".zip" → "50 GB".',
      'Click "Create export". You\'ll get an email in 1–48 hours.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Google Takeout `Mail/*.mbox` (RFC-5322 mbox). The parser streams the mbox line-by-line and filters bulk/automated mail unless `CI_GMAIL_INCLUDE_BULK=1` is set.',
    whatImported: [
      'Every message with sender, recipients, subject, and date',
      'Thread relationships and inline + attached files',
      'Labels Google stored in the mbox headers',
    ],
    inboxPath: 'google-takeout/Mail',
    importer: 'gmail',
    importerReady: true,
    notes: ['Parses the Takeout .mbox including threads and attachments.'],
  },
  {
    id: 'google_photos',
    title: 'Google Photos (Takeout)',
    blurb: 'Every photo + video + the JSON sidecars Google attaches.',
    ecosystem: 'google',
    category: 'photos',
    tier: 1,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://takeout.google.com/settings/takeout/custom/photos',
    steps: [
      'Open the link and select "Google Photos".',
      'Optionally pick specific albums; default exports everything.',
      'Export once → email link → .zip → 50 GB.',
      "Create the export. You'll get an email in 1–48 hours.",
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A Takeout `Google Photos/` tree of media files, each paired with a `*.supplemental-metadata.json` (or legacy `*.json`) sidecar. `-edited` derivatives and motion photos are detected and linked.',
    whatImported: [
      'Photos and videos with their original timestamps',
      'GPS coordinates, descriptions, and album membership from the JSON sidecars',
      'Motion-photo / Live Photo pairs linked as related items',
    ],
    caveats: [
      'The `.json` sidecars hold most of the metadata — keep them next to the media, do not unzip selectively.',
    ],
    inboxPath: 'google-takeout/Google Photos',
    importer: 'google_photos',
    importerReady: true,
    notes: ['The .json sidecars are where most metadata lives — keep them.'],
  },
  {
    id: 'google_location',
    title: 'Google Location History',
    blurb: 'Every GPS ping Google ever recorded for you.',
    ecosystem: 'google',
    category: 'location',
    tier: 1,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://takeout.google.com/settings/takeout/custom/location_history',
    steps: [
      'Open the link and select "Location History (Timeline)".',
      'Export once → email link → .zip.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Takeout `Location History (Timeline)/Records.json` — the legacy account-level history of `latitudeE7`/`longitudeE7` points.',
    inboxPath: 'google-takeout/Location History',
    importer: 'google_location',
    importerReady: true,
    notes: [
      'Google has been migrating this on-device only since 2024 — if your account is new, you may have less than you expect.',
    ],
  },
  {
    id: 'google_calendar',
    title: 'Google Calendar',
    blurb: 'All calendars as .ics files.',
    ecosystem: 'google',
    category: 'calendar',
    tier: 1,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://calendar.google.com/calendar/u/0/r/settings/export',
    steps: ['Open the link and click "Export". A zip downloads immediately.', UPLOAD_STEP],
    expectedFormat:
      'Takeout `Calendar/*.ics` — one iCalendar file per calendar, parsed as `VEVENT` blocks (handles all-day `VALUE=DATE` events).',
    inboxPath: 'google-takeout/Calendar',
    importer: 'calendar',
    importerReady: true,
  },
  {
    id: 'google_contacts',
    title: 'Google Contacts',
    blurb: 'Contacts as a single .vcf file.',
    ecosystem: 'google',
    category: 'contacts',
    tier: 1,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://contacts.google.com/?hl=en',
    steps: [
      'Open Google Contacts and click "Export" in the left sidebar.',
      'Select "All contacts" → "vCard (for iOS Contacts)".',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A `.vcf` vCard file (export as "vCard (for iOS Contacts)"), parsed as `BEGIN:VCARD` blocks.',
    inboxPath: 'google-takeout/Contacts',
    importer: 'vcard',
    importerReady: true,
  },
  {
    id: 'youtube',
    title: 'YouTube history (Takeout)',
    blurb: 'Watch history, search history, likes, subscriptions, playlists.',
    ecosystem: 'google',
    category: 'video',
    tier: 1,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://takeout.google.com/settings/takeout/custom/youtube',
    steps: [
      'Open the link and select "YouTube and YouTube Music".',
      'Click "All YouTube data included" and uncheck videos/music/comments unless you want them (they\'re huge).',
      'Pick JSON for history; HTML is harder to parse.',
      'Export once → email link → .zip.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Takeout `YouTube and YouTube Music/history/watch-history.json` (and `watch-later`/playlist JSON). Choose JSON, not HTML.',
    inboxPath: 'google-takeout/YouTube and YouTube Music',
    importer: 'youtube',
    importerReady: true,
    notes: ['Untick "videos" unless you really want a copy — it can balloon to 100+ GB.'],
  },

  // ===========================================================================
  // Tier 1 — Apple
  // ===========================================================================
  {
    id: 'imessage',
    title: 'iMessage (chat.db)',
    blurb: 'Every blue and green bubble, reactions, and attachments. Mac only.',
    ecosystem: 'apple',
    category: 'messages',
    tier: 1,
    acquisition: 'local-file',
    wait: 'instant',
    steps: [
      'Open Finder and press Cmd+Shift+G.',
      'Paste: ~/Library/Messages and press Enter.',
      UPLOAD_STEP,
      'You may need to grant Terminal/Finder "Full Disk Access" in System Settings → Privacy.',
    ],
    expectedFormat:
      'The `chat.db` SQLite database from `~/Library/Messages` (optionally its `Attachments/` folder). The same database inside an unencrypted iPhone backup is also recognized.',
    whatImported: [
      'Every iMessage and SMS/MMS with timestamps',
      'Group conversations and participants',
      'Attachments, reactions, and tapbacks',
    ],
    caveats: [
      'Mac only — the database lives at `~/Library/Messages/chat.db`.',
      'You may need to grant Terminal/Finder "Full Disk Access" to copy it.',
    ],
    inboxPath: 'apple/messages',
    importer: 'imessage',
    importerReady: true,
    notes: ['Instant win. No waiting. Massive payload.'],
  },
  {
    id: 'apple_photos',
    title: 'Apple Photos',
    blurb: 'Photos + videos with full EXIF, places, and faces (on device).',
    ecosystem: 'apple',
    category: 'photos',
    tier: 1,
    acquisition: 'app-export',
    wait: 'minutes',
    steps: [
      'Easiest: point the Import page directly at ~/Pictures/Photos Library.photoslibrary — the apple_photos importer reads dates, places, and faces straight from its database.',
      UPLOAD_STEP,
      'For a full off-device archive, the Apple privacy export at https://privacy.apple.com is more complete but takes 1–7 days.',
    ],
    expectedFormat:
      'A `.photoslibrary` package (point the import directly at it) containing `database/Photos.sqlite` and the `originals/` media tree. Exported "Originals" land as plain files handled by the generic importer instead.',
    whatImported: [
      'Photos and videos with full EXIF, timestamps, and GPS',
      'Place names, titles, descriptions, keywords, favorites',
      'People and pets recognized in the library, linked as entities',
      'Edit history and album membership',
    ],
    caveats: [
      'Turn on Photos → Settings → iCloud → "Download Originals to this Mac" first, or cloud-only photos are skipped with warnings.',
      'Keep the `.photoslibrary` package intact — do not open or modify its contents.',
    ],
    inboxPath: 'apple/photos',
    importer: 'apple_photos',
    importerReady: true,
  },
  {
    id: 'apple_health',
    title: 'Apple Health',
    blurb: 'Steps, heart rate, sleep, workouts, cycles — every sensor reading you have.',
    ecosystem: 'apple',
    category: 'health',
    tier: 1,
    acquisition: 'app-export',
    wait: 'minutes',
    steps: [
      'On your iPhone, open Health.app.',
      'Tap your profile picture (top right) → scroll to "Export All Health Data".',
      'Tap "Export". Wait a few minutes — the file is big.',
      'Share to Mac (AirDrop / iCloud Drive) and unzip.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'The `export.xml` from Health → "Export All Health Data" (unzip the `export.zip` first). Parsed as `<Record>`, `<Workout>`, and `<ActivitySummary>` elements.',
    whatImported: [
      'Steps, heart rate, sleep, and every other sensor Record',
      'Workouts with type, duration, and energy',
      'Daily activity summaries',
    ],
    inboxPath: 'apple/health',
    importer: 'apple_health',
    importerReady: true,
    notes: ['Instant win on Mac+iPhone. The XML is decades of biometrics.'],
  },
  {
    id: 'apple_contacts',
    title: 'Apple Contacts',
    blurb: 'Contacts.app vCard export.',
    ecosystem: 'apple',
    category: 'contacts',
    tier: 1,
    acquisition: 'app-export',
    wait: 'minutes',
    steps: [
      'Open Contacts.app and Cmd+A to select everything.',
      'File → Export → "Export vCard…".',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'An exported `.vcf` vCard. The on-disk `AddressBook-v22.abcddb` SQLite database is also recognized directly (the `apple_contacts` importer).',
    alsoImporters: ['apple_contacts'],
    inboxPath: 'apple/contacts',
    importer: 'vcard',
    importerReady: true,
    notes: [
      'The exported .vcf imports via the vcard importer. The on-disk AddressBook-v22.abcddb database is also supported (apple_contacts importer).',
    ],
  },
  {
    id: 'apple_calendar',
    title: 'Apple Calendar',
    blurb: 'All Calendar.app calendars as .ics.',
    ecosystem: 'apple',
    category: 'calendar',
    tier: 1,
    acquisition: 'app-export',
    wait: 'minutes',
    steps: ['Open Calendar.app.', 'For each calendar in the sidebar: File → Export → Export…', UPLOAD_STEP],
    expectedFormat:
      'One `.ics` file per calendar (Calendar.app → File → Export), parsed as iCalendar `VEVENT` blocks.',
    inboxPath: 'apple/calendar',
    importer: 'calendar',
    importerReady: true,
  },

  {
    id: 'apple_music',
    title: 'Apple Music',
    blurb: 'Play history and library from Apple Music, via the Apple privacy export.',
    ecosystem: 'apple',
    category: 'audio',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://privacy.apple.com/',
    steps: [
      'Open privacy.apple.com and sign in with your Apple ID.',
      'Request a copy of your data; tick "Apple Media Services information".',
      'Apple emails a download link in 7–14 days.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'The `Apple Music Play Activity.csv` from the Apple privacy export (look for "Song Name" and "Event Start Timestamp" columns).',
    inboxPath: 'apple_music',
    signature: ['Apple Music Play Activity.csv', 'Apple Music - Play Activity.csv', '*.csv'],
    importer: 'apple_music',
    importerReady: true,
    notes: [
      'The Play Activity CSV has your full listening history with track, artist, and timestamp. Comes bundled with iTunes purchase history.',
    ],
  },
  {
    id: 'apple_tv_plus',
    title: 'Apple TV+',
    blurb: 'Watch history from Apple TV+ and the TV app, via the Apple privacy export.',
    ecosystem: 'apple',
    category: 'video',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://privacy.apple.com/',
    steps: [
      'Open privacy.apple.com and sign in.',
      'Request a copy of your data; tick "Apple Media Services information".',
      'Apple emails a download link in 7–14 days.',
      UPLOAD_STEP,
    ],
    inboxPath: 'apple_tv_plus',
    importerReady: false,
    notes: [
      'TV app watch history (Apple TV+, iTunes purchases, and third-party channels) is in the "App Store, iTunes Store & Apple Books" section of the export.',
    ],
  },

  // ===========================================================================
  // Tier 1 — Meta
  // ===========================================================================
  {
    id: 'facebook',
    title: 'Facebook',
    blurb: 'Posts, messages, photos, friends, ads, events.',
    ecosystem: 'meta',
    category: 'social',
    tier: 1,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.facebook.com/dyi/',
    steps: [
      'Open the link and choose "Download your information".',
      'Pick "All available information" or just the categories you want.',
      'Format: JSON (HTML is harder to parse).',
      'Media quality: Low keeps the export small; High keeps full-res.',
      'Click "Create file". 1–7 day wait, then a notification.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A Facebook "Download your information" export in JSON — a `your_facebook_activity/` tree with `messages/inbox/<thread>/message_*.json`, `posts/`, etc. HTML exports are also parsed, but JSON is richer.',
    whatImported: [
      'Posts, photos, and events',
      'Messenger threads (included in the same export)',
      'Friends, and ad/interest data',
    ],
    caveats: [
      'Choose JSON, not HTML.',
      'Messenger threads come with this export — no separate request needed.',
    ],
    inboxPath: 'facebook',
    importer: 'facebook',
    importerReady: true,
    notes: ['Messenger threads come with this export — no separate request needed.'],
  },
  {
    id: 'instagram',
    title: 'Instagram',
    blurb: 'DMs, posts, stories, follows, likes.',
    ecosystem: 'meta',
    category: 'social',
    tier: 1,
    acquisition: 'web-export',
    wait: 'hours',
    url: 'https://accountscenter.facebook.com/info_and_permissions/dyi/?entry_point=download_your_information&target_id',
    steps: [
      'Open Meta Accounts Center → “Download your information”, signed in with the Facebook account your Instagram is linked to.',
      'If your Instagram account is not listed, link it first: Accounts Center → Manage Accounts → “Add accounts”. Only accounts in this Accounts Center can be exported.',
      'Choose your Instagram profile. Instagram exports separately from Facebook — request Facebook as its own export if you want both.',
      'Set Date range to “All time”, Format to “JSON”, and Media quality to “High”.',
      'Click “Create files”. You’ll get an email when the download is ready (minutes to a few hours).',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'An Instagram "Download your information" export in JSON — a `your_instagram_activity/` tree with `messages/inbox/` and `posts_*.json`. HTML exports are also parsed.',
    whatImported: [
      'Posts, stories, and reels metadata',
      'Direct-message threads',
      'Followers, following, and likes',
    ],
    caveats: ['Choose JSON format when you request the export.'],
    inboxPath: 'instagram',
    importer: 'instagram',
    importerReady: true,
  },
  {
    id: 'whatsapp',
    title: 'WhatsApp',
    blurb: 'Per-chat export of messages + media.',
    ecosystem: 'meta',
    category: 'messages',
    tier: 1,
    acquisition: 'app-export',
    wait: 'minutes',
    steps: [
      'On your phone, open the WhatsApp chat you want to back up.',
      'Tap the chat title → "Export Chat" → "Attach Media" for the full archive.',
      UPLOAD_STEP,
      'Repeat per chat. There is no "export everything" button — this is a per-chat workflow.',
    ],
    expectedFormat:
      'A per-chat "Export Chat" `.zip`/`.txt` (with "Attach Media") — a line-delimited `_chat.txt` plus media. There is no all-chats export.',
    caveats: [
      'Per-chat only — there is no "export everything" button. Pick your top 5–10 conversations first.',
    ],
    inboxPath: 'whatsapp',
    importer: 'whatsapp',
    importerReady: true,
    notes: ['Annoyingly per-chat. Pick your top 5–10 conversations first.'],
  },

  // ===========================================================================
  // Tier 1 — X / Twitter
  // ===========================================================================
  {
    id: 'twitter',
    title: 'Twitter / X',
    blurb: 'Tweets, DMs, media, and the Grok chats bundled in the same archive.',
    ecosystem: 'x',
    category: 'social',
    tier: 1,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://x.com/settings/download_your_data',
    steps: [
      'Open the link and verify your password.',
      'Click "Request archive". 1–7 day wait, then an email.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'The X/Twitter archive `data/tweets.js` (a `window.YTD.tweets.part0 = […]` array); a tweets CSV is also accepted.',
    whatImported: [
      'Tweets and replies with timestamps, long-form posts at full length',
      'Direct messages and retweets',
      'Media attached to your tweets and DMs',
      'Grok conversations, which ship inside the same archive',
    ],
    inboxPath: 'twitter',
    importer: 'twitter',
    importerReady: true,
  },

  // ===========================================================================
  // Tier 1 — Browser
  // ===========================================================================
  {
    id: 'chromium',
    title: 'Chrome / Brave / Edge / Arc (browsing history)',
    blurb: "Every URL you've visited, with timestamps and visit counts.",
    ecosystem: 'browser',
    category: 'browser',
    tier: 1,
    acquisition: 'local-file',
    wait: 'instant',
    steps: [
      'Quit the browser completely (it locks the History SQLite file).',
      [
        'Find the profile folder for your OS:',
        '',
        '- **macOS:** `~/Library/Application Support/{Google/Chrome|BraveSoftware/Brave-Browser|Microsoft Edge|Arc}/Default/`',
        '- **Linux:** `~/.config/{google-chrome|BraveSoftware/Brave-Browser|microsoft-edge}/Default/`',
        '- **Windows:** `C:\\Users\\{USERNAME}\\AppData\\Local\\{Google\\Chrome|BraveSoftware\\Brave-Browser|Microsoft\\Edge|Arc}\\User Data\\Default\\`',
      ].join('\n'),
      '`Default/` is your first profile. If you use more than one profile in that browser, the others sit beside it as `Profile 1/`, `Profile 2/`, and so on — do this once per profile you want to import.',
      'Find the file(s) named `History`, without any additional text.',
      'Rename them to e.g. `History-chrome1` / `Bookmarks-chrome1` to tell several browsers or profiles apart — they all ship the same two filenames, so unrenamed copies overwrite each other in `browser/`.',
      UPLOAD_STEP,
    ],
    inboxPath: 'browser',
    expectedFormat:
      "A Chromium-family `History` SQLite file (Chrome/Brave/Edge/Arc) with `urls` + `visits` tables, and/or the profile's `Bookmarks` JSON file. One `page_view` per visit, one `bookmark` per saved link. The file itself does not say which browser wrote it, so rename it per browser (e.g. `History-brave`, `History-chrome`) — the suffix is recorded as the browser on every visit, and lets several browsers import side by side.",
    whatImported: [
      'Every URL visited, with title and timestamp',
      'Saved bookmarks, with their folder and the date added',
    ],
    caveats: [
      'Quit the browser first — it locks the History file while open.',
      'Bookmarks live in a separate `Bookmarks` file; copying only `History` imports no bookmarks.',
    ],
    // Chromium browsers all name the files `History` / `Bookmarks` (no
    // extension). Users may rename per browser; accept `-*` variants too.
    // `Bookmarks.bak` is deliberately excluded — it duplicates `Bookmarks`.
    signature: ['History', 'History-*', 'history.sqlite', 'Bookmarks', 'Bookmarks-*'],
    importer: 'chromium',
    importerReady: true,
    notes: [
      'Instant win. Surprisingly rich behavioral signal.',
      'If you have both Chromium and Firefox histories, drop them both into browser/ — the scanner tells them apart by filename.',
    ],
  },
  {
    id: 'firefox',
    title: 'Firefox (places.sqlite)',
    blurb: 'Browsing history and saved bookmarks.',
    ecosystem: 'browser',
    category: 'browser',
    tier: 1,
    acquisition: 'local-file',
    wait: 'instant',
    steps: [
      'Quit Firefox.',

      [
        'Find the most recent profile folder for your OS:',
        '',
        '- **macOS:** `~/Library/Application Support/Firefox/Profiles/<random>.default-release(-<random>)/`',
        '- **Linux:** `~/.mozilla/firefox/<random>.default-release(-<random>)/`',
        '- **Windows:** `C:\\Users\\{USERNAME}\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\<random>.default-release(-<random>)\\`',
      ].join('\n'),
      UPLOAD_STEP,
    ],
    inboxPath: 'browser',
    expectedFormat:
      'The Firefox `places.sqlite` profile database (`moz_places` + `moz_historyvisits` for history, `moz_bookmarks` for saved links). One `page_view` per visit, one `bookmark` per saved link.',
    whatImported: [
      'Every URL visited, with title, description and timestamp',
      'Saved bookmarks, with their folder and the date added',
    ],
    caveats: [
      'Quit Firefox first so the database is not locked.',
      'Tags are stored as bookmarks in Firefox; they are skipped so a tagged page is not counted twice.',
    ],
    // Firefox uses `places.sqlite`; nothing else looks like that.
    signature: ['places.sqlite'],
    importer: 'firefox',
    importerReady: true,
  },

  // ===========================================================================
  // Tier 1 — Spotify
  // ===========================================================================
  {
    id: 'spotify',
    title: 'Spotify',
    blurb: 'Streaming history (years of it), playlists, follows, library.',
    ecosystem: 'music',
    category: 'audio',
    tier: 1,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://www.spotify.com/account/privacy/',
    steps: [
      'Open the privacy page and sign in.',
      'Under "Download your data", check "Extended streaming history" if you want years (not just last year).',
      'Click "Request data". Spotify can take up to 30 days.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Spotify `StreamingHistory*.json` (last year) or extended `endsong_*.json` arrays of play records.',
    whatImported: ['Every track play with timestamp and duration', 'Playlists, follows, and saved library'],
    caveats: [
      'Tick "Extended streaming history" or you only get the last year. It can take up to 30 days to arrive.',
    ],
    inboxPath: 'spotify',
    importer: 'spotify',
    importerReady: true,
    notes: ['Extended history is the one that matters — opt into it.'],
  },

  // ===========================================================================
  // Tier 2 — Music (beyond Spotify)
  // ===========================================================================
  {
    id: 'deezer',
    title: 'Deezer',
    blurb: 'Streaming history, playlists, and liked tracks from Deezer.',
    ecosystem: 'music',
    category: 'audio',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.deezer.com/account/gdpr',
    steps: [
      'Open the Deezer privacy page (link below) and sign in.',
      'Click "Request my data"; Deezer emails a zip in a few days.',
      UPLOAD_STEP,
    ],
    inboxPath: 'deezer',
    importerReady: false,
    notes: ['The export includes listening history, playlists, search queries, and subscription details.'],
  },
  {
    id: 'last_fm',
    title: 'Last.fm',
    blurb: 'Your complete music scrobble history — every track you have ever played.',
    ecosystem: 'music',
    category: 'audio',
    tier: 2,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://www.last.fm/settings/dataexporter',
    steps: [
      'Open Last.fm Settings → "Export your data" (link below) and sign in.',
      'Click "Request Export". The CSV downloads immediately.',
      UPLOAD_STEP,
    ],
    expectedFormat: 'A Last.fm `scrobbles*.csv` (carries `uts` + `utc_time` columns).',
    inboxPath: 'last_fm',
    signature: ['*.csv'],
    importer: 'last_fm',
    importerReady: true,
    notes: ['Often millions of rows for long-time users. Instant download — rare for music services.'],
  },
  {
    id: 'soundcloud',
    title: 'SoundCloud',
    blurb: 'Your SoundCloud uploads, likes, and account data.',
    ecosystem: 'music',
    category: 'audio',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://soundcloud.com/settings/account',
    steps: [
      'Open SoundCloud → Settings → Account (link below).',
      'Scroll to "Request a copy of your SoundCloud data" and click the button.',
      'Confirm via email; SoundCloud emails a download link in a few days.',
      UPLOAD_STEP,
    ],
    inboxPath: 'soundcloud',
    importerReady: false,
  },
  {
    id: 'pandora',
    title: 'Pandora',
    blurb: 'Station history, thumbed tracks, and account data from Pandora (SiriusXM).',
    ecosystem: 'music',
    category: 'audio',
    tier: 3,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://privacy.siriusxm.com/privacy/datasubjectrequest',
    steps: [
      'Open the SiriusXM Privacy Center (link below) — Pandora is owned by SiriusXM.',
      'Select "Access my personal data" and fill in the form with your Pandora account email.',
      'Submit. SiriusXM has 45 days to fulfill the request under CCPA/GDPR.',
      UPLOAD_STEP,
    ],
    inboxPath: 'pandora',
    importerReady: false,
    notes: [
      'The export typically includes listening history, station data, thumbs up/down, and account info.',
    ],
  },

  // ===========================================================================
  // Tier 2 — additions worth including in v1 wizard if user clicks "more"
  // ===========================================================================
  {
    id: 'strava',
    title: 'Strava',
    blurb: 'Every activity with GPS, heart rate, splits.',
    ecosystem: 'wearable',
    category: 'health',
    tier: 2,
    acquisition: 'web-export',
    wait: 'hours',
    url: 'https://www.strava.com/account/delete_your_account',
    steps: [
      "Open the link — yes, this is the same page as account delete. Don't worry, the export button is separate.",
      'Click "Request your archive".',
      "You'll get an email in a few hours with a download link.",
      UPLOAD_STEP,
    ],
    expectedFormat:
      'The `activities.csv` index from a Strava bulk export (the archive also bundles per-activity `.gpx`/`.fit` files, importable on their own via the GPX guide).',
    inboxPath: 'strava',
    importer: 'strava',
    importerReady: true,
  },
  {
    id: 'fitbit',
    title: 'Fitbit / Google Fit',
    blurb: 'Steps, sleep, heart rate, and GPS from Fitbit (now a Google product).',
    ecosystem: 'wearable',
    category: 'health',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://takeout.google.com/',
    steps: [
      'Fitbit is now a Google product — its data exports via Google Takeout.',
      'Open Takeout → "Deselect all" → tick "Fit" (includes Fitbit and Google Fit data).',
      'Export once → .zip → Create export. Email arrives in 1–48 hours.',
      UPLOAD_STEP,
      'Alternatively, open the Fitbit app → Account → Export Account Data for a direct download (activity CSV only).',
    ],
    expectedFormat:
      'Takeout `Fit/` — `sleep-YYYY-MM-DD.json` files plus activity CSV/JSON (covers Fitbit and Google Fit data).',
    inboxPath: 'fitbit',
    importer: 'fitbit',
    importerReady: true,
    notes: [
      'After the 2021 Google acquisition, Fitbit data merges with Google Fit. The Takeout export includes CSV and JSON activity, sleep, and heart-rate files.',
    ],
  },
  {
    id: 'garmin',
    title: 'Garmin Connect',
    blurb: 'GPS tracks, activities, sleep, and health metrics from Garmin devices.',
    ecosystem: 'wearable',
    category: 'health',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.garmin.com/en-US/account/datamanagement/exportdata/',
    steps: [
      'Open the Garmin Data Management page (link below) and sign in.',
      'Click "Export Data" and confirm with your password.',
      'Garmin emails a download link within a few days.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A Garmin `Activities.csv` (Activity Type / Distance + Garmin-specific columns). The export also bundles `.fit`/`.gpx` activity files importable via the GPX guide.',
    inboxPath: 'garmin',
    importer: 'garmin',
    importerReady: true,
    notes: [
      'Export includes .fit and .gpx activity files plus JSON health summaries. Individual .gpx files can also be imported via the generic importer.',
    ],
  },
  {
    id: 'myfitnesspal',
    title: 'MyFitnessPal',
    blurb: 'Food diary, nutrition log, and exercise history.',
    ecosystem: 'wearable',
    category: 'health',
    tier: 3,
    acquisition: 'web-export',
    wait: 'hours',
    url: 'https://www.myfitnesspal.com/account/download_data',
    steps: [
      'Open MyFitnessPal → Settings → Account → "Download Your Data" (link below — must be logged in).',
      'Click the download request button and wait for the email (up to 24 hours).',
      'Download and unzip the archive (contains CSV files).',
      UPLOAD_STEP,
    ],
    expectedFormat: 'A MyFitnessPal `Nutrition-Summary*.csv` (Date / Calories / Protein columns).',
    inboxPath: 'myfitnesspal',
    importer: 'myfitnesspal',
    importerReady: true,
    notes: [
      'Requires a MyFitnessPal Premium subscription — free accounts can only print diary reports. Export includes food diary, custom foods, recipes, weight history, and exercise logs.',
    ],
  },
  {
    id: 'withings',
    title: 'Withings (Nokia Health)',
    blurb: 'Weight, sleep, blood pressure, and ECG from Withings devices.',
    ecosystem: 'wearable',
    category: 'health',
    tier: 3,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://account.withings.com/export/export2',
    steps: [
      'Open the Withings export page (link below) and sign in.',
      'Select the data types and date range, then click "Export".',
      'A CSV downloads within minutes.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Withings CSV export(s) — e.g. `weight.csv` with a `Date` + `(kg)` header. Covers weight, sleep, blood pressure, and SpO2.',
    inboxPath: 'withings',
    signature: ['*.csv'],
    importer: 'withings',
    importerReady: true,
    notes: [
      'Withings has a genuine self-serve export — uncommon for health data. CSVs cover weight, sleep stages, blood pressure, and SpO2.',
    ],
  },
  {
    id: 'oura',
    title: 'Oura Ring',
    blurb: 'Sleep, readiness, and activity data from your Oura Ring.',
    ecosystem: 'wearable',
    category: 'health',
    tier: 3,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://membership.ouraring.com',
    steps: [
      'Open the Oura Member portal (link below) and sign in.',
      'Go to Profile → "Export data" → "Request your data".',
      'An email arrives when the export is ready; download the CSV.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'An Oura "trends" CSV with a `date` column plus Sleep / Readiness / Activity Score columns.',
    inboxPath: 'oura',
    importer: 'oura',
    importerReady: true,
    notes: [
      'Available to all members with or without an active subscription. Duration values are in seconds (÷ 3600 for hours). Oura also has a V2 API for programmatic access.',
    ],
  },
  {
    id: 'kindle',
    title: 'Kindle highlights',
    blurb: "Every highlight from every book you've read on Kindle.",
    ecosystem: 'reading',
    category: 'reading',
    tier: 2,
    acquisition: 'web-export',
    wait: 'minutes',
    // url: 'https://read.amazon.com/notebook',
    steps: [
      // 'Open the link and sign in to your Amazon account.',
      // 'In the wizard there\'s a scraper helper that walks the notebook page and writes notebook.json.',
      // 'Alternatively: on a Kindle device, plug into your Mac and copy documents/My Clippings.txt into data/inbox/kindle/.',
      UPLOAD_STEP,
    ],
    expectedFormat: 'The `My Clippings.txt` from a Kindle device (`==========`-separated blocks)', //, or a scraped `notebook.json`.',
    inboxPath: 'kindle',
    importer: 'kindle',
    importerReady: true,
  },
  {
    id: 'goodreads',
    title: 'Goodreads',
    blurb: 'Your reading shelf — every book read, rated, and reviewed.',
    ecosystem: 'reading',
    category: 'reading',
    tier: 2,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://www.goodreads.com/review/import',
    steps: [
      'Open the Goodreads Import/Export page (link below — it doubles as the export page).',
      'Click "Export Library" — a CSV downloads immediately.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'The `goodreads_library_export.csv` (Book Id / Title / Author / Shelves / Rating / dates).',
    inboxPath: 'goodreads',
    signature: ['goodreads_library_export.csv', 'goodreads*.csv'],
    importer: 'goodreads',
    importerReady: true,
    notes: [
      'The CSV includes title, author, shelves (read/to-read), star rating, review text, and dates for every book.',
    ],
  },
  {
    id: 'letterboxd',
    title: 'Letterboxd',
    blurb: 'Your film diary — every movie watched, rated, and reviewed.',
    ecosystem: 'reading',
    category: 'misc',
    tier: 2,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://letterboxd.com/settings/data/',
    steps: [
      'Open Letterboxd Settings → "Data" tab (link below).',
      'Click "Export your data" — a zip downloads immediately.',
      'The zip contains diary.csv, ratings.csv, watchlist.csv, reviews.csv.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Letterboxd CSVs from the export zip — `diary.csv`, `ratings.csv`, `reviews.csv`, `watchlist.csv` (each carries a `Letterboxd URI` column).',
    inboxPath: 'letterboxd',
    signature: ['diary.csv', 'ratings.csv', 'reviews.csv', 'watchlist.csv'],
    importer: 'letterboxd',
    importerReady: true,
    notes: [
      'One of the best-designed data exports around: instant, well-structured CSV, with full diary (date, watch, rewatch) and review text.',
    ],
  },
  {
    id: 'reddit',
    title: 'Reddit',
    blurb: 'Posts, comments, saved, upvotes, subscribed subs.',
    ecosystem: 'social',
    category: 'social',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.reddit.com/settings/data-request',
    steps: [
      'Open the link and submit a "GDPR" request (works for everyone, not just EU).',
      'Wait 1–30 days for an email with a download link.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Reddit GDPR CSVs — `posts.csv`, `comments.csv`, `saved_posts.csv`, `saved_comments.csv`, etc.',
    inboxPath: 'reddit',
    importer: 'reddit',
    importerReady: true,
  },
  {
    id: 'flighty',
    title: 'Flighty flights',
    blurb: 'Every flight from your Flighty app.',
    ecosystem: 'travel',
    category: 'travel',
    tier: 2,
    acquisition: 'app-export',
    wait: 'minutes',
    steps: ['In Flighty, go to Profile → Export.', UPLOAD_STEP],
    expectedFormat:
      'A `FlightyExport-YYYY-MM-DD.csv` flight log (Airline / Flight / From / To / actual take-off + landing).',
    inboxPath: 'flighty',
    importer: 'flighty',
    importerReady: true,
  },
  {
    id: 'uber',
    title: 'Uber',
    blurb: 'Ride history, Uber Eats orders, and account data.',
    ecosystem: 'travel',
    category: 'travel',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://myprivacy.uber.com/exploreyourdata/download',
    steps: [
      'Open the Uber Privacy Center (link below) and sign in.',
      'Select "Get a Copy of My Uber Data" and submit the request.',
      'Uber emails a download link in a few days.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'An Uber `trips.csv` from the privacy export (ride history; the archive also includes Uber Eats orders).',
    inboxPath: 'uber',
    importer: 'uber',
    importerReady: true,
    notes: ['Export includes trip history CSV, delivery orders, and full account information.'],
  },
  {
    id: 'lyft',
    title: 'Lyft',
    blurb: 'Ride history and account data from Lyft.',
    ecosystem: 'travel',
    category: 'travel',
    tier: 3,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://account.lyft.com/privacy/data',
    steps: [
      'Open Lyft Privacy Data, most easily by following the link below, and click the "Download Data" button.',
      'Wait for the email with a download link (can take a few weeks).',
      UPLOAD_STEP,
    ],
    expectedFormat: 'A Lyft `rides.csv` from the GDPR data export (pickup/dropoff, time, fare).',
    inboxPath: 'lyft',
    importer: 'lyft',
    importerReady: true,
    notes: [
      'Ride history is visible in-app under Activity, but the data export gives a machine-readable CSV.',
    ],
  },
  {
    id: 'airbnb',
    title: 'Airbnb',
    blurb: 'Booking history, messages, and account data from Airbnb.',
    ecosystem: 'travel',
    category: 'travel',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.airbnb.com/account/privacy',
    steps: [
      'Open Airbnb → Account → Privacy (link below).',
      'Click "Request data" under "Access and portability".',
      'Wait for the email with a download link (a few days).',
      UPLOAD_STEP,
    ],
    inboxPath: 'airbnb',
    importerReady: false,
    notes: ['Export includes trips, messages, wish lists, and reviews.'],
  },
  {
    id: 'googlevoice',
    title: 'Google Voice (Takeout)',
    blurb: 'SMS, voicemail, call logs.',
    ecosystem: 'google',
    category: 'messages',
    tier: 2,
    acquisition: 'web-export',
    wait: 'hours',
    url: 'https://takeout.google.com/settings/takeout/custom/voice',
    steps: ['Open the link, confirm "Voice" is selected.', 'Export once → .zip.', UPLOAD_STEP],
    expectedFormat:
      'Takeout `Voice/Calls/*.html` (one file per SMS thread, voicemail, or call) plus an optional `Phones.vcf` phonebook.',
    inboxPath: 'google-takeout/Voice',
    importer: 'google_voice',
    importerReady: true,
  },

  // ===========================================================================
  // Tier 2 — AI assistants
  // ===========================================================================
  {
    id: 'chatgpt',
    title: 'ChatGPT (OpenAI)',
    blurb: 'Your full ChatGPT conversation history — and your saved memories.',
    ecosystem: 'ai',
    category: 'ai',
    tier: 2,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://chatgpt.com/#settings/DataControls',
    steps: [
      'Open ChatGPT → Settings → Data controls → "Export data" → Confirm export.',
      "You'll get an email with a download link within minutes (it expires in 24 hours).",
      'Download and unzip the export.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A ChatGPT export `conversations.json` — the full node `mapping` tree (distinguished from Claude by the `mapping` key). Saved memories, when present, arrive as a sibling `memories.json`.',
    whatImported: [
      'Every user + assistant turn as a message',
      'Saved memories (from memories.json) as searchable notes',
    ],
    inboxPath: 'chatgpt',
    signature: ['conversations.json', 'chat.html'],
    importer: 'chatgpt',
    importerReady: true,
    notes: [
      'We parse conversations.json — the full message tree, including edited/regenerated branches.',
      'If the export includes memories.json (your saved memories), those import too — the "bring your ChatGPT memory to your Companion" path.',
      'Images in the export (DALL-E generations, uploads — the file-… sidecar files) are imported as photos linked to their messages.',
    ],
  },
  {
    id: 'claude',
    title: 'Claude (Anthropic)',
    blurb: 'Your full Claude conversation history — and your saved memories.',
    ecosystem: 'ai',
    category: 'ai',
    tier: 2,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://claude.ai/settings/data-privacy-controls',
    steps: [
      'Open Claude → Settings → Privacy → "Export data" → Confirm.',
      "You'll get an email with a download link within minutes (it expires in 24 hours).",
      'Download and unzip the export.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      "A Claude export `conversations.json` — conversations with `chat_messages` arrays (no `mapping` key). Saved memories, when present, arrive as a sibling `memories.json` (Claude's Mar 2026 memory export). Projects, when present, arrive as a sibling `projects/` folder with one `<uuid>.json` file per Project.",
    whatImported: [
      'Every human + assistant turn as a message',
      'Saved memories (from memories.json) as searchable notes',
      'Projects (name, description, instructions, and knowledge docs) as searchable notes',
    ],
    inboxPath: 'claude',
    signature: ['conversations.json'],
    importer: 'claude',
    importerReady: true,
    notes: [
      'Since Claude added memory export (Mar 2026), an export can include memories.json — we import those as notes.',
      'Projects (name, description, custom instructions, and knowledge docs), when the export includes a projects/ folder, import as notes too.',
      'If the export ships uploaded files (a files/ folder), photos and videos are imported and linked to their messages.',
      'This only works for individual Claude accounts — Team and Enterprise plans do not allow for user data exports.',
    ],
  },
  {
    id: 'gemini',
    title: 'Gemini (Google Takeout)',
    blurb: 'Your Gemini app chat history — and your Saved Info memories.',
    ecosystem: 'ai',
    category: 'ai',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://takeout.google.com/',
    steps: [
      'Open Google Takeout → "Deselect all".',
      'Tick "My Activity", then under it choose "Gemini Apps" only — that is where the chat history lives.',
      'To also bring your memories, tick the "Gemini" product too — its export includes your "Saved Info".',
      'Export once → .zip → Create export. The email arrives in 1–48 hours.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Takeout `My Activity/Gemini Apps/MyActivity.json` (or legacy `Bard`) — an array of activity records. Memories arrive as a "Saved Info" JSON under the `Gemini` product folder.',
    whatImported: ['Each Gemini prompt as a message', 'Saved Info memories as searchable notes'],
    inboxPath: 'gemini',
    signature: ['MyActivity.json'],
    importer: 'gemini',
    importerReady: true,
    notes: [
      'Selecting only the "Gemini" product in Takeout exports Gems + Saved Info, NOT your chats — pick "My Activity → Gemini Apps" for chats, and add "Gemini" for Saved Info memories.',
      'Images referenced from MyActivity (generated or uploaded) that ship next to it are imported as photos linked to their prompts.',
    ],
  },
  {
    id: 'perplexity',
    title: 'Perplexity',
    blurb: 'Thread history and saved searches.',
    ecosystem: 'ai',
    category: 'ai',
    tier: 3,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://www.perplexity.ai/settings/account',
    steps: [
      'Open Perplexity → Settings → Account and look for a data-export option.',
      'If none is offered, email privacy@perplexity.ai requesting a data export (GDPR/CCPA — up to 30 days).',
      UPLOAD_STEP,
    ],
    inboxPath: 'perplexity',
    importerReady: false,
    notes: [
      'No reliable self-serve bulk export yet, so there is no importer — this is a request guide for now.',
    ],
  },
  {
    id: 'grok',
    title: 'Grok (xAI)',
    blurb: 'Grok conversation history, bundled inside the X data archive.',
    ecosystem: 'ai',
    category: 'ai',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://x.com/settings/download_your_data',
    steps: [
      'Grok history ships inside your X (Twitter) data archive, as data/grok-chat-item.js.',
      'Open the link → "Request archive" → confirm.',
      'Wait 1–7 days for the email, then download the .zip.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'The X/Twitter archive `data/grok-chat-item.js` (a `window.YTD.grok_chat_item.part0 = […]` array), plus any generated images in `data/grok_chat_media/`.',
    whatImported: [
      "Grok conversations, threaded by chat, with your prompts and Grok's replies",
      'Images Grok generated, from data/grok_chat_media/',
    ],
    inboxPath: 'grok',
    signature: ['data/grok-chat-item.js', 'grok*.json'],
    importer: 'grok',
    importerReady: true,
    notes: [
      'Grok is an X product; its data is bundled with the X/Twitter export. No separate export page exists.',
      'This card imports ONLY the Grok chats out of the archive. Use the Twitter / X card to import the whole thing — tweets, DMs and Grok together.',
    ],
  },

  // ===========================================================================
  // Tier 2 — Microsoft
  // ===========================================================================
  {
    id: 'linkedin',
    title: 'LinkedIn',
    blurb: 'Connections, messages, and profile from a LinkedIn data export.',
    ecosystem: 'microsoft',
    category: 'social',
    tier: 2,
    acquisition: 'web-export',
    wait: 'hours',
    url: 'https://www.linkedin.com/mypreferences/d/download-my-data',
    steps: [
      'Open LinkedIn → Settings & Privacy → Data Privacy → "Get a copy of your data".',
      'Pick "Download larger data archive" to include Connections, Messages, and more.',
      'Request, then download the email link (fast archive ~10 min; full archive up to 24 hours).',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'LinkedIn `Connections.csv` (3-line "Notes" preamble, skipped automatically) and `messages.csv`.',
    inboxPath: 'linkedin',
    signature: ['Connections.csv', 'messages.csv'],
    importer: 'linkedin',
    importerReady: true,
    notes: ['Connections.csv has a 3-line "Notes" preamble before the header — we skip it automatically.'],
  },
  {
    id: 'microsoft_account',
    title: 'Microsoft account (privacy export)',
    blurb: 'Search, browse, location, voice, and app-usage history.',
    ecosystem: 'microsoft',
    category: 'misc',
    tier: 2,
    acquisition: 'web-export',
    wait: 'hours',
    url: 'https://account.microsoft.com/privacy/download-data',
    steps: [
      'Open the Microsoft privacy dashboard → "Download your data".',
      'Choose the categories you want and create the archive (usually ready in minutes; up to 30 days).',
      'Download and unzip.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Microsoft privacy-export JSON — `ProductAndServiceUsage.json`, `ContentConsumption.json`, and siblings (read defensively; schema is undocumented).',
    inboxPath: 'microsoft/account',
    signature: ['ProductAndServiceUsage.json', 'ContentConsumption.json'],
    importer: 'microsoft_account',
    importerReady: true,
    notes: ['Microsoft does not document the per-file schema, so each JSON file is read defensively.'],
  },
  {
    id: 'outlook_mail',
    title: 'Outlook Mail',
    blurb: 'Outlook.com / Microsoft 365 mail as .eml or .mbox.',
    ecosystem: 'microsoft',
    category: 'mail',
    tier: 2,
    acquisition: 'app-export',
    wait: 'minutes',
    url: 'https://outlook.live.com/mail/',
    steps: [
      'There is no one-click web export — connect Outlook to a desktop client (Thunderbird/Apple Mail) over IMAP, or save messages as .eml.',
      'Export a folder as .mbox (Thunderbird: ImportExportTools NG) or collect .eml files.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      '`.mbox` or `.eml` files (export Outlook over IMAP via Thunderbird/Apple Mail). `.pst` archives are not parsed — convert first.',
    inboxPath: 'microsoft/mail',
    signature: ['*.eml', '*.mbox'],
    importer: 'email',
    importerReady: true,
    notes: ['.pst archives are not parsed yet — export to .mbox/.eml first.'],
  },
  {
    id: 'outlook_calendar',
    title: 'Outlook Calendar',
    blurb: 'Microsoft calendar as .ics.',
    ecosystem: 'microsoft',
    category: 'calendar',
    tier: 2,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://outlook.live.com/calendar/',
    steps: [
      'Open Outlook Calendar → Settings → Shared calendars → Publish a calendar → "Can view all details".',
      'Download the generated .ics link.',
      UPLOAD_STEP,
    ],
    expectedFormat: 'A published Outlook `.ics` calendar (iCalendar `VEVENT` blocks).',
    inboxPath: 'microsoft/calendar',
    signature: ['*.ics'],
    importer: 'calendar',
    importerReady: true,
  },
  {
    id: 'outlook_contacts',
    title: 'Outlook Contacts',
    blurb: 'Microsoft contacts as a .csv.',
    ecosystem: 'microsoft',
    category: 'contacts',
    tier: 2,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://outlook.live.com/people/',
    steps: [
      'Open Outlook People → Manage → "Export contacts" → choose all → Export.',
      'A .csv downloads immediately.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'An Outlook People `.csv` export (recognized as a contact list by its name/email columns).',
    inboxPath: 'microsoft/contacts',
    signature: ['*.csv'],
    importer: 'contact_list',
    importerReady: true,
  },
  {
    id: 'onedrive',
    title: 'OneDrive',
    blurb: 'Your OneDrive files.',
    ecosystem: 'microsoft',
    category: 'misc',
    tier: 3,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://onedrive.live.com/',
    steps: [
      'Open OneDrive on the web → select the files/folders you want → Download (you get a .zip).',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Downloaded OneDrive files — imported as generic media/documents (embedded EXIF/metadata is preserved).',
    inboxPath: 'microsoft/onedrive',
    importer: 'generic',
    // Parsed by the generic walker, but these files came from OneDrive and say
    // so in CI-Server — not 'generic', which told you only which parser ran.
    provenance: 'microsoft_onedrive',
    importerReady: true,
    notes: ['Imported as generic files — photos/docs keep their embedded metadata.'],
  },

  // ===========================================================================
  // Tier 2 — Yahoo
  // ===========================================================================
  {
    id: 'yahoo_mail',
    title: 'Yahoo Mail',
    blurb: "Your Yahoo Mail inbox exported via IMAP or Yahoo's privacy download.",
    ecosystem: 'misc',
    category: 'mail',
    tier: 2,
    acquisition: 'app-export',
    wait: 'minutes',
    url: 'https://mail.yahoo.com/',
    steps: [
      'Easiest: connect Yahoo Mail to a desktop client (Thunderbird, Apple Mail) over IMAP.',
      'In Thunderbird: install ImportExportTools NG → right-click a folder → "Export folder" → .mbox.',
      'Or use Apple Mail: select the mailbox → Mailbox → Export Mailbox → saves as .mbox.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      '`.mbox` or `.eml` files exported over IMAP (Thunderbird ImportExportTools NG, or Apple Mail → Export Mailbox).',
    inboxPath: 'yahoo_mail',
    signature: ['*.mbox', '*.eml'],
    importer: 'email',
    importerReady: true,
    notes: [
      'Yahoo Mail does not offer a one-click export — IMAP + Thunderbird is the fastest path. The email importer handles .mbox and .eml files from any provider.',
    ],
  },

  // ===========================================================================
  // Tier 2 — Messaging
  // ===========================================================================
  {
    id: 'telegram',
    title: 'Telegram',
    blurb: 'Contacts and personal chat history.',
    ecosystem: 'messaging',
    category: 'messages',
    tier: 2,
    acquisition: 'app-export',
    wait: 'minutes',
    url: 'https://telegram.org/',
    steps: [
      'Open Telegram Desktop → Settings → Advanced → "Export Telegram data".',
      'Choose "Machine-readable JSON" format, pick what to include, and export.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A Telegram Desktop "Machine-readable JSON" export — the `result.json` (plus its media folders).',
    inboxPath: 'telegram',
    signature: ['result.json'],
    importer: 'telegram',
    importerReady: true,
    notes: ['Export must be done from Telegram Desktop, not the mobile app.'],
  },
  {
    id: 'discord',
    title: 'Discord',
    blurb: 'Your message history across servers and DMs.',
    ecosystem: 'messaging',
    category: 'messages',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://support.discord.com/hc/en-us/articles/360004027692',
    steps: [
      'Open Discord → User Settings → Privacy & Safety → "Request all of my data".',
      'Wait for the email (up to ~30 days), then download the package.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A Discord data package with `messages/<channel_id>/messages.csv` (header `ID,Timestamp,Contents,Attachments`).',
    inboxPath: 'discord',
    importer: 'discord',
    importerReady: true,
  },
  {
    id: 'sms_backup_restore',
    title: 'SMS Backup & Restore (Android)',
    blurb: 'SMS/MMS archive from the Android app.',
    ecosystem: 'messaging',
    category: 'messages',
    tier: 2,
    acquisition: 'app-export',
    wait: 'minutes',
    url: 'https://www.synctech.com.au/sms-backup-restore/',
    steps: [
      'Install "SMS Backup & Restore" (SyncTech) on your Android phone.',
      'Back up your messages to an XML file.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'An SMS Backup & Restore `.xml` (a `<smses>` root with `<sms type="1">` received / `<sms type="2">` sent). Unzip Pro `.zip` backups to the `.xml` first.',
    inboxPath: 'sms-backup-restore',
    signature: ['*.xml'],
    importer: 'sms_backup_restore',
    importerReady: true,
    notes: ['Pro-version .zip backups must be unzipped to the .xml first.'],
  },
  {
    id: 'signal',
    title: 'Signal',
    blurb: 'Local encrypted message backup or desktop JSON export.',
    ecosystem: 'messaging',
    category: 'messages',
    tier: 3,
    acquisition: 'app-export',
    wait: 'instant',
    url: 'https://support.signal.org/hc/en-us/articles/360007059752',
    steps: [
      'Desktop (April 2026+): Signal Desktop → Settings → Chat history → "Export chats" → saves JSON.',
      'Android: Settings → Chats → "Chat backups" → enable, create a backup, write down the 30-digit passphrase.',
      'Copy the .backup file off your Android or the JSON from Signal Desktop.',
      UPLOAD_STEP,
    ],
    inboxPath: 'signal',
    importerReady: false,
    notes: [
      'Desktop JSON export is available as of April 2026 (beta). Android backups are encrypted — no importer yet. iOS has no native backup/export path.',
    ],
  },

  // ===========================================================================
  // Tier 2 — Social & streaming
  // ===========================================================================
  {
    id: 'disney_plus',
    title: 'Disney+',
    blurb: 'Viewing history and account data from your Disney+ subscription.',
    ecosystem: 'streaming',
    category: 'video',
    tier: 2,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://privacy.thewaltdisneycompany.com/en/current-privacy-policy/data-subject-rights-portal/',
    steps: [
      'Open the Walt Disney Privacy Center (link below) and submit a "Data Subject Rights" request.',
      'Choose "Access" or "Download my data" and provide your Disney+ account email.',
      'Verify your identity via the email link that arrives.',
      'Wait up to 45 days for the data archive. Download and unzip.',
      UPLOAD_STEP,
    ],
    inboxPath: 'disney_plus',
    importerReady: false,
    notes: [
      'Disney+ has no self-serve download button — all exports go through their DSAR (Data Subject Access Request) portal. US Hulu subscribers are redirected to the Hulu portal. No importer yet.',
    ],
  },
  {
    id: 'hulu',
    title: 'Hulu',
    blurb: 'Viewing history and account data from your Hulu subscription.',
    ecosystem: 'streaming',
    category: 'video',
    tier: 2,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://www.hulu.com/your-us-state-privacy-rights',
    steps: [
      'Open the Hulu Privacy Rights page (link below).',
      'Submit a "Right to Know / Access My Data" request and verify your identity by email.',
      'Wait up to 45 days for a download link.',
      UPLOAD_STEP,
    ],
    inboxPath: 'hulu',
    importerReady: false,
    notes: [
      'Hulu (now part of Disney) routes all CCPA/GDPR exports through a manual review process. No self-serve download button. No importer yet.',
    ],
  },
  {
    id: 'hbo_max',
    title: 'Max (HBO Max)',
    blurb: 'Viewing history and account data from your Max subscription.',
    ecosystem: 'streaming',
    category: 'video',
    tier: 2,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://www.wbdprivacy.com/access-data-request/',
    steps: [
      'Open the Warner Bros. Discovery Privacy Center (link below).',
      'Click "Access / Download my data" and verify your identity by email.',
      'Wait up to 45 days for the download link.',
      UPLOAD_STEP,
    ],
    inboxPath: 'hbo_max',
    importerReady: false,
    notes: [
      'Max (HBO Max) is part of Warner Bros. Discovery; data requests go through their shared WBD Privacy Center. No self-serve download. No importer yet.',
    ],
  },
  {
    id: 'paramount_plus',
    title: 'Paramount+',
    blurb: 'Viewing history and account data from your Paramount+ subscription.',
    ecosystem: 'streaming',
    category: 'video',
    tier: 3,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://www.paramount.com/paramount-data-subject-right-center',
    steps: [
      'Open the Paramount Data Subject Rights Center (link below).',
      'Choose "Access / Download My Data" and verify your identity by email.',
      'Wait up to 45 days for the download link.',
      UPLOAD_STEP,
    ],
    inboxPath: 'paramount_plus',
    importerReady: false,
    notes: [
      'Paramount+ DSAR requests are managed through paramount.com (not ViacomCBS). No self-serve option exists. No importer yet.',
    ],
  },
  {
    id: 'peacock',
    title: 'Peacock',
    blurb: 'Viewing history and account data from Peacock (NBCUniversal).',
    ecosystem: 'streaming',
    category: 'video',
    tier: 3,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://www.nbcuniversalprivacy.com/privacy/app-form',
    steps: [
      'Open the NBCUniversal Individual Rights Request portal (link below).',
      'Choose "Access / Download My Data", select Peacock as the service, and verify your email.',
      'Wait for a download link (timeline unspecified by NBCUniversal).',
      UPLOAD_STEP,
    ],
    inboxPath: 'peacock',
    importerReady: false,
    notes: [
      "Peacock data requests are handled by NBCUniversal's OneTrust-hosted privacy portal. No self-serve export exists. No importer yet.",
    ],
  },
  {
    id: 'crunchyroll',
    title: 'Crunchyroll',
    blurb: 'Anime watch history and account data from Crunchyroll (Sony).',
    ecosystem: 'streaming',
    category: 'video',
    tier: 3,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://www.sonyentertainmentprivacy.com/',
    steps: [
      'Open the Sony Entertainment Privacy Portal (link below).',
      'Choose "Submit a Request" → "Access / Download My Data" → select Crunchyroll.',
      'Wait for the email (up to 45 days).',
      UPLOAD_STEP,
    ],
    inboxPath: 'crunchyroll',
    importerReady: false,
    notes: [
      "Crunchyroll is now part of Sony. GDPR/CCPA requests go through Sony's privacy portal. No importer yet.",
    ],
  },
  {
    id: 'tiktok',
    title: 'TikTok',
    blurb: 'Watch history, likes, comments, and DMs.',
    ecosystem: 'social',
    category: 'video',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.tiktok.com/setting/download-your-data',
    steps: [
      'Open TikTok → Settings → Account → "Download your data".',
      'Choose "All data" and the "JSON" format (not TXT), then request.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A TikTok data export in JSON (`user_data_tiktok.json`). The TXT export cannot be parsed.',
    inboxPath: 'tiktok',
    signature: ['user_data_tiktok.json', 'user_data.json', 'tiktok.json'],
    importer: 'tiktok',
    importerReady: true,
    notes: ['Pick JSON, not TXT — the TXT export cannot be parsed.'],
  },
  {
    id: 'netflix',
    title: 'Netflix',
    blurb: 'Your viewing activity across profiles.',
    ecosystem: 'streaming',
    category: 'video',
    tier: 2,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://www.netflix.com/viewingactivity',
    stepsTitle: 'Quick history (fast, but imprecise)',
    steps: [
      'Open the Netflix Viewing Activity page (link below) — sign in if prompted.',
      'Scroll to the bottom and click "Download all".',
      'NetflixViewingHistory.csv downloads immediately. It has just a title and a date per row — no exact timestamps, no profile, device, or duration.',
      UPLOAD_STEP,
    ],
    altPath: {
      title: 'Full history (complete, takes longer)',
      url: 'https://www.netflix.com/account/getmyinfo',
      steps: [
        'Open the Netflix "Get my info" page (link below) and sign in.',
        'Request a copy of your personal information and confirm.',
        'Netflix emails you when the export is ready — this can take up to 30 days.',
        UPLOAD_STEP,
      ],
    },
    expectedFormat:
      'Netflix `ViewingActivity.csv` (full "Get my info" export — precise timestamps, profile, device, duration) or the quick `NetflixViewingHistory.csv` (title + date only).',
    inboxPath: 'netflix',
    signature: ['ViewingActivity.csv', 'NetflixViewingHistory.csv'],
    importer: 'netflix',
    importerReady: true,
  },
  {
    id: 'snapchat',
    title: 'Snapchat',
    blurb: 'Memories, chat history, and location.',
    ecosystem: 'social',
    category: 'social',
    tier: 3,
    acquisition: 'web-export',
    wait: 'hours',
    url: 'https://accounts.snapchat.com/accounts/downloadmydata',
    steps: [
      'Open accounts.snapchat.com → "My Data" → Submit Request.',
      'Download the .zip when the email arrives.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Snapchat "My Data" JSON — `snap_history.json` / `chat_history.json` (in the export root or a `json/` subfolder).',
    inboxPath: 'snapchat',
    importer: 'snapchat',
    importerReady: true,
  },
  {
    id: 'pinterest',
    title: 'Pinterest',
    blurb: 'Pins, boards, and account data.',
    ecosystem: 'social',
    category: 'social',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.pinterest.com/settings/privacy/',
    steps: [
      'Open Pinterest → Settings → Privacy and data → "Request your data".',
      'Download the archive from the email (can take a few days).',
      UPLOAD_STEP,
    ],
    inboxPath: 'pinterest',
    importerReady: false,
  },

  // ===========================================================================
  // Tier 2 — Photos & social (non-Meta)
  // ===========================================================================
  {
    id: 'flickr',
    title: 'Flickr',
    blurb: 'Your entire Flickr photo library with metadata, albums, and contacts.',
    ecosystem: 'social',
    category: 'photos',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.flickr.com/account',
    steps: [
      'Open Flickr → Account Settings → "Your Flickr Data" section (link below).',
      'Click "Request your data"; Flickr emails a download link when ready (1–3 days for large libraries).',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A flat folder of Flickr’s `photo_<id>.json` sidecars (one per photo/video) alongside the media files themselves, named `<slug>_<id>_o.<ext>`.',
    whatImported: [
      'Photos and videos with their title, description, capture date, and license',
      'GPS coordinates and tags from each photo’s JSON sidecar',
      'Album membership as collection edges, and tagged people as person entities',
    ],
    caveats: [
      'Only the photo/video library imports today — contacts and the CSV activity log in the export are not yet read.',
      'A photo whose JSON sidecar has no matching media file (e.g. only the metadata archive was unzipped) is skipped rather than imported without its bytes.',
    ],
    inboxPath: 'flickr',
    importer: 'flickr',
    importerReady: true,
    notes: [
      'Export includes all photos with EXIF, JSON metadata files per album and contact, and CSV activity data.',
    ],
  },
  {
    id: 'mastodon',
    title: 'Mastodon',
    blurb: 'Your posts, follows, bookmarks, and lists from any Mastodon instance.',
    ecosystem: 'social',
    category: 'social',
    tier: 2,
    acquisition: 'app-export',
    wait: 'minutes',
    url: 'https://mastodon.social/settings/exports',
    steps: [
      'Go to your Mastodon instance → Settings → "Import and export" → "Data export".',
      '(The link below goes to mastodon.social — replace the domain with your instance.)',
      'Click "Request your archive" for a .tar.gz of all posts and media.',
      'Also export follows, blocked, muted, and lists as CSV files from the same page.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A Mastodon ActivityPub archive — `outbox.json` (an `orderedItems` collection), ideally with `actor.json`.',
    inboxPath: 'mastodon',
    signature: ['outbox.json', 'actor.json'],
    importer: 'mastodon',
    importerReady: true,
    notes: [
      "The archive uses ActivityPub JSON-LD format. Export from your own instance, not mastodon.social, if that's where your account lives.",
    ],
  },
  {
    id: 'tumblr',
    title: 'Tumblr',
    blurb: 'Every post, photo, and reblog from your Tumblr blog.',
    ecosystem: 'social',
    category: 'social',
    tier: 2,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://www.tumblr.com/settings/blog',
    steps: [
      'Open Tumblr blog settings (link below) → scroll to the "Export" section.',
      'Click "Export [your blog name]" — a zip downloads promptly.',
      UPLOAD_STEP,
    ],
    inboxPath: 'tumblr',
    importerReady: false,
    notes: [
      'Export is a set of HTML files, one per post. Large blogs with many photos can take a few minutes to generate.',
    ],
  },
  {
    id: 'smugmug',
    title: 'SmugMug',
    blurb: 'Your SmugMug photo galleries and original files.',
    ecosystem: 'social',
    category: 'photos',
    tier: 3,
    acquisition: 'web-export',
    wait: 'hours',
    url: 'https://www.smugmug.com/account/',
    steps: [
      'Open SmugMug → Account → "Request My Data" (link below).',
      'SmugMug emails a download link within a few hours.',
      UPLOAD_STEP,
    ],
    inboxPath: 'smugmug',
    importerReady: false,
    notes: ['Backed by the Data Transfer Project — SmugMug supports both import and export of photos.'],
  },
  {
    id: 'imgur',
    title: 'Imgur',
    blurb: 'Your Imgur account images and albums.',
    ecosystem: 'social',
    category: 'photos',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://imgur.com/account/settings/privacy',
    steps: [
      'Open Imgur → Account Settings → Privacy (link below).',
      'Look for "Request a data export" or "Download my data" and submit.',
      'Imgur emails a download link within a few days.',
      UPLOAD_STEP,
    ],
    inboxPath: 'imgur',
    importerReady: false,
    notes: [
      'Anonymous (not logged-in) posts are not exported — only uploads tied to your account. Backed by the Data Transfer Project.',
    ],
  },
  {
    id: 'daybook',
    title: 'Daybook',
    blurb: 'Photos and social posts from the Daybook journaling app.',
    ecosystem: 'social',
    category: 'photos',
    tier: 3,
    acquisition: 'app-export',
    wait: 'minutes',
    steps: ['Open Daybook → Settings → Export.', 'Choose the export format and save the file.', UPLOAD_STEP],
    inboxPath: 'daybook',
    importerReady: false,
    notes: [
      'Backed by the Data Transfer Project — Daybook supports photo and social-post import. No importer yet.',
    ],
  },

  // ===========================================================================
  // Tier 2 — Productivity & notes
  // ===========================================================================
  {
    id: 'notion',
    title: 'Notion',
    blurb: 'All your Notion pages and databases as Markdown, CSV, or HTML.',
    ecosystem: 'productivity',
    category: 'productivity',
    tier: 2,
    acquisition: 'app-export',
    wait: 'minutes',
    steps: [
      'Open Notion → click your workspace name (top left) → Settings.',
      'Go to the "Settings" tab → scroll to "Export content" → "Export all workspace content".',
      'Choose format: "Markdown & CSV" is most portable; "HTML" also works.',
      'A zip downloads automatically (large workspaces may take a minute).',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A Notion "Markdown & CSV" export — `.md` pages (with optional `Created:` property lines) and database `.csv` files.',
    inboxPath: 'notion',
    importer: 'notion',
    importerReady: true,
    notes: [
      'Databases export as CSV; pages export as Markdown. Nested pages become nested folders. Comments and version history are not included.',
    ],
  },
  {
    id: 'evernote',
    title: 'Evernote',
    blurb: 'Notes, notebooks, and attachments as .enex files.',
    ecosystem: 'productivity',
    category: 'productivity',
    tier: 2,
    acquisition: 'app-export',
    wait: 'minutes',
    url: 'https://evernote.com/',
    steps: [
      'Use the Evernote desktop app (the web app cannot export full archives).',
      'Right-click a notebook in the sidebar → "Export Notebook…" → ".enex format".',
      'Or: File → Export All Notes → .enex to grab everything at once.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Evernote `.enex` exports (XML `<en-export><note>` notebooks). Only the desktop app can export — the web app cannot.',
    inboxPath: 'evernote',
    signature: ['*.enex'],
    importer: 'evernote',
    importerReady: true,
    notes: [
      '.enex is XML containing notes, embedded HTML, and attachments. Only the Mac/Windows desktop app can export; the web app cannot.',
    ],
  },
  {
    id: 'remember_the_milk',
    title: 'Remember the Milk',
    blurb: 'Your tasks from a Remember the Milk account export.',
    ecosystem: 'productivity',
    category: 'productivity',
    tier: 3,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://www.rememberthemilk.com/app/#settings/account',
    steps: [
      'Open Remember the Milk (web or desktop app) → click the Settings gear (top right).',
      'Choose "Account settings" → "Export" in the left menu.',
      'Click "Download Export" for the JSON format (the iCalendar link next to it is more limited — skip it).',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'RTM\'s account "Download Export" JSON — a `{ "tasks": [ { "name", "date_completed"?, ... } ] }` file. RTM does not publish a schema for it, so only the two fields a real downloaded export was confirmed to carry (github.com/feoh/forgetthemilk) are imported.',
    whatImported: ["Each task's title", 'Whether the task is completed'],
    inboxPath: 'remember_the_milk',
    importer: 'remember_the_milk',
    importerReady: true,
    notes: [
      "RTM's Help Center documents the export button but not the JSON layout, and RTM has not published one — so due dates, notes, tags, priority, and list names are not imported yet, only each task's title and completed/not-completed status.",
    ],
  },

  // ===========================================================================
  // Tier 3 — Gaming
  // ===========================================================================
  {
    id: 'roblox',
    title: 'Roblox',
    blurb: 'Account, login, purchase, and chat history.',
    ecosystem: 'gaming',
    category: 'gaming',
    tier: 3,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://en.help.roblox.com/hc/en-us/articles/40630460625556-Right-to-Access-Reports',
    steps: [
      'Submit a Roblox support request: category "Data Privacy Requests" → "Right of Access".',
      'Roblox verifies your identity, then posts a download link to your Roblox inbox (up to ~45 days; the link expires after 7 days).',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A Roblox "Right to Access" report (undocumented CSV/JSON files; ingested best-effort, classified from filename).',
    inboxPath: 'roblox',
    importer: 'roblox',
    importerReady: true,
    notes: [
      'Roblox does not publish the report file format, so we ingest its CSV/JSON files on a best-effort basis.',
    ],
  },
  {
    id: 'steam',
    title: 'Steam',
    blurb: 'Playtime, purchases, and account data.',
    ecosystem: 'gaming',
    category: 'gaming',
    tier: 3,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://help.steampowered.com/en/wizard/HelpWithSteamIssue/?issueid=417',
    steps: [
      'Open the Steam Support page (link below) and sign in, then request a copy of your Steam account data.',
      'Steam emails you when the archive is ready — this usually takes a few days to a few weeks.',
      UPLOAD_STEP,
    ],
    inboxPath: 'steam',
    importerReady: false,
  },
  {
    id: 'twitch',
    title: 'Twitch',
    blurb: 'Subscriptions, channel points, and chat.',
    ecosystem: 'gaming',
    category: 'gaming',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.twitch.tv/settings/security',
    steps: [
      'Open Twitch → Settings → Security & Privacy → "Request Data Export".',
      'Download the archive from the email (up to ~30 days).',
      UPLOAD_STEP,
    ],
    inboxPath: 'twitch',
    importerReady: false,
  },

  // ===========================================================================
  // Tier 3 — Shopping & finance
  // ===========================================================================
  {
    id: 'instacart',
    title: 'Instacart',
    blurb: 'Grocery order history from your Instacart account.',
    ecosystem: 'finance',
    category: 'finance',
    tier: 3,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://www.instacart.com/accounts/privacy',
    steps: [
      'Open Instacart → Account → Privacy (link below).',
      'Click "Request your data" or "Download my data".',
      'Confirm the request by email.',
      'Wait for the archive (up to 30 days).',
      UPLOAD_STEP,
    ],
    inboxPath: 'instacart',
    importerReady: false,
    notes: [
      'Instacart exports include order history, delivery addresses, and browsing data. No importer yet.',
    ],
  },
  {
    id: 'walmart',
    title: 'Walmart',
    blurb: 'Order and purchase history from your Walmart account.',
    ecosystem: 'finance',
    category: 'finance',
    tier: 3,
    acquisition: 'web-export',
    wait: 'weeks',
    url: 'https://www.walmart.com/account/privacyportal',
    steps: [
      'Open Walmart → Account → Privacy Portal (link below).',
      'Choose "Access / Download My Data" and submit the form.',
      'Verify your identity via email.',
      'Wait for the archive (up to 45 days).',
      UPLOAD_STEP,
    ],
    inboxPath: 'walmart',
    importerReady: false,
    notes: [
      'Walmart order history is also visible in-app under Account → Purchase History, but no machine-readable export exists without the privacy request. No importer yet.',
    ],
  },
  // --- Amazon ---------------------------------------------------------------
  // One Privacy Central flow serves every `amazon`-ecosystem source: each can
  // be requested as its own category export, and "Request All Your Data"
  // yields one archive carrying all of them — the frontend collapses the five
  // into a single bundle card. The standalone and all-data archives use
  // different layouts and column dialects; the importers read both.
  {
    id: 'amazon',
    title: 'Amazon orders',
    blurb: 'Order history — retail, digital, and Audible purchases.',
    ecosystem: 'amazon',
    category: 'finance',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.amazon.com/hz/privacy-central/data-requests/preview.html',
    steps: [
      'Open Amazon Privacy Central → "Request Your Data" → choose "Your Orders" (or "Request All Your Data" — one archive covers every Amazon source here) → Submit.',
      'Confirm the request by email. A single-category export usually arrives within days; the full archive can take up to 30.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'An Amazon orders CSV in any of its dialects: `Order History.csv` (standalone "Your Orders" export) ' +
      'or `Retail.OrderHistory*.csv` (the all-data archive), plus the digital ledger `Digital Items.csv` ' +
      'and the Audible `Purchase History.csv` when the archive carries them.',
    inboxPath: 'amazon',
    signature: ['Order History.csv', 'Retail.OrderHistory*', 'Digital Items.csv', 'Purchase History.csv'],
    importer: 'amazon',
    importerReady: true,
  },
  {
    id: 'prime_video',
    title: 'Prime Video',
    blurb: 'Viewing history — what you watched, and when.',
    ecosystem: 'amazon',
    category: 'video',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.amazon.com/hz/privacy-central/data-requests/preview.html',
    steps: [
      'Open Amazon Privacy Central → "Request Your Data" → choose "Prime Video" (or "Request All Your Data") → Submit.',
      'Confirm the request by email and download the zip when it arrives.',
      UPLOAD_STEP,
    ],
    expectedFormat: 'The `PrimeVideo.ViewingHistory.csv` from an Amazon data export.',
    inboxPath: 'amazon',
    signature: ['PrimeVideo.ViewingHistory*'],
    importer: 'prime_video',
    importerReady: true,
  },
  {
    id: 'audible',
    title: 'Audible',
    blurb: 'Listening history — every audiobook session.',
    ecosystem: 'amazon',
    category: 'audio',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.amazon.com/hz/privacy-central/data-requests/preview.html',
    steps: [
      'Open Amazon Privacy Central → "Request Your Data" → choose "Audible" (or "Request All Your Data") → Submit.',
      'Confirm the request by email and download the zip when it arrives.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'The Audible `Listening History.csv` from an Amazon data export, enriched from the sibling ' +
      '`Library.csv` when present. Audible purchases ride the Amazon orders source instead.',
    inboxPath: 'amazon',
    signature: ['Listening History.csv'],
    importer: 'audible',
    importerReady: true,
  },
  {
    id: 'kindle_reading',
    title: 'Kindle reading',
    blurb: 'Reading sessions — which book, when, and for how long.',
    ecosystem: 'amazon',
    category: 'reading',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.amazon.com/hz/privacy-central/data-requests/preview.html',
    steps: [
      'Open Amazon Privacy Central → "Request Your Data" → choose "Kindle" (or "Request All Your Data") → Submit.',
      'Confirm the request by email and download the zip when it arrives.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      '`Kindle.Devices.ReadingSession_v0.csv` or the `Kindle.reading-insights-sessions` CSV from an ' +
      'Amazon data export; book titles joined from `Digital Items.csv` when present.',
    inboxPath: 'amazon',
    signature: ['Kindle.Devices.ReadingSession*', 'Kindle.reading-insights-sessions*'],
    importer: 'kindle_reading',
    importerReady: true,
  },
  {
    id: 'amazon_music',
    title: 'Amazon Music',
    blurb: 'Music library — saved tracks, playlists, and followed artists.',
    ecosystem: 'amazon',
    category: 'audio',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://www.amazon.com/hz/privacy-central/data-requests/preview.html',
    steps: [
      'Open Amazon Privacy Central → "Request Your Data" → choose "Amazon Music" (or "Request All Your Data") → Submit.',
      'Confirm the request by email and download the zip when it arrives.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'The "Your Music Library" CSVs from an Amazon data export (`Saved Music.csv`, `Playlists.csv`, ' +
      '`Followed Artists and Accounts.csv`) — a library snapshot, not listening history.',
    inboxPath: 'amazon',
    signature: ['Saved Music.csv', 'Playlists.csv', 'Followed Artists and Accounts.csv'],
    importer: 'amazon_music',
    importerReady: true,
  },
  {
    id: 'paypal',
    title: 'PayPal',
    blurb: 'Transaction history.',
    ecosystem: 'finance',
    category: 'finance',
    tier: 3,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://www.paypal.com/reports/dlog',
    steps: [
      'Open PayPal → Activity → "Statements & Documents" (Download button) → download an activity report as CSV (monthly or custom date range).',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A PayPal activity report CSV (Date + Transaction ID columns; a UTF-8 BOM / preamble is tolerated).',
    inboxPath: 'paypal',
    importer: 'paypal',
    importerReady: true,
  },
  {
    id: 'coinbase',
    title: 'Coinbase',
    blurb: 'Crypto transaction history from your Coinbase account.',
    ecosystem: 'finance',
    category: 'finance',
    tier: 3,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://accounts.coinbase.com/statements',
    steps: [
      'Open Coinbase → Manage Account → Statements → download monthtly statements as CSV OR generate custom statement for each year as CSV.',
      'Or via the privacy portal (https://coinbase.com/settings/privacy-rights) → "Request Export" (NOT "Request Data").',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A Coinbase transaction CSV (Quantity Transacted + Spot Price columns; the privacy-portal "Request Export" also works).',
    inboxPath: 'coinbase',
    signature: ['*.csv'],
    importer: 'coinbase',
    importerReady: true,
    notes: ['The transaction CSV is useful for tax purposes. The GDPR export is more complete but slower.'],
  },
  {
    id: 'venmo',
    title: 'Venmo',
    blurb: 'Transaction history and account data from Venmo.',
    ecosystem: 'finance',
    category: 'finance',
    tier: 3,
    acquisition: 'web-export',
    wait: 'minutes',
    url: `https://account.venmo.com/api/statement/download?startDate=2010-01-01&endDate=${new Date().toISOString().slice(0, 10)}&csv=true`,
    steps: [
      'Log into your Venmo account',
      `Navigate to https://account.venmo.com/api/statement/download?startDate=2010-01-01&endDate=${new Date().toISOString().slice(0, 10)}&csv=true`,
      'Your export CSV should download automatically, but it may get sent to your linked email within a few minutes',
      UPLOAD_STEP,
    ],
    expectedFormat: 'A Venmo statement CSV of your transaction history (date, party, amount, note).',
    inboxPath: 'venmo',
    signature: ['*.csv'],
    importer: 'venmo',
    importerReady: true,
  },
  {
    id: 'robinhood',
    title: 'Robinhood',
    blurb: 'Brokerage/retirement transaction history — trades, dividends, and transfers.',
    ecosystem: 'finance',
    category: 'finance',
    tier: 3,
    acquisition: 'web-export',
    wait: 'hours',
    url: 'https://robinhood.com/account/reports-statements/activity-reports',
    steps: [
      'Open Robinhood → Account → Reports and Statements → "Generate a New Report" (or go straight to the URL above).',
      'Pick a date range and generate the report; download it as a CSV once it finishes (usually minutes, but can take up to 24 hours at peak times).',
      UPLOAD_STEP,
    ],
    altPath: {
      title:
        'Full CCPA/GDPR data request (slower, broader — a different export this importer does not parse)',
      url: 'https://robinhood.com/account/settings',
      steps: [
        'Open Robinhood → Account → Settings → look for a "Privacy" or "Data Request" section.',
        'Submit a CCPA/GDPR access request and wait for the emailed download link (a few days).',
      ],
    },
    expectedFormat:
      'A Robinhood transaction-history CSV ("Activity Date"/"Trans Code"/"Instrument" columns) from Reports and Statements → "Generate a New Report". Recognizes buys/sells, cash dividends, interest, ACH transfers, the Gold fee, and stock-split/option-lifecycle rows; any other Trans Code is skipped rather than guessed.',
    whatImported: [
      'Buys and sells, with the security, quantity, and price',
      'Cash dividends, interest, and ACH bank transfers',
      'Stock splits and other corporate-action / option-lifecycle rows the report itself records',
    ],
    inboxPath: 'robinhood',
    signature: ['*.csv'],
    importer: 'robinhood',
    importerReady: true,
    caveats: [
      'Futures, crypto, and the spending account are excluded from this export by Robinhood itself, not just this importer.',
      'The CCPA/GDPR data request is a separate bundle and is not recognized by this importer — use the CSV activity report above.',
    ],
  },

  // ===========================================================================
  // Tier 3 — Cloud storage / photo destinations (Data Transfer Project)
  // ===========================================================================
  {
    id: 'dropbox',
    title: 'Dropbox',
    blurb: 'Your Dropbox files downloaded locally.',
    ecosystem: 'misc',
    category: 'misc',
    tier: 3,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://www.dropbox.com/',
    steps: [
      'Fastest: open Dropbox on the web, select files/folders → "Download" (downloads a .zip).',
      'For account metadata + full export: Account → Settings → Security → "Export your account data".',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Downloaded Dropbox files — imported as generic media/documents (embedded EXIF/metadata preserved).',
    inboxPath: 'dropbox',
    importer: 'generic',
    provenance: 'dropbox',
    importerReady: true,
    notes: [
      'Downloaded Dropbox files import as generic files — photos and documents keep their embedded metadata.',
    ],
  },
  {
    id: 'backblaze',
    title: 'Backblaze',
    blurb: 'Photos and videos stored in Backblaze B2 cloud backup.',
    ecosystem: 'misc',
    category: 'photos',
    tier: 3,
    acquisition: 'web-export',
    wait: 'hours',
    url: 'https://secure.backblaze.com/user_signin.htm',
    steps: [
      'Sign in to Backblaze → B2 Cloud Storage → select your bucket.',
      'Download the files or folders you want to restore.',
      UPLOAD_STEP,
    ],
    expectedFormat: 'Files restored from a Backblaze B2 bucket — imported as generic media (EXIF preserved).',
    inboxPath: 'backblaze',
    importer: 'generic',
    provenance: 'backblaze',
    importerReady: true,
    notes: [
      'Backblaze is a Data Transfer Project destination (photo/video import). Photos import via the generic importer.',
    ],
  },
  {
    id: 'koofr',
    title: 'Koofr',
    blurb: 'Photos and videos stored in Koofr cloud storage.',
    ecosystem: 'misc',
    category: 'photos',
    tier: 3,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://app.koofr.net/',
    steps: ['Open Koofr → select the files/folders you want → Download.', UPLOAD_STEP],
    expectedFormat: 'Files downloaded from Koofr — imported as generic media/documents.',
    inboxPath: 'koofr',
    importer: 'generic',
    provenance: 'koofr',
    importerReady: true,
    notes: [
      'Koofr is a European cloud storage service in the Data Transfer Project. Photos import via the generic importer.',
    ],
  },
  {
    id: 'synology',
    title: 'Synology Photos',
    blurb: 'Photos and videos from your Synology NAS.',
    ecosystem: 'misc',
    category: 'photos',
    tier: 3,
    acquisition: 'local-file',
    wait: 'instant',
    steps: [
      'On your Synology NAS, open File Station and navigate to your Photos folder.',
      'Select the folders you want → Download (or copy them directly if on the same network).',
      UPLOAD_STEP,
    ],
    expectedFormat: 'Photos/videos copied off Synology Photos — imported as generic media with full EXIF.',
    inboxPath: 'synology',
    importer: 'generic',
    provenance: 'synology',
    importerReady: true,
    notes: [
      'Synology Photos is a Data Transfer Project partner. Photos import via the generic importer with full EXIF metadata.',
    ],
  },

  // ===========================================================================
  // Google Takeout sub-products — folded into the Google bundle drop, listed
  // here so each registered importer has its own authored guide.
  // ===========================================================================
  {
    id: 'google_my_activity',
    title: 'Google My Activity',
    blurb: 'Search, Maps, Assistant, and product activity from Google My Activity.',
    ecosystem: 'google',
    category: 'misc',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://takeout.google.com/settings/takeout/custom/my_activity',
    steps: [
      'Open Google Takeout → "Deselect all" → tick "My Activity".',
      'Use the "Multiple formats" button and set My Activity to HTML (the importer reads the HTML view).',
      'Export once → .zip → Create export. The email arrives in 1–48 hours.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Takeout `My Activity/<product>/MyActivity.html` — per-product activity pages (parsed from the `mdl-typography--body-1` cells).',
    inboxPath: 'google-takeout/My Activity',
    importer: 'google_my_activity',
    importerReady: true,
    notes: [
      'Gemini chats live under My Activity → "Gemini Apps"; import those via the Gemini guide instead.',
    ],
  },
  {
    id: 'google_maps_places',
    title: 'Google Maps (your places)',
    blurb: 'Saved places and the reviews you have left on Google Maps.',
    ecosystem: 'google',
    category: 'location',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://takeout.google.com/settings/takeout/custom/maps_my_places',
    steps: [
      'Open Google Takeout → "Deselect all" → tick "Maps (your places)".',
      'Export once → .zip → Create export. Email arrives in 1–48 hours.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Takeout `Saved Places.json` and/or `Reviews.json` — GeoJSON FeatureCollections of point places (reviews carry ratings).',
    inboxPath: 'google-takeout/Maps',
    importer: 'google_maps_places',
    importerReady: true,
  },
  {
    id: 'google_keep',
    title: 'Google Keep',
    blurb: 'Your Google Keep notes and checklists.',
    ecosystem: 'google',
    category: 'productivity',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://takeout.google.com/settings/takeout/custom/keep',
    steps: [
      'Open Google Takeout → "Deselect all" → tick "Keep".',
      'Export once → .zip → Create export. Email arrives in 1–48 hours.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Takeout `Keep/*.json` — one JSON per note (with `userEditedTimestampUsec`). Trashed notes are skipped.',
    inboxPath: 'google-takeout/Keep',
    importer: 'google_keep',
    importerReady: true,
  },
  {
    id: 'google_chrome',
    title: 'Google Chrome (Takeout)',
    blurb: 'Browsing history and bookmarks from a Google Takeout Chrome export.',
    ecosystem: 'google',
    category: 'browser',
    tier: 2,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://takeout.google.com/settings/takeout/custom/chrome',
    steps: [
      'Open Google Takeout → "Deselect all" → tick "Chrome".',
      'Export once → .zip → Create export. Email arrives in 1–48 hours.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Takeout `Chrome/History.json` (`{ "Browser History": [ { url, title, time_usec, … } ] }`; `time_usec` is microseconds) and/or `Chrome/Bookmarks.html` (a Netscape-bookmark document, `ADD_DATE` in seconds). One `page_view` per visit, one `bookmark` per saved link.',
    inboxPath: 'google-takeout/Chrome',
    importer: 'google_chrome',
    importerReady: true,
    caveats: [
      'Distinct from the live-browser "Chrome / Brave / Edge / Arc" source — this reads a Takeout export (History.json / Bookmarks.html), not the live History SQLite database.',
    ],
  },
  {
    id: 'google_purchases',
    title: 'Google Purchases & Reservations',
    blurb: 'Orders, bookings, and reservations Google has on file for you.',
    ecosystem: 'google',
    category: 'finance',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://takeout.google.com/',
    steps: [
      'Open Google Takeout → "Deselect all" → tick "Purchases & Reservations".',
      'Export once → .zip → Create export. Email arrives in 1–48 hours.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Takeout `Purchases & Reservations/action_*.json` — per-record purchase, order, booking, or waitlist files.',
    inboxPath: 'google-takeout/Purchases',
    importer: 'google_purchases',
    importerReady: true,
  },
  {
    id: 'google_fit',
    title: 'Google Fit',
    blurb: 'Daily activity metrics and workout sessions from Google Fit.',
    ecosystem: 'google',
    category: 'health',
    tier: 3,
    acquisition: 'web-export',
    wait: 'days',
    url: 'https://takeout.google.com/settings/takeout/custom/fit',
    steps: [
      'Open Google Takeout → "Deselect all" → tick "Fit".',
      'Export once → .zip → Create export. Email arrives in 1–48 hours.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'Takeout `Fit/Daily activity metrics/YYYY-MM-DD.csv` plus `All Sessions/*.json` and `Activities/*.tcx`.',
    inboxPath: 'google-takeout/Fit',
    importer: 'google_fit',
    importerReady: true,
    notes: [
      'Fitbit data is bundled into the same "Fit" export — see the Fitbit guide if you only use Fitbit.',
    ],
  },

  // ===========================================================================
  // Developer
  // ===========================================================================
  {
    id: 'github',
    title: 'GitHub',
    blurb: 'The repositories you have starred on GitHub.',
    ecosystem: 'misc',
    category: 'code',
    tier: 3,
    acquisition: 'web-export',
    wait: 'minutes',
    url: 'https://github.com/settings/admin',
    steps: [
      'Open GitHub → Settings → Account → "Export account data" and request your archive (emailed in a few minutes).',
      'Unzip and find `starred_repositories.json`.',
      'Alternatively, use a stars exporter (e.g. ghstars) to produce a `ghstars.json`.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A `starred_repositories*.json` or `ghstars*.json` — a JSON array of starred-repo objects.',
    inboxPath: 'github',
    signature: ['starred_repositories*.json', 'ghstars*.json'],
    importer: 'github',
    importerReady: true,
    notes: [
      'Only your stars are imported today. A GitHub personal access token (github.token in Settings) is not required for the file export.',
    ],
  },

  // ===========================================================================
  // Location file formats — drop raw track files you already have. Each is its
  // own importer; the wizard also auto-recognizes these inside any dropped
  // folder, so you usually do not need to pick them explicitly.
  // ===========================================================================
  {
    id: 'gpx',
    title: 'GPX (GPS Exchange)',
    blurb: 'Raw .gpx tracks from a GPS device or fitness/tracking app.',
    ecosystem: 'misc',
    category: 'location',
    tier: 2,
    acquisition: 'manual-upload',
    wait: 'instant',
    steps: [
      'Export GPX from your source: Garmin Connect (Activity → gear → "Export to GPX"), Strava (activity → "Export GPX"), or apps like OsmAnd / Komoot / AllTrails.',
      'Garmin devices also expose `.gpx` files directly under their `Activities/`/`GPX` folder over USB.',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'One or more `.gpx` files — XML adhering to the GPX 1.1 schema (`<trk><trkseg><trkpt>` and `<wpt>`).',
    whatImported: [
      'Track points (lat/lon) in route order',
      'Elevation, timestamps, and track type when present',
      'Speed/course where the file includes them',
    ],
    caveats: [
      'GPX files without timestamps import as spatial-only (no timeline position).',
      'Heart-rate / cadence GPX extensions may not be fully captured.',
    ],
    inboxPath: 'gpx',
    importer: 'gpx',
    importerReady: true,
  },
  {
    id: 'geojson',
    title: 'GeoJSON',
    blurb: 'Location data in the GeoJSON interchange format.',
    ecosystem: 'misc',
    category: 'location',
    tier: 2,
    acquisition: 'manual-upload',
    wait: 'instant',
    steps: [
      'Obtain or export a `.geojson` file (many mapping tools and some location exporters produce it).',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A `.geojson` FeatureCollection of Point / LineString / MultiPoint / MultiLineString features.',
    inboxPath: 'geojson',
    importer: 'geojson',
    importerReady: true,
  },
  {
    id: 'kml_gx',
    title: 'KML (Google gx:Track)',
    blurb: 'KML location tracks using the Google Earth gx:Track extension.',
    ecosystem: 'misc',
    category: 'location',
    tier: 3,
    acquisition: 'manual-upload',
    wait: 'instant',
    steps: [
      'Export KML from a tool that emits the Google `gx:Track` extension (e.g. Google Earth, some Timeline exporters).',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A `.kml` file declaring `xmlns:gx`, with `<gx:Track>` `<when>` + `<gx:coord>` time/coordinate pairs.',
    inboxPath: 'kml',
    importer: 'kmlgx',
    importerReady: true,
    notes: ['Plain KML without the gx:Track extension is not parsed for location paths today.'],
  },
  {
    id: 'nmea',
    title: 'NMEA 0183',
    blurb: 'Raw GPS sentence logs from a GPS receiver or logger.',
    ecosystem: 'misc',
    category: 'location',
    tier: 3,
    acquisition: 'manual-upload',
    wait: 'instant',
    steps: ['Save the NMEA log from your GPS logger (commonly `.nmea`, `.log`, or `.txt`).', UPLOAD_STEP],
    expectedFormat:
      'A text log of NMEA sentences beginning with `$GPRMC` / `$GPGGA` (date + fix, with altitude).',
    inboxPath: 'nmea',
    signature: ['*.nmea', '*.log', '*.txt'],
    importer: 'nmea',
    importerReady: true,
  },

  // ===========================================================================
  // Generic media — any folder of photos/videos/audio you already have.
  // ===========================================================================
  {
    id: 'media',
    title: 'Photos, videos & audio (folder)',
    blurb: 'A folder of media files — camera roll, scanned photos, downloads, a NAS album.',
    ecosystem: 'misc',
    category: 'photos',
    tier: 1,
    acquisition: 'manual-upload',
    wait: 'instant',
    steps: [
      "Gather the media into a folder — e.g. copy a camera SD card's DCIM folder, or a phone's Pictures folder, onto your computer.",
      'Optionally organize into subfolders by date or event (folders can become albums).',
      UPLOAD_STEP,
    ],
    expectedFormat:
      'A folder made up mostly of image/video/audio files (JPEG/HEIC/PNG/RAW, MP4/MOV/MKV, MP3/M4A/FLAC, …). EXIF/XMP and video container metadata are read; files are never modified.',
    whatImported: [
      'Each photo/video/audio item with its best-available timestamp',
      'Embedded EXIF/XMP metadata and GPS',
      'Live Photos (HEIC + MOV/MP4 sidecars) linked together',
      'Folder names as albums when you enable that option',
    ],
    caveats: [
      'Screenshots are imported alongside photos — remove them first if you do not want them.',
      'Scanned photos often carry the scan date; organize them into date folders and set a date range so the folder date wins.',
    ],
    inboxPath: 'media',
    importer: 'generic',
    importerReady: true,
    notes: [
      'This is the catch-all media importer (the same one behind Dropbox/OneDrive/NAS imports). For full faces/places use the Apple Photos or Google Photos guides instead.',
    ],
  },
];

/** Lookup helpers. */
export function getSource(id: string): WizardSource | undefined {
  return WIZARD_SOURCES.find((s) => s.id === id);
}

export function sourcesByEcosystem(): Record<Ecosystem, WizardSource[]> {
  const out = {} as Record<Ecosystem, WizardSource[]>;
  for (const s of WIZARD_SOURCES) {
    (out[s.ecosystem] ||= []).push(s);
  }

  return out;
}

export function sourcesByTier(tier: Tier): WizardSource[] {
  return WIZARD_SOURCES.filter((s) => s.tier === tier);
}

/**
 * The importer names whose ingested items COUNT UNDER a wizard source: its
 * primary importer plus the `alsoImporters` companions attributed to it.
 *
 * A bundle drop fans out to companions (an Amazon "All Data Categories"
 * archive also feeds prime_video / audible / kindle_reading / amazon_music),
 * and each companion tags its items with its own importer name. Counting only
 * the primary importer showed a fraction of what the drop actually imported —
 * a real archive read "3,665 items imported" for amazon while the run had
 * ingested ~10k across its companions, none of which have a wizard card of
 * their own.
 *
 * Attribution stays double-count-free: a companion that is some other
 * source's PRIMARY importer keeps its count there (it already has a home),
 * and a companion listed by several sources counts under the first in
 * registry order. Memoized — WIZARD_SOURCES is static.
 */
let attributedMemo: Map<string, string[]> | undefined;
export function attributedImporters(sourceId: string, importer?: string): string[] {
  if (!attributedMemo) {
    attributedMemo = new Map();
    const primary = new Set(WIZARD_SOURCES.map((s) => s.importer ?? s.id));
    const claimed = new Set<string>();
    for (const s of WIZARD_SOURCES) {
      const keys = [s.importer ?? s.id];
      for (const a of s.alsoImporters ?? []) {
        if (primary.has(a) || claimed.has(a)) {
          continue;
        }

        claimed.add(a);
        keys.push(a);
      }

      attributedMemo.set(s.id, keys);
    }
  }

  return attributedMemo.get(sourceId) ?? [importer ?? sourceId];
}

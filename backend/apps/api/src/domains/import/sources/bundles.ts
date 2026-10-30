import type { Ecosystem } from './guides';

/**
 * The export bundles: platforms whose ONE download covers several of the
 * sources in `guides.ts`.
 *
 * Google Takeout is one archive for Gmail, Photos, Calendar and nine more;
 * Meta Accounts Center exports Facebook and Instagram; Amazon's "Request All
 * Your Data" covers orders, Prime Video, Audible, Kindle and Music. Each
 * member keeps its own guide below for the person who wants just that one
 * export, but the wizard shows the bundle as one picker button and one export
 * card, and the parse finds every member inside the archive on its own.
 *
 * Authored here, beside the guides, so that every export instruction the
 * wizard shows comes from this directory and is served by the catalog. Until
 * 2026-10 these three lived in the web app's `sources.tsx` next to the logos
 * and section groupings — the one place the instructions were written twice.
 * The frontend keeps the presentation it owns: the bundle's logo is resolved
 * there from its `id`.
 */
export interface WizardBundle {
  /** Stable id (`google`, `meta`, `amazon`); also the picker key `b:<id>` and the logo name. */
  id: string;
  /** The ecosystem whose section the bundle leads. One bundle per ecosystem. */
  ecosystem: Ecosystem;
  title: string;
  blurb: string;
  /** Deep link to the export page. */
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
  /** The `WIZARD_SOURCES` ids this one download covers. */
  members: string[];
  /** Loose addenda rendered under the steps, like a source's notes. */
  notes?: string[];
}

export const WIZARD_BUNDLES: WizardBundle[] = [
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
      'Takeout exports any single file larger than your chosen part size — a long video, typically — as a loose file NEXT TO the zip parts, not inside them. A handful of loose files upload fine; for a large Photos library with many of them, prefer the appliance’s import inbox: move the whole Takeout folder into the inbox directory and import it from the Inbox panel as one unit.',
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
  },
  {
    id: 'meta',
    ecosystem: 'meta',
    title: 'Meta (Facebook, Instagram)',
    blurb:
      'Meta Accounts Center exports your Facebook and Instagram data — each profile arrives as its own archive. WhatsApp exports separately.',
    url: 'https://accountscenter.facebook.com/info_and_permissions/dyi/?entry_point=download_your_information&target_id',
    stepsTitle: 'One-time export',
    steps: [
      'Open Meta Accounts Center → “Download your information”. Instagram must be linked to the Facebook account you’re signed in with (Accounts Center → Manage Accounts → “Add accounts”).',
      "Click 'Create Export'.",
      'Request each profile you want — Facebook and Instagram export as separate archives, one request each.',
      "Click 'Export to device'.",
      'Set Date range to “All time”, Format to “JSON”, and Media quality to “High”.',
      'Click “Create files”. You’ll get an email when each download is ready (minutes to a few hours).',
      'Upload every archive here — each one imports on its own. (WhatsApp is a separate export.)',
    ],
    altPath: {
      title: 'Recurring sync through Google Drive or Dropbox',
      url: 'https://accountscenter.facebook.com/info_and_permissions/dyi/?entry_point=download_your_information&target_id',
      steps: [
        'Open Meta Accounts Center → “Download your information”. Instagram must be linked to the Facebook account you’re signed in with (Accounts Center → Manage Accounts → “Add accounts”).',
        "Click 'Create Export'.",
        'Request each profile you want — Facebook and Instagram export as separate archives, one request each.',
        "Click 'Export to external service'.",
        'Select the service you wish to export to.',
        'Choose how often to export it (daily, weekly, monthly), and then how many years to do these periodic exports.',
        'Connect Meta to the service.',
        'Set Date range to “All time”, Format to “JSON”, and Media quality to “High”.',
        "Click 'Start Export'. The first sync might not start until midnight, and it might take many hours to fully sync.",
        'Create a Service Connection to [Google](/providers/0198779b-182c-716e-9275-b81d99a47fdb) or [Dropbox](/providers/01a10dc2-7dc5-7d4c-b3ab-7d3caaf7ebd3), and include Drive/File permissions. When these services sync, they will run completed Facebook or Instagram archives through their respective import tools.',
      ],
    },
    // WhatsApp is deliberately NOT a member — its export is separate, so it
    // keeps its own picker button and export card.
    members: ['facebook', 'instagram'],
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
  },
];

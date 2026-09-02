/**
 * Chromium-family browsing history and bookmarks.
 *
 * Covers Chrome, Brave, Edge, Arc, Opera - anything that ships the standard
 * Chromium `History` SQLite database. We recognize by filename and confirm the
 * `urls`/`visits` tables exist, then project one Item per visit.
 *
 * Bookmarks live in a separate `Bookmarks` file (JSON, no extension) beside the
 * history database, so it recognizes as its own import root and is dispatched
 * independently - dropping a whole profile folder picks up both without
 * importing either twice.
 *
 * Mirrors the firefox.ts importer. The only Chromium-specific wrinkle is the
 * timestamp epoch: Chromium stores visit_time (and a bookmark's date_added) as
 * microseconds since 1601-01-01 UTC, so we offset by the 1601->1970 gap before
 * constructing a Date.
 *
 * Identities come from the registry's browser builders (identity/browser.ts)
 * under the `chromium` system, shared with the Takeout Chrome importer and the
 * browser extension: one visit, one row, however many of the three deliver it.
 */
import fs from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  browserBookmarkIdentity,
  browserDownloadIdentity,
  browserVisitIdentity,
  unixMsFromChromiumMicros,
} from '@ci/domains/memory';

import { asRecord } from './json';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Graph } from './timeline';
import { timeframeContains } from './timeline';

// Filenames a Chromium-based browser uses for its history database.
const HISTORY_FILENAMES = new Set([
  'history',
  'history.sqlite',
  'history-chrome',
  'history-brave',
  'history-edge',
  'history-arc',
]);

// Filenames a Chromium-based browser uses for its bookmark file. It ships as
// `Bookmarks` with no extension; `Bookmarks.bak` is deliberately absent (it is
// the previous revision and would duplicate everything).
const BOOKMARK_FILENAMES = new Set([
  'bookmarks',
  'bookmarks.json',
  'bookmarks-chrome',
  'bookmarks-brave',
  'bookmarks-edge',
  'bookmarks-arc',
]);

// A bookmark's date_added arrives as a STRING of microseconds, so isFinite also
// rejects the unparseable rather than letting NaN through to an Invalid Date.
// Pass the exact integer — a BigInt from a `.safeIntegers(true)` statement, or
// the JSON's decimal string — never a Number: Chromium stamps sit above 2^53
// and a Number has already dropped the last microsecond (see the registry).
function chromeTimeToDate(micros: bigint | string | number | null | undefined): Date | undefined {
  // The registry owns the epoch shift so the identity and the timestamp are
  // computed from one truncation.
  const ms = unixMsFromChromiumMicros(micros);

  return ms === undefined ? undefined : new Date(ms);
}

interface ChromiumBookmarkNode {
  type?: string;
  name?: string;
  url?: string;
  date_added?: string | number;
  children?: ChromiumBookmarkNode[];
}

interface FlatBookmark {
  url: string;
  title: string;
  dateAdded?: string | number;
  folder?: string;
}

/**
 * Walk the bookmark tree, carrying the enclosing folder's name down to its
 * children so each link records the folder it was saved in (the roots name
 * themselves "Bookmarks bar" / "Other bookmarks", which is what a user sees).
 */
function flattenBookmarks(
  node: ChromiumBookmarkNode | undefined,
  folder: string | undefined,
  out: FlatBookmark[],
  depth = 0,
): FlatBookmark[] {
  if (!node || typeof node !== 'object' || depth > 20) {
    return out;
  }

  if (node.type === 'url' && node.url) {
    out.push({ url: node.url, title: node.name || '', dateAdded: node.date_added, folder });

    return out;
  }

  if (Array.isArray(node.children)) {
    const childFolder = node.name || folder;
    for (const child of node.children) {
      flattenBookmarks(child, childFolder, out, depth + 1);
    }
  }

  return out;
}

/** Parse a Chromium `Bookmarks` file, or undefined when it is not one. */
async function readBookmarksFile(fpath: string): Promise<FlatBookmark[] | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(fpath, 'utf8'));
  } catch {
    return undefined;
  }

  // The Takeout export is `Bookmarks.html` (Netscape format, handled by
  // google_chrome.ts); the live profile file is JSON keyed by `roots`.
  const doc = asRecord(parsed);
  const roots = asRecord(doc?.roots);
  if (!roots) {
    return undefined;
  }

  const out: FlatBookmark[] = [];
  for (const root of Object.values(roots)) {
    flattenBookmarks(root as ChromiumBookmarkNode, undefined, out);
  }

  return out;
}

/**
 * Chromium's per-visit dwell time, in seconds, or undefined when it is not
 * usable as a measure of attention.
 *
 * `visits.visit_duration` is microseconds and is populated on the large
 * majority of visits — 43,010 of 46,791 (91.9%) in the reference profile — so
 * dropping it discarded the only record of how long anything was actually
 * looked at. `ci.browser_activity.duration_seconds`, its DTO field, and the
 * `screen_minutes` daily metric that sums it were all already built and had
 * simply never had a producer.
 *
 * ## Why an upper bound is required rather than nice to have
 *
 * Chrome accrues this while a tab merely STAYS OPEN, not while anyone is
 * looking at it. The distribution says so plainly: the median visit is 6.9
 * seconds, but p99 is 33 hours, 572 visits exceed a day, and the longest is
 * 114 hours. Summed raw, the reference profile reports 51,119 hours of screen
 * time — 5.8 years, out of a few years of history. Feeding that to
 * `screen_minutes` would not produce a slightly-high number, it would produce
 * a meaningless one.
 *
 * So a visit longer than MAX_PLAUSIBLE_DWELL_S is treated as UNKNOWN and the
 * field is omitted, rather than clamped to the bound. Clamping would fabricate
 * a specific large number for every one of them — the 2,361 visits over four
 * hours would contribute 9,444 hours of screen time nobody spent. Omitting
 * says the only honest thing: a tab was open, and how long it held attention
 * is not something this source knows. That keeps 40,649 visits (94.5% of those
 * carrying a duration) totalling 6,240 hours.
 *
 * Four hours is the bound because it is where "a long sitting" stops being the
 * likelier reading than "a tab left open" — p90 is already 84 minutes, so the
 * bound sits well above ordinary use while excluding 5.5% of durations.
 */
const MAX_PLAUSIBLE_DWELL_S = 4 * 60 * 60;

function dwellSeconds(microseconds: number | null | undefined): number | undefined {
  if (typeof microseconds !== 'number' || !Number.isFinite(microseconds) || microseconds <= 0) {
    return undefined;
  }

  const seconds = Math.round(microseconds / 1_000_000);

  return seconds > 0 && seconds <= MAX_PLAUSIBLE_DWELL_S ? seconds : undefined;
}

/**
 * Path segments that name a Chromium-family brand, compared whole (lowercased,
 * spaces/dashes/underscores stripped) so `operations/` is not Opera. Profile
 * directories: `BraveSoftware/Brave-Browser`, `Google/Chrome`, `Microsoft Edge`,
 * `Arc/User Data`, `Opera Software/Opera Stable`, `Vivaldi`, `Chromium`.
 */
const BRAND_BY_SEGMENT: Readonly<Record<string, string>> = {
  brave: 'brave',
  bravesoftware: 'brave',
  bravebrowser: 'brave',
  chrome: 'chrome',
  googlechrome: 'chrome',
  edge: 'edge',
  microsoftedge: 'edge',
  arc: 'arc',
  opera: 'opera',
  operasoftware: 'opera',
  operastable: 'opera',
  vivaldi: 'vivaldi',
  chromium: 'chromium',
};

/**
 * The brand that wrote a History / Bookmarks file, when its NAME or PATH says
 * — the file itself never does: every Chromium-family browser writes the
 * identical schema with no brand marker inside. Two signals, in order:
 *
 *   1. the rename the import guide asks for (`History-brave`, `Bookmarks-edge`)
 *   2. a profile-directory segment on the way to the file, when a folder was
 *      dropped rather than the bare file
 *
 * Undefined when neither says, never guessed: the value lands on the row as
 * `properties.browser`, where the browser extension writes the brand it can
 * detect at runtime, and a wrong guess here would out-vote a right answer
 * there. This is a FACT ABOUT THE ARRIVAL, deliberately kept off the identity:
 * `source_system` stays `chromium` for every brand so a Brave visit delivered
 * by this importer and by the extension is one row (identity/browser.ts).
 */
export function browserBrandFromPath(...paths: Array<string | undefined>): string | undefined {
  for (const raw of paths) {
    if (!raw) {
      continue;
    }

    const segments = raw.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
    const base = segments[segments.length - 1] ?? '';
    const suffix = /^(?:history|bookmarks)(?:\.sqlite|\.json)?-([a-z]+)$/.exec(base);
    if (suffix) {
      return BRAND_BY_SEGMENT[suffix[1]] ?? suffix[1];
    }

    for (const segment of segments.slice(0, -1)) {
      const brand = BRAND_BY_SEGMENT[segment.replace(/[\s_-]/g, '')];
      if (brand) {
        return brand;
      }
    }
  }

  return undefined;
}

class ChromiumFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const full = entry.fullPath || entry.fsRoot || entry.filename;
    if (!full) {
      return { confidence: 0 };
    }

    const base = path.basename(full).toLowerCase();

    if (BOOKMARK_FILENAMES.has(base)) {
      try {
        await stat(full);
      } catch {
        return { confidence: 0 };
      }

      // Confirm it parses as a Chromium bookmark tree rather than some other
      // file named "Bookmarks" (notably the Takeout `Bookmarks.html`).
      return (await readBookmarksFile(full)) ? { confidence: 0.95 } : { confidence: 0 };
    }

    if (!HISTORY_FILENAMES.has(base)) {
      return { confidence: 0 };
    }

    try {
      await stat(full);
    } catch {
      return { confidence: 0 };
    }

    // Confirm this is actually a Chromium history DB rather than some other
    // file that happens to be named "History".
    let db: Database.Database | undefined;
    try {
      db = new Database(full, { readonly: true, fileMustExist: true });
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('urls', 'visits')")
        .all() as Array<{ name: string }>;

      return tables.length === 2 ? { confidence: 0.95 } : { confidence: 0 };
    } catch {
      return { confidence: 0 };
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const fpath = entry.fullPath || entry.fsRoot || entry.filename;
    if (!fpath || !fs.existsSync(fpath)) {
      return;
    }

    // The archive-relative name first: it keeps the profile folders the user
    // dropped, where fullPath may be an Inbox location that lost them.
    const browser = browserBrandFromPath(entry.filename, entry.fullPath, entry.fsRoot);

    if (BOOKMARK_FILENAMES.has(path.basename(fpath).toLowerCase())) {
      await this.importBookmarks(fpath, params, browser);

      return;
    }

    this.importHistory(fpath, params, browser);
  }

  /**
   * Saved bookmarks from the profile's `Bookmarks` JSON. Emits the same
   * `bookmark` item shape as firefox.ts and google_chrome.ts - Title / URL /
   * Folder / Added Date - so every browser lands on CI-Server's `web.bookmark`
   * the same way.
   */
  /**
   * Chrome's `downloads` table — every file the browser fetched.
   *
   * Not imported at all before this: the string "download" did not occur in
   * chromium.ts, firefox.ts or google_chrome.ts, while `ci.browser_activity`
   * has modelled `action_type='download'` in its DTO union the whole time and
   * held 0 such rows.
   *
   * This is not recoverable from history by any other route. A download's own
   * URL is usually never a page visit: for 255 of 278 downloads in the
   * reference profile the final URL of the download chain appears nowhere in
   * `urls`, so without this table there is no record the file was ever fetched
   * — not the filename, not the size, not where it came from.
   *
   * The download's identity is its `guid`, which Chrome already generates and
   * keeps stable, so re-importing the same profile dedups on the provenance
   * triple exactly as visits do.
   */
  private importDownloads(
    db: Database.Database,
    dbPath: string,
    params: ImportParams,
    browser?: string,
  ): void {
    // `downloads` postdates `urls`/`visits` and a stripped or very old profile
    // may not carry it. Probing keeps its absence from failing the whole file,
    // which the caller's catch would turn into zero imported VISITS too.
    const hasDownloads = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'downloads'")
        .all() as Array<{
        name: string;
      }>
    ).length;
    if (!hasDownloads) {
      return;
    }

    // The chain's last hop is the URL the bytes actually came from, after any
    // redirects; `tab_url` is the page the user was on, which is a different
    // and also useful fact, so both are kept.
    const stmt = db.prepare(`SELECT d.guid AS guid, d.target_path AS target_path, d.start_time AS start_time,
             d.received_bytes AS received_bytes, d.total_bytes AS total_bytes, d.state AS state,
             d.mime_type AS mime_type, d.referrer AS referrer, d.tab_url AS tab_url,
             (SELECT c.url FROM downloads_url_chains c WHERE c.id = d.id
               ORDER BY c.chain_index DESC LIMIT 1) AS source_url
      FROM downloads d
      ORDER BY d.start_time ASC`);

    // safeIntegers: start_time must arrive exact (above 2^53 as a Number).
    // Every other integer column comes as a BigInt too and is narrowed below.
    stmt.safeIntegers(true);

    for (const row of stmt.iterate() as Iterable<{
      guid: string | null;
      target_path: string | null;
      start_time: bigint;
      received_bytes: bigint | null;
      total_bytes: bigint | null;
      state: bigint | null;
      mime_type: string | null;
      referrer: string | null;
      tab_url: string | null;
      source_url: string | null;
    }>) {
      const ts = chromeTimeToDate(row.start_time);
      if (!timeframeContains(params.timeframe, ts)) {
        continue;
      }

      const url = row.source_url || row.tab_url || '';
      if (!url) {
        // Nothing to file it under. A browser_activity row is keyed by url.
        params.pipeline.drop?.('download_no_url');
        continue;
      }

      const filename = row.target_path ? path.basename(row.target_path) : undefined;
      params.pipeline.push({
        item: {
          // (url, start ms), not the row's guid: the extension's downloads API
          // never sees the guid, but both sides see the final URL and the start
          // instant. The guid rides along in metadata.
          id: browserDownloadIdentity('chromium', url, ts?.getTime()).id,
          classification: 'download',
          timestamp: ts,
          intermediateLocation: dbPath,
          content: { filename: 'download.txt', data: async () => Buffer.from(url) },
          metadata: {
            Source: 'Chromium',
            // Lowercase key on purpose: the browser extension writes the same
            // fact as `properties.browser`, and metadata IS the row's
            // properties bag — one key, whichever producer knew.
            browser,
            URL: url,
            Title: filename,
            Filename: filename,
            MimeType: row.mime_type || undefined,
            Guid: row.guid || undefined,
            // `total_bytes` is what the server promised, `received_bytes` what
            // arrived; they differ for an interrupted download, and the second
            // is the only one that describes the file on disk.
            SizeBytes: row.received_bytes ? Number(row.received_bytes) : undefined,
            ExpectedBytes: row.total_bytes ? Number(row.total_bytes) : undefined,
            // Chrome's DownloadState: 1 is complete. Anything else was
            // interrupted or cancelled, and saying so is the point — an
            // interrupted download is a different fact, not a missing one.
            Completed: row.state === 1n,
            Referrer: row.referrer || undefined,
            TabURL: row.tab_url || undefined,
            'Visit Date': ts?.toISOString(),
          },
        },
      } as Graph);
    }
  }

  private async importBookmarks(fpath: string, params: ImportParams, browser?: string): Promise<void> {
    const bookmarks = await readBookmarksFile(fpath);
    if (!bookmarks) {
      params.log?.('error', 'parse chromium Bookmarks failed', { path: fpath });

      return;
    }

    for (const b of bookmarks) {
      // The raw string, not Number(): see chromeTimeToDate.
      const ts = chromeTimeToDate(b.dateAdded);
      if (!timeframeContains(params.timeframe, ts)) {
        continue;
      }

      // Key on (url, added second) so re-saving the same page stays distinct,
      // a re-import dedups, and the extension's bookmark for the same link
      // lands on the same content row.
      const id = browserBookmarkIdentity('chromium', b.url, ts?.getTime()).id;
      params.pipeline.push({
        item: {
          id,
          classification: 'bookmark',
          timestamp: ts,
          intermediateLocation: fpath,
          content: {
            filename: 'bookmark.txt',
            mediaType: 'text/plain',
            data: async () => Buffer.from(`${b.title}\n${b.url}`),
          },
          metadata: {
            // A title-less save (Chrome allows editing a bookmark's name down
            // to empty) left `Title` undefined, which push/canonical.ts's
            // titleFor() falls through all the way to the row's own filename
            // — this content's is the constant 'bookmark.txt', so every
            // untitled bookmark showed that instead of the page it saved. The
            // URL is always present for a real bookmark and is at least the
            // saved page, not a meaningless constant shared by every one of
            // them.
            Title: b.title || b.url || undefined,
            URL: b.url,
            Folder: b.folder || undefined,
            'Added Date': ts?.toISOString(),
            Source: 'Chromium',
            // Lowercase key on purpose: the browser extension writes the same
            // fact as `properties.browser`, and metadata IS the row's
            // properties bag — one key, whichever producer knew.
            browser,
          },
        },
      } as Graph);
    }
  }

  private importHistory(dbPath: string, params: ImportParams, browser?: string): void {
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (e) {
      params.log?.('error', 'open chromium History failed', { error: (e as Error).message });

      return;
    }

    try {
      // `visits.visit_duration` has been present for many Chromium releases but
      // is not guaranteed across every profile this importer may be handed, and
      // the catch below turns a bad SELECT into ZERO imported visits rather than
      // a loud failure. Probe for the column and leave it out when absent, the
      // same way imessage.ts guards chat.db's varying schema.
      const hasDuration = (db.prepare('PRAGMA table_info(visits)').all() as Array<{ name: string }>).some(
        (c) => c.name === 'visit_duration',
      );

      // Chromium's visits.url column is a foreign key onto urls.id.
      const stmt = db.prepare(`SELECT u.url AS url, u.title AS title, v.visit_time AS visit_time
               ${hasDuration ? ', v.visit_duration AS visit_duration' : ''}
        FROM visits v
        INNER JOIN urls u ON u.id = v.url
        ORDER BY v.visit_time ASC`);

      // safeIntegers: visit_time must arrive exact — as a Number it is above
      // 2^53 and the last microsecond is gone, which puts a `...999999` visit
      // one millisecond late and on a different key from Takeout's.
      stmt.safeIntegers(true);

      for (const row of stmt.iterate() as Iterable<{
        url: string;
        title: string | null;
        visit_time: bigint;
        visit_duration: bigint | null;
      }>) {
        const ts = chromeTimeToDate(row.visit_time);
        if (!timeframeContains(params.timeframe, ts)) {
          continue;
        }

        const url = row.url || '';
        // Cross-producer key on (url, visit ms): a re-import of the same
        // database dedups, and so does the same visit arriving from Takeout or
        // the browser extension.
        const id = browserVisitIdentity('chromium', url, ts?.getTime()).id;

        const item = {
          id,
          classification: 'page_view',
          timestamp: ts,
          intermediateLocation: dbPath,
          content: { filename: 'url.txt', data: async () => Buffer.from(url) },
          metadata: {
            Source: 'Chromium',
            // Lowercase key on purpose: the browser extension writes the same
            // fact as `properties.browser`, and metadata IS the row's
            // properties bag — one key, whichever producer knew.
            browser,
            URL: url,
            Title: row.title || undefined,
            'Visit Date': ts?.toISOString(),
            DurationSeconds: dwellSeconds(
              row.visit_duration == null ? undefined : Number(row.visit_duration),
            ),
          },
        };
        params.pipeline.push({ item } as Graph);
      }

      this.importDownloads(db, dbPath, params, browser);
    } catch (e) {
      params.log?.('error', 'chromium query failed', { error: (e as Error).message });
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }
  }
}

registerDataSource({
  name: 'chromium',
  title: 'Chromium browsers (Chrome / Brave / Edge / Arc)',
  icon: '',
  description:
    'Browsing history (URLs + visit timestamps) and saved bookmarks from any Chromium-based browser.',
  newFileImporter: () => new ChromiumFileImporter(),
});

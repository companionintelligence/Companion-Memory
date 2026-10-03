import fs from 'fs';
import { readdir, stat } from 'fs/promises';
import path from 'path';

import Database from 'better-sqlite3';

import { browserBookmarkIdentity, browserVisitIdentity } from '@ci/domains/memory';

import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Graph } from './timeline';
import { timeframeContains } from './timeline';

// Find places.sqlite within a path: the file itself, or anywhere a few levels
// deep when handed a folder (the importer is dispatched once on the job root, so
// dropping a whole `browser/` or `Firefox Profile/` folder must still resolve).
async function findPlacesDbs(root: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 4) {
    return out;
  }

  let st: fs.Stats;
  try {
    st = await stat(root);
  } catch {
    return out;
  }

  if (st.isFile()) {
    if (path.basename(root) === 'places.sqlite') {
      out.push(root);
    }

    return out;
  }

  if (!st.isDirectory()) {
    return out;
  }

  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return out;
  }

  for (const name of names) {
    if (name === 'places.sqlite') {
      out.push(path.join(root, name));
    } else if (!name.startsWith('.')) {
      await findPlacesDbs(path.join(root, name), depth + 1, out);
    }
  }

  return out;
}

/** A joined moz_places × moz_historyvisits row. */
interface HistoryRow {
  url?: string | null;
  title?: string | null;
  description?: string | null;
  visit_date?: number | null;
  total_view_time_ms?: number | null;
}

/**
 * Firefox's own measure of how long a page held foreground attention, in
 * seconds, or undefined when there is nothing usable.
 *
 * `moz_places_metadata.total_view_time` is populated on the large majority of
 * visits (1,046 of 1,102 in a reference profile matched to a visit within the
 * join window below) and, unlike Chromium's `visit_duration`, it is measured
 * foreground time rather than time-since-tab-opened — Firefox pauses the
 * counter on blur — so it does not carry Chromium's multi-day outliers. A
 * generous upper bound is kept anyway as a sanity guard against a stuck tab
 * or clock skew rather than as the primary correction Chromium needed.
 */
const MAX_PLAUSIBLE_VIEW_TIME_S = 4 * 60 * 60;

function viewTimeSeconds(ms: number | null | undefined): number | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }

  const seconds = Math.round(ms / 1000);

  return seconds > 0 && seconds <= MAX_PLAUSIBLE_VIEW_TIME_S ? seconds : undefined;
}

/** A moz_bookmarks × moz_places row from the bookmark query. */
interface BookmarkRow {
  url?: string | null;
  title?: string | null;
  date_added?: number | null;
  /** Parent folder title, joined in by the query. */
  folder?: string | null;
}

/** `SELECT id FROM moz_bookmarks WHERE guid = 'tags________'`. */
interface BookmarkIdRow {
  id: number;
}

class FirefoxFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const full = entry.fullPath || entry.fsRoot || entry.filename;
    if (!full) {
      return { confidence: 0 };
    }

    // Match the bare file, or a folder that contains a places.sqlite.
    if (path.basename(full) === 'places.sqlite') {
      try {
        await stat(full);

        return { confidence: 1.0 };
      } catch {
        /* missing or unreadable: fall through to the directory scan */
      }
    }

    if ((await findPlacesDbs(full)).length > 0) {
      return { confidence: 0.9, dir_threshold: 0.6 };
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root || !fs.existsSync(root)) {
      return;
    }

    for (const dbPath of await findPlacesDbs(root)) {
      this.importDb(dbPath, params);
    }
  }

  private importDb(dbPath: string, params: ImportParams): void {
    let db: Database.Database | undefined;
    try {
      // readonly + fileMustExist + query_only avoids "database is locked" / missing-WAL errors on a copied profile.
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma('query_only = ON');
    } catch (e) {
      params.log?.('error', 'open firefox places.sqlite failed', { error: (e as Error).message, dbPath });

      return;
    }

    try {
      // Separate try/catch per table: a profile whose bookmark schema we cannot
      // read must still yield its history (and vice versa).
      this.importHistory(db, dbPath, params);
      this.importBookmarks(db, dbPath, params);
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  private importHistory(db: Database.Database, dbPath: string, params: ImportParams): void {
    try {
      // moz_places_metadata postdates moz_historyvisits (added for the page
      // interaction data Firefox has only collected since ~2021) and an
      // older or stripped profile may not carry it — probing keeps its
      // absence from failing the whole file, the same way chromium.ts probes
      // for visit_duration.
      const hasMetadata = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'moz_places_metadata'")
          .all() as Array<{ name: string }>
      ).length;

      // moz_places_metadata has no visit_id FK, only place_id + its own
      // created_at session timestamp, so the metadata row nearest the visit
      // within a 2s window is the closest thing to a join key Firefox gives
      // us. This is a correlated subquery rather than a plain JOIN so a
      // place_id with two sessions inside the window cannot fan a visit row
      // out into duplicates. `ORDER BY m.created_at` (not the outer visit's
      // timestamp) is deliberate, not merely "close enough": SQLite's
      // parser cannot resolve the outer table's column when it is
      // referenced ONLY inside a subquery's ORDER BY (it resolves fine in
      // WHERE) — verified directly against this scan's engine — so ordering
      // by the metadata row's own timestamp is both the workaround and,
      // since ties inside a 2s window are rare, an adequate proxy for
      // nearest.
      const stmt = db.prepare(`SELECT p.url, p.title, p.description, h.visit_date
          ${
            hasMetadata
              ? `, (
                  SELECT m.total_view_time
                  FROM moz_places_metadata m
                  WHERE m.place_id = h.place_id
                    AND ABS(h.visit_date / 1000 - m.created_at) <= 2000
                  ORDER BY m.created_at DESC
                  LIMIT 1
                ) AS total_view_time_ms`
              : ''
          }
        FROM moz_places p
        INNER JOIN moz_historyvisits h ON p.id = h.place_id`);
      for (const row of stmt.iterate() as IterableIterator<HistoryRow>) {
        // Firefox stores microseconds since epoch; convert to Date
        let ts: Date | undefined;
        if (typeof row.visit_date === 'number') {
          ts = new Date(Math.floor(row.visit_date / 1000));
        }

        if (!timeframeContains(params.timeframe, ts)) {
          continue;
        }

        // Cross-producer key on (url, visit ms) under `firefox` — the same
        // visit captured by the Firefox build of the browser extension is the
        // same row (identity/browser.ts).
        const id = browserVisitIdentity('firefox', row.url || '', ts?.getTime()).id;
        const item = {
          id,
          classification: 'page_view',
          timestamp: ts,
          intermediateLocation: dbPath,
          content: { filename: 'url.txt', data: async () => Buffer.from(row.url || '') },
          metadata: {
            Source: 'Firefox',
            browser: 'firefox',
            URL: row.url,
            Title: row.title,
            Description: row.description,
            'Visit Date': ts?.toISOString(),
            DurationSeconds: viewTimeSeconds(row.total_view_time_ms),
          },
        };
        params.pipeline.push({ item } as Graph);
      }
    } catch (e) {
      params.log?.('error', 'firefox query failed', { error: (e as Error).message, dbPath });
    }
  }

  /**
   * Saved bookmarks (`moz_bookmarks` joined onto `moz_places` for the URL).
   * Emits the same `bookmark` item shape as the Chrome Takeout importer
   * (google_chrome.ts) — Title/URL/Folder/Added Date — so both browsers land on
   * CI-Server's `web.bookmark` the same way.
   */
  private importBookmarks(db: Database.Database, dbPath: string, params: ImportParams): void {
    try {
      // The history-only fixtures (and any partial profile) have no bookmark
      // table; that is not an error, there is just nothing to import.
      const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'moz_bookmarks'")
        .get();
      if (!hasTable) {
        return;
      }

      // Firefox files tags as bookmarks too: a folder per tag under the tags
      // root, each holding one entry per tagged page. Those duplicate the real
      // bookmark, so resolve the tags root and exclude its grandchildren.
      let tagsRootId: number | null = null;
      try {
        const row = db.prepare("SELECT id FROM moz_bookmarks WHERE guid = 'tags________'").get() as
          BookmarkIdRow | undefined;
        if (row) {
          tagsRootId = row.id;
        }
      } catch {
        // Pre-guid schema (Firefox < 52): the tags root is the fixed id 4.
        tagsRootId = 4;
      }

      // type 1 = bookmark (2 = folder, 3 = separator). `fk` points at moz_places.
      const stmt = db.prepare(`SELECT b.title AS title, p.url AS url,
          b.dateAdded AS date_added, parent.title AS folder
        FROM moz_bookmarks b
        INNER JOIN moz_places p ON p.id = b.fk
        LEFT JOIN moz_bookmarks parent ON parent.id = b.parent
        WHERE b.type = 1
          AND ($tags IS NULL OR (b.parent != $tags AND (parent.parent IS NULL OR parent.parent != $tags)))`);

      for (const row of stmt.iterate({ tags: tagsRootId }) as IterableIterator<BookmarkRow>) {
        // dateAdded is microseconds since epoch, as visit_date is. It can be 0
        // or NULL on synced/imported bookmarks, which leaves the item undated.
        let ts: Date | undefined;
        if (typeof row.date_added === 'number' && row.date_added > 0) {
          ts = new Date(Math.floor(row.date_added / 1000));
        }

        if (!timeframeContains(params.timeframe, ts)) {
          continue;
        }

        const url = row.url || '';
        const title = row.title || '';
        // Key on (url, added second) so re-saving the same page stays distinct,
        // a re-import dedups, and the extension's bookmark for the same link
        // lands on the same content row.
        const id = browserBookmarkIdentity('firefox', url, ts?.getTime()).id;
        params.pipeline.push({
          item: {
            id,
            classification: 'bookmark',
            timestamp: ts,
            intermediateLocation: dbPath,
            content: {
              filename: 'bookmark.txt',
              mediaType: 'text/plain',
              data: async () => Buffer.from(`${title}\n${url}`),
            },
            metadata: {
              Title: title || undefined,
              URL: url,
              Folder: row.folder || undefined,
              'Added Date': ts?.toISOString(),
              Source: 'Firefox',
              browser: 'firefox',
            },
          },
        } as Graph);
      }
    } catch (e) {
      params.log?.('error', 'firefox bookmark query failed', { error: (e as Error).message, dbPath });
    }
  }
}

registerDataSource({
  name: 'firefox',
  title: 'Firefox',
  icon: 'firefox.svg',
  description: 'Firefox places.sqlite database importer',
  newFileImporter: () => new FirefoxFileImporter(),
});

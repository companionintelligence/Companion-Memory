import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { allDataSources, dataSourcesRecognize } from '../registry';
import type { ImportParams, Timeframe } from '../timeline';

import type { EmittedGraph } from './support/emitted';

import '../chromium';

function getImporter(name: string) {
  const ds = allDataSources().find((d) => d.name === name);
  if (!ds?.newFileImporter) {
    throw new Error('missing importer');
  }

  return ds.newFileImporter();
}

// Chromium stores visit_time as microseconds since 1601-01-01 UTC.
function toChromeTime(iso: string): number {
  return (Date.parse(iso) + 11644473600000) * 1000;
}

// Build a minimal Chromium `History` SQLite DB with two urls and three visits.
function makeHistoryDb(dir: string): string {
  const p = path.join(dir, 'History');
  const db = new Database(p);
  db.exec(`
    CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER);
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);
  `);
  db.prepare('INSERT INTO urls (id, url, title) VALUES (?, ?, ?)').run(
    1,
    'https://example.com',
    'Example Domain',
  );
  db.prepare('INSERT INTO urls (id, url, title) VALUES (?, ?, ?)').run(2, 'https://news.example.org', 'News');
  const v = db.prepare('INSERT INTO visits (id, url, visit_time) VALUES (?, ?, ?)');
  v.run(1, 1, toChromeTime('2025-02-14T00:00:00Z'));
  v.run(2, 2, toChromeTime('2025-02-15T12:00:00Z'));
  v.run(3, 1, toChromeTime('2025-06-01T08:30:00Z'));
  db.close();

  return p;
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ci-chromium-'));
}

async function runImport(dbPath: string, timeframe: Timeframe = {}) {
  const importer = getImporter('chromium');
  const pipeline: EmittedGraph[] = [];
  await importer.fileImport({}, { filename: 'History', fullPath: dbPath }, {
    pipeline,
    timeframe,
    log: () => {},
  } as unknown as ImportParams);

  return pipeline.filter((p) => p.item).map((p) => p.item);
}

describe('Chromium datasource', () => {
  it('recognizes a real History database', async () => {
    const dbPath = makeHistoryDb(tmpdir());
    const importer = getImporter('chromium');
    const rec = await importer.recognize({}, { filename: 'History', fullPath: dbPath }, {});
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('does not recognize a SQLite file lacking the urls/visits tables', async () => {
    const dir = tmpdir();
    const p = path.join(dir, 'History');
    const db = new Database(p);
    db.exec('CREATE TABLE not_chromium (id INTEGER PRIMARY KEY)');
    db.close();
    const importer = getImporter('chromium');
    const rec = await importer.recognize({}, { filename: 'History', fullPath: p }, {});
    expect(rec.confidence).toBe(0);
  });

  it('imports one page_view item per visit with url/title metadata', async () => {
    const items = await runImport(makeHistoryDb(tmpdir()));
    expect(items.length).toBe(3);
    expect(items.every((i) => i.classification === 'page_view')).toBe(true);
    expect(items.every((i) => i.metadata?.Source === 'Chromium')).toBe(true);
    // Ordered by visit_time ascending.
    expect(items[0].metadata?.URL).toBe('https://example.com');
    expect(items[0].metadata?.Title).toBe('Example Domain');
    expect(items[1].metadata?.URL).toBe('https://news.example.org');
  });

  it('converts the Chromium (1601) epoch to the correct timestamp', async () => {
    const items = await runImport(makeHistoryDb(tmpdir()));
    expect(items[0].timestamp?.toISOString()).toBe('2025-02-14T00:00:00.000Z');
    expect(items[2].timestamp?.toISOString()).toBe('2025-06-01T08:30:00.000Z');
  });

  it('respects the timeframe filter', async () => {
    const items = await runImport(makeHistoryDb(tmpdir()), { since: new Date('2025-03-01T00:00:00Z') });
    expect(items.length).toBe(1);
    expect(items[0].metadata?.URL).toBe('https://example.com');
    expect(items[0].timestamp?.toISOString()).toBe('2025-06-01T08:30:00.000Z');
  });

  it('assigns a stable, unique id per visit (idempotent re-import)', async () => {
    const dbPath = makeHistoryDb(tmpdir());
    const first = await runImport(dbPath);
    const second = await runImport(dbPath);
    const ids = first.map((i) => i.id!);
    expect(new Set(ids).size).toBe(3); // distinct visits -> distinct ids
    expect(ids.every(Boolean)).toBe(true);
    expect(second.map((i) => i.id!)).toEqual(ids); // deterministic across runs
  });
});

// Bookmarks ship in a separate `Bookmarks` JSON file (no extension) beside the
// history DB, so it must recognize and import as its own root.
describe('Chromium bookmarks', () => {
  const ADDED = toChromeTime('2025-03-01T12:00:00Z');

  function makeBookmarksFile(dir: string, name = 'Bookmarks'): string {
    const p = path.join(dir, name);
    fs.writeFileSync(
      p,
      JSON.stringify({
        checksum: 'abc123',
        version: 1,
        roots: {
          bookmark_bar: {
            type: 'folder',
            name: 'Bookmarks bar',
            date_added: String(ADDED),
            children: [
              {
                type: 'url',
                name: 'Saved Page',
                url: 'https://saved.example.com',
                date_added: String(ADDED),
              },
              {
                type: 'folder',
                name: 'Reading',
                date_added: String(ADDED),
                children: [
                  {
                    type: 'url',
                    name: 'Nested',
                    url: 'https://nested.example.com',
                    date_added: String(ADDED),
                  },
                ],
              },
            ],
          },
          other: {
            type: 'folder',
            name: 'Other bookmarks',
            date_added: '0',
            children: [{ type: 'url', name: 'Undated', url: 'https://undated.example.com', date_added: '0' }],
          },
        },
      }),
    );

    return p;
  }

  async function importBookmarks(fpath: string, timeframe: Timeframe = {}) {
    const importer = getImporter('chromium');
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport({}, { filename: path.basename(fpath), fullPath: fpath }, {
      pipeline,
      timeframe,
      log: () => {},
    } as unknown as ImportParams);

    return pipeline.filter((p) => p.item).map((p) => p.item);
  }

  it('recognizes a Bookmarks file', async () => {
    const dir = tmpdir();
    const importer = getImporter('chromium');
    const rec = await importer.recognize({}, { filename: 'Bookmarks', fullPath: makeBookmarksFile(dir) }, {});
    expect(rec.confidence).toBeGreaterThan(0.9);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Guard against swallowing the Takeout Netscape export, which google_chrome.ts owns.
  it('does not recognize a non-Chromium file named Bookmarks', async () => {
    const dir = tmpdir();
    const p = path.join(dir, 'Bookmarks');
    fs.writeFileSync(p, '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="x" ADD_DATE="1">x</A></DL>');
    const importer = getImporter('chromium');
    expect((await importer.recognize({}, { filename: 'Bookmarks', fullPath: p }, {})).confidence).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imports bookmarks with the same shape as the Firefox importer', async () => {
    const dir = tmpdir();
    const items = await importBookmarks(makeBookmarksFile(dir));
    expect(items.length).toBe(3);
    expect(items.every((i) => i.classification === 'bookmark')).toBe(true);

    const saved = items.find((i) => i.metadata.URL === 'https://saved.example.com');
    expect(saved!.metadata.Title).toBe('Saved Page');
    expect(saved!.metadata.Folder).toBe('Bookmarks bar'); // root name is the folder
    expect(saved!.metadata.Source).toBe('Chromium');
    expect(saved!.metadata['Added Date']).toBe('2025-03-01T12:00:00.000Z');
    expect(saved!.content.filename).toBe('bookmark.txt');
    expect((await saved!.content.data!()).toString()).toBe('Saved Page\nhttps://saved.example.com');

    // A nested folder wins over the root it sits in.
    expect(items!.find((i) => i.metadata.URL === 'https://nested.example.com')!.metadata.Folder).toBe(
      'Reading',
    );

    // date_added "0" leaves the bookmark undated rather than stamping 1601/1970.
    expect(items!.find((i) => i.metadata.URL === 'https://undated.example.com')!.timestamp).toBeUndefined();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the URL when a bookmark has no title', async () => {
    // Chrome lets a saved bookmark's name be edited down to empty. Before
    // this fix, a title-less bookmark's `Title` metadata was `undefined`,
    // which push/canonical.ts's titleFor() falls through all the way to the
    // content's own filename — a constant, 'bookmark.txt', shared by every
    // bookmark this importer has ever written. A real page URL is a strictly
    // more useful label than a filename repeated across every untitled save.
    const dir = tmpdir();
    const p = path.join(dir, 'Bookmarks');
    fs.writeFileSync(
      p,
      JSON.stringify({
        checksum: 'abc123',
        version: 1,
        roots: {
          bookmark_bar: {
            type: 'folder',
            name: 'Bookmarks bar',
            date_added: String(ADDED),
            children: [
              { type: 'url', name: '', url: 'https://untitled.example.com', date_added: String(ADDED) },
            ],
          },
        },
      }),
    );

    const items = await importBookmarks(p);
    expect(items[0].metadata.Title).toBe('https://untitled.example.com');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives bookmarks stable ids that survive re-import', async () => {
    const dir = tmpdir();
    const p = makeBookmarksFile(dir);
    const first = (await importBookmarks(p)).map((i) => i.id!);
    expect(new Set(first).size).toBe(3);
    expect(first.every((id: string) => id.startsWith('chromium:bookmark:'))).toBe(true);
    expect((await importBookmarks(p)).map((i) => i.id!)).toEqual(first);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('honours the timeframe filter', async () => {
    const dir = tmpdir();
    const items = await importBookmarks(makeBookmarksFile(dir), { since: new Date('2025-06-01T00:00:00Z') });
    // Only the undated bookmark survives; timeframeContains passes undated items.
    expect(items.map((i) => i.metadata.URL)).toEqual(['https://undated.example.com']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // History and bookmarks are distinct roots, so a profile folder yields both
  // exactly once rather than one import swallowing the other.
  it('imports history and bookmarks separately from one profile folder', async () => {
    const dir = tmpdir();
    const historyItems = await runImport(makeHistoryDb(dir));
    const bookmarkItems = await importBookmarks(makeBookmarksFile(dir));
    expect(historyItems.every((i) => i.classification === 'page_view')).toBe(true);
    expect(bookmarkItems.every((i) => i.classification === 'bookmark')).toBe(true);
    const ids = new Set([...historyItems, ...bookmarkItems].map((i) => i.id!));
    expect(ids.size).toBe(historyItems.length + bookmarkItems.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a renamed Bookmarks-brave file', async () => {
    const dir = tmpdir();
    const p = makeBookmarksFile(dir, 'Bookmarks-brave');
    const importer = getImporter('chromium');
    expect(
      (await importer.recognize({}, { filename: 'Bookmarks-brave', fullPath: p }, {})).confidence,
    ).toBeGreaterThan(0.9);
    expect((await importBookmarks(p)).length).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// DEFERRED: the "Chromium mock-export corpus fixture" block asserted against
// tests/mock-exports/archives/chromium/History — a repo-root corpus shared with
// the end-to-end run-matrix, which is not part of this port. It returns with the
// run-matrix, pointed at wherever that corpus lands here; duplicating the fixture
// into this directory instead would let the two copies drift, which is precisely
// what that test exists to catch. Every other case in this file builds its own
// SQLite database and is unaffected.

/*
 * A real Chrome profile has `History` and `Bookmarks` side by side, and
 * chromium.ts correctly recognizes each independently (its own recognize()
 * unit tests above prove this in isolation). But recognizing each file is not
 * the same as IMPORTING each file: `dataSourcesRecognize` (registry.ts) used
 * to keep only ONE match per data-source NAME across a whole directory —
 * "best match per data source" — which conflated two different situations:
 * the same unit seen at two nesting levels (correctly collapsed) and two
 * unrelated sibling files the same importer happens to also recognize
 * (incorrectly collapsed onto whichever `readdir()` returned first). Because
 * `ParseStage.run()` calls the file importer exactly once per surviving
 * match, the dropped sibling was never imported at all — silently, with the
 * run reporting `completed`, zero failures. Confirmed live: importing a real
 * ~44MB Chrome profile landed 3,197 bookmarks and ZERO history rows,
 * deterministically, twice in a row.
 *
 * These tests exercise the registry function directly rather than
 * `importer.recognize()` in isolation, because the bug lived in how the
 * registry COMBINES multiple per-file recognitions, not in any single call.
 */
describe('recognizing a directory with two sibling Chromium files', () => {
  function makeMinimalBookmarksFile(dir: string): string {
    const p = path.join(dir, 'Bookmarks');
    fs.writeFileSync(p, JSON.stringify({ roots: {} }));

    return p;
  }

  it('keeps both the History and Bookmarks matches, not just whichever sorts first', async () => {
    const dir = tmpdir();
    makeHistoryDb(dir);
    makeMinimalBookmarksFile(dir);

    const matches = await dataSourcesRecognize(
      undefined,
      { filename: path.basename(dir), fullPath: dir, fsRoot: dir },
      {},
      { descend: true },
    );

    const chromiumMatches = matches.filter((m) => m.data_source.name === 'chromium');

    expect(chromiumMatches).toHaveLength(2);
    expect(new Set(chromiumMatches.map((m) => path.basename(m.matchedPath ?? '')))).toEqual(
      new Set(['History', 'Bookmarks']),
    );
    expect(chromiumMatches.every((m) => m.recognition.confidence > 0.9)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('still collapses the same match found at two nesting levels', async () => {
    // A file matched both when handed directly AND when found by descending
    // into its own parent (the top-level `recognizeLevel` call and the
    // descent both walk into the same tree here) must not double-count —
    // this is the case the original dedup existed to handle, and the fix
    // must not regress it.
    const dir = tmpdir();
    const historyPath = makeHistoryDb(dir);

    const matches = await dataSourcesRecognize(
      undefined,
      { filename: path.basename(historyPath), fullPath: historyPath, fsRoot: dir },
      {},
      { descend: true },
    );

    expect(matches.filter((m) => m.data_source.name === 'chromium')).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// `visits.visit_duration` records how long each visit lasted. It was never
// selected, so `ci.browser_activity.duration_seconds` — which has a column, a
// DTO field, and a `screen_minutes` metric summing it — had no producer on any
// import path and sat at 0 of 327,745 rows.
//
// Note the fixture ABOVE has no visit_duration column at all, which is the
// older-schema case: those tests passing is what proves the column probe
// degrades instead of importing nothing.
describe('visit dwell time', () => {
  function makeHistoryDbWithDuration(dir: string, durationsMicros: Array<number | null>): string {
    const p = path.join(dir, 'History');
    const db = new Database(p);
    db.exec(`
      CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER);
      CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, visit_duration INTEGER);
    `);
    db.prepare('INSERT INTO urls (id, url, title) VALUES (?, ?, ?)').run(1, 'https://example.com', 'Example');
    const v = db.prepare('INSERT INTO visits (id, url, visit_time, visit_duration) VALUES (?, ?, ?, ?)');
    durationsMicros.forEach((d, i) => v.run(i + 1, 1, toChromeTime(`2025-02-1${i}T00:00:00Z`), d));
    db.close();

    return p;
  }

  // runImport already returns ITEMS, not graphs. Note the assertions below use
  // toStrictEqual, not toEqual: toEqual ignores undefined array entries, so an
  // EMPTY result compares equal to [undefined], and a test asserting "no
  // duration" would pass against an import that produced nothing at all.
  const durations = async (micros: Array<number | null>) => {
    const dir = tmpdir();
    const items = await runImport(makeHistoryDbWithDuration(dir, micros));
    const views = items.filter((i) => i.classification === 'page_view');
    expect(views).toHaveLength(micros.length);

    return views.map((i) => i.metadata.DurationSeconds);
  };

  it('converts microseconds to seconds', async () => {
    // 45 s and 90 s expressed in microseconds.
    expect(await durations([45_000_000, 90_000_000])).toStrictEqual([45, 90]);
  });

  it('rounds to the nearest second rather than truncating', async () => {
    expect(await durations([6_900_000])).toStrictEqual([7]);
  });

  it('omits a duration of zero, which means "not recorded"', async () => {
    expect(await durations([0])).toStrictEqual([undefined]);
  });

  it('omits a null duration', async () => {
    expect(await durations([null])).toStrictEqual([undefined]);
  });

  it('omits an implausibly long visit instead of clamping it', async () => {
    // Chrome accrues this while a tab merely stays open: in the reference
    // profile p99 is 33 h and the longest visit is 114 h, which summed raw
    // reports 5.8 YEARS of screen time. Clamping would fabricate a specific
    // large number for each; omitting reports the visit with no duration.
    const fiveHours = 5 * 60 * 60 * 1_000_000;
    const oneHundredHours = 100 * 60 * 60 * 1_000_000;
    expect(await durations([fiveHours, oneHundredHours])).toStrictEqual([undefined, undefined]);
  });

  it('keeps a long but plausible sitting just under the bound', async () => {
    const justUnderFourHours = (4 * 60 * 60 - 1) * 1_000_000;
    expect(await durations([justUnderFourHours])).toStrictEqual([4 * 60 * 60 - 1]);
  });

  it('still imports the visit itself when the duration is unusable', async () => {
    const dir = tmpdir();
    const items = await runImport(makeHistoryDbWithDuration(dir, [0, 100 * 60 * 60 * 1_000_000]));
    const views = items.filter((i) => i.classification === 'page_view');
    expect(views).toHaveLength(2);
    expect(views.every((i) => i.metadata.URL === 'https://example.com')).toBe(true);
  });
});

// Chrome's `downloads` table was not read at all — the string "download" did
// not occur in chromium.ts, firefox.ts or google_chrome.ts, while
// ci.browser_activity has modelled action_type='download' in its DTO union the
// whole time and held 0 such rows. It is not recoverable by another route
// either: for 255 of 278 downloads in the reference profile the final URL of
// the download chain appears nowhere in `urls`.
describe('downloads', () => {
  function makeDbWithDownloads(
    dir: string,
    rows: Array<{
      guid: string;
      target: string | null;
      chainUrl: string | null;
      tabUrl?: string | null;
      state?: number;
      mime?: string;
      received?: number;
      total?: number;
    }>,
  ): string {
    const p = path.join(dir, 'History');
    const db = new Database(p);
    db.exec(`
      CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER);
      CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER);
      CREATE TABLE downloads (id INTEGER PRIMARY KEY, guid TEXT, current_path TEXT, target_path TEXT,
        start_time INTEGER, received_bytes INTEGER, total_bytes INTEGER, state INTEGER,
        mime_type TEXT, referrer TEXT, tab_url TEXT);
      CREATE TABLE downloads_url_chains (id INTEGER, chain_index INTEGER, url TEXT);
    `);
    const d = db.prepare(`INSERT INTO downloads
      (id, guid, target_path, start_time, received_bytes, total_bytes, state, mime_type, referrer, tab_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const c = db.prepare('INSERT INTO downloads_url_chains (id, chain_index, url) VALUES (?, ?, ?)');
    rows.forEach((r, i) => {
      d.run(
        i + 1,
        r.guid,
        r.target,
        toChromeTime(`2025-04-0${i + 1}T00:00:00Z`),
        r.received ?? 100,
        r.total ?? 100,
        r.state ?? 1,
        r.mime ?? 'application/pdf',
        'https://ref.example',
        r.tabUrl ?? null,
      );
      if (r.chainUrl) {
        // A redirect chain: the LAST hop is where the bytes came from.
        c.run(i + 1, 0, 'https://redirect.example/start');
        c.run(i + 1, 1, r.chainUrl);
      }
    });
    db.close();

    return p;
  }

  const downloadsFrom = async (rows: Parameters<typeof makeDbWithDownloads>[1]) => {
    const items = await runImport(makeDbWithDownloads(tmpdir(), rows));

    return items.filter((i) => i.classification === 'download');
  };

  it('imports a download the visits table knows nothing about', async () => {
    const got = await downloadsFrom([
      {
        guid: 'g1',
        target: '/Users/x/Downloads/statement.pdf',
        chainUrl: 'https://files.example/statement.pdf',
      },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].metadata.URL).toBe('https://files.example/statement.pdf');
    expect(got[0].metadata.Filename).toBe('statement.pdf');
    expect(got[0].metadata.MimeType).toBe('application/pdf');
    expect(got[0].metadata.Completed).toBe(true);
  });

  it('takes the LAST hop of the redirect chain as the source URL', async () => {
    // chain_index 0 is where the click went; the final hop is where the bytes
    // actually came from, and is the one that identifies the file.
    const got = await downloadsFrom([
      { guid: 'g1', target: '/d/a.zip', chainUrl: 'https://cdn.example/final.zip' },
    ]);
    expect(got[0].metadata.URL).toBe('https://cdn.example/final.zip');
  });

  it('records an interrupted download as not completed, rather than dropping it', async () => {
    const got = await downloadsFrom([
      {
        guid: 'g1',
        target: '/d/partial.iso',
        chainUrl: 'https://files.example/partial.iso',
        state: 4,
        received: 40,
        total: 100,
      },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].metadata.Completed).toBe(false);
    // received is what is on disk; total is what the server promised.
    expect(got[0].metadata.SizeBytes).toBe(40);
    expect(got[0].metadata.ExpectedBytes).toBe(100);
  });

  it('falls back to the tab URL when the chain is empty', async () => {
    const got = await downloadsFrom([
      { guid: 'g1', target: '/d/a.pdf', chainUrl: null, tabUrl: 'https://page.example/report' },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].metadata.URL).toBe('https://page.example/report');
  });

  it('drops a download with no URL at all rather than filing it under an empty key', async () => {
    const got = await downloadsFrom([{ guid: 'g1', target: '/d/a.pdf', chainUrl: null, tabUrl: null }]);
    expect(got).toHaveLength(0);
  });

  it('keys on the guid so a re-import of the same profile dedups', async () => {
    const got = await downloadsFrom([
      { guid: 'stable-guid', target: '/d/a.pdf', chainUrl: 'https://files.example/a.pdf' },
    ]);
    expect(got[0].id).toContain('stable-guid');
  });

  it('imports visits normally on a profile with no downloads table', async () => {
    // The caller's catch turns a bad query into ZERO imported visits, so an
    // unguarded reference here would empty the history of an older profile.
    const items = await runImport(makeHistoryDb(tmpdir()));
    expect(items.filter((i) => i.classification === 'page_view').length).toBeGreaterThan(0);
    expect(items.filter((i) => i.classification === 'download')).toHaveLength(0);
  });
});

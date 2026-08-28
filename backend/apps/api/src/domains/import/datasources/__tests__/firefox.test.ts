import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import Database from 'better-sqlite3';

import { allDataSources } from '../registry';
import type { ImportParams } from '../timeline';

import type { EmittedGraph, EmittedItem } from './support/emitted';

import '../firefox';

function getImporter(name: string) {
  const ds = allDataSources().find((d) => d.name === name);
  if (!ds?.newFileImporter) {
    throw new Error('missing importer');
  }

  return ds.newFileImporter();
}

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Firefox datasource', () => {
  it('recognizes places.sqlite file', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'places.sqlite');
    const importer = getImporter('firefox');
    const rec = await importer.recognize({}, { filename: 'places.sqlite', fullPath: dbPath }, {});
    expect(rec.confidence).toBe(1.0);
  });

  it('imports Firefox history', async () => {
    const dbPath = path.join(FIXTURES_DIR, 'places.sqlite');
    const importer = getImporter('firefox');
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport({}, { filename: 'places.sqlite', fullPath: dbPath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBe(1);
    expect(items[0].item.classification).toBe('page_view');
    expect(items[0].item.metadata?.Source).toBe('Firefox');
    expect(items[0].item.metadata?.URL).toBe('https://example.com');
    expect(items[0].item.metadata?.Title).toBe('Example Domain');
  });

  // Real exports drop a whole browser/profile folder, not the bare file. The
  // importer is dispatched once on the job root, so it must find places.sqlite
  // nested inside (regression for the inbox folder that imported 0 items).
  it('recognizes and imports from a folder containing places.sqlite (nested)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
    const nested = path.join(tmp, 'browser', 'firefox');
    fs.mkdirSync(nested, { recursive: true });
    fs.copyFileSync(path.join(FIXTURES_DIR, 'places.sqlite'), path.join(nested, 'places.sqlite'));

    const importer = getImporter('firefox');
    const rec = await importer.recognize(
      {},
      { filename: 'browser', fullPath: path.join(tmp, 'browser') },
      {},
    );
    expect(rec.confidence).toBeGreaterThan(0); // folder is recognized, not just the bare file

    const pipeline: EmittedGraph[] = [];
    await importer.fileImport({}, { filename: 'browser', fullPath: path.join(tmp, 'browser') }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBe(1);
    expect(items[0].item.metadata?.URL).toBe('https://example.com');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Regression: two distinct visits sharing the same visit_date (Firefox stores
  // microseconds since epoch; importDb truncates to ms) used to collapse because
  // items had no id and a constant filename/intermediateLocation. Each visit must
  // now get a stable, unique id derived from (url, visit_date).
  it('assigns a stable, unique id per visit so same-ms visits do not collapse', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-dedup-'));
    const dbPath = path.join(tmp, 'places.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, description TEXT);
      CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
    `);
    db.prepare('INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)').run(
      1,
      'https://a.example.com',
      'A',
    );
    db.prepare('INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)').run(
      2,
      'https://b.example.com',
      'B',
    );
    // Same visit_date (microseconds since epoch) for two different URLs.
    const sameTs = Date.parse('2025-02-14T00:00:00Z') * 1000;
    const v = db.prepare('INSERT INTO moz_historyvisits (id, place_id, visit_date) VALUES (?, ?, ?)');
    v.run(1, 1, sameTs);
    v.run(2, 2, sameTs);
    db.close();

    const importer = getImporter('firefox');
    async function run(): Promise<EmittedItem[]> {
      const pipeline: EmittedGraph[] = [];
      await importer.fileImport({}, { filename: 'places.sqlite', fullPath: dbPath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return pipeline.filter((p) => p.item).map((p) => p.item);
    }

    const first = await run();
    expect(first.length).toBe(2);
    const ids = first.map((i) => i.id!);
    expect(ids.every(Boolean)).toBe(true); // every id truthy
    expect(new Set(ids).size).toBe(2); // distinct visits -> distinct ids
    const second = await run();
    expect(second.map((i) => i.id!)).toEqual(ids); // idempotent across re-imports
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Bookmarks live in moz_bookmarks (type 1) and join to moz_places for the URL.
  // Firefox also files tags as bookmark rows under the tags root, which would
  // double-count every tagged page if imported.
  describe('bookmarks', () => {
    function makeProfile(dir: string): string {
      const dbPath = path.join(dir, 'places.sqlite');
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, description TEXT);
        CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
        CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER,
          parent INTEGER, position INTEGER, title TEXT, dateAdded INTEGER, guid TEXT);
      `);
      db.prepare('INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)').run(
        1,
        'https://saved.example.com',
        'Saved Page',
      );
      db.prepare('INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)').run(
        2,
        'https://undated.example.com',
        'Undated',
      );

      const bm = db.prepare(
        'INSERT INTO moz_bookmarks (id, type, fk, parent, title, dateAdded, guid) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      // Roots: menu (folder) and the tags root.
      bm.run(2, 2, null, 1, '', 0, 'menu________');
      bm.run(4, 2, null, 1, '', 0, 'tags________');
      // A real bookmark inside a user folder under the menu.
      bm.run(10, 2, null, 2, 'Reading', 0, 'folderAAAAAA');
      const added = Date.parse('2025-03-01T12:00:00Z') * 1000; // microseconds
      bm.run(11, 1, 1, 10, 'Saved Page', added, 'bookmarkAAAA');
      // A bookmark with no dateAdded (synced/imported) directly under the menu.
      bm.run(12, 1, 2, 2, 'Undated', 0, 'bookmarkBBBB');
      // A tag folder under the tags root, holding an entry for the same place.
      bm.run(20, 2, null, 4, 'research', 0, 'tagfolderAAA');
      bm.run(21, 1, 1, 20, null, added, 'tagentryAAAA');
      // A separator, which must never become an item.
      bm.run(30, 3, null, 2, null, 0, 'separatorAAA');
      db.close();

      return dbPath;
    }

    async function importAll(dbPath: string): Promise<EmittedItem[]> {
      const importer = getImporter('firefox');
      const pipeline: EmittedGraph[] = [];
      await importer.fileImport({}, { filename: 'places.sqlite', fullPath: dbPath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return pipeline.filter((p) => p.item).map((p) => p.item);
    }

    it('imports bookmarks with the same shape as the Chrome importer', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bm-'));
      const items = await importAll(makeProfile(tmp));

      const bookmarks = items.filter((i) => i.classification === 'bookmark');
      expect(bookmarks.length).toBe(2); // the tag entry and separator are excluded

      const saved = bookmarks.find((b) => b.metadata.URL === 'https://saved.example.com');
      expect(saved!.metadata.Title).toBe('Saved Page');
      expect(saved!.metadata.Folder).toBe('Reading');
      expect(saved!.metadata.Source).toBe('Firefox');
      expect(saved!.metadata['Added Date']).toBe('2025-03-01T12:00:00.000Z');
      expect(saved!.content.filename).toBe('bookmark.txt');
      expect((await saved!.content.data!()).toString()).toBe('Saved Page\nhttps://saved.example.com');

      // dateAdded 0 leaves the bookmark undated rather than stamping 1970.
      const undated = bookmarks.find((b) => b.metadata.URL === 'https://undated.example.com');
      expect(undated!.timestamp).toBeUndefined();

      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('gives bookmarks stable ids that survive re-import', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bm-id-'));
      const dbPath = makeProfile(tmp);
      const first = (await importAll(dbPath))
        .filter((i) => i.classification === 'bookmark')
        .map((i) => i.id!);
      expect(new Set(first).size).toBe(first.length);
      expect(first.every((id: string) => id.startsWith('firefox:bookmark:'))).toBe(true);
      const second = (await importAll(dbPath))
        .filter((i) => i.classification === 'bookmark')
        .map((i) => i.id!);
      expect(second).toEqual(first);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    // A partial profile (or the history-only fixtures) has no moz_bookmarks.
    it('still imports history when moz_bookmarks is absent', async () => {
      const items = await importAll(path.join(FIXTURES_DIR, 'places.sqlite'));
      expect(items.length).toBe(1);
      expect(items[0].classification).toBe('page_view');
    });
  });

  // moz_places_metadata.total_view_time is Firefox's own measured foreground
  // dwell time, in milliseconds. It was never selected, so every visit lost
  // it even though ci.browser_activity.duration_seconds — the same DTO field
  // and screen_minutes metric the Chromium visit_duration fix (PR #2198)
  // feeds — had a producer ready and waiting.
  describe('view time', () => {
    function makeHistoryDbWithViewTime(dir: string, viewTimesMs: Array<number | null>): string {
      const dbPath = path.join(dir, 'places.sqlite');
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, description TEXT);
        CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER);
        CREATE TABLE moz_places_metadata (id INTEGER PRIMARY KEY, place_id INTEGER, referrer_place_id INTEGER,
          created_at INTEGER, updated_at INTEGER, total_view_time INTEGER, typing_time INTEGER,
          key_presses INTEGER, scrolling_time INTEGER, scrolling_distance INTEGER, document_type INTEGER,
          search_query_id INTEGER);
      `);
      db.prepare('INSERT INTO moz_places (id, url, title) VALUES (?, ?, ?)').run(
        1,
        'https://example.com',
        'Example',
      );
      const v = db.prepare('INSERT INTO moz_historyvisits (id, place_id, visit_date) VALUES (?, ?, ?)');
      const m = db.prepare(
        'INSERT INTO moz_places_metadata (id, place_id, created_at, updated_at, total_view_time) VALUES (?, ?, ?, ?, ?)',
      );
      viewTimesMs.forEach((vt, i) => {
        const visitDateUs = Date.parse(`2025-02-1${i}T00:00:00Z`).valueOf() * 1000;
        v.run(i + 1, 1, visitDateUs);
        if (vt !== null) {
          // created_at is milliseconds; align it with the visit so it falls
          // inside the join's 2s window, same as a real profile's session
          // metadata starting essentially when the visit does.
          m.run(i + 1, 1, Math.floor(visitDateUs / 1000), Math.floor(visitDateUs / 1000), vt);
        }
      });
      db.close();

      return dbPath;
    }

    // toStrictEqual, not toEqual: toEqual ignores undefined array entries, so
    // an EMPTY result would compare equal to [undefined] and a test asserting
    // "no duration" would pass against an import that produced nothing.
    const viewTimes = async (msValues: Array<number | null>) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-vt-'));
      const dbPath = makeHistoryDbWithViewTime(tmp, msValues);
      const importer = getImporter('firefox');
      const pipeline: EmittedGraph[] = [];
      await importer.fileImport({}, { filename: 'places.sqlite', fullPath: dbPath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      const views = pipeline.filter((p) => p.item).map((p) => p.item);
      expect(views).toHaveLength(msValues.length);
      fs.rmSync(tmp, { recursive: true, force: true });

      return views.map((i) => i.metadata.DurationSeconds);
    };

    it('converts milliseconds to seconds', async () => {
      expect(await viewTimes([45_000, 90_000])).toStrictEqual([45, 90]);
    });

    it('omits a visit with no metadata row', async () => {
      expect(await viewTimes([null])).toStrictEqual([undefined]);
    });

    it('omits an implausibly long view time instead of clamping it', async () => {
      const fiveHours = 5 * 60 * 60 * 1000;
      const oneHundredHours = 100 * 60 * 60 * 1000;
      expect(await viewTimes([fiveHours, oneHundredHours])).toStrictEqual([undefined, undefined]);
    });

    it('keeps a long but plausible sitting just under the bound', async () => {
      const justUnderFourHours = (4 * 60 * 60 - 1) * 1000;
      expect(await viewTimes([justUnderFourHours])).toStrictEqual([4 * 60 * 60 - 1]);
    });

    // The base fixture (used throughout this file) has no moz_places_metadata
    // table at all — the already-passing 'imports Firefox history' test above
    // is the regression coverage for that probe degrading instead of
    // importing nothing.
  });
});

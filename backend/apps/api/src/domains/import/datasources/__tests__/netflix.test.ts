import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { NetflixFileImporter } from '../netflix';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const EXPORT_DIR = path.join(FIXTURES_DIR, 'netflix-export');
const CSV_FILE = path.join(EXPORT_DIR, 'ViewingActivity.csv');
const SIMPLE_DIR = path.join(FIXTURES_DIR, 'netflix-simple-export');
const SIMPLE_CSV = path.join(SIMPLE_DIR, 'NetflixViewingHistory.csv');

function runImport(entry: { filename: string; fullPath: string }) {
  const pipeline: EmittedGraph[] = [];
  const fi = new NetflixFileImporter();

  return fi
    .fileImport({}, entry, { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams)
    .then(() => pipeline);
}

describe('Netflix datasource', () => {
  it('recognizes a directory containing ViewingActivity.csv', async () => {
    const fi = new NetflixFileImporter();
    const rec = await fi.recognize({}, { filename: 'netflix-export', fullPath: EXPORT_DIR });
    expect(rec.confidence).toBeGreaterThan(0.85);
  });

  it('recognizes a single ViewingActivity.csv file', async () => {
    const fi = new NetflixFileImporter();
    const rec = await fi.recognize({}, { filename: 'ViewingActivity.csv', fullPath: CSV_FILE });
    expect(rec.confidence).toBeGreaterThan(0.85);
  });

  it('recognizes a renamed CSV by header columns', async () => {
    const tmp = path.join(os.tmpdir(), `netflix-renamed-${Date.now()}.csv`);
    fs.copyFileSync(CSV_FILE, tmp);
    try {
      const fi = new NetflixFileImporter();
      const rec = await fi.recognize({}, { filename: 'renamed.csv', fullPath: tmp });
      expect(rec.confidence).toBeGreaterThan(0.8);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('imports viewing rows as watch items', async () => {
    const pipeline = await runImport({ filename: 'ViewingActivity.csv', fullPath: CSV_FILE });
    expect(pipeline.length).toBe(2);
    expect(pipeline.every((p) => p.item.classification === 'watch')).toBe(true);
  });

  it('imports via the export directory too', async () => {
    const pipeline = await runImport({ filename: 'netflix-export', fullPath: EXPORT_DIR });
    expect(pipeline.length).toBe(2);
  });

  it('parses metadata and the quoted-comma title intact', async () => {
    const pipeline = await runImport({ filename: 'ViewingActivity.csv', fullPath: CSV_FILE });
    // First title contains commas inside quotes — must survive the CSV parser whole.
    expect(pipeline[0].item.metadata.Title).toBe(
      'Stranger Things: Season 1: Chapter One: The Vanishing of Will Byers',
    );
    expect(pipeline[0].item.metadata.Profile).toBe('Liam');
    expect(pipeline[0].item.metadata.Source).toBe('Netflix');
    expect(pipeline[0].item.timestamp).toBeDefined();
    // Second row also has a comma inside a quoted title.
    expect(pipeline[1].item.metadata.Title).toBe('Glass Onion: A Knives Out Mystery');
    expect(pipeline[1].item.metadata.Device).toBe('iPhone');
  });

  it('keys the content row on the title, so every viewing of one title shares a row', async () => {
    const pipeline = await runImport({ filename: 'ViewingActivity.csv', fullPath: CSV_FILE });
    const crypto = await import('node:crypto');
    const expected =
      'netflix:title:' +
      crypto.createHash('sha256').update('glass onion: a knives out mystery').digest('hex').slice(0, 16);
    expect(pipeline[1].item.metadata.URI).toBe(expected);
    // Item ids stay per viewing: the URI is the CONTENT identity, not the event's.
    expect(pipeline[1].item.id).not.toBe(expected);
    // Identical across case/whitespace, so a re-export that re-spaces a title converges.
    const ids = new Set(pipeline.map((p) => p.item.metadata.URI));
    expect(ids.size).toBeLessThanOrEqual(pipeline.length);
  });

  it('computes timespanEnd as start time plus the hh:mm:ss Duration', async () => {
    const pipeline = await runImport({ filename: 'ViewingActivity.csv', fullPath: CSV_FILE });
    // 2021-01-01 20:15:00 + 00:48:12 = 21:03:12
    expect(pipeline[0].item.timespanEnd?.toISOString()).toBe('2021-01-01T21:03:12.000Z');
    // 2021-01-02 21:30:00 + 01:52:30 = 23:22:30
    expect(pipeline[1].item.timespanEnd?.toISOString()).toBe('2021-01-02T23:22:30.000Z');
  });

  it('drops full-export rows with a sub-minute Duration', async () => {
    const tmp = path.join(os.tmpdir(), `netflix-short-${Date.now()}.csv`);
    fs.writeFileSync(
      tmp,
      'Profile Name,Start Time,Duration,Title\n' +
        'Liam,2021-01-01 20:15:00,00:00:59,"Trailer Autoplay"\n' +
        'Liam,2021-01-01 20:16:00,00:01:00,"Kept: Exactly One Minute"\n' +
        'Liam,2021-01-01 20:20:00,00:45:00,"Kept: Real Episode"\n',
    );
    try {
      const pipeline = await runImport({ filename: 'short.csv', fullPath: tmp });
      expect(pipeline.map((p) => p.item.metadata.Title)).toEqual([
        'Kept: Exactly One Minute',
        'Kept: Real Episode',
      ]);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('omits timespanEnd when Duration is absent or malformed', async () => {
    const tmp = path.join(os.tmpdir(), `netflix-nodur-${Date.now()}.csv`);
    fs.writeFileSync(
      tmp,
      'Profile Name,Start Time,Duration,Title\n' +
        'Liam,2021-01-01 20:15:00,,"No Duration"\n' +
        'Liam,2021-01-01 21:15:00,garbage,"Bad Duration"\n',
    );
    try {
      const pipeline = await runImport({ filename: 'nodur.csv', fullPath: tmp });
      expect(pipeline.length).toBe(2);
      expect(pipeline[0].item.timespanEnd).toBeUndefined();
      expect(pipeline[1].item.timespanEnd).toBeUndefined();
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('recognizes the quick NetflixViewingHistory.csv export by name', async () => {
    const fi = new NetflixFileImporter();
    const rec = await fi.recognize({}, { filename: 'NetflixViewingHistory.csv', fullPath: SIMPLE_CSV });
    expect(rec.confidence).toBeGreaterThan(0.85);
  });

  it('recognizes the quick export directory', async () => {
    const fi = new NetflixFileImporter();
    const rec = await fi.recognize({}, { filename: 'netflix-simple-export', fullPath: SIMPLE_DIR });
    expect(rec.confidence).toBeGreaterThan(0.85);
  });

  it('does not recognize a renamed quick export from its Title,Date header alone', async () => {
    // The quick export's header is just "Title,Date" — no Netflix-specific
    // marker anywhere in it, so a generic watchlist or to-do app's minimal
    // CSV export in that exact shape would previously have been claimed at
    // 0.85 confidence under any filename. Content alone can no longer stand
    // in for the missing/renamed canonical filename; only the richer full-export
    // header is distinctive enough to survive a rename on its own.
    const tmp = path.join(os.tmpdir(), `netflix-simple-renamed-${Date.now()}.csv`);
    fs.copyFileSync(SIMPLE_CSV, tmp);
    try {
      const fi = new NetflixFileImporter();
      const rec = await fi.recognize({}, { filename: 'renamed.csv', fullPath: tmp });
      expect(rec.confidence).toBe(0);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('does not recognize a same-named CSV with unrelated content', async () => {
    // "ViewingActivity.csv" and "NetflixViewingHistory.csv" used to be worth
    // 0.9 confidence the moment the name matched — no header read at all. A
    // same-named CSV from an unrelated app (or a stale/corrupted download)
    // must not be claimed as Netflix on the filename alone.
    const tmp = path.join(os.tmpdir(), `netflix-lookalike-${Date.now()}.csv`);
    fs.writeFileSync(tmp, 'Item,Category,Store,Total\nWidget,Home,Target,19.99\n');
    try {
      const fi = new NetflixFileImporter();
      const rec = await fi.recognize({}, { filename: 'ViewingActivity.csv', fullPath: tmp });
      expect(rec.confidence).toBe(0);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('imports the quick export with a parsed date and title', async () => {
    const pipeline = await runImport({ filename: 'NetflixViewingHistory.csv', fullPath: SIMPLE_CSV });
    expect(pipeline.length).toBe(2);
    expect(pipeline.every((p) => p.item.classification === 'watch')).toBe(true);
    expect(pipeline[0].item.metadata.Title).toBe(
      'Stranger Things: Season 1: Chapter One: The Vanishing of Will Byers',
    );
    expect(pipeline[0].item.metadata.Source).toBe('Netflix');
    // "1/1/21" → 2021-01-01 UTC midnight; profile/device absent in this format.
    expect(pipeline[0].item.timestamp?.toISOString()).toBe('2021-01-01T00:00:00.000Z');
    expect(pipeline[0].item.metadata.Profile).toBeUndefined();
  });

  it('gives same-day quick-export rows distinct stable ids', async () => {
    const tmp = path.join(os.tmpdir(), `netflix-sameday-${Date.now()}.csv`);
    fs.writeFileSync(
      tmp,
      'Title,Date\n' +
        '"Show A: Episode 2","4/5/26"\n' +
        '"Show A: Episode 1","4/5/26"\n' +
        '"Show B","4/5/26"\n',
    );
    try {
      const pipeline = await runImport({ filename: 'NetflixViewingHistory.csv', fullPath: tmp });
      expect(pipeline.length).toBe(3);
      const ids = pipeline.map((p) => p.item.id!);
      expect(new Set(ids).size).toBe(3);
      expect(ids[0]).toBe('netflix:4/5/26::Show A: Episode 2');
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('disambiguates exactly-identical rows with an occurrence counter', async () => {
    const tmp = path.join(os.tmpdir(), `netflix-dupes-${Date.now()}.csv`);
    fs.writeFileSync(tmp, 'Title,Date\n' + '"Same Show","4/5/26"\n' + '"Same Show","4/5/26"\n');
    try {
      const pipeline = await runImport({ filename: 'NetflixViewingHistory.csv', fullPath: tmp });
      expect(pipeline.map((p) => p.item.id!)).toEqual([
        'netflix:4/5/26::Same Show',
        'netflix:4/5/26::Same Show:1',
      ]);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('builds full-export ids from start time, profile, and title', async () => {
    const pipeline = await runImport({ filename: 'ViewingActivity.csv', fullPath: CSV_FILE });
    expect(pipeline[0].item.id).toBe(
      'netflix:2021-01-01 20:15:00:Liam:Stranger Things: Season 1: Chapter One: The Vanishing of Will Byers',
    );
  });

  it('does not claim an unrelated two-column Title,Date CSV with extra columns', async () => {
    const tmp = path.join(os.tmpdir(), `not-netflix-${Date.now()}.csv`);
    fs.writeFileSync(tmp, 'Title,Date,Author\n"Some Book","1/2/21","Jane"\n');
    try {
      const fi = new NetflixFileImporter();
      const rec = await fi.recognize({}, { filename: 'books.csv', fullPath: tmp });
      expect(rec.confidence).toBe(0);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('malformed input does not throw', async () => {
    const tmp = path.join(os.tmpdir(), `netflix-malformed-${Date.now()}.csv`);
    // Unbalanced quotes, stray commas, binary noise.
    fs.writeFileSync(tmp, 'Profile Name,Start Time,Title\n"unterminated, quote,\x00\xff,garbage\n,,');
    try {
      const pipeline = await runImport({ filename: 'malformed.csv', fullPath: tmp });
      expect(Array.isArray(pipeline)).toBe(true);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it('empty input yields no items', async () => {
    const tmp = path.join(os.tmpdir(), `netflix-empty-${Date.now()}.csv`);
    fs.writeFileSync(tmp, '');
    try {
      const pipeline = await runImport({ filename: 'empty.csv', fullPath: tmp });
      expect(pipeline.length).toBe(0);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

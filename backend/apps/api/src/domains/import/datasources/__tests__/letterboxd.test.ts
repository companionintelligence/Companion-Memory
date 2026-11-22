import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { LetterboxdFileImporter } from '../letterboxd';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

// diary.csv export with rows that share the SAME 'Watched Date'. Before the id
// fix these collapsed to a single dedup key: sha1(data_source \0 'watch' \0
// 'watch.txt' \0 '' \0 ISO(midnight-of-day) \0 ''). Each row carries a distinct
// 'Letterboxd URI'.
const HEADER = 'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date';
const ROWS = [
  '2024-03-01,Dune,2021,https://boxd.it/aaa,5,No,,2024-03-01',
  '2024-03-01,Arrival,2016,https://boxd.it/bbb,4,No,,2024-03-01',
  '2024-03-01,Sicario,2015,https://boxd.it/ccc,4,No,,2024-03-01',
];

function writeExport(): string {
  const tmp = path.join(os.tmpdir(), `diary-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(tmp, `${HEADER}\n${ROWS.join('\n')}\n`);

  return tmp;
}

async function importRows(fpath: string): Promise<EmittedGraph[]> {
  const fi = new LetterboxdFileImporter();
  const pipeline: EmittedGraph[] = [];
  await fi.fileImport({}, { filename: path.basename(fpath), fullPath: fpath }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return pipeline;
}

describe('Letterboxd datasource', () => {
  it('does not recognize a same-named CSV from a different app', async () => {
    // "diary.csv" and "ratings.csv" are generic names other apps' own exports
    // use verbatim (a mood-tracking app's diary, a beer-rating app's ratings)
    // — the filename tier used to skip the header check entirely and return
    // 0.8 the moment the name matched, outranking other importers' own
    // content-verified tiers.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-letterboxd-lookalike-'));
    const fpath = path.join(dir, 'diary.csv');
    fs.writeFileSync(fpath, 'Date,Mood,Notes\n2024-03-01,Good,Slept well\n');

    const fi = new LetterboxdFileImporter();
    const rec = await fi.recognize({}, { filename: 'diary.csv', fullPath: fpath });
    expect(rec.confidence).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('assigns a unique stable id to every film even when Watched Date collides', async () => {
    const fpath = writeExport();
    try {
      const pipeline = await importRows(fpath);
      expect(pipeline.length).toBe(ROWS.length);

      const ids = pipeline.map((p) => p.item.id!);
      // (a) every id truthy
      expect(ids.every((id) => !!id)).toBe(true);
      // (b) no collisions despite identical day-precision timestamp + constant filename
      expect(new Set(ids).size).toBe(pipeline.length);
    } finally {
      await fs.promises.unlink(fpath).catch(() => {});
    }
  });

  it('produces identical ids on re-import (idempotent)', async () => {
    const fpath = writeExport();
    try {
      const first = (await importRows(fpath)).map((p) => p.item.id!);
      const second = (await importRows(fpath)).map((p) => p.item.id!);
      expect(second).toEqual(first);
      expect(first).toEqual(['https://boxd.it/aaa', 'https://boxd.it/bbb', 'https://boxd.it/ccc']);
    } finally {
      await fs.promises.unlink(fpath).catch(() => {});
    }
  });

  describe('a full export folder', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-letterboxd-export-'));
      // Diary and review rows carry the diary entry's URI; ratings carry the film's.
      fs.writeFileSync(
        path.join(dir, 'diary.csv'),
        [
          'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date',
          '2026-09-12,The Lantern Orchard,2025,https://boxd.it/9xKq1p,4,,,2026-09-11',
          '2026-10-04,A Heron in Winter,2026,https://boxd.it/9yLr2q,4.5,,,2026-10-04',
          "2026-10-20,The Cartographer's Daughter,2026,https://boxd.it/9zMs3r,3.5,,,2026-10-20",
          '2026-11-01,The Lantern Orchard,2025,https://boxd.it/a0Nt4s,4.5,Yes,,2026-10-31',
        ].join('\n') + '\n',
      );
      fs.writeFileSync(
        path.join(dir, 'ratings.csv'),
        [
          'Date,Name,Year,Letterboxd URI,Rating',
          '2026-11-01,The Lantern Orchard,2025,https://boxd.it/aZ91,4.5',
          '2026-10-04,A Heron in Winter,2026,https://boxd.it/bQ27,4.5',
          "2026-10-20,The Cartographer's Daughter,2026,https://boxd.it/dS63,3.5",
          '2026-08-02,Neap Tide,2024,https://boxd.it/cR48,3',
        ].join('\n') + '\n',
      );
      fs.writeFileSync(
        path.join(dir, 'reviews.csv'),
        [
          'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date',
          '2026-10-04,A Heron in Winter,2026,https://boxd.it/9yLr2q,4.5,,Ninety minutes of a bird standing still.,,2026-10-04',
        ].join('\n') + '\n',
      );
    });

    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    async function importDir(): Promise<EmittedGraph[]> {
      const fi = new LetterboxdFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return pipeline;
    }

    it('counts a rated film once when the diary already logged it', async () => {
      const pipeline = await importDir();
      // Four diary viewings, plus the one film that was only ever rated.
      expect(pipeline.map((g) => g.item.id)).toEqual([
        'https://boxd.it/9xKq1p',
        'https://boxd.it/9yLr2q',
        'https://boxd.it/9zMs3r',
        'https://boxd.it/a0Nt4s',
        'https://boxd.it/cR48',
      ]);
      const rated = pipeline[4].item;
      expect(rated.metadata.Name).toBe('Neap Tide');
      expect(rated.timestamp?.toISOString()).toBe('2026-08-02T00:00:00.000Z');
    });

    it('puts review text on the diary row it was written on', async () => {
      const pipeline = await importDir();
      const heron = pipeline.find((g) => g.item.id === 'https://boxd.it/9yLr2q')!.item;
      expect(heron.metadata.Review).toBe('Ninety minutes of a bird standing still.');
      expect(heron.metadata.Text).toBe('Ninety minutes of a bird standing still.');
      expect(heron.metadata.Rating).toBe('4.5');
      // No second row for the review itself.
      expect(pipeline.filter((g) => g.item.id === 'https://boxd.it/9yLr2q')).toHaveLength(1);
      expect(
        pipeline.find((g) => g.item.id === 'https://boxd.it/9xKq1p')!.item.metadata.Review,
      ).toBeUndefined();
    });

    it('imports a review whose diary row is missing as its own viewing', async () => {
      fs.rmSync(path.join(dir, 'diary.csv'));
      const pipeline = await importDir();
      expect(pipeline.map((g) => g.item.id)).toEqual([
        'https://boxd.it/9yLr2q',
        'https://boxd.it/aZ91',
        'https://boxd.it/dS63',
        'https://boxd.it/cR48',
      ]);
      expect(pipeline[0].item.metadata.Review).toBe('Ninety minutes of a bird standing still.');
    });

    it('gives an unrated latest viewing the rating the film got afterwards', async () => {
      fs.writeFileSync(
        path.join(dir, 'diary.csv'),
        [
          'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date',
          '2026-09-12,The Lantern Orchard,2025,https://boxd.it/9xKq1p,3,,,2026-09-11',
          '2026-11-01,The Lantern Orchard,2025,https://boxd.it/a0Nt4s,,Yes,,2026-10-31',
        ].join('\n') + '\n',
      );
      const pipeline = await importDir();
      const lantern = pipeline.filter((g) => g.item.metadata.Name === 'The Lantern Orchard');
      expect(lantern.map((g) => [g.item.id, g.item.metadata.Rating])).toEqual([
        ['https://boxd.it/9xKq1p', '3'],
        ['https://boxd.it/a0Nt4s', '4.5'],
      ]);
    });

    it('puts a review without a URI on the diary row of the same film and day', async () => {
      fs.writeFileSync(
        path.join(dir, 'reviews.csv'),
        [
          'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date',
          '2026-10-04,A Heron in Winter,2026,,4.5,,Ninety minutes of a bird standing still.,,2026-10-04',
        ].join('\n') + '\n',
      );
      const pipeline = await importDir();
      const heron = pipeline.filter((g) => g.item.metadata.Name === 'A Heron in Winter');
      expect(heron).toHaveLength(1);
      expect(heron[0].item.metadata.Review).toBe('Ninety minutes of a bird standing still.');
    });
  });
});

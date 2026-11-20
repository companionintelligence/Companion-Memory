import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { NotionFileImporter } from '../notion';
import type { ImportParams } from '../timeline';

import type { EmittedGraph, EmittedItem } from './support/emitted';
import { metaText } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Notion datasource', () => {
  it('recognizes an export directory containing markdown pages', async () => {
    const root = path.join(FIXTURES_DIR, 'notion-export');
    const fi = new NotionFileImporter();
    const rec = await fi.recognize({}, { filename: 'notion-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.6);
    expect(rec.confidence).toBeLessThan(0.8);
    expect(rec.dir_threshold).toBe(0.7);
  });

  it('recognizes a single markdown page dropped directly', async () => {
    const fpath = path.join(
      FIXTURES_DIR,
      'notion-export',
      'Weekly Review 0f1e2d3c4b5a69788796a5b4c3d2e1f0.md',
    );
    const fi = new NotionFileImporter();
    const rec = await fi.recognize({}, { filename: 'Weekly Review.md', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.5);
    expect(rec.confidence).toBeLessThan(0.8);
  });

  it('does not recognize a non-markdown file', async () => {
    const fpath = path.join(
      FIXTURES_DIR,
      'notion-export',
      'Project Notes 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.csv',
    );
    const fi = new NotionFileImporter();
    const rec = await fi.recognize({}, { filename: 'db.csv', fullPath: fpath });
    expect(rec.confidence).toBe(0);
  });

  it('imports each markdown page (recursing subdirs) as a note', async () => {
    const root = path.join(FIXTURES_DIR, 'notion-export');
    const fi = new NotionFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'notion-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(2);
    for (const g of pipeline) {
      expect(g.item.classification).toBe('note');
      expect(g.item.metadata.Source).toBe('Notion');
      expect(g.item.content.mediaType).toBe('text/plain');
    }

    const byTitle: Record<string, EmittedItem> = {};
    for (const g of pipeline) {
      byTitle[metaText(g.item.metadata.Title)] = g.item;
    }

    // Top-level page with a "Created:" property → parsed timestamp + full content.
    const weekly = byTitle['Weekly Review'];
    expect(weekly).toBeDefined();
    expect(weekly.timestamp).toBeInstanceOf(Date);
    expect(weekly.timestamp!.getUTCFullYear()).toBe(2023);
    expect(weekly.timestamp!.getUTCMonth()).toBe(0);
    expect(weekly.timestamp!.getUTCDate()).toBe(15);
    const weeklyText = (await weekly.content.data!()).toString('utf8');
    expect(weeklyText).toContain('# Weekly Review');
    expect(weeklyText).toContain('Finished the Notion importer');

    // Nested page with no created date → timestamp omitted.
    const meeting = byTitle['Meeting Notes'];
    expect(meeting).toBeDefined();
    expect(meeting.timestamp).toBeUndefined();
    const meetingText = (await meeting.content.data!()).toString('utf8');
    expect(meetingText).toContain('GraphQL handoff');
  });

  // SRC-01. A `note` routes to `content` ONLY, and the content row's `text` is
  // read out of metadata by push/canonical.ts `descriptionFor`. Nothing on the
  // push path ever calls `item.content.data()`, so a body that exists only in
  // the blob loader lands as an empty content row.
  it('carries the page body in metadata.Text, not only in the content loader', async () => {
    const root = path.join(FIXTURES_DIR, 'notion-export');
    const fi = new NotionFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'notion-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const byTitle: Record<string, EmittedItem> = {};
    for (const g of pipeline) {
      byTitle[metaText(g.item.metadata.Title)] = g.item;
    }

    const weekly = byTitle['Weekly Review'];
    expect(metaText(weekly.metadata.Text)).toContain('Finished the Notion importer');
    // Same bytes the loader would have produced.
    expect(metaText(weekly.metadata.Text)).toBe((await weekly.content.data!()).toString('utf8'));
  });

  it('respects the timeframe filter', async () => {
    const root = path.join(FIXTURES_DIR, 'notion-export');
    const fi = new NotionFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'notion-export', fullPath: root }, {
      pipeline,
      timeframe: { since: new Date('2024-01-01T00:00:00Z') },
      log: () => {},
    } as unknown as ImportParams);

    // The dated "Weekly Review" (2023) is filtered out; the undated page passes
    // (undefined timestamp is always included).
    const titles = pipeline.map((g) => g.item.metadata.Title);
    expect(titles).not.toContain('Weekly Review');
    expect(titles).toContain('Meeting Notes');
  });

  it('assigns a unique, stable, idempotent id per page (undated pages do not collapse)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'notion-dedup-'));
    try {
      // Two undated pages (no "Created:" line) → identical timestamp/filename/coords,
      // which without an explicit item.id would hash to the same dedup key and collapse.
      await fs.promises.writeFile(
        path.join(dir, 'Alpha 1111111111111111111111111111aaaa.md'),
        '# Alpha\nfirst page body\n',
      );
      await fs.promises.writeFile(
        path.join(dir, 'Beta 2222222222222222222222222222bbbb.md'),
        '# Beta\nsecond page body\n',
      );

      const fi = new NotionFileImporter();
      const run = async () => {
        const pipeline: EmittedGraph[] = [];
        await fi.fileImport({}, { filename: 'notion-export', fullPath: dir }, {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);

        return pipeline;
      };

      const pipeline = await run();
      expect(pipeline.length).toBe(2);

      const ids = pipeline.map((g) => g.item.id!);
      // (a) every id truthy, (b) all ids unique.
      for (const id of ids) {
        expect(id).toBeTruthy();
      }

      expect(new Set(ids).size).toBe(ids.length);

      // (c) re-importing the same export yields identical ids (idempotent).
      const again = await run();
      expect(again.map((g) => g.item.id!).sort()).toEqual(ids.slice().sort());
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not throw on an empty file', async () => {
    const fi = new NotionFileImporter();
    const fs = await import('node:fs');
    const tmp = path.join(FIXTURES_DIR, 'notion-export', 'Empty Page deadbeefdeadbeefdeadbeefdeadbeef.md');
    await fs.promises.writeFile(tmp, '');
    try {
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'Empty.md', fullPath: tmp }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(0);
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  });
});

describe('Notion datasource — nested pages, databases and embedded files', () => {
  let root: string;

  const write = (rel: string, body: string | Buffer): void => {
    const fpath = path.join(root, rel);
    fs.mkdirSync(path.dirname(fpath), { recursive: true });
    fs.writeFileSync(fpath, body);
  };

  const RG = 'Reading Garden 74a391fc8c6449a78233d098f84227ed';
  const BN = 'Book Notes 6b7d714dc27c3cafa521c95893bafbd3';
  const QU = 'Quotes 4d5f6a86a4a9065049ee36fa045eb834';
  const WL = 'Wishlist 863a4c0fbc23d78288d94d1004240ea0';

  beforeEach(() => {
    // An export zip unpacks into a folder named after the archive.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-nested-'));
    const ex = 'Export-2c3d4e5f';
    write(`${ex}/${RG}.md`, '# Reading Garden\n\nHome page.\n\n![bookshelf.jpg](bookshelf.jpg)\n');
    write(`${ex}/${RG}/bookshelf.jpg`, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    write(`${ex}/${RG}/${BN}.md`, '# Book Notes\n');
    write(`${ex}/${RG}/${BN}/${QU}.md`, '# Quotes\n\n> The beauty of the House is immeasurable.\n');
    write(
      `${ex}/${RG}/${BN}/${QU}/Favourite lines 0379d0c80a280df7ceddb6e17758f49c.md`,
      '# Favourite lines\n',
    );
    // A database inside a page: the CSV (twice, as newer exports write it) and a page per row.
    write(`${ex}/${RG}/${WL}.csv`, 'Name,Author,Status\nThe Bee Sting,Paul Murray,Wanted\n');
    write(`${ex}/${RG}/${WL}_all.csv`, 'Name,Author,Status\nThe Bee Sting,Paul Murray,Wanted\n');
    write(
      `${ex}/${RG}/${WL}/The Bee Sting abce3e4f2d41949dfb6487a20291b1d7.md`,
      '# The Bee Sting\n\nAuthor: Paul Murray\nStatus: Wanted\n',
    );
    // Not inside a Notion page folder: someone else's file in the same upload.
    write('stray/readme.txt', 'not Notion');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = async (): Promise<{ pipeline: EmittedGraph[]; drops: [string, string?][] }> => {
    const pipeline: EmittedGraph[] = [];
    const drops: [string, string?][] = [];
    (pipeline as unknown as { drop: (reason: string, detail?: string) => void }).drop = (reason, detail) =>
      drops.push([reason, detail]);
    await new NotionFileImporter().fileImport({}, { filename: path.basename(root), fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    return { pipeline, drops };
  };

  it('imports pages at every depth, database rows included', async () => {
    const { pipeline } = await run();
    const notes = pipeline.filter((g) => g.item.classification === 'note').map((g) => g.item.metadata.Title);
    expect(notes.sort()).toEqual([
      'Book Notes',
      'Favourite lines',
      'Quotes',
      'Reading Garden',
      'The Bee Sting',
    ]);
    const row = pipeline.find((g) => g.item.metadata.Title === 'The Bee Sting')!.item;
    expect(metaText(row.metadata.Text)).toContain('Author: Paul Murray');
  });

  it('imports a file embedded in a page as media named after the page', async () => {
    const { pipeline } = await run();
    const files = pipeline.filter((g) => g.item.classification !== 'note').map((g) => g.item);
    expect(files).toHaveLength(1);
    expect(files[0].classification).toBe('media');
    expect(files[0].id).toBe(`notion:${RG}/bookshelf.jpg`);
    expect(files[0].metadata).toMatchObject({
      Title: 'bookshelf.jpg',
      Page: 'Reading Garden',
      Source: 'Notion',
    });
    expect(files[0].intermediateLocation!.endsWith(path.join(RG, 'bookshelf.jpg'))).toBe(true);
  });

  it('counts the database CSVs as represented by their row pages', async () => {
    const { drops } = await run();
    expect(drops).toHaveLength(2);
    expect(drops).toEqual(
      expect.arrayContaining([
        ['notion_database_csv', `${WL}.csv`],
        ['notion_database_csv', `${WL}_all.csv`],
      ]),
    );
  });
});

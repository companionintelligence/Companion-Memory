import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { KindleFileImporter } from '../kindle';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Kindle highlights datasource', () => {
  it('recognizes directory containing My Clippings.txt', async () => {
    const root = path.join(FIXTURES_DIR, 'kindle-export');
    const fi = new KindleFileImporter();
    const rec = await fi.recognize({}, { filename: 'kindle-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('recognizes My Clippings.txt file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'kindle-export', 'My Clippings.txt');
    const fi = new KindleFileImporter();
    const rec = await fi.recognize({}, { filename: 'My Clippings.txt', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  // The importer used to claim notebook.json at 0.8 while fileImport only ever
  // looked for My Clippings.txt — so a dropped notebook.json recognized, ran,
  // and imported nothing while reporting success. Recognition is gone until the
  // scraper that would produce that file actually exists.
  it('does not recognize a notebook.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-kindle-nb-'));
    try {
      const fpath = path.join(dir, 'notebook.json');
      fs.writeFileSync(fpath, JSON.stringify([{ book: 'The Hobbit', highlight: 'In a hole…' }]));
      const fi = new KindleFileImporter();
      const asFile = await fi.recognize({}, { filename: 'notebook.json', fullPath: fpath });
      expect(asFile.confidence).toBe(0);
      const asDir = await fi.recognize({}, { filename: path.basename(dir), fullPath: dir });
      expect(asDir.confidence).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports highlights as annotation items', async () => {
    const root = path.join(FIXTURES_DIR, 'kindle-export');
    const fi = new KindleFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'kindle-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(3);
    expect(pipeline.every((p) => p.item.classification === 'annotation')).toBe(true);
  });

  it('extracts book title, author, and clip content', async () => {
    const root = path.join(FIXTURES_DIR, 'kindle-export');
    const fi = new KindleFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'kindle-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const first = pipeline[0];
    expect(first.item.metadata.Book).toBe('Thinking, Fast and Slow');
    expect(first.item.metadata.Author).toBe('Kahneman, Daniel');
    expect(first.item.metadata['Clip Type']).toBe('Highlight');
    expect(first.entity?.type).toBe('book');
    expect(first.entity?.name).toBe('Thinking, Fast and Slow');
  });

  // SRC-01. `annotation` → kind `reading.annotation`, which routes to `content`
  // only. The clipping text has to ride in metadata: `descriptionFor` fills the
  // content row's `text` from `Highlight`, and `titleFor` appends it to the book
  // name so two clippings from one book do not share a title.
  it('carries the clipping text in metadata.Highlight, not only in the content loader', async () => {
    const root = path.join(FIXTURES_DIR, 'kindle-export');
    const fi = new KindleFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'kindle-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    for (const g of pipeline) {
      const highlight = g.item.metadata.Highlight;
      expect(typeof highlight).toBe('string');
      expect(highlight).toBe((await g.item.content!.data!()).toString('utf8'));
    }

    // Distinct clippings carry distinct text — this is what keeps their titles apart.
    const highlights = new Set(pipeline.map((g) => g.item.metadata.Highlight));
    expect(highlights.size).toBe(pipeline.length);
  });

  it('handles two different books', async () => {
    const root = path.join(FIXTURES_DIR, 'kindle-export');
    const fi = new KindleFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'kindle-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const books = new Set(pipeline.map((p) => p.item.metadata.Book));
    expect(books.size).toBe(2);
  });

  it('assigns distinct, idempotent ids to clippings that would otherwise collapse on the dedup hash', async () => {
    // Two highlights in the SAME book at the SAME added-on second — the constant
    // 'clipping.txt' filename + identical timestamp would collapse them on hashItem.
    const block = (loc: string, text: string) =>
      `Sapiens (Harari, Yuval)\n- Your Highlight | Location ${loc} | Added on Monday, January 4, 2021 8:15:00 AM\n\n${text}\n==========\n`;
    const raw =
      block('100-104', 'First idea about cognitive revolution.') +
      block('200-204', 'Second idea about agricultural revolution.');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-dedup-'));
    fs.writeFileSync(path.join(dir, 'My Clippings.txt'), raw);

    const fi = new KindleFileImporter();
    const run = async () => {
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: path.basename(dir), fullPath: dir }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return pipeline;
    };

    const pipeline = await run();
    expect(pipeline.length).toBe(2);

    const ids = pipeline.map((p) => p.item.id!);
    expect(ids.every((id) => !!id)).toBe(true);
    expect(new Set(ids).size).toBe(pipeline.length);

    // Re-import yields identical ids (idempotent).
    const ids2 = (await run()).map((p) => p.item.id!);
    expect(ids2).toEqual(ids);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

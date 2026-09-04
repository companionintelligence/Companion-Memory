import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { EvernoteFileImporter } from '../evernote';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Evernote datasource', () => {
  it('recognizes export directory containing a .enex file', async () => {
    const root = path.join(FIXTURES_DIR, 'evernote-export');
    const fi = new EvernoteFileImporter();
    const rec = await fi.recognize({}, { filename: 'evernote-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes a single .enex file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'evernote-export', 'Notebook.enex');
    const fi = new EvernoteFileImporter();
    const rec = await fi.recognize({}, { filename: 'Notebook.enex', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('does not recognize an unrelated directory', async () => {
    const root = path.join(FIXTURES_DIR, 'netflix-export');
    const fi = new EvernoteFileImporter();
    const rec = await fi.recognize({}, { filename: 'netflix-export', fullPath: root });
    expect(rec.confidence).toBe(0);
  });

  it('imports each note as a note item with correct fields', async () => {
    const root = path.join(FIXTURES_DIR, 'evernote-export');
    const fi = new EvernoteFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'evernote-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(2);

    const first = pipeline[0].item;
    expect(first.classification).toBe('note');
    expect(first.metadata.Title).toBe('Grocery List');
    expect(first.metadata.Source).toBe('Evernote');
    expect(first.metadata.Tags).toEqual(['shopping', 'home']);
    // created: 20230115T103000Z
    expect(first.timestamp).toBeInstanceOf(Date);
    expect(first.timestamp!.toISOString()).toBe('2023-01-15T10:30:00.000Z');

    // Content stripped to plain text with entities decoded.
    const text = (await first.content!.data!()).toString('utf8');
    expect(text).toContain('Buy milk & eggs');
    expect(text).toContain('Pick up bread from the <corner> store');
    expect(text).toContain('Apples');
    expect(text).not.toContain('<div>');
    expect(text).not.toContain('<en-note>');

    const second = pipeline[1].item;
    expect(second.metadata.Title).toBe('Meeting Notes');
    // No tags -> Tags omitted.
    expect(second.metadata.Tags).toBeUndefined();
    expect(second.timestamp!.toISOString()).toBe('2023-02-10T14:30:00.000Z');
    const text2 = (await second.content!.data!()).toString('utf8');
    expect(text2).toContain('Q1 Planning');
    expect(text2).toContain('Discussed roadmap and budget.');
  });

  // SRC-01. See notion.test.ts for the reasoning: a `note` routes to `content`
  // only, and that row's `text` comes from metadata via `descriptionFor` — the
  // content blob attached to the item is never read on the push path.
  it('carries the note body in metadata.Text, not only in the content loader', async () => {
    const root = path.join(FIXTURES_DIR, 'evernote-export');
    const fi = new EvernoteFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'evernote-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const first = pipeline[0].item;
    expect(first.metadata.Text).toContain('Buy milk & eggs');
    // Plain text, not the raw ENML the note stored.
    expect(first.metadata.Text).not.toContain('<en-note>');
    expect(first.metadata.Text).toBe((await first.content!.data!()).toString('utf8'));
  });

  it('respects the timeframe filter', async () => {
    const root = path.join(FIXTURES_DIR, 'evernote-export');
    const fi = new EvernoteFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'evernote-export', fullPath: root }, {
      pipeline,
      timeframe: { since: new Date('2023-02-01T00:00:00Z') },
      log: () => {},
    } as unknown as ImportParams);

    // Only the February note survives.
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.metadata.Title).toBe('Meeting Notes');
  });

  it('does not throw on an empty file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evernote-empty-'));
    const fpath = path.join(dir, 'empty.enex');
    fs.writeFileSync(fpath, '');
    try {
      const fi = new EvernoteFileImporter();
      const rec = await fi.recognize({}, { filename: 'empty.enex', fullPath: fpath });
      // Recognized by extension; import must produce zero items, not throw.
      expect(rec.confidence).toBeGreaterThan(0.8);
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'empty.enex', fullPath: fpath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assigns stable unique ids so same-second notes do not collapse', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evernote-dedup-'));
    const fpath = path.join(dir, 'Same.enex');
    // Two distinct notes sharing the exact same <created> second.
    fs.writeFileSync(
      fpath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<en-export export-date="20230120T120000Z" application="Evernote" version="10.0">',
        '  <note><title>First</title><created>20230115T103000Z</created>',
        '    <content><![CDATA[<en-note><div>Alpha body</div></en-note>]]></content></note>',
        '  <note><title>Second</title><created>20230115T103000Z</created>',
        '    <content><![CDATA[<en-note><div>Beta body</div></en-note>]]></content></note>',
        '</en-export>',
      ].join('\n'),
    );
    try {
      const fi = new EvernoteFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'Same.enex', fullPath: fpath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      expect(pipeline.length).toBe(2);
      const ids = pipeline.map((p) => p.item.id!);
      // (a) every id truthy.
      expect(ids.every(Boolean)).toBe(true);
      // (b) ids are distinct even though created-second + filename collide.
      expect(new Set(ids).size).toBe(2);

      // (c) re-import yields identical ids (idempotent).
      const pipeline2: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'Same.enex', fullPath: fpath }, {
        pipeline: pipeline2,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline2.map((p) => p.item.id!)).toEqual(ids);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw on a non-enex XML file and yields zero items', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evernote-other-'));
    const fpath = path.join(dir, 'other.xml');
    fs.writeFileSync(fpath, '<?xml version="1.0"?><root><child>hello</child></root>');
    try {
      const fi = new EvernoteFileImporter();
      // Not an .enex extension and not an en-export body -> not recognized.
      const rec = await fi.recognize({}, { filename: 'other.xml', fullPath: fpath });
      expect(rec.confidence).toBe(0);

      // Even if asked to import directly, it must not throw and produce nothing.
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'other.xml', fullPath: fpath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

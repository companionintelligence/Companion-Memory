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

import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { RememberTheMilkFileImporter } from '../remember_the_milk';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Fixture shape is deliberately limited to the two fields a real downloaded
// RTM export was actually confirmed to carry — see the module comment in
// ../remember_the_milk.ts and fixtures/remember_the_milk-export/export.json.
describe('Remember the Milk datasource', () => {
  it('recognizes export directory containing the export json', async () => {
    const root = path.join(FIXTURES_DIR, 'remember_the_milk-export');
    const fi = new RememberTheMilkFileImporter();
    const rec = await fi.recognize({}, { filename: 'remember_the_milk-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.7);
  });

  it('recognizes a single export json file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'remember_the_milk-export', 'export.json');
    const fi = new RememberTheMilkFileImporter();
    const rec = await fi.recognize({}, { filename: 'export.json', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.7);
  });

  it('boosts confidence when the filename hints at Remember the Milk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtm-hint-'));
    const fpath = path.join(dir, 'rememberthemilk-export.json');
    fs.writeFileSync(fpath, JSON.stringify({ tasks: [{ name: 'Buy milk' }] }));
    try {
      const fi = new RememberTheMilkFileImporter();
      const rec = await fi.recognize({}, { filename: 'rememberthemilk-export.json', fullPath: fpath });
      expect(rec.confidence).toBeGreaterThan(0.85);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not recognize an unrelated directory', async () => {
    const root = path.join(FIXTURES_DIR, 'netflix-export');
    const fi = new RememberTheMilkFileImporter();
    const rec = await fi.recognize({}, { filename: 'netflix-export', fullPath: root });
    expect(rec.confidence).toBe(0);
  });

  it('does not recognize a JSON file that merely has a "tasks" array of the wrong shape', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtm-notmilk-'));
    const fpath = path.join(dir, 'tasks.json');
    // A generic todo export using 'tasks' as a key too, but entries carry no
    // 'name' field — must not be claimed by a structural coincidence alone.
    fs.writeFileSync(fpath, JSON.stringify({ tasks: [{ title: 'Buy milk', done: false }] }));
    try {
      const fi = new RememberTheMilkFileImporter();
      const rec = await fi.recognize({}, { filename: 'tasks.json', fullPath: fpath });
      expect(rec.confidence).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not recognize a JSON file with no "tasks" key at all', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtm-other-'));
    const fpath = path.join(dir, 'other.json');
    fs.writeFileSync(fpath, JSON.stringify({ notes: [{ name: 'not a task export' }] }));
    try {
      const fi = new RememberTheMilkFileImporter();
      const rec = await fi.recognize({}, { filename: 'other.json', fullPath: fpath });
      expect(rec.confidence).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('imports each task as a note item with title and completion status', async () => {
    const root = path.join(FIXTURES_DIR, 'remember_the_milk-export');
    const fi = new RememberTheMilkFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'remember_the_milk-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(3);

    const [buyMilk, renewPassport, payRent] = pipeline.map((g) => g.item);

    expect(buyMilk.classification).toBe('note');
    expect(buyMilk.metadata.Title).toBe('Buy milk');
    expect(buyMilk.metadata.Completed).toBe(false);
    expect(buyMilk.metadata.Source).toBe('Remember the Milk');
    expect(buyMilk.timestamp).toBeUndefined();

    expect(renewPassport.metadata.Title).toBe('Renew passport');
    expect(renewPassport.metadata.Completed).toBe(false);

    expect(payRent.metadata.Title).toBe('Pay rent');
    expect(payRent.metadata.Completed).toBe(true);
    expect(payRent.timestamp).toBeInstanceOf(Date);
    expect(payRent.timestamp!.toISOString()).toBe('2026-08-01T09:15:00.000Z');

    // Content body is the task name, so a note with no other captured field
    // still carries readable text.
    const text = (await buyMilk.content!.data!()).toString('utf8');
    expect(text).toBe('Buy milk');
  });

  it('respects the timeframe filter against completion time, passing undated (incomplete) tasks through', async () => {
    const root = path.join(FIXTURES_DIR, 'remember_the_milk-export');
    const fi = new RememberTheMilkFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'remember_the_milk-export', fullPath: root }, {
      pipeline,
      timeframe: { since: new Date('2026-09-01T00:00:00Z') },
      log: () => {},
    } as unknown as ImportParams);

    // The completed task's date is before the timeframe and is dropped; the
    // two undated (incomplete) tasks have no timestamp to filter on, so they
    // pass through — matching timeframeContains' "no date, no opinion" rule.
    expect(pipeline.length).toBe(2);
    expect(pipeline.map((g) => g.item.metadata.Title)).toEqual(['Buy milk', 'Renew passport']);
  });

  it('assigns stable, idempotent ids derived from content and position', async () => {
    const root = path.join(FIXTURES_DIR, 'remember_the_milk-export');
    const fi = new RememberTheMilkFileImporter();
    const pipeline1: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'remember_the_milk-export', fullPath: root }, {
      pipeline: pipeline1,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const pipeline2: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'remember_the_milk-export', fullPath: root }, {
      pipeline: pipeline2,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const ids1 = pipeline1.map((g) => g.item.id!);
    const ids2 = pipeline2.map((g) => g.item.id!);
    expect(new Set(ids1).size).toBe(3);
    expect(ids2).toEqual(ids1);
  });

  it('does not throw on an unnamed task and skips it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtm-unnamed-'));
    const fpath = path.join(dir, 'export.json');
    fs.writeFileSync(
      fpath,
      JSON.stringify({ tasks: [{ name: 'Real task' }, { name: '' }, { name: '   ' }] }),
    );
    try {
      const fi = new RememberTheMilkFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'export.json', fullPath: fpath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(1);
      expect(pipeline[0].item.metadata.Title).toBe('Real task');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw on an empty tasks array', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtm-empty-'));
    const fpath = path.join(dir, 'export.json');
    fs.writeFileSync(fpath, JSON.stringify({ tasks: [] }));
    try {
      const fi = new RememberTheMilkFileImporter();
      const rec = await fi.recognize({}, { filename: 'export.json', fullPath: fpath });
      // An empty tasks array carries no name-bearing sample to confirm the
      // shape against, so it is not recognized — but importing it directly
      // (as recognize() would never route it) still must not throw.
      expect(rec.confidence).toBe(0);

      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'export.json', fullPath: fpath }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw on invalid JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtm-invalid-'));
    const fpath = path.join(dir, 'export.json');
    fs.writeFileSync(fpath, '{not valid json');
    try {
      const fi = new RememberTheMilkFileImporter();
      const rec = await fi.recognize({}, { filename: 'export.json', fullPath: fpath });
      expect(rec.confidence).toBe(0);

      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'export.json', fullPath: fpath }, {
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

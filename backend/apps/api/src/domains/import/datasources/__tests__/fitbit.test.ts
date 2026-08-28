import path from 'path';

import { FitbitFileImporter } from '../fitbit';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Fitbit datasource', () => {
  it('recognizes the export directory by nested sleep-*.json files', async () => {
    const root = path.join(FIXTURES_DIR, 'fitbit-export');
    const fi = new FitbitFileImporter();
    const rec = await fi.recognize({}, { filename: 'fitbit-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes a single sleep-*.json file directly', async () => {
    const fpath = path.join(
      FIXTURES_DIR,
      'fitbit-export',
      'Fitbit',
      'Global Export Data',
      'sleep-2023-01-15.json',
    );
    const fi = new FitbitFileImporter();
    const rec = await fi.recognize({}, { filename: 'sleep-2023-01-15.json', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('does not recognize an unrelated export directory', async () => {
    // Another importer's fixture dir — has no Fitbit sleep-*.json anywhere.
    const root = path.join(FIXTURES_DIR, 'spotify-export');
    const fi = new FitbitFileImporter();
    const rec = await fi.recognize({}, { filename: 'spotify-export', fullPath: root });
    expect(rec.confidence).toBeLessThan(0.8);
    expect(rec.dir_threshold).toBe(0.7);
  });

  // Regression: findSleepFiles used to recurse into every subdirectory of
  // whatever root it was given, unbounded by folder name, looking for
  // sleep-*.json anywhere below it — so one coincidentally-named/shaped file
  // deep inside an unrelated multi-GB export (e.g. a personal Drive dump
  // nested nowhere near a `Fitbit/` folder) claimed high confidence for the
  // WHOLE ancestor tree, which then wrongly disabled the generic importer for
  // everything else in that tree (see ParseStage.dropGenericWhenSpecialised).
  it('does not recognize a coincidental sleep-shaped file deep in an unrelated tree', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ci-fitbit-fp-'));
    try {
      const deep = path.join(tmpRoot, 'Drive', 'personal', 'health-notes');
      await fs.promises.mkdir(deep, { recursive: true });
      // Matches the filename pattern AND the content shape, but sits nowhere
      // near a `Fitbit/` folder — an unrelated personal export could contain
      // this coincidentally.
      await fs.promises.writeFile(
        path.join(deep, 'sleep-2023-01-15.json'),
        JSON.stringify([{ dateOfSleep: '2023-01-15', minutesAsleep: 400 }]),
      );

      const fi = new FitbitFileImporter();
      const rec = await fi.recognize({}, { filename: path.basename(tmpRoot), fullPath: tmpRoot });
      expect(rec.confidence).toBeLessThan(0.8);
      expect(rec.dir_threshold).toBe(0.7);
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('imports sleep records into sleep items, ignoring non-sleep json', async () => {
    const root = path.join(FIXTURES_DIR, 'fitbit-export');
    const fi = new FitbitFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'fitbit-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    // 2 records from sleep-2023-01-15 + 1 from sleep-2023-01-16 = 3; steps file ignored
    expect(pipeline.length).toBe(3);

    for (const g of pipeline) {
      expect(g.item.classification).toBe('sleep');
      expect(g.item.metadata.Source).toBe('Fitbit');
      // Title-fallback fix: a title-bearing key is set, not the bare 'sleep.txt'.
      expect(g.item.metadata.Title).toMatch(/^Slept /);
      expect(g.item.metadata.Title).not.toBe('sleep.txt');
    }

    const byMinutes = pipeline.map((g) => Number(g.item.metadata['Minutes Asleep'])).sort((a, b) => a - b);
    expect(byMinutes).toEqual([40, 420, 455]);

    // Find the main overnight record and verify its fields + timestamp.
    const main = pipeline.find((g) => g.item.metadata['Minutes Asleep'] === 420)!;
    expect(main.item.metadata['Minutes Awake']).toBe(30);
    expect(main.item.metadata.Efficiency).toBe(92);
    expect(main.item.metadata['Date Of Sleep']).toBe('2023-01-15');
    expect(main.item.metadata.Title).toBe('Slept 420 min on 2023-01-15');
    expect(main.item.timestamp).toBeInstanceOf(Date);
    expect(main.item.timestamp!.getTime()).toBe(new Date('2023-01-14T23:00:00.000').getTime());
  });

  it('respects the timeframe filter', async () => {
    const root = path.join(FIXTURES_DIR, 'fitbit-export');
    const fi = new FitbitFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'fitbit-export', fullPath: root }, {
      pipeline,
      timeframe: { since: new Date('2023-01-15T12:00:00.000') },
      log: () => {},
    } as unknown as ImportParams);

    // Only the two records that start after 2023-01-15 12:00 survive.
    expect(pipeline.length).toBe(2);
    const minutes = pipeline.map((g) => Number(g.item.metadata['Minutes Asleep'])).sort((a, b) => a - b);
    expect(minutes).toEqual([40, 455]);
  });

  // One Takeout "Fit" export carries both halves, and this source is what the
  // wizard labels "Fitbit / Google Fit". An account with no Fitbit device gets
  // only the Google Fit half — which used to import zero items, silently.
  describe('Google Fit half of the same export', () => {
    const GFIT = path.join(FIXTURES_DIR, 'google_fit');

    it('recognizes a Google-Fit-only export', async () => {
      const fi = new FitbitFileImporter();
      const rec = await fi.recognize({}, { filename: 'google_fit', fullPath: GFIT });
      expect(rec.confidence).toBeGreaterThan(0);
    });

    it('ranks below the dedicated Google Fit source', async () => {
      const { GoogleFitFileImporter } = await import('../google_fit');
      const entry = { filename: 'google_fit', fullPath: GFIT };
      const mine = await new FitbitFileImporter().recognize({}, entry);
      const theirs = await new GoogleFitFileImporter().recognize({}, entry);
      expect(mine.confidence).toBeLessThan(theirs.confidence);
    });

    it('imports the daily metrics and workouts', async () => {
      const fi = new FitbitFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'google_fit', fullPath: GFIT }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      const items = pipeline.map((g) => g.item);
      // Same yield as importing through the Google Fit source itself —
      // including the TCX trackpoint positions.
      expect(items.length).toBe(13);
      expect(items.filter((i) => i.classification === 'observation').length).toBe(1);
      expect(items.filter((i) => i.classification === 'workout').length).toBe(7);
      expect(items.filter((i) => i.classification === 'location').length).toBe(5);
      expect(items.every((i) => i.metadata.Source === 'Google Fit')).toBe(true);
    });

    it('attributes the Google Fit records to google_fit, not fitbit', async () => {
      // data_source must describe where a record came FROM, not which card
      // imported it — so these dedup against a later Google Takeout import.
      const fi = new FitbitFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'google_fit', fullPath: GFIT }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBeGreaterThan(0);
      expect(pipeline.every((g) => g.item.dataSource === 'google_fit')).toBe(true);
    });

    it('leaves a pure-Fitbit export untouched, and unstamped', async () => {
      // The delegation must not invent items where there is no Fit/ tree, and
      // real Fitbit sleep logs must keep the job's own source (no stamp).
      const fi = new FitbitFileImporter();
      const pipeline: EmittedGraph[] = [];
      await fi.fileImport(
        {},
        { filename: 'fitbit-export', fullPath: path.join(FIXTURES_DIR, 'fitbit-export') },
        {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams,
      );
      expect(pipeline.length).toBe(3);
      expect(pipeline.every((g) => g.item.metadata.Source === 'Fitbit')).toBe(true);
      expect(pipeline.every((g) => g.item.dataSource === undefined)).toBe(true);
    });
  });

  it('does not throw on empty or malformed sleep json', async () => {
    const fs = await import('node:fs');
    const dir = path.join(FIXTURES_DIR, 'fitbit-export', 'Fitbit', 'Global Export Data');
    const emptyFile = path.join(dir, 'sleep-2099-01-01.json');
    const badFile = path.join(dir, 'sleep-2099-01-02.json');
    await fs.promises.writeFile(emptyFile, '');
    await fs.promises.writeFile(badFile, '{ this is not valid json ');
    const fi = new FitbitFileImporter();
    const pipeline: EmittedGraph[] = [];
    try {
      await fi.fileImport(
        {},
        { filename: 'fitbit-export', fullPath: path.join(FIXTURES_DIR, 'fitbit-export') },
        {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams,
      );
      // Malformed files contribute nothing; the 3 real records still import.
      expect(pipeline.length).toBe(3);
    } finally {
      await fs.promises.unlink(emptyFile).catch(() => {});
      await fs.promises.unlink(badFile).catch(() => {});
    }
  });

  // Regression: pushRecord used a constant content.filename ('sleep.txt') and
  // set no item.id, so hashItem's fallback hash reduced to
  // dataSource+classification+ISO(timestamp) alone — two sleep entries sharing
  // a recorded start second (a paired Fitbit + phone app both logging sleep,
  // or a record genuinely missing logId) collapsed under the staging table's
  // ON CONFLICT (run_id, data_source, content_hash) DO NOTHING and one was
  // silently dropped. Real Fitbit exports carry a logId, so this exercises
  // both: the (missing-logId) index fallback, and — via the re-import — that
  // a real logId alone is enough to stay stable and idempotent.
  it('assigns unique, stable ids to same-second sleep records that would otherwise dedup-collapse', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const fi = new FitbitFileImporter();
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fitbit-collapse-'));
    const sleepFile = path.join(tmpDir, 'sleep-2023-06-01.json');
    // Two records, same startTime second, neither carrying a logId.
    await fs.promises.writeFile(
      sleepFile,
      JSON.stringify([
        {
          dateOfSleep: '2023-06-01',
          startTime: '2023-06-01T23:00:00.000',
          endTime: '2023-06-02T02:00:00.000',
          minutesAsleep: 180,
          minutesAwake: 10,
          efficiency: 90,
        },
        {
          dateOfSleep: '2023-06-01',
          startTime: '2023-06-01T23:00:00.000',
          endTime: '2023-06-02T03:00:00.000',
          minutesAsleep: 235,
          minutesAwake: 15,
          efficiency: 91,
        },
      ]),
    );
    try {
      const run = async () => {
        const pipeline: EmittedGraph[] = [];
        await fi.fileImport({}, { filename: 'sleep-2023-06-01.json', fullPath: sleepFile }, {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);

        return pipeline;
      };

      const items = await run();
      expect(items.length).toBe(2);
      const ids = items.map((p) => p.item.id!);
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(2);

      const again = await run();
      expect(again.map((p) => p.item.id!)).toEqual(ids);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

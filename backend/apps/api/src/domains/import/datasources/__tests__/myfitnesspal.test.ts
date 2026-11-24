import path from 'path';

import { MyfitnesspalFileImporter } from '../myfitnesspal';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('MyFitnessPal datasource', () => {
  it('recognizes export directory by Nutrition-Summary csv', async () => {
    const root = path.join(FIXTURES_DIR, 'myfitnesspal-export');
    const fi = new MyfitnesspalFileImporter();
    const rec = await fi.recognize({}, { filename: 'myfitnesspal-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes a single Nutrition-Summary csv directly', async () => {
    const fpath = path.join(
      FIXTURES_DIR,
      'myfitnesspal-export',
      'Nutrition-Summary-2023-01-15-to-2023-01-16.csv',
    );
    const fi = new MyfitnesspalFileImporter();
    const rec = await fi.recognize({}, { filename: path.basename(fpath), fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it("returns zero confidence for another importer's csv directory", async () => {
    // netflix-export contains a ViewingActivity.csv whose header has none of the
    // nutrition columns — must not false-match.
    const root = path.join(FIXTURES_DIR, 'netflix-export');
    const fi = new MyfitnesspalFileImporter();
    const rec = await fi.recognize({}, { filename: 'netflix-export', fullPath: root });
    expect(rec.confidence).toBe(0);
  });

  it('imports nutrition rows as observation items', async () => {
    const root = path.join(FIXTURES_DIR, 'myfitnesspal-export');
    const fi = new MyfitnesspalFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'myfitnesspal-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(5);

    const first = pipeline[0].item;
    expect(first.classification).toBe('observation');
    expect(first.timestamp).toBeInstanceOf(Date);
    expect(first.timestamp!.getTime()).toBe(new Date('2023-01-15').getTime());
    expect(first.metadata.Meal).toBe('Breakfast');
    expect(first.metadata.Calories).toBe(420);
    expect(first.metadata['Protein (g)']).toBe(22);
    expect(first.metadata['Carbohydrates (g)']).toBe(48);
    expect(first.metadata['Fat (g)']).toBe(14);
    expect(first.metadata.Source).toBe('MyFitnessPal');
    // title-bearing key so titleFor no longer falls back to basename('nutrition.txt')
    expect(first.metadata.Title).toBe('2023-01-15 Breakfast — 420 kcal');
    expect(first.metadata.Title).not.toBe(first.content.filename);
  });

  it('assigns a distinct stable id per (date, meal) so same-day meals do not collapse', async () => {
    // The fixture logs Breakfast/Lunch/Dinner all on 2023-01-15 with the same
    // bare-date (midnight UTC) timestamp; without an explicit id they collapse
    // to one dedup hash.
    const root = path.join(FIXTURES_DIR, 'myfitnesspal-export');
    const fi = new MyfitnesspalFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'myfitnesspal-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const ids = pipeline.map((g) => g.item.id!);
    // (a) every id is truthy
    expect(ids.every(Boolean)).toBe(true);
    // (b) all ids are unique
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(5);

    // (c) re-import yields identical ids (idempotent)
    const pipeline2: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'myfitnesspal-export', fullPath: root }, {
      pipeline: pipeline2,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    expect(pipeline2.map((g) => g.item.id!)).toEqual(ids);
  });

  it('handles quoted fields with embedded commas via the CSV parser', async () => {
    const root = path.join(FIXTURES_DIR, 'myfitnesspal-export');
    const fi = new MyfitnesspalFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'myfitnesspal-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const snackRow = pipeline.find((g) => g.item.metadata.Meal === 'Snacks, afternoon');
    expect(snackRow).toBeDefined();
    expect(snackRow!.item.metadata.Calories).toBe(180);
  });

  it('filters rows outside the timeframe', async () => {
    const root = path.join(FIXTURES_DIR, 'myfitnesspal-export');
    const fi = new MyfitnesspalFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'myfitnesspal-export', fullPath: root }, {
      pipeline,
      timeframe: { since: new Date('2023-01-15T12:00:00Z') },
      log: () => {},
    } as unknown as ImportParams);

    // Only the 2023-01-16 rows survive (strictly after the since boundary).
    expect(pipeline.length).toBe(2);
    for (const g of pipeline) {
      expect(g.item.timestamp!.getTime()).toBe(new Date('2023-01-16').getTime());
    }
  });

  it('does not throw on an empty file', async () => {
    const fs = await import('node:fs');
    const tmpFile = path.join(FIXTURES_DIR, 'myfitnesspal-export', 'empty-tmp.csv');
    await fs.promises.writeFile(tmpFile, '');
    const fi = new MyfitnesspalFileImporter();
    const pipeline: EmittedGraph[] = [];
    try {
      const rec = await fi.recognize({}, { filename: 'empty-tmp.csv', fullPath: tmpFile });
      expect(rec.confidence).toBe(0);
      await fi.fileImport({}, { filename: 'empty-tmp.csv', fullPath: tmpFile }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(0);
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => {});
    }
  });

  // The export holds three files. Only the nutrition one was read, so the
  // exercise log and the weight history never arrived as MyFitnessPal data.
  describe('exercise and measurement files', () => {
    const NUTRITION =
      'Date,Meal,Calories,Fat (g),Carbohydrates (g),Protein (g),Note\n' +
      '2026-10-12,Breakfast,412.5,13.1,51.2,21.4,\n';
    const EXERCISE =
      'Date,Exercise,Type,Exercise Calories,Exercise Minutes,Sets,Reps Per Set,Kilograms,Steps,Note\n' +
      '2026-10-12,"Running (jogging), 10 kph (6 min/km)",Cardio,402,35,,,,,"Riverside loop"\n' +
      '2026-10-13,Bench Press,Strength,,,4,8,60,,\n' +
      '2026-10-13,Bench Press,Strength,,,3,10,55,,\n' +
      '2026-10-14,MFP iOS calorie adjustment,Cardio,211,,,,,5120,\n';
    const MEASUREMENT = 'Date,Weight\n2026-10-12,71.4\n2026-10-14,71.1\n';

    async function withExport<T>(
      files: Record<string, string>,
      run: (dir: string) => Promise<T>,
    ): Promise<T> {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfp-'));
      for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), body);
      }

      try {
        return await run(dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    const FILES = {
      'Nutrition-Summary-2026-10-12-to-2026-10-14.csv': NUTRITION,
      'Exercise-Summary-2026-10-12-to-2026-10-14.csv': EXERCISE,
      'Measurement-Summary-2026-10-12-to-2026-10-14.csv': MEASUREMENT,
    };

    async function importAll(timeframe: Record<string, unknown> = {}) {
      return withExport(FILES, async (dir) => {
        const pipeline: EmittedGraph[] = [];
        await new MyfitnesspalFileImporter().fileImport({}, { filename: 'export', fullPath: dir }, {
          pipeline,
          timeframe,
          log: () => {},
        } as unknown as ImportParams);

        return pipeline.map((g) => g.item);
      });
    }

    it('reads all three files of the export', async () => {
      const items = await importAll();
      expect(items).toHaveLength(1 + 4 + 2);
      expect(items.every((i) => i.metadata.Source === 'MyFitnessPal')).toBe(true);
      expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    });

    it('imports exercise rows as workouts', async () => {
      const workouts = (await importAll()).filter((i) => i.classification === 'workout');
      expect(workouts.map((w) => w.metadata.Title)).toEqual([
        'Running (jogging), 10 kph (6 min/km)',
        'Bench Press',
        'Bench Press',
      ]);
      const [run, bench] = workouts;
      expect(run.timestamp!.toISOString()).toBe('2026-10-12T00:00:00.000Z');
      expect(run.metadata['Activity Type']).toBe('Cardio');
      expect(run.metadata.Calories).toBe(402);
      expect(run.metadata['Duration (min)']).toBe(35);
      expect(run.metadata.Note).toBe('Riverside loop');
      expect(bench.metadata.Sets).toBe(4);
      expect(bench.metadata['Reps Per Set']).toBe(8);
      expect(bench.metadata['Weight Lifted (kg)']).toBe(60);
    });

    it('keeps a tracker calorie adjustment as a daily observation, not a workout', async () => {
      const adjustment = (await importAll()).find(
        (i) => i.metadata.Title === 'MFP iOS calorie adjustment on 2026-10-14',
      )!;
      expect(adjustment.classification).toBe('observation');
      expect(adjustment.metadata.Steps).toBe(5120);
      expect(adjustment.metadata.Calories).toBe(211);
    });

    it('imports each day of measurements as an observation', async () => {
      const weights = (await importAll()).filter((i) => i.metadata.Weight !== undefined);
      expect(weights.map((w) => [w.classification, w.metadata.Weight, w.metadata.Title])).toEqual([
        ['observation', 71.4, 'Weight on 2026-10-12: 71.4'],
        ['observation', 71.1, 'Weight on 2026-10-14: 71.1'],
      ]);

      const several = await withExport(
        {
          'Measurement-Summary-2026-10-12-to-2026-10-12.csv':
            'Date,Weight,Body Fat %,Waist\n2026-10-12,71.4,22.5,\n',
        },
        async (dir) => {
          const pipeline: EmittedGraph[] = [];
          await new MyfitnesspalFileImporter().fileImport({}, { filename: 'export', fullPath: dir }, {
            pipeline,
            timeframe: {},
            log: () => {},
          } as unknown as ImportParams);

          return pipeline.map((g) => g.item);
        },
      );
      expect(several).toHaveLength(1);
      expect(several[0].metadata.Title).toBe('Measurements on 2026-10-12');
      expect(several[0].metadata['Body Fat %']).toBe(22.5);
      expect(several[0].metadata.Waist).toBeUndefined();
    });

    it('applies the timeframe to exercise and measurement rows', async () => {
      const items = await importAll({ since: new Date('2026-10-13T00:00:00Z') });
      expect(items.map((i) => i.metadata.Title).sort()).toEqual([
        'Bench Press',
        'Bench Press',
        'MFP iOS calorie adjustment on 2026-10-14',
        'Weight on 2026-10-14: 71.1',
      ]);
    });

    it('recognizes an export folder or file by any of its three names', async () => {
      const fi = new MyfitnesspalFileImporter();
      await withExport(
        {
          'Exercise-Summary-2026-10-12-to-2026-10-14.csv': EXERCISE,
          'Measurement-Summary-2026-10-12-to-2026-10-14.csv': MEASUREMENT,
        },
        async (dir) => {
          expect((await fi.recognize({}, { filename: 'export', fullPath: dir })).confidence).toBeGreaterThan(
            0.9,
          );
          const file = path.join(dir, 'Measurement-Summary-2026-10-12-to-2026-10-14.csv');
          expect(
            (await fi.recognize({}, { filename: path.basename(file), fullPath: file })).confidence,
          ).toBeGreaterThan(0.9);
        },
      );
    });

    it('does not read a file that has the name but not the columns', async () => {
      const fi = new MyfitnesspalFileImporter();
      await withExport(
        { 'Exercise-Summary-2026-10-12-to-2026-10-14.csv': 'Date,Weight\n2026-10-12,71.4\n' },
        async (dir) => {
          expect((await fi.recognize({}, { filename: 'export', fullPath: dir })).confidence).toBe(0);
        },
      );
    });
  });
});

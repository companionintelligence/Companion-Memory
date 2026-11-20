import path from 'path';

import type { ImportParams } from '../timeline';
import { WithingsFileImporter } from '../withings';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Withings datasource', () => {
  it('recognizes export directory by weight.csv', async () => {
    const root = path.join(FIXTURES_DIR, 'withings-export');
    const fi = new WithingsFileImporter();
    const rec = await fi.recognize({}, { filename: 'withings-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes a single weight.csv file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'withings-export', 'weight.csv');
    const fi = new WithingsFileImporter();
    const rec = await fi.recognize({}, { filename: 'weight.csv', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('recognizes a related CSV with a (kg) column by header sniff (height.csv)', async () => {
    const fs = await import('node:fs');
    const tmp = path.join(FIXTURES_DIR, 'withings-export', 'height.csv');
    await fs.promises.writeFile(tmp, 'Date,Height (kg)\n2024-01-15 08:30:00,1.78\n');
    const fi = new WithingsFileImporter();
    try {
      const rec = await fi.recognize({}, { filename: 'height.csv', fullPath: tmp });
      expect(rec.confidence).toBeGreaterThan(0.8);
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  });

  // A related CSV that carries no "(kg)"/"Weight" column (e.g. blood_pressure.csv)
  // is NOT recognized on its own — the recognizer is intentionally specific so it
  // does not false-claim arbitrary "Date,"-prefixed CSVs from other importers. It
  // is still imported when it lives inside a recognized Withings export directory
  // (see "imports every Date-bearing CSV in a directory").
  it('does not recognize a standalone CSV lacking a (kg)/Weight column (blood_pressure.csv)', async () => {
    const fpath = path.join(FIXTURES_DIR, 'withings-export', 'blood_pressure.csv');
    const fi = new WithingsFileImporter();
    const rec = await fi.recognize({}, { filename: 'blood_pressure.csv', fullPath: fpath });
    expect(rec.confidence).toBe(0);
  });

  it('does not recognize a non-matching directory', async () => {
    const root = path.join(FIXTURES_DIR, 'netflix-export');
    const fi = new WithingsFileImporter();
    const rec = await fi.recognize({}, { filename: 'netflix-export', fullPath: root });
    expect(rec.confidence).toBe(0);
  });

  // Regression guard for the over-broad recognize() bug: a header that merely
  // starts with "Date," (with no "(kg)"/"Weight" column) must NOT match, or
  // Withings false-claims other CSV importers' exports.
  it('does not recognize a Date,-prefixed non-Withings CSV (myfitnesspal)', async () => {
    const fpath = path.join(
      FIXTURES_DIR,
      'myfitnesspal-export',
      'Nutrition-Summary-2023-01-15-to-2023-01-16.csv',
    );
    const fi = new WithingsFileImporter();
    const rec = await fi.recognize(
      {},
      { filename: 'Nutrition-Summary-2023-01-15-to-2023-01-16.csv', fullPath: fpath },
    );
    expect(rec.confidence).toBe(0);
  });

  it('does not recognize a Date,-prefixed non-Withings CSV (roblox LoginHistory)', async () => {
    const fpath = path.join(FIXTURES_DIR, 'roblox-export', 'LoginHistory.csv');
    const fi = new WithingsFileImporter();
    const rec = await fi.recognize({}, { filename: 'LoginHistory.csv', fullPath: fpath });
    expect(rec.confidence).toBe(0);
  });

  it('does not recognize a directory of Date,-prefixed non-Withings CSVs', async () => {
    const fi = new WithingsFileImporter();
    const mfp = path.join(FIXTURES_DIR, 'myfitnesspal-export');
    expect((await fi.recognize({}, { filename: 'myfitnesspal-export', fullPath: mfp })).confidence).toBe(0);
    const roblox = path.join(FIXTURES_DIR, 'roblox-export');
    expect((await fi.recognize({}, { filename: 'roblox-export', fullPath: roblox })).confidence).toBe(0);
  });

  // The MyFitnessPal fixture above holds only the nutrition file. A real export
  // also carries a measurement file, "Date,Weight" with no unit, and a bare
  // "Weight" column used to be enough: Withings claimed the export's folder and
  // imported every row of all three files as Withings measurements.
  it('does not claim a MyFitnessPal export by its unit-less "Date,Weight" measurement file', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'withings-mfp-'));
    const range = '2026-10-12-to-2026-10-14';
    await fs.promises.writeFile(
      path.join(dir, `Nutrition-Summary-${range}.csv`),
      'Date,Meal,Calories,Fat (g),Carbohydrates (g),Protein (g),Note\n2026-10-12,Breakfast,412.5,13.1,51.2,21.4,\n',
    );
    await fs.promises.writeFile(
      path.join(dir, `Measurement-Summary-${range}.csv`),
      'Date,Weight\n2026-10-12,71.4\n2026-10-14,71.1\n',
    );
    await fs.promises.writeFile(
      path.join(dir, `Exercise-Summary-${range}.csv`),
      'Date,Exercise,Type,Exercise Calories,Exercise Minutes,Sets,Reps Per Set,Kilograms,Steps,Note\n' +
        '2026-10-13,Bench Press,Strength,,,4,8,60,,\n',
    );
    const fi = new WithingsFileImporter();
    try {
      const measurement = path.join(dir, `Measurement-Summary-${range}.csv`);
      expect(
        (await fi.recognize({}, { filename: path.basename(measurement), fullPath: measurement })).confidence,
      ).toBe(0);
      expect((await fi.recognize({}, { filename: path.basename(dir), fullPath: dir })).confidence).toBe(0);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('still recognizes a quoted weight column with a unit other than kg', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'withings-lb-'));
    const fpath = path.join(dir, 'measurements.csv');
    await fs.promises.writeFile(fpath, 'Date,"Weight (lb)",Comments\n"2024-01-15 08:30:00",181.7,\n');
    try {
      const rec = await new WithingsFileImporter().recognize(
        {},
        { filename: 'measurements.csv', fullPath: fpath },
      );
      expect(rec.confidence).toBeGreaterThan(0.8);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('drops undated rows when a timeframe filter is active', async () => {
    const fs = await import('node:fs');
    const tmp = path.join(FIXTURES_DIR, 'withings-export', 'undated.csv');
    await fs.promises.writeFile(tmp, 'Date,Weight (kg)\n2024-01-15 08:30:00,82.4\n,79.0\n');
    const fi = new WithingsFileImporter();
    try {
      // No filter: both rows (dated + undated) flow through.
      const all: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'undated.csv', fullPath: tmp }, {
        pipeline: all,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(all.length).toBe(2);

      // Active future filter: the undated row must NOT leak through, and the
      // dated 2024-01-15 row is excluded by the since bound.
      const filtered: EmittedGraph[] = [];
      await fi.fileImport({}, { filename: 'undated.csv', fullPath: tmp }, {
        pipeline: filtered,
        timeframe: { since: new Date('2024-06-01T00:00:00Z') },
        log: () => {},
      } as unknown as ImportParams);
      expect(filtered.length).toBe(0);
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  });

  it('imports weight.csv rows as observation items with parsed metadata', async () => {
    const fpath = path.join(FIXTURES_DIR, 'withings-export', 'weight.csv');
    const fi = new WithingsFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'weight.csv', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(3);
    const first = pipeline[0].item;
    expect(first.classification).toBe('observation');
    expect(first.timestamp).toBeInstanceOf(Date);
    expect(first.timestamp!.toISOString()).toBe('2024-01-15T08:30:00.000Z');
    // numeric columns become numbers
    expect(first.metadata['Weight (kg)']).toBe(82.4);
    expect(first.metadata['Fat mass (kg)']).toBe(18.2);
    // text columns stay strings
    expect(first.metadata.Comments).toBe('Morning weigh-in, post run');
    expect(first.metadata.File).toBe('weight.csv');
    expect(first.metadata.Source).toBe('Withings');
    // Title key is set so titleFor() does not fall back to 'observation.txt'.
    expect(first.metadata.Title).toBe('weight — 2024-01-15 08:30:00');
    expect(first.content.filename).toBe('observation.txt');
    expect(first.metadata.Title).not.toBe(first.content.filename);

    // empty Comments column is omitted on the second row
    expect(pipeline[1].item.metadata.Comments).toBeUndefined();
  });

  it('imports every Date-bearing CSV in a directory', async () => {
    const root = path.join(FIXTURES_DIR, 'withings-export');
    const fi = new WithingsFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'withings-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    // 3 weight rows + 2 blood pressure rows
    expect(pipeline.length).toBe(5);
    const files = new Set(pipeline.map((p) => p.item.metadata.File));
    expect(files.has('weight.csv')).toBe(true);
    expect(files.has('blood_pressure.csv')).toBe(true);

    const bp = pipeline.find((p) => p.item.metadata.File === 'blood_pressure.csv');
    expect(bp!.item.metadata['Systolic (mmHg)']).toBe(118);
  });

  it('respects the timeframe filter', async () => {
    const fpath = path.join(FIXTURES_DIR, 'withings-export', 'weight.csv');
    const fi = new WithingsFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'weight.csv', fullPath: fpath }, {
      pipeline,
      timeframe: { since: new Date('2024-01-16T00:00:00Z') },
      log: () => {},
    } as unknown as ImportParams);

    // Only the 16th and 17th remain
    expect(pipeline.length).toBe(2);
  });

  // Regression: rows that would collapse under hashItem (constant filename
  // 'observation.txt', same timestamp across files / undated rows) must each get
  // a unique, stable item.id so INSERT OR IGNORE on (data_source, content_hash)
  // does not silently drop them.
  it('assigns unique, stable ids to rows that would otherwise dedup-collapse', async () => {
    const fs = await import('node:fs');
    // Two files, same synced instant; plus undated rows that share an empty Date.
    const weight = path.join(FIXTURES_DIR, 'withings-export', 'collapse_weight.csv');
    const bp = path.join(FIXTURES_DIR, 'withings-export', 'collapse_bp.csv');
    await fs.promises.writeFile(
      weight,
      'Date,Weight (kg)\n2024-03-01 07:00:00,82.4\n2024-03-01 07:00:00,82.5\n,79.0\n,78.0\n',
    );
    await fs.promises.writeFile(bp, 'Date,Systolic (mmHg)\n2024-03-01 07:00:00,118\n');
    const fi = new WithingsFileImporter();
    try {
      const run = async () => {
        const out: EmittedGraph[] = [];
        await fi.fileImport({}, { filename: 'collapse_weight.csv', fullPath: weight }, {
          pipeline: out,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);
        await fi.fileImport({}, { filename: 'collapse_bp.csv', fullPath: bp }, {
          pipeline: out,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams);

        return out;
      };

      const items = await run();
      // 2 same-instant weight rows + 2 undated weight rows + 1 same-instant bp row
      expect(items.length).toBe(5);
      const ids = items.map((p) => p.item.id!);
      // (a) every id is truthy
      expect(ids.every(Boolean)).toBe(true);
      // (b) all ids are unique despite shared timestamps / constant filename
      expect(new Set(ids).size).toBe(items.length);

      // (c) re-import yields identical ids (idempotent)
      const again = await run();
      expect(again.map((p) => p.item.id!)).toEqual(ids);
    } finally {
      await fs.promises.unlink(weight).catch(() => {});
      await fs.promises.unlink(bp).catch(() => {});
    }
  });

  it('does not throw on an empty file', async () => {
    const fs = await import('node:fs');
    const tmp = path.join(FIXTURES_DIR, 'withings-export', 'empty.csv');
    await fs.promises.writeFile(tmp, '');
    const fi = new WithingsFileImporter();
    const pipeline: EmittedGraph[] = [];
    try {
      await fi.fileImport({}, { filename: 'empty.csv', fullPath: tmp }, {
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

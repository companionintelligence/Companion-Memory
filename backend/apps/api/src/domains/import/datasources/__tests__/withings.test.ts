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

  // sleep.csv, activities.csv and the aggregates_*.csv files have no `Date`
  // column, so the reader skipped them without counting anything: an export
  // with three nights, two workouts and daily step totals arrived as its
  // weight and blood-pressure readings alone.
  describe('files without a Date column', () => {
    const SLEEP =
      'from,to,"light (s)","deep (s)","rem (s)","awake (s)","wake up","Duration to sleep (s)","Duration to wake up (s)","Snoring (s)","Snoring episodes","Average heart rate","Heart rate (min)","Heart rate (max)"\n' +
      '2026-10-28 23:04:00,2026-10-29 06:51:00,14220,5460,6120,1020,2,540,300,420,4,56,49,71\n' +
      '2026-10-30T22:47:00+01:00,2026-10-31T07:12:00+01:00,15360,6000,6540,1320,3,540,300,420,4,55,48,74\n';
    const ACTIVITIES =
      'from,to,"from (manual)","to (manual)",Timezone,"Activity type",Data,GPS,Modified\n' +
      '2026-10-28T08:01:00+00:00,2026-10-28T09:58:31+00:00,,,Europe/London,Running,"{""calories"":1210,""distance"":21097,""hr_average"":158,""hr_min"":96,""hr_max"":181,""steps"":19840,""elevation"":88}","{""latitude"":[51.3812],""longitude"":[-2.359]}",2026-10-28T10:05:12+00:00\n' +
      '2026-11-03T18:20:00+00:00,2026-11-03T19:05:00+00:00,,,Europe/London,Swimming,"{""calories"":402,""distance"":1500,""hr_average"":0,""pool_laps"":60}",,2026-11-03T19:10:00+00:00\n';

    async function importDir(files: Record<string, string>, timeframe: Record<string, unknown> = {}) {
      const fs = await import('node:fs');
      const os = await import('node:os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'withings-'));
      for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), body);
      }

      const pipeline: EmittedGraph[] = [];
      const drops: Array<[string, string | undefined]> = [];
      Object.assign(pipeline, { drop: (reason: string, detail?: string) => drops.push([reason, detail]) });
      try {
        await new WithingsFileImporter().fileImport({}, { filename: 'withings', fullPath: dir }, {
          pipeline,
          timeframe,
          log: () => {},
        } as unknown as ImportParams);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }

      return { items: pipeline.map((g) => g.item), drops };
    }

    it('imports sleep.csv nights as sleep with the minutes the daily total adds up', async () => {
      const { items } = await importDir({
        'weight.csv': 'Date,"Weight (kg)"\n"2026-10-28 07:41:12",74.32\n',
        'sleep.csv': SLEEP,
      });
      const sleep = items.filter((i) => i.classification === 'sleep');
      expect(sleep).toHaveLength(2);
      expect(sleep[0].timestamp!.toISOString()).toBe('2026-10-28T23:04:00.000Z');
      expect(sleep[0].timespanEnd!.toISOString()).toBe('2026-10-29T06:51:00.000Z');
      // light 14220 + deep 5460 + REM 6120 seconds
      expect(sleep[0].metadata['Minutes Asleep']).toBe(430);
      expect(sleep[0].metadata['Minutes Awake']).toBe(17);
      expect(sleep[0].metadata['Average heart rate']).toBe(56);
      expect(sleep[0].metadata.Title).toBe('Slept 430 min on 2026-10-29');
      expect(sleep[0].metadata.Source).toBe('Withings');
      // Real exports write times with an offset.
      expect(sleep[1].timestamp!.toISOString()).toBe('2026-10-30T21:47:00.000Z');
    });

    // Nights recorded before a device tracked stages carry blank or zero stage
    // columns and only the time awake. 0 minutes asleep would count each one
    // as a night without sleep in the daily total.
    it('counts a night without sleep stages as its length less the time awake', async () => {
      const { items } = await importDir({
        'sleep.csv':
          'from,to,"light (s)","deep (s)","rem (s)","awake (s)","wake up"\n' +
          '2019-03-02T23:30:00+00:00,2019-03-03T07:00:00+00:00,,,,1800,1\n' +
          '2019-03-03T23:00:00+00:00,2019-03-04T06:00:00+00:00,0,0,0,,0\n' +
          '2019-03-05T23:00:00+00:00,,,,,600,0\n',
      });
      expect(items.map((i) => i.metadata['Minutes Asleep'])).toEqual([420, 420, undefined]);
      expect(items.map((i) => i.metadata.Title)).toEqual([
        'Slept 420 min on 2019-03-03',
        'Slept 420 min on 2019-03-04',
        'Slept ? min on 2019-03-05',
      ]);
    });

    it('reads a sleep.csv whose headers are translated', async () => {
      const { items } = await importDir({
        'sleep.csv':
          'von,bis,"leicht (s)","tief (s)","rem (s)","wach (s)",Aufwachen\n' +
          '2020-07-14T22:09:00+02:00,2020-07-15T08:08:00+02:00,24660,2640,6480,2160,3\n',
      });
      expect(items).toHaveLength(1);
      expect(items[0].classification).toBe('sleep');
      expect(items[0].metadata['Minutes Asleep']).toBe(563);
      expect(items[0].metadata.Aufwachen).toBe(3);
    });

    it('imports activities.csv rows as workouts with their totals', async () => {
      const { items } = await importDir({ 'activities.csv': ACTIVITIES });
      expect(items).toHaveLength(2);
      const [run, swim] = items;
      expect(run.classification).toBe('workout');
      expect(run.metadata.Title).toBe('Running');
      expect(run.timespanEnd!.getTime() - run.timestamp!.getTime()).toBe((60 + 57) * 60_000 + 31_000);
      expect(run.metadata['Distance (km)']).toBe(21.097);
      expect(run.metadata.Calories).toBe(1210);
      expect(run.metadata.Steps).toBe(19840);
      expect(run.metadata['Average Heart Rate']).toBe(158);
      expect(run.metadata['Floors Climbed']).toBe(88);
      expect(run.metadata['Max Heart Rate']).toBe(181);
      expect(run.metadata['Time Zone']).toBe('Europe/London');
      expect(swim.metadata['Distance (km)']).toBe(1.5);
      // Withings writes 0 for a heart rate it did not measure.
      expect(swim.metadata['Average Heart Rate']).toBeUndefined();
    });

    it('reads an activities.csv whose headers are translated', async () => {
      const { items } = await importDir({
        'activities.csv':
          'von,bis,"von (manuell)","bis (manuell)",Zeitzone,Aktivitätstyp,Daten,GPS,Geändert\n' +
          '2026-10-28T08:01:00+00:00,2026-10-28T09:58:31+00:00,,,Europe/Berlin,Laufen,"{""calories"":1210,""distance"":21097}",,2026-10-28T10:05:12+00:00\n',
      });
      expect(items).toHaveLength(1);
      expect(items[0].classification).toBe('workout');
      expect(items[0].metadata['Distance (km)']).toBe(21.097);
      expect(items[0].metadata['Time Zone']).toBe('Europe/Berlin');
    });

    it('keeps the recorded length when only the start was moved by hand', async () => {
      const { items } = await importDir({
        'activities.csv':
          'from,to,"from (manual)","to (manual)",Timezone,"Activity type",Data,GPS,Modified\n' +
          '2026-10-28T08:00:00+00:00,2026-10-28T09:00:00+00:00,2026-10-29T18:00:00+00:00,,Europe/London,Running,{},,\n',
      });
      expect(items[0].timestamp!.toISOString()).toBe('2026-10-29T18:00:00.000Z');
      expect(items[0].timespanEnd!.toISOString()).toBe('2026-10-29T19:00:00.000Z');
    });

    it('keeps a workout whose Data cell is not JSON, without totals', async () => {
      const { items } = await importDir({
        'activities.csv':
          'from,to,"from (manual)","to (manual)",Timezone,"Activity type",Data,GPS,Modified\n' +
          '2026-11-03T18:20:00+00:00,2026-11-03T19:05:00+00:00,,,Europe/London,Yoga,not json,,\n',
      });
      expect(items).toHaveLength(1);
      expect(items[0].metadata.Title).toBe('Yoga');
      expect(items[0].metadata.Calories).toBeUndefined();
    });

    it('imports each day of the aggregates files', async () => {
      const { items } = await importDir({
        'aggregates_steps.csv': 'date,value\n2026-10-28,24310\n2026-10-29,6120\n',
        'aggregates_distance.csv': 'date,value\n2026-10-28,25310.4\n',
        'aggregates_calories_earned.csv': 'date,value\n2026-10-28,1630.5\n',
      });
      const steps = items.filter((i) => i.metadata.File === 'aggregates_steps.csv');
      expect(steps.map((i) => i.metadata.Steps)).toEqual([24310, 6120]);
      expect(steps[0].classification).toBe('observation');
      expect(steps[0].timestamp!.toISOString()).toBe('2026-10-28T00:00:00.000Z');
      expect(steps[0].metadata.Title).toBe('Steps on 2026-10-28: 24310');
      const distance = items.find((i) => i.metadata.File === 'aggregates_distance.csv')!;
      expect(distance.metadata['Distance (km)']).toBe(25.31);
      const calories = items.find((i) => i.metadata.File === 'aggregates_calories_earned.csv')!;
      expect(calories.metadata['Active Calories']).toBe(1630.5);
      expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    });

    it('applies the timeframe to the new files', async () => {
      const { items } = await importDir(
        {
          'sleep.csv': SLEEP,
          'activities.csv': ACTIVITIES,
          'aggregates_steps.csv': 'date,value\n2026-10-28,24310\n2026-11-04,9000\n',
        },
        { since: new Date('2026-11-01T00:00:00Z') },
      );
      expect(items.map((i) => i.metadata.Title).sort()).toEqual(['Steps on 2026-11-04: 9000', 'Swimming']);
    });

    it('counts each per-reading raw_*.csv as dropped instead of skipping it silently', async () => {
      const { items, drops } = await importDir({
        'raw_tracker_steps.csv': 'start,duration,value\n2026-10-28T08:00:00+00:00,[60],[112]\n',
      });
      expect(items).toHaveLength(0);
      expect(drops).toEqual([['unread_export_file', 'raw_tracker_steps.csv']]);
    });

    it("leaves another service's activities.csv alone", async () => {
      const { items } = await importDir({
        'activities.csv':
          'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance\n1,"Mar 14, 2026, 7:05:12 AM",Run,Run,1980,6.12\n',
      });
      expect(items).toHaveLength(0);
    });
  });
});

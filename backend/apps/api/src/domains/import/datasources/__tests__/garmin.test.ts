import path from 'path';

import { GarminFileImporter } from '../garmin';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('Garmin Connect datasource', () => {
  it('recognizes export directory by Activities.csv', async () => {
    const root = path.join(FIXTURES_DIR, 'garmin-export');
    const fi = new GarminFileImporter();
    const rec = await fi.recognize({}, { filename: 'garmin-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes a single Activities.csv file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'garmin-export', 'Activities.csv');
    const fi = new GarminFileImporter();
    const rec = await fi.recognize({}, { filename: 'Activities.csv', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('does not false-match a Strava activities.csv', async () => {
    // Strava's activities.csv also has "Activity Type" + "Distance" columns but
    // lacks Garmin-distinctive fields (Favorite/Calories/Avg HR/Aerobic TE).
    const fpath = path.join(FIXTURES_DIR, 'strava-export', 'activities.csv');
    const fi = new GarminFileImporter();
    const rec = await fi.recognize({}, { filename: 'activities.csv', fullPath: fpath });
    expect(rec.confidence).toBe(0);
  });

  it('imports activities into workout items', async () => {
    const root = path.join(FIXTURES_DIR, 'garmin-export');
    const fi = new GarminFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'garmin-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(3);

    const first = pipeline[0].item;
    expect(first.classification).toBe('workout');
    expect(first.metadata['Activity Type']).toBe('Running');
    expect(first.metadata.Title).toBe('Morning Run, riverside');
    expect(first.metadata.Distance).toBe('5.02');
    expect(first.metadata.Calories).toBe('412');
    expect(first.metadata.Time).toBe('00:28:43');
    expect(first.metadata['Avg HR']).toBe('148');
    expect(first.metadata.Source).toBe('Garmin Connect');
    expect(first.timestamp).toBeInstanceOf(Date);
    expect(first.timestamp!.getFullYear()).toBe(2023);

    // Embedded quotes inside a quoted field must survive the CSV parse.
    expect(pipeline[2].item.metadata.Title).toBe('Lap swim "intervals"');

    // Content is the human-readable title.
    const buf = await first.content.data!();
    expect(buf.toString()).toBe('Morning Run, riverside');
  });

  it('honors the timeframe filter', async () => {
    const root = path.join(FIXTURES_DIR, 'garmin-export');
    const fi = new GarminFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'garmin-export', fullPath: root }, {
      pipeline,
      timeframe: { since: new Date('2023-01-20T00:00:00') },
      log: () => {},
    } as unknown as ImportParams);

    // Only the Feb swim is after the since cutoff.
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.metadata['Activity Type']).toBe('Pool Swimming');
  });

  it('falls back to Activity Type as the title when Title is empty', async () => {
    // Garmin's Title column is often empty for auto-recorded activities; without a
    // title-bearing key the item would display as the bare 'workout.txt' filename.
    const fi = new GarminFileImporter();
    const pipeline: EmittedGraph[] = [];
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'garmin-untitled-'));
    const csv = path.join(tmpDir, 'Activities.csv');
    await fs.promises.writeFile(
      csv,
      'Activity Type,Date,Favorite,Title,Distance,Calories,Avg HR\n' +
        'Walking,2023-03-01 08:00:00,false,,2.10,180,98\n',
    );
    try {
      await fi.fileImport({}, { filename: 'Activities.csv', fullPath: csv }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(1);
      const item = pipeline[0].item;
      // Title now carries the activity type so titleFor does not fall back to 'workout.txt'.
      expect(item.metadata.Title).toBe('Walking');
      expect(item.metadata.Title).not.toBe(item.content.filename);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not throw on an empty or malformed CSV', async () => {
    const fi = new GarminFileImporter();
    const pipeline: EmittedGraph[] = [];
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'garmin-empty-'));
    const empty = path.join(tmpDir, 'Activities.csv');
    await fs.promises.writeFile(empty, '');
    try {
      await fi.fileImport({}, { filename: 'Activities.csv', fullPath: empty }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(0);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // Regression: pushRow used a constant content.filename ('workout.txt') and set
  // no item.id, so hashItem's fallback hash reduced to
  // dataSource+classification+ISO(timestamp) alone — two activities recorded in
  // the same second (plausible for back-to-back Garmin activities) collapsed
  // under the staging table's ON CONFLICT (run_id, data_source, content_hash)
  // DO NOTHING and one was silently dropped.
  it('assigns unique, stable ids to same-second activities that would otherwise dedup-collapse', async () => {
    const fi = new GarminFileImporter();
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'garmin-collapse-'));
    const csv = path.join(tmpDir, 'Activities.csv');
    await fs.promises.writeFile(
      csv,
      'Activity Type,Date,Favorite,Title,Distance,Calories,Avg HR\n' +
        'Running,2023-06-01 07:00:00,false,Interval 1,3.00,300,150\n' +
        'Running,2023-06-01 07:00:00,false,Interval 2,3.10,310,152\n',
    );
    try {
      const run = async () => {
        const pipeline: EmittedGraph[] = [];
        await fi.fileImport({}, { filename: 'Activities.csv', fullPath: csv }, {
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

      // Re-import of the same file yields the same ids (idempotent).
      const again = await run();
      expect(again.map((p) => p.item.id!)).toEqual(ids);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // Strava's real activities.csv runs to dozens of columns, Calories and
  // Average Heart Rate among them, and repeats Elapsed Time and Distance. The
  // fixture above stops before Calories, which is how a header test that
  // counted Calories as Garmin's let this file through: each Strava activity
  // came in again as an undated "Garmin Connect" workout.
  it("does not claim Strava's full activities.csv, Calories column included", async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'garmin-strava-'));
    const csv = path.join(tmpDir, 'activities.csv');
    await fs.promises.writeFile(
      csv,
      'Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,' +
        'Distance,Max Heart Rate,Relative Effort,Commute,Activity Private Note,Activity Gear,' +
        'Filename,Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance,Max Speed,' +
        'Average Speed,Elevation Gain,Elevation Loss,Elevation Low,Elevation High,Max Grade,' +
        'Average Grade,Max Cadence,Average Cadence,Max Heart Rate,Average Heart Rate,Calories,' +
        'Start Time,Media\n' +
        '16012345101,"Mar 14, 2026, 7:05:12 AM",Creek tempo run,Run,,1980,6.12,176,48,false,,,' +
        'activities/16012345101.gpx,71.5,,1980.0,1841.0,6120.0,6.1,3.091,88.0,84.0,12.4,96.2,' +
        '9.3,0.1,,,176,151.2,512.0,,\n',
    );
    fs.mkdirSync(path.join(tmpDir, 'activities'));
    try {
      const fi = new GarminFileImporter();
      const asFile = await fi.recognize({}, { filename: 'activities.csv', fullPath: csv });
      expect(asFile.confidence).toBe(0);
      const asDir = await fi.recognize({}, { filename: path.basename(tmpDir), fullPath: tmpDir });
      expect(asDir.confidence).toBe(0);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('still recognizes an Activities.csv whose header cells are quoted', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'garmin-quoted-'));
    const csv = path.join(tmpDir, 'Activities.csv');
    await fs.promises.writeFile(
      csv,
      '\uFEFF"Activity Type","Date","Favorite","Title","Distance","Calories","Time","Avg HR"\r\n' +
        '"Running","2023-01-15 10:30:00","false","Morning Run","5.02","412","00:28:43","148"\r\n',
    );
    try {
      const rec = await new GarminFileImporter().recognize({}, { filename: 'Activities.csv', fullPath: csv });
      expect(rec.confidence).toBeGreaterThan(0.8);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

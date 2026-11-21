import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GarminFileImporter } from '../garmin';
import { findImportRoots, type DataSource } from '../registry';
import type { ImportParams } from '../timeline';

import type { EmittedGraph, TestPipeline } from './support/emitted';

// The account export from Garmin's Data Management page ("Export Data"): a
// DI_CONNECT folder of JSON. Activities and sleep are read; the rest stays put.
const ACTIVITIES = [
  {
    summarizedActivitiesExport: [
      {
        activityId: 17012345601,
        name: 'Forest Park Running',
        activityType: 'running',
        userProfileId: 98123456,
        timeZoneId: 124,
        beginTimestamp: 1775916201000,
        sportType: 'RUNNING',
        startTimeGmt: 1775916201000.0,
        startTimeLocal: 1775891001000.0,
        duration: 2711000.0,
        distance: 742000.0,
        avgSpeed: 0.2737,
        avgHr: 151.0,
        maxHr: 174.0,
      },
      {
        activityId: 17012345602,
        name: 'Willamette Riverfront Cycling',
        activityType: 'road_biking',
        beginTimestamp: 1780763400000,
        startTimeGmt: 1780763400000.0,
        duration: 5320000.0,
        distance: 3421000.0,
      },
      // No start time at all: counted, not imported.
      { activityId: 17012345603, name: 'Manual entry', activityType: 'walking' },
    ],
  },
];

const SLEEP = [
  {
    sleepStartTimestampGMT: '2026-04-11T06:00:00.0',
    sleepEndTimestampGMT: '2026-04-11T13:25:00.0',
    calendarDate: '2026-04-11',
    sleepWindowConfirmationType: 'ENHANCED_CONFIRMED_FINAL',
    deepSleepSeconds: 5400,
    lightSleepSeconds: 14880,
    remSleepSeconds: 5640,
    awakeSleepSeconds: 780,
    sleepScores: { overallScore: 81, qualityScore: 77 },
  },
  {
    sleepStartTimestampGMT: '2026-06-02T05:40:00.0',
    sleepEndTimestampGMT: '2026-06-02T12:10:00.0',
    calendarDate: '2026-06-02',
    deepSleepSeconds: 4200,
    lightSleepSeconds: 15000,
    remSleepSeconds: 4800,
    awakeSleepSeconds: 1200,
  },
];

describe('Garmin Connect account export', () => {
  let root: string;
  let activitiesFile: string;
  let sleepFile: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-di-connect-'));
    const di = path.join(root, 'DI_CONNECT');
    const write = (rel: string, body: unknown) => {
      const full = path.join(di, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, JSON.stringify(body));

      return full;
    };

    activitiesFile = write('DI-Connect-Fitness/runner_0_summarizedActivities.json', ACTIVITIES);
    sleepFile = write('DI-Connect-Wellness/2026-03-01_2026-09-30_98123456_sleepData.json', SLEEP);
    write('DI-Connect-Aggregator/UDSFile_2026-03-01_2026-09-30.json', [
      { calendarDate: '2026-04-11', totalSteps: 9000 },
    ]);
    write('DI-Connect-User/user_profile.json', { userName: 'runner' });
    write('DI-Connect-Fitness/runner_personalRecord.json', [{ personalRecords: [] }]);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(file: string, timeframe: ImportParams['timeframe'] = {}) {
    const drops: string[] = [];
    let consumed = 0;
    const pipeline: TestPipeline = Object.assign([] as EmittedGraph[], {
      drop: (reason: string) => {
        drops.push(reason);
      },
      consumed: (n: number) => {
        consumed += n;
      },
    });
    await new GarminFileImporter().fileImport({}, { filename: path.basename(file), fullPath: file }, {
      pipeline,
      timeframe,
      log: () => {},
    } as unknown as ImportParams);

    return { pipeline, drops, consumed: () => consumed };
  }

  it('claims the activity and sleep files and nothing else in the folder', async () => {
    const fi = new GarminFileImporter();
    const confidence = async (p: string) =>
      (await fi.recognize({}, { filename: path.basename(p), fullPath: p })).confidence;

    expect(await confidence(activitiesFile)).toBeGreaterThan(0.9);
    expect(await confidence(sleepFile)).toBeGreaterThan(0.9);
    expect(await confidence(path.join(root, 'DI_CONNECT', 'DI-Connect-User', 'user_profile.json'))).toBe(0);
    expect(await confidence(path.join(root, 'DI_CONNECT'))).toBe(0);

    const garmin: DataSource = {
      name: 'garmin',
      title: 'Garmin Connect',
      icon: '',
      description: '',
      newFileImporter: () => new GarminFileImporter(),
    };
    expect((await findImportRoots({}, garmin, root)).sort()).toEqual([activitiesFile, sleepFile].sort());
  });

  it('does not claim a directory that happens to carry the file name', async () => {
    const dir = path.join(root, 'odd_summarizedActivities.json');
    fs.mkdirSync(dir);
    try {
      const rec = await new GarminFileImporter().recognize(
        {},
        { filename: path.basename(dir), fullPath: dir },
      );
      expect(rec.confidence).toBe(0);
    } finally {
      fs.rmdirSync(dir);
    }
  });

  it('reads activities as workouts in the units the CSV export uses', async () => {
    const { pipeline, drops, consumed } = await run(activitiesFile);

    expect(pipeline.length).toBe(2);
    const [runItem, ride] = pipeline.map((g) => g.item);

    expect(runItem.id).toBe('garmin:activity:17012345601');
    expect(runItem.classification).toBe('workout');
    expect(runItem.timestamp!.toISOString()).toBe('2026-04-11T14:03:21.000Z');
    expect(runItem.timespanEnd!.toISOString()).toBe('2026-04-11T14:48:32.000Z');
    expect(runItem.metadata).toEqual(
      expect.objectContaining({
        'Activity Type': 'Running',
        Title: 'Forest Park Running',
        Distance: '7.42',
        Time: '00:45:11',
        'Avg HR': '151',
        Source: 'Garmin Connect',
      }),
    );
    expect((await runItem.content.data!()).toString()).toBe('Forest Park Running');

    expect(ride.metadata['Activity Type']).toBe('Road Biking');
    expect(ride.metadata.Distance).toBe('34.21');
    expect(ride.metadata.Time).toBe('01:28:40');
    expect(ride.metadata['Avg HR']).toBeUndefined();

    expect(drops).toEqual(['garmin_undated_record']);
    expect(consumed()).toBe(3);
  });

  it('reads sleep nights with GMT times, whatever the server zone', async () => {
    const { pipeline, drops, consumed } = await run(sleepFile);

    expect(pipeline.length).toBe(2);
    const night = pipeline[0].item;
    expect(night.id).toBe('garmin:sleep:2026-04-11');
    expect(night.classification).toBe('sleep');
    expect(night.timestamp!.toISOString()).toBe('2026-04-11T06:00:00.000Z');
    expect(night.timespanEnd!.toISOString()).toBe('2026-04-11T13:25:00.000Z');
    expect(night.metadata).toEqual(
      expect.objectContaining({
        Title: 'Slept 432 min on 2026-04-11',
        'Minutes Asleep': 432,
        'Minutes Awake': 13,
        'Sleep Score': 81,
        'Date Of Sleep': '2026-04-11',
        Source: 'Garmin Connect',
      }),
    );
    expect(pipeline[1].item.metadata['Sleep Score']).toBeUndefined();
    expect(drops).toEqual([]);
    expect(consumed()).toBe(2);
  });

  it('counts what the timeframe leaves out', async () => {
    const { pipeline, drops } = await run(sleepFile, { since: new Date('2026-05-01T00:00:00Z') });

    expect(pipeline.map((g) => g.item.metadata['Date Of Sleep'])).toEqual(['2026-06-02']);
    expect(drops).toEqual(['outside_timeframe']);
  });

  it('survives a file that is not the expected JSON', async () => {
    const bad = path.join(root, 'broken_summarizedActivities.json');
    fs.writeFileSync(bad, '{ not json');
    try {
      const { pipeline } = await run(bad);
      expect(pipeline.length).toBe(0);
    } finally {
      fs.rmSync(bad);
    }
  });
});

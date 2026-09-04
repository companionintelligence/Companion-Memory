import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { AppleHealthFileImporter } from '../apple_health';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Run the importer against an ad-hoc export.xml written to a temp dir.
async function importXml(xml: string, timeframe: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-'));
  const fpath = path.join(dir, 'export.xml');
  fs.writeFileSync(fpath, xml);
  const fi = new AppleHealthFileImporter();
  const pipeline: EmittedGraph[] = [];
  const logs: Array<unknown[]> = [];
  await fi.fileImport({}, { filename: 'export.xml', fullPath: fpath }, {
    pipeline,
    timeframe,
    log: (...a: unknown[]) => logs.push(a),
  } as unknown as ImportParams);

  return { pipeline, logs };
}

describe('Apple Health datasource', () => {
  it('recognizes export directory containing export.xml', async () => {
    const root = path.join(FIXTURES_DIR, 'apple-health-export');
    const fi = new AppleHealthFileImporter();
    const rec = await fi.recognize({}, { filename: 'apple-health-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('recognizes export.xml file directly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'apple-health-export', 'export.xml');
    const fi = new AppleHealthFileImporter();
    const rec = await fi.recognize({}, { filename: 'export.xml', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('imports health records, workout, and activity summary', async () => {
    const root = path.join(FIXTURES_DIR, 'apple-health-export');
    const fi = new AppleHealthFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'apple-health-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    // 2 health records + 1 sleep + 1 workout + 1 activity summary
    expect(pipeline.length).toBe(5);

    const health = pipeline.filter((p) => p.item.classification === 'health');
    const sleep = pipeline.filter((p) => p.item.classification === 'sleep');
    const workouts = pipeline.filter((p) => p.item.classification === 'workout');
    expect(health.length).toBe(3); // steps + heart rate + activity summary
    expect(sleep.length).toBe(1); // SleepAnalysis is its own classification
    expect(workouts.length).toBe(1);
  });

  it('parses record metadata correctly', async () => {
    const root = path.join(FIXTURES_DIR, 'apple-health-export');
    const fi = new AppleHealthFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'apple-health-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const stepsRecord = pipeline.find((p) => p.item.metadata?.Type === 'HKQuantityTypeIdentifierStepCount');
    expect(stepsRecord).toBeDefined();
    expect(stepsRecord!.item.metadata.Value).toBe(1234);
    expect(stepsRecord!.item.metadata.Unit).toBe('count');
    expect(stepsRecord!.item.metadata.Source).toBe('iPhone');
  });

  it('parses workout metadata correctly', async () => {
    const root = path.join(FIXTURES_DIR, 'apple-health-export');
    const fi = new AppleHealthFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'apple-health-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const workout = pipeline.find((p) => p.item.classification === 'workout');
    expect(workout).toBeDefined();
    expect(workout!.item.metadata['Activity Type']).toBe('Running');
    expect(workout!.item.metadata.Calories).toBe(350);
  });

  // A5 — real multi-GB exports broke the old line-based scanner, which silently
  // produced 0 items. These lock the element-based parser against the two real
  // failure modes plus the silent-0 diagnostic.
  it('parses records whose opening tag WRAPS across lines (old scanner → 0 items)', async () => {
    const wrapped =
      '<?xml version="1.0"?>\n<HealthData locale="en_US">\n' +
      '<Record\n type="HKQuantityTypeIdentifierStepCount"\n unit="count"\n' +
      ' startDate="2024-01-01 08:00:00 +0000"\n value="9"/>\n' +
      '</HealthData>\n';
    const { pipeline } = await importXml(wrapped);
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.metadata.Value).toBe(9);
  });

  it('parses MANY records packed onto a single line (compact export)', async () => {
    const compact =
      '<?xml version="1.0"?>\n<HealthData locale="en_US">' +
      Array.from(
        { length: 4 },
        (_, i) =>
          `<Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2024-01-0${i + 1} 08:00:00 +0000" value="${i + 1}"/>`,
      ).join('') +
      '</HealthData>';
    const { pipeline } = await importXml(compact);
    expect(pipeline.length).toBe(4);
    expect(pipeline.map((p) => p.item.metadata.Value)).toEqual([1, 2, 3, 4]);
  });

  it('handles a leading DTD and Records with nested <MetadataEntry> children', async () => {
    const withDtd =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE HealthData [\n<!ELEMENT HealthData (Record|Workout)*>\n]>\n' +
      '<HealthData locale="en_US">\n' +
      '<Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2024-01-01 08:30:00 +0000" value="72">\n' +
      '  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="0"/>\n' +
      '</Record>\n' +
      '<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" sourceName="Watch" startDate="2024-01-01 08:00:00 +0000" endDate="2024-01-01 08:30:00 +0000">\n' +
      '  <MetadataEntry key="HKIndoorWorkout" value="0"/>\n' +
      '</Workout>\n' +
      '</HealthData>\n';
    const { pipeline } = await importXml(withDtd);
    const record = pipeline.find((p) => p.item.classification === 'health');
    const workout = pipeline.find((p) => p.item.classification === 'workout');
    expect(record?.item.metadata.Value).toBe(72);
    expect(workout?.item.metadata['Activity Type']).toBe('Running');
    // The child MetadataEntry's key/value must NOT leak into the workout metadata.
    expect(workout?.item.metadata.key).toBeUndefined();
  });

  // DEDUP-COLLAPSE regression: records that share a startDate second and the same
  // type/source/value/unit (e.g. iPhone + Apple Watch both writing StepCount, or
  // repeated identical samples) previously hashed to ONE dedup id and collapsed,
  // because pushRecord set no item.id and the filename is constant. Each item must
  // now carry a stable, unique, idempotent id.
  it('gives every same-second record a unique, idempotent id (no dedup collapse)', async () => {
    const collide =
      '<?xml version="1.0"?>\n<HealthData locale="en_US">' +
      Array.from(
        { length: 3 },
        () =>
          '<Record type="HKQuantityTypeIdentifierStepCount" unit="count" sourceName="iPhone" startDate="2024-01-01 08:00:00 +0000" endDate="2024-01-01 08:00:00 +0000" value="10"/>',
      ).join('') +
      '<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" sourceName="Watch" startDate="2024-01-01 08:00:00 +0000" endDate="2024-01-01 08:00:00 +0000"/>' +
      '<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" sourceName="Watch" startDate="2024-01-01 08:00:00 +0000" endDate="2024-01-01 08:00:00 +0000"/>' +
      '</HealthData>';
    const { pipeline } = await importXml(collide);
    expect(pipeline.length).toBe(5);
    const ids = pipeline.map((p) => p.item.id!);
    // (a) every id truthy
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    // (b) all ids distinct despite identical timestamp/type/source/value
    expect(new Set(ids).size).toBe(ids.length);
    // (c) re-import yields identical ids (idempotent)
    const { pipeline: pipeline2 } = await importXml(collide);
    expect(pipeline2.map((p) => p.item.id!)).toEqual(ids);
  });

  // TITLE-FALLBACK regression: records/workouts/summaries previously set no
  // title-bearing metadata key, so titleFor fell back to the constant filename
  // ('health_record.txt' / 'workout.txt' / 'activity_summary.txt'). Each pusher
  // must now carry a human Title derived from the item's own data.
  it('gives every item a title-bearing metadata key (not the bare filename)', async () => {
    const root = path.join(FIXTURES_DIR, 'apple-health-export');
    const fi = new AppleHealthFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'apple-health-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const steps = pipeline.find((p) => p.item.metadata?.Type === 'HKQuantityTypeIdentifierStepCount');
    expect(steps!.item.metadata.Title).toBe('StepCount: 1234 count');

    const workout = pipeline.find((p) => p.item.classification === 'workout');
    expect(workout!.item.metadata.Title).toBe('Running');

    const summary = pipeline.find((p) => p.item.metadata?.Type === 'ActivitySummary');
    expect(summary!.item.metadata.Title).toBeDefined();
    expect(summary!.item.metadata.Title).toMatch(/^Activity Summary /);

    // None of the titles is the bare content filename.
    for (const p of pipeline) {
      expect(p.item.metadata.Title).not.toBe(p.item.content.filename);
    }
  });

  it('emits a clear warning (not silence) when an export yields 0 items', async () => {
    const empty = '<?xml version="1.0"?>\n<HealthData locale="en_US">\n</HealthData>\n';
    const { pipeline, logs } = await importXml(empty);
    expect(pipeline.length).toBe(0);
    const warned = logs.some((a) => a[0] === 'warn' && String(a[1]).includes('produced 0 timeline items'));
    expect(warned).toBe(true);
  });
});

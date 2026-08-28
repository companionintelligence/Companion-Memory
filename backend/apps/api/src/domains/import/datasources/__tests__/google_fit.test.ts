import path from 'path';

import { GoogleFitFileImporter } from '../google_fit';
import type { Graph, ImportParams, Timeframe } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const ROOT = path.join(FIXTURES_DIR, 'google_fit');

async function run(root: string, timeframe: Timeframe = {}): Promise<EmittedGraph[]> {
  const fi = new GoogleFitFileImporter();
  const pipeline: EmittedGraph[] = [];
  await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
    pipeline,
    timeframe,
    log: () => {},
  } as unknown as ImportParams);

  return pipeline;
}

describe('Google Fit datasource', () => {
  it('recognizes a Fit export directory', async () => {
    const fi = new GoogleFitFileImporter();
    const rec = await fi.recognize({}, { filename: 'google_fit', fullPath: ROOT });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('recognizes a single daily-metrics CSV', async () => {
    const fpath = path.join(ROOT, 'Fit', 'Daily activity metrics', '2019-06-03.csv');
    const fi = new GoogleFitFileImporter();
    const rec = await fi.recognize({}, { filename: '2019-06-03.csv', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.5);
  });

  it('does not recognize an unrelated directory', async () => {
    const fi = new GoogleFitFileImporter();
    const rec = await fi.recognize({}, { filename: 'fixtures', fullPath: FIXTURES_DIR });
    // fixtures/ has no `Fit` (or daily-metrics) folder as its OWN immediate
    // child — the nested `google_fit/Fit/` tree belongs to an unrelated
    // sibling fixture two levels down, and must not be attributed to the
    // whole fixtures/ root. Regression: findFitRoot used to recurse into
    // every subdirectory looking for a `Fit` folder anywhere below `root` and
    // claimed confidence for `root` itself when it found one two levels down.
    expect(rec.confidence).toBe(0);
    expect(rec.dir_threshold).toBe(0.7);
  });

  it('does not recognize a Fit-like folder found deep in an unrelated tree', async () => {
    // A real-world shape: a huge, unrelated export (e.g. a Drive dump) that
    // happens to contain a folder literally named "Fit" several levels down,
    // with none of the daily-metrics/sessions structure. That must not claim
    // the ancestor directory it's nested under.
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ci-google-fit-fp-'));
    try {
      const deep = path.join(tmpRoot, 'Drive', 'personal', 'notes');
      await fs.promises.mkdir(deep, { recursive: true });
      await fs.promises.writeFile(path.join(deep, 'unrelated.txt'), 'hello');
      // Coincidentally-named folder, several levels deep, with no Fit content.
      await fs.promises.mkdir(path.join(deep, 'Fit'));

      const fi = new GoogleFitFileImporter();
      const rec = await fi.recognize({}, { filename: path.basename(tmpRoot), fullPath: tmpRoot });
      expect(rec.confidence).toBe(0);
      expect(rec.dir_threshold).toBe(0.7);
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('aggregates a daily CSV into one observation', async () => {
    const pipeline = await run(ROOT);
    const obs = pipeline.map((g) => g.item).filter((i) => i.classification === 'observation');
    expect(obs.length).toBe(1);
    const o = obs[0];
    expect(o.id).toBe('google_fit:2019-06-03');
    expect(o.metadata.Steps).toBe(1234); // 482 + 752
    expect(o.metadata.HeartRate).toBe(76); // (72 + 80) / 2
    expect(o.metadata['Max Heart Rate']).toBe(95);
    expect(o.metadata['Min Heart Rate']).toBe(60);
    expect(o.metadata.Calories).toBe(87); // 17 + 30 + 40 rounded sum
    expect(o.metadata.Distance).toBe(321); // 148 + 173
    expect(o.metadata.Source).toBe('Google Fit');
    // Title is meaningful, never the bare filename.
    expect(o.metadata.Title).toBe('Activity 2019-06-03 (1,234 steps)');
    expect(o.metadata.Title).not.toBe(o.content.filename);
    // Timestamp parses to the file's day.
    expect(o.timestamp).toBeInstanceOf(Date);
    expect(isNaN(o.timestamp!.getTime())).toBe(false);
    expect(o.timestamp!.getFullYear()).toBe(2019);
  });

  it('imports workout sessions and dedups the JSON/TCX pair', async () => {
    const pipeline = await run(ROOT);
    const workouts = pipeline.map((g) => g.item).filter((i) => i.classification === 'workout');
    // Four JSON sessions, each collapsing with its TCX twin, plus three
    // TCX-only workouts (Biking, Hiking, the 2018-09-05 Walking) → 7.
    expect(workouts.length).toBe(7);

    const walk = workouts.find((w) => w.id === 'google_fit:session:2018-04-03T20:50:05.067Z');
    expect(walk).toBeDefined();
    expect(walk!.id).toBe('google_fit:session:2018-04-03T20:50:05.067Z');
    expect(walk!.metadata.Title).toBe('Walking');
    expect(walk!.metadata.Steps).toBe(1982); // from JSON aggregate (TCX has none)
    expect(walk!.metadata.Calories).toBe(138);
    expect(walk!.timestamp).toBeInstanceOf(Date);
    expect(walk!.timestamp!.getFullYear()).toBe(2018);

    const bike = workouts.find((w) => w.metadata['Activity Type'] === 'Biking');
    expect(bike).toBeDefined();
    expect(bike!.metadata.Title).toBe('Biking');
    // TCX-only: the key still comes from the filename's local start, not <Id>.
    expect(bike!.id).toBe('google_fit:session:2018-04-06T00:16:46.293Z');
  });

  // The three ways a TCX <Id> fails to equal its session's startTime. Each one
  // used to mint a second, duplicate 'workout' for a workout already imported.
  it('dedups when the TCX spells a whole second as ".000Z"', async () => {
    const pipeline = await run(ROOT);
    const run2018 = pipeline
      .map((g) => g.item)
      .filter((i) => i.id!.startsWith('google_fit:session:2018-05-01'));
    // JSON startTime "2018-05-01T17:00:00Z" vs TCX <Id> "…T17:00:00.000Z".
    expect(run2018.length).toBe(1);
    expect(run2018[0].id).toBe('google_fit:session:2018-05-01T17:00:00.000Z');
    expect(run2018[0].metadata['Activity Type']).toBe('running'); // JSON won
    expect(run2018[0].metadata.Steps).toBe(4200);
  });

  it('dedups when the TCX <Id> is the first trackpoint, not the session start', async () => {
    const pipeline = await run(ROOT);
    const items = pipeline
      .map((g) => g.item)
      .filter((i) => i.id!.startsWith('google_fit:session:2018-06-02'));
    // <Id> trails the session start by 48s; only the filename ties them.
    expect(items.length).toBe(1);
    expect(items[0].id).toBe('google_fit:session:2018-06-02T17:00:00.250Z');
    expect(items[0].metadata['Activity Type']).toBe('walking');
  });

  it('dedups a multi-<Activity> TCX whose leading <Id> is a later segment', async () => {
    const pipeline = await run(ROOT);
    const items = pipeline
      .map((g) => g.item)
      .filter((i) => i.id!.startsWith('google_fit:session:2018-07-03'));
    // Three <Activity> blocks, document order starting at the THIRD segment.
    // They are stop-go segments of one walk, so the walk imports as one item and
    // the segments are not surfaced at all.
    expect(items.length).toBe(1);
    expect(items[0].id).toBe('google_fit:session:2018-07-03T17:00:00.100Z');
    expect(items[0].metadata.Segments).toBeUndefined();
  });

  it('emits a multi-segment TCX-only workout exactly once', async () => {
    const pipeline = await run(ROOT);
    const hike = pipeline.map((g) => g.item).filter((i) => i.id!.startsWith('google_fit:session:2018-08-04'));
    expect(hike.length).toBe(1);
    // Neither <Id> matches the filename's start; the filename is authoritative.
    expect(hike[0].id).toBe('google_fit:session:2018-08-04T16:00:00.000Z');
    expect(hike[0].metadata.Title).toBe('Hiking');
    expect(hike[0].metadata.Segments).toBeUndefined();
  });

  it('reads the start off a truncated TCX filename', async () => {
    // Takeout clips long names: "…_PT40M_Walkin.tcx". Keying on the leading
    // timestamp rather than stripping the tail keeps that file matchable.
    const pipeline = await run(ROOT);
    const ids = pipeline.map((g) => g.item.id!);
    expect(ids).toContain('google_fit:session:2018-07-03T17:00:00.100Z');
  });

  // TCX <Trackpoint><Position> fixes → 'location' items, which the CI-Server
  // mapping routes to the position table (location.fix → ['position']).
  describe('trackpoint positions', () => {
    const positions = async () =>
      (await run(ROOT)).map((g) => g.item).filter((i) => i.classification === 'location');

    it('imports one position per fixed trackpoint, timed by its own <Time>', async () => {
      const pos = (await positions()).filter((p) => p.id!.startsWith('google_fit:position:'));
      // 2018-09-05 contributes 2 fixes; 2018-04-03 contributes 1. Trackpoints
      // with no <Position>, and a <Position> with an empty coordinate, do not.
      expect(pos.length).toBe(3);

      const p = pos.find((i) => i.id === 'google_fit:position:2018-09-05T16:00:38.775Z')!;
      expect(p).toBeDefined();
      expect(p.location).toEqual({ latitude: 33.5159276, longitude: -117.7219496 });
      // The trackpoint's time, NOT the session start (16:00:00).
      expect(p.timestamp!.toISOString()).toBe('2018-09-05T16:00:38.775Z');
      expect(p.metadata.Elevation).toBe(113.29999542236328);
      expect(p.metadata.Source).toBe('Google Fit');
      expect(p.metadata['Activity Type']).toBe('Walking');
      expect(p.metadata.Title).toBe('33.51593, -117.72195');
    });

    it('keeps a fix that carries no altitude', async () => {
      const p = (await positions()).find((i) => i.id === 'google_fit:position:2018-09-05T16:01:12.500Z')!;
      expect(p).toBeDefined();
      expect(p.location).toEqual({ latitude: 33.5161, longitude: -117.7221 });
      expect(p.metadata.Elevation).toBeUndefined();
    });

    it('imports the track even when the workout dedups against its JSON twin', async () => {
      // The regression this guards: skipping the TCX once the session JSON had
      // covered the workout also threw away the export's only coordinates.
      const pos = await positions();
      const p = pos.find((i) => i.id === 'google_fit:position:2018-04-03T20:51:00.000Z')!;
      expect(p).toBeDefined();
      expect(p.location).toEqual({ latitude: 37.7749295, longitude: -122.4194155 });
      // ...and the workout itself is still a single, deduped item.
      const walks = (await run(ROOT))
        .map((g) => g.item)
        .filter((i) => i.id === 'google_fit:session:2018-04-03T20:50:05.067Z');
      expect(walks.length).toBe(1);
    });

    it('drops trackpoints with no fix rather than emitting 0,0', async () => {
      const pos = await positions();
      expect(pos.every((p) => p.location!.latitude !== 0 && p.location!.longitude !== 0)).toBe(true);
      expect(pos.every((p) => Number.isFinite(p.location!.latitude))).toBe(true);
      expect(pos.some((p) => p.timestamp!.toISOString() === '2018-09-05T16:02:00.000Z')).toBe(false);
    });

    // Forward-looking: Google Fit writes no <Courses> today, but the schema puts
    // a <Position> on <CoursePoint> too, and other devices' TCX carry them.
    it('imports course-point waypoints as positions', async () => {
      const pos = await positions();
      const summit = pos.find((i) => i.id === 'google_fit:coursepoint:2018-09-05T16:20:00.000Z')!;
      expect(summit).toBeDefined();
      expect(summit.location).toEqual({ latitude: 33.52, longitude: -117.73 });
      expect(summit.timestamp!.toISOString()).toBe('2018-09-05T16:20:00.000Z');
      expect(summit.metadata.Elevation).toBe(240.5);
      // Name drives the CI-Server position's name; the rest rides in metadata.
      expect(summit.metadata.Name).toBe('Summit');
      expect(summit.metadata.Title).toBe('Summit');
      expect(summit.metadata['Point Type']).toBe('Summit');
      expect(summit.metadata.Notes).toBe('Top of the ridge');
      expect(summit.metadata.Course).toBe('Ridge Loop');
    });

    it('accepts a course point carrying only the mandatory fields', async () => {
      const water = (await positions()).find(
        (i) => i.id === 'google_fit:coursepoint:2018-09-05T16:25:30.250Z',
      )!;
      expect(water).toBeDefined();
      expect(water.metadata.Name).toBe('Water');
      expect(water.metadata.Elevation).toBeUndefined();
      expect(water.metadata['Point Type']).toBeUndefined();
      expect(water.metadata.Notes).toBeUndefined();
      // The course name still comes from the enclosing <Course>.
      expect(water.metadata.Course).toBe('Ridge Loop');
    });

    it('keeps course points in their own id namespace', async () => {
      // A waypoint and a track fix at the same instant must not collide.
      const pos = await positions();
      const cp = pos.filter((p) => p.id!.startsWith('google_fit:coursepoint:'));
      const tp = pos.filter((p) => p.id!.startsWith('google_fit:position:'));
      expect(cp.length).toBe(2);
      expect(tp.length).toBe(3);
      expect(new Set(pos.map((p) => p.id)).size).toBe(pos.length);
    });

    it('does not mistake a <Course> name for a waypoint name', async () => {
      // Course_t puts <Name> before the waypoints; reading the whole block
      // would label the first waypoint "Ridge Loop".
      const named = (await positions()).filter((p) => p.metadata.Name === 'Ridge Loop');
      expect(named.length).toBe(0);
    });

    it('ignores <BeginPosition> on a course lap', async () => {
      // Only <Trackpoint>/<CoursePoint> positions are imported; a lap's
      // begin/end markers are route geometry, not observations.
      const pos = await positions();
      expect(pos.some((p) => p.location!.latitude === 33.51 && p.location!.longitude === -117.71)).toBe(
        false,
      );
    });

    it('reports unusable positions to the drop ledger', async () => {
      // Silent loss is what the ledger exists to prevent: a <Position> that
      // can't become a fix is counted, not swallowed.
      const fi = new GoogleFitFileImporter();
      const pushed: EmittedGraph[] = [];
      const drops: Array<[string, string | undefined]> = [];
      await fi.fileImport({}, { filename: 'google_fit', fullPath: ROOT }, {
        pipeline: {
          push: (g: Graph) => pushed.push(g as EmittedGraph),
          drop: (reason: string, detail?: string) => drops.push([reason, detail]),
        },
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      const reasons = drops.map((d) => d[0]).sort();
      // One malformed trackpoint + the "Broken" course point, plus "Untimed".
      expect(reasons).toEqual(['position_without_fix', 'position_without_fix', 'position_without_time']);
      // Details name the file and the offending point.
      expect(drops.some(([, d]) => d?.includes('course point "Broken"'))).toBe(true);
      expect(drops.some(([, d]) => d?.includes('course point "Untimed"'))).toBe(true);
      expect(drops.every(([, d]) => d?.endsWith('.tcx') || d?.includes('.tcx:'))).toBe(true);
    });

    it('honors the timeframe filter per trackpoint', async () => {
      const pipeline = await run(ROOT, { since: new Date('2018-09-05T16:01:00Z') });
      const ids = pipeline
        .map((g) => g.item)
        .filter((i) => i.classification === 'location')
        .map((i) => i.id!)
        .sort();
      // The 16:00:38 trackpoint and the 2018-04-03 one fall before the cutoff;
      // the later trackpoint and both course points survive.
      expect(ids).toEqual([
        'google_fit:coursepoint:2018-09-05T16:20:00.000Z',
        'google_fit:coursepoint:2018-09-05T16:25:30.250Z',
        'google_fit:position:2018-09-05T16:01:12.500Z',
      ]);
    });
  });

  it('gives every item a truthy, distinct id and a parseable timestamp', async () => {
    const pipeline = await run(ROOT);
    const items = pipeline.map((g) => g.item);
    expect(items.length).toBe(13);
    const ids = items.map((i) => i.id!);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of items) {
      expect(i.timestamp).toBeInstanceOf(Date);
      expect(isNaN(i.timestamp!.getTime())).toBe(false);
    }
  });

  it('is idempotent across re-import (same ids)', async () => {
    const a = (await run(ROOT)).map((g) => g.item.id!).sort();
    const b = (await run(ROOT)).map((g) => g.item.id!).sort();
    expect(a).toEqual(b);
  });

  it('honors the timeframe filter', async () => {
    const pipeline = await run(ROOT, { since: new Date('2019-01-01T00:00:00Z') });
    // Only the 2019 daily observation is after the cutoff; 2018 workouts drop.
    const items = pipeline.map((g) => g.item);
    expect(items.length).toBe(1);
    expect(items[0].classification).toBe('observation');
  });
});

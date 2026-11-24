/* Fitbit — sleep, workouts, steps and heart rate from a Google Takeout Fitbit export.
   Takeout ships Fitbit data inside a "Fitbit/" folder (often nested under
   "Fitbit/Global Export Data/"). The sleep logs are JSON files named
   "sleep-YYYY-MM-DD.json", each an array of records like:
     { "logId": ..., "dateOfSleep": "2023-01-15",
       "startTime": "2023-01-14T23:00:00.000",
       "endTime": "2023-01-15T07:00:00.000",
       "minutesAsleep": 420, "minutesAwake": 30,
       "efficiency": 92, "duration": 28800000 }
   One 'sleep' event per record. Beside them, in the same folder:
     exercise-N.json            one 'workout' per logged activity
     steps-YYYY-MM-DD.json      a count per minute, summed into one daily row
     resting_heart_rate-*.json  one reading per day
     heart_rate-YYYY-MM-DD.json a reading every few seconds, summarised per day
   Steps, resting heart rate and heart rate become one 'observation' per day
   each. Any other file in "Global Export Data/" is counted as dropped, by name.
   Fitbit's own folders are claimed whole; the same files dropped loose beside
   other files are claimed one by one, so the rest of the upload stays with the
   other importers.
   Note: the Fitbit export format varies; this targets the documented export.

   This source is also the one the wizard presents as "Fitbit / Google Fit",
   because since the 2021 acquisition ONE Takeout "Fit" export carries both:
   Fitbit's "Fitbit/" sleep logs and Google Fit's "Fit/" activity tree. An
   account that never owned a Fitbit has only the latter, so the Google Fit half
   is delegated to GoogleFitFileImporter rather than left unread — dropping such
   an export here used to import nothing and still report success.
*/
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { childDir, filesIn } from './fsWalk';
import { GoogleFitFileImporter } from './google_fit';
import { readJsonFile } from './readers';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import { readHead } from './sniff';
import type { Graph, ImportParams } from './timeline';
import { textContent, timeframeContains } from './timeline';

const SLEEP_FILE_RE = /^sleep-\d{4}-\d{2}-\d{2}\.json$/i;
const EXERCISE_FILE_RE = /^exercise-\d+\.json$/i;
const STEPS_FILE_RE = /^steps-\d{4}-\d{2}-\d{2}\.json$/i;
const RESTING_HR_FILE_RE = /^resting_heart_rate-\d{4}-\d{2}-\d{2}\.json$/i;
const HEART_RATE_FILE_RE = /^heart_rate-\d{4}-\d{2}-\d{2}\.json$/i;
const READ_FILE_RES = [
  SLEEP_FILE_RE,
  EXERCISE_FILE_RE,
  STEPS_FILE_RE,
  RESTING_HR_FILE_RE,
  HEART_RATE_FILE_RE,
];
// Confidence for an export holding only the Google Fit half. Deliberately below
// GoogleFitFileImporter's own 0.95 so the dedicated Google Fit source still
// ranks first in drag-and-drop suggestions — this claim exists to stop a silent
// no-op, not to outrank the source that owns the format.
const GOOGLE_FIT_CONFIDENCE = 0.75;

interface SleepRecord {
  logId?: number | string;
  dateOfSleep?: string;
  startTime?: string;
  endTime?: string;
  minutesAsleep?: number;
  minutesAwake?: number;
  efficiency?: number;
  duration?: number;
}

// A parsed value looks like a Fitbit sleep export when it is a non-empty array
// whose first element carries a "minutesAsleep" or "dateOfSleep" field.
function isSleepExport(parsed: unknown): boolean {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return false;
  }

  const first = parsed[0];
  if (!first || typeof first !== 'object') {
    return false;
  }

  const rec = first as SleepRecord;

  return 'minutesAsleep' in rec || 'dateOfSleep' in rec;
}

// Matching files directly in a Fitbit/ folder, or its Global Export Data/ child.
async function filesUnderFitbitDir(fitbitDir: string, match: (name: string) => boolean): Promise<string[]> {
  const out = await filesIn(fitbitDir, match);
  const nested = await childDir(fitbitDir, 'global export data');
  if (nested) {
    out.push(...(await filesIn(nested, match)));
  }

  return out;
}

/**
 * Find sleep-*.json files following Takeout's known layout: directly in
 * `dir`, in a `Fitbit/` child of it, or in `Fitbit/Global Export Data/` two
 * levels down — never by recursing into arbitrary sibling folders (`Drive/`,
 * `Photos/`, …) looking for the filename pattern anywhere below `dir`. A
 * prior version did exactly that unbounded walk, so one coincidentally-named
 * `sleep-YYYY-MM-DD.json` anywhere inside an unrelated multi-GB export (e.g.
 * a personal file dump under `Drive/`) was enough to claim confidence for
 * the entire tree above it, at the path `dir` itself — exactly the
 * false-positive shape `dropGenericWhenSpecialised` relies on `matchedPath`
 * NOT being for a claim wider than what was actually found.
 */
async function findSleepFiles(dir: string): Promise<string[]> {
  return findFitbitFiles(dir, (name) => SLEEP_FILE_RE.test(name));
}

/** {@link findSleepFiles} for any file name, each file listed once. */
async function findFitbitFiles(dir: string, match: (name: string) => boolean): Promise<string[]> {
  const out = await filesIn(dir, match);

  if (path.basename(dir).toLowerCase() === 'fitbit') {
    out.push(...(await filesUnderFitbitDir(dir, match)));
  }

  const fitbitChild = await childDir(dir, 'fitbit');
  if (fitbitChild) {
    out.push(...(await filesUnderFitbitDir(fitbitChild, match)));
  }

  // A Fitbit/ folder is read both as `dir` and as a Fitbit folder; summing a
  // steps file twice would double the day's count.
  return [...new Set(out)];
}

/** The Global Export Data/ folders the layout above reaches from `dir`. */
async function globalExportDirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  if (path.basename(dir).toLowerCase() === 'global export data') {
    out.push(dir);
  }

  for (const fitbitDir of [
    path.basename(dir).toLowerCase() === 'fitbit' ? dir : undefined,
    await childDir(dir, 'fitbit'),
  ]) {
    const nested = fitbitDir ? await childDir(fitbitDir, 'global export data') : undefined;
    if (nested) {
      out.push(nested);
    }
  }

  return [...new Set(out)];
}

/**
 * What a folder holding the export claims: 0.9 for Fitbit's own folders, 0.85
 * for one that holds them as a `Fitbit/` child (a Takeout root, so recognition
 * settles on Fitbit/), 0 for any other folder. A claim covers the whole
 * folder, and the catch-all importer skips everything a claim covers, so
 * loose files in an upload are claimed one by one instead.
 */
async function exportFolderConfidence(dir: string): Promise<number> {
  const name = path.basename(dir).toLowerCase();
  if (name === 'fitbit' || name === 'global export data') {
    return 0.9;
  }

  return (await childDir(dir, 'fitbit')) ? 0.85 : 0;
}

/**
 * Is this one of the export's files, by name and by how it starts? Only the
 * first few KB are read: a heart-rate file is a day of readings.
 */
async function isExportFile(fpath: string): Promise<boolean> {
  const name = path.basename(fpath);
  if (SLEEP_FILE_RE.test(name)) {
    return isSleepExport(await readJsonFile(fpath));
  }

  if (!READ_FILE_RES.some((re) => re.test(name))) {
    return false;
  }

  const head = (await readHead(fpath)) ?? '';
  const key = EXERCISE_FILE_RE.test(name) ? '"activityName"' : '"dateTime"';

  return /^\uFEFF?\s*\[\s*\{/.test(head) && head.includes(key);
}

// A non-empty array whose first element carries every one of `keys`: the
// shape of Fitbit's exercise, steps and heart-rate files.
function isRecordArray(parsed: unknown, keys: string[]): boolean {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return false;
  }

  const first: unknown = parsed[0];

  return !!first && typeof first === 'object' && keys.every((k) => k in first);
}

/**
 * "MM/DD/YY HH:MM:SS" (Fitbit's local time, no zone) as "YYYY-MM-DDTHH:MM:SS".
 * A four-digit year is read whole, not as its first two digits.
 */
function fitbitLocal(value: unknown): string | undefined {
  const m =
    typeof value === 'string'
      ? /^(\d{2})\/(\d{2})\/(\d{4}|\d{2})(?!\d)(?: (\d{2}:\d{2}:\d{2}))?/.exec(value)
      : null;
  if (!m) {
    return undefined;
  }

  const year = m[3].length === 2 ? `20${m[3]}` : m[3];

  return `${year}-${m[1]}-${m[2]}T${m[4] ?? '00:00:00'}`;
}

/**
 * A Fitbit local time as a Date. Read the same way as the sleep logs' zone-less
 * ISO times: as the importing process's local time.
 */
function fitbitDate(value: unknown): Date | undefined {
  const local = fitbitLocal(value);
  const d = local ? new Date(local) : undefined;

  return d && !isNaN(d.getTime()) ? d : undefined;
}

/** Kilometres per Fitbit `distanceUnit`. */
const KM_PER_FITBIT_UNIT: Record<string, number> = { kilometer: 1, mile: 1.609344, meter: 0.001 };

interface ExerciseRecord {
  logId?: number | string;
  activityName?: string;
  startTime?: string;
  duration?: number;
  distance?: number;
  distanceUnit?: string;
  calories?: number;
  steps?: number;
  averageHeartRate?: number;
}

/** A day's heart-rate readings, summarised. */
interface HeartDay {
  min?: number;
  max?: number;
  sum: number;
  count: number;
}

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;

  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Re-label everything an inner importer pushes as belonging to `dataSource`.
 * The delegated importer has no idea it is running under another source's job,
 * so the stamp goes on here, on the way out. Persistence then attributes AND
 * dedups those records under that name — so the same Takeout arriving later
 * through the Google card collides with them instead of being filed twice.
 */
function attributeTo(params: ImportParams, dataSource: string): ImportParams {
  const stamp = (g: Graph): Graph => {
    if (g.item && !g.item.dataSource) {
      g.item.dataSource = dataSource;
    }

    for (const edge of g.edges ?? []) {
      stamp(edge.to);
    }

    return g;
  };

  return {
    ...params,
    pipeline: {
      ...params.pipeline,
      push: (g: Graph) => params.pipeline.push(stamp(g)),
    },
  };
}

export class FitbitFileImporter implements FileImporter {
  // The Google Fit half of the same Takeout "Fit" export. A pure-Fitbit tree
  // makes this a no-op (it finds none of the Fit subfolders), so it costs
  // nothing to always consult.
  private readonly googleFit = new GoogleFitFileImporter();

  async recognize(ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = await stat(root);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile()) {
      // Below the folder's 0.9 on purpose. Recognition keeps the more confident
      // of two nested matches, and a sleep file above its folder made every
      // Takeout import run on the sleep files alone, so nothing beside them
      // (workouts, steps, heart rate) was ever read.
      return (await isExportFile(root)) ? { confidence: 0.85 } : { confidence: 0 };
    }

    if (st.isDirectory()) {
      const confidence = await exportFolderConfidence(root);

      const found = confidence > 0 ? await findSleepFiles(root) : [];
      for (const f of found) {
        if (isSleepExport(await readJsonFile(f))) {
          return { confidence };
        }
      }

      // An account that logged workouts or steps but never sleep.
      for (const [re, keys] of [
        [EXERCISE_FILE_RE, ['activityName', 'startTime']],
        [STEPS_FILE_RE, ['dateTime', 'value']],
        [RESTING_HR_FILE_RE, ['dateTime', 'value']],
      ] as const) {
        const [first] = confidence > 0 ? await findFitbitFiles(root, (name) => re.test(name)) : [];
        if (first && isRecordArray(await readJsonFile(first), [...keys])) {
          return { confidence };
        }
      }

      // No Fitbit sleep logs — but a Takeout "Fit" export with only the Google
      // Fit half still belongs to this card. Claim it (below Google Fit's own
      // confidence) so the import resolves a root instead of importing nothing.
      const gfit = await this.googleFit.recognize(ctx, entry);
      if (gfit.confidence > 0) {
        return { confidence: GOOGLE_FIT_CONFIDENCE };
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  async fileImport(ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return;
    }

    if (stat.isFile()) {
      // One loose file of the export, claimed on its own.
      const name = path.basename(root);
      if (SLEEP_FILE_RE.test(name)) {
        await this.processFile(root, params);
      } else {
        const only = (re: RegExp) => (re.test(name) ? [root] : []);
        await this.readActivity(
          {
            exercise: only(EXERCISE_FILE_RE),
            steps: only(STEPS_FILE_RE),
            resting: only(RESTING_HR_FILE_RE),
            heart: only(HEART_RATE_FILE_RE),
          },
          params,
        );
      }

      return;
    }

    if (!stat.isDirectory()) {
      return;
    }

    for (const fpath of await findSleepFiles(root)) {
      await this.processFile(fpath, params);
    }

    await this.importActivity(root, params);

    // Then the Google Fit half of the same export: daily metrics and workouts.
    // Directories only — a lone sleep-*.json has no Fit tree around it. The two
    // halves are disjoint (sleep JSON under Fitbit/ vs the Fit/ subfolders), so
    // nothing is read twice. Those records are Google Fit's, not Fitbit's, so
    // they are attributed to google_fit — only the sleep logs above are Fitbit
    // data. This keeps `data_source` describing where a record came FROM rather
    // than which card happened to import it.
    await this.googleFit.fileImport(ctx, entry, attributeTo(params, 'google_fit'));
  }

  /** Workouts, daily steps and daily heart rate, then a drop for every file left unread. */
  private async importActivity(root: string, params: ImportParams): Promise<void> {
    const files = (re: RegExp) => findFitbitFiles(root, (name) => re.test(name));
    await this.readActivity(
      {
        exercise: await files(EXERCISE_FILE_RE),
        steps: await files(STEPS_FILE_RE),
        resting: await files(RESTING_HR_FILE_RE),
        heart: await files(HEART_RATE_FILE_RE),
      },
      params,
    );

    // Everything else in Global Export Data/ (calories, distance, altitude,
    // active minutes, weight, ...) has no reader yet: say so, one per file.
    // Dot files (.DS_Store left by unzipping on a Mac) are not export files.
    for (const dir of await globalExportDirs(root)) {
      const unread = (name: string) => !name.startsWith('.') && !READ_FILE_RES.some((re) => re.test(name));
      for (const fpath of await filesIn(dir, unread)) {
        params.pipeline.drop?.('unread_export_file', path.basename(fpath));
      }
    }
  }

  /**
   * The workouts, steps and heart-rate files given. Each kind of row comes
   * from one kind of file, so a file read on its own yields the same rows it
   * does as part of its folder.
   */
  private async readActivity(
    files: { exercise: string[]; steps: string[]; resting: string[]; heart: string[] },
    params: ImportParams,
  ): Promise<void> {
    const log = params.log;

    for (const fpath of files.exercise) {
      const parsed = await readJsonFile(fpath, { log });
      const base = path.basename(fpath);
      if (Array.isArray(parsed)) {
        parsed.forEach((rec, index) => {
          // One bad record must not stop the rest of the export (and the
          // Google Fit half after it) from importing.
          try {
            this.pushExercise(rec as ExerciseRecord, base, index, params);
          } catch (e) {
            log?.('error', `Failed to import exercise record in ${base}`, { error: (e as Error).message });
          }
        });
      }
    }

    // Steps come one per minute across month-long files: sum them by day.
    const steps = new Map<string, number>();
    for (const fpath of files.steps) {
      const parsed = await readJsonFile(fpath, { log });
      for (const rec of Array.isArray(parsed) ? parsed : []) {
        const day = fitbitLocal((rec as { dateTime?: unknown })?.dateTime)?.slice(0, 10);
        const n = positiveNumber((rec as { value?: unknown })?.value);
        if (day && n !== undefined) {
          steps.set(day, (steps.get(day) ?? 0) + n);
        }
      }
    }

    const resting = new Map<string, number>();
    for (const fpath of files.resting) {
      const parsed = await readJsonFile(fpath, { log });
      for (const rec of Array.isArray(parsed) ? parsed : []) {
        const value = (rec as { value?: { date?: unknown; value?: unknown } })?.value;
        const day = fitbitLocal(value?.date ?? (rec as { dateTime?: unknown })?.dateTime)?.slice(0, 10);
        // A day the tracker was not worn reads 0 (or null): not a reading.
        const bpm = positiveNumber(value?.value);
        if (day && bpm !== undefined) {
          resting.set(day, bpm);
        }
      }
    }

    const heart = new Map<string, HeartDay>();
    for (const fpath of files.heart) {
      const parsed = await readJsonFile(fpath, { log });
      for (const rec of Array.isArray(parsed) ? parsed : []) {
        const day = fitbitLocal((rec as { dateTime?: unknown })?.dateTime)?.slice(0, 10);
        const bpm = positiveNumber((rec as { value?: { bpm?: unknown } })?.value?.bpm);
        if (day && bpm !== undefined) {
          const d = heart.get(day) ?? { sum: 0, count: 0 };
          heart.set(day, d);
          d.min = d.min === undefined ? bpm : Math.min(d.min, bpm);
          d.max = d.max === undefined ? bpm : Math.max(d.max, bpm);
          d.sum += bpm;
          d.count++;
        }
      }
    }

    for (const [day, total] of [...steps].sort(([a], [b]) => a.localeCompare(b))) {
      const title = `Steps on ${day}: ${Math.round(total)}`;
      this.pushDaily(`fitbit:steps:${day}`, day, title, { Steps: Math.round(total) }, params);
    }

    for (const [day, bpm] of [...resting].sort(([a], [b]) => a.localeCompare(b))) {
      const title = `Resting heart rate on ${day}: ${bpm}`;
      this.pushDaily(`fitbit:resting_heart_rate:${day}`, day, title, { 'Resting Heart Rate': bpm }, params);
    }

    for (const [day, d] of [...heart].sort(([a], [b]) => a.localeCompare(b))) {
      this.pushDaily(
        `fitbit:heart_rate:${day}`,
        day,
        `Heart rate on ${day}`,
        {
          'Average Heart Rate': Math.round(d.sum / d.count),
          'Min Heart Rate': d.min,
          'Max Heart Rate': d.max,
        },
        params,
      );
    }
  }

  private pushExercise(rec: ExerciseRecord, base: string, index: number, params: ImportParams): void {
    if (!rec || typeof rec !== 'object') {
      return;
    }

    const ts = fitbitDate(rec.startTime);
    if (!ts || !timeframeContains(params.timeframe, ts)) {
      return;
    }

    const duration = positiveNumber(rec.duration);
    const distance =
      typeof rec.distance === 'number' && Number.isFinite(rec.distance) ? rec.distance : undefined;
    // Typed fields from untyped JSON: a number here would throw in toLowerCase
    // now, or in Buffer.from when the content is read.
    const unit = typeof rec.distanceUnit === 'string' ? rec.distanceUnit : undefined;
    const activity = typeof rec.activityName === 'string' && rec.activityName ? rec.activityName : undefined;
    const factor = KM_PER_FITBIT_UNIT[(unit ?? '').toLowerCase()];
    const name = activity ?? 'Workout';

    params.pipeline.push({
      item: {
        id: `fitbit:exercise:${rec.logId ?? `${base}:${index}`}`,
        classification: 'workout',
        timestamp: ts,
        timespanEnd: duration !== undefined ? new Date(ts.getTime() + duration) : undefined,
        content: textContent('workout.txt', name),
        metadata: {
          Title: name,
          'Activity Type': activity,
          'Duration (min)': duration !== undefined ? Math.round(duration / 6000) / 10 : undefined,
          'Distance (km)':
            distance !== undefined && factor !== undefined
              ? Math.round(distance * factor * 1000) / 1000
              : undefined,
          Distance:
            distance !== undefined && factor === undefined ? `${distance} ${unit ?? ''}`.trim() : undefined,
          Calories: positiveNumber(rec.calories),
          Steps: positiveNumber(rec.steps),
          'Average Heart Rate': positiveNumber(rec.averageHeartRate),
          Source: 'Fitbit',
        },
      },
    });
  }

  /** One 'observation' for a day, at its local midnight like Google Fit's daily rows. */
  private pushDaily(
    id: string,
    day: string,
    title: string,
    values: Record<string, number | undefined>,
    params: ImportParams,
  ): void {
    const ts = new Date(`${day}T00:00:00`);
    if (isNaN(ts.getTime()) || !timeframeContains(params.timeframe, ts)) {
      return;
    }

    params.pipeline.push({
      item: {
        id,
        classification: 'observation',
        timestamp: ts,
        content: textContent('observation.txt', title),
        metadata: { Title: title, Date: day, ...values, Source: 'Fitbit' },
      },
    });
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    } // strip UTF-8 BOM

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    if (!Array.isArray(parsed)) {
      return;
    }

    parsed.forEach((rec, index) => {
      try {
        this.pushRecord(rec as SleepRecord, base, index, params);
      } catch (e) {
        params.log?.('error', `Failed to import sleep record in ${base}`, { error: (e as Error).message });
      }
    });
  }

  private pushRecord(rec: SleepRecord, base: string, index: number, params: ImportParams): void {
    if (!rec || typeof rec !== 'object') {
      return;
    }

    let ts: Date | undefined;
    if (rec.startTime) {
      const d = new Date(rec.startTime);
      if (!isNaN(d.getTime())) {
        ts = d;
      }
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    let tsEnd: Date | undefined;
    if (rec.endTime) {
      const d = new Date(rec.endTime);
      if (!isNaN(d.getTime())) {
        tsEnd = d;
      }
    }

    const minutesAsleep = typeof rec.minutesAsleep === 'number' ? rec.minutesAsleep : undefined;
    const minutesAwake = typeof rec.minutesAwake === 'number' ? rec.minutesAwake : undefined;
    const efficiency = typeof rec.efficiency === 'number' ? rec.efficiency : undefined;

    const summary = `Slept ${minutesAsleep ?? '?'} min` + (rec.dateOfSleep ? ` on ${rec.dateOfSleep}` : '');

    params.pipeline.push({
      item: {
        // Prefer Fitbit's own logId — a genuinely unique per-record id — and
        // fall back to a source-file + per-file row index only when it's
        // missing. Without either, hashItem's fallback hash is
        // dataSource+classification+ISO(timestamp) alone (content.filename is
        // the constant 'sleep.txt'), so two sleep entries sharing a recorded
        // start second (multi-source exports, e.g. a paired Fitbit + phone
        // app both logging sleep) would collide under the staging table's ON
        // CONFLICT and one would be silently dropped.
        id: `fitbit:sleep:${rec.logId ?? `${base}:${index}`}`,
        classification: 'sleep',
        timestamp: ts,
        timespanEnd: tsEnd,
        content: textContent('sleep.txt', summary),
        metadata: {
          Title: summary,
          'Minutes Asleep': minutesAsleep,
          'Minutes Awake': minutesAwake,
          Efficiency: efficiency,
          'Duration (min)': typeof rec.duration === 'number' ? rec.duration / 60000 : undefined,
          'Date Of Sleep': rec.dateOfSleep || undefined,
          Source: 'Fitbit',
        },
      },
    });
  }
}

registerDataSource({
  name: 'fitbit',
  title: 'Fitbit',
  icon: '',
  description:
    'Sleep, workouts, steps and heart rate from a Fitbit export (via Google Takeout Fitbit/ JSON).',
  newFileImporter: () => new FitbitFileImporter(),
});

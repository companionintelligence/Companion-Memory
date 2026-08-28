/* Google Fit — a Google Takeout "Fit" export.
   Two streams are imported:
     - "Daily activity metrics/YYYY-MM-DD.csv": 96 quarter-hour rows whose "Start
       time"/"End time" are time-of-day-with-offset (the calendar date lives in the
       filename). Most rows are blank; we aggregate the day into ONE 'observation'
       (steps/calories/distance summed, heart rate averaged). Header columns vary
       between exports (extra *_duration columns), so rows are read BY HEADER NAME.
     - "All Sessions/<start>_<ACTIVITY>.json" (and the parallel "Activities/*.tcx"):
       one logged workout each → a 'workout' item. The .json and .tcx for the same
       workout agree on the local start time IN THEIR FILENAME, and that — not the
       TCX <Id> — is what both sides key on, so the pair collapses. See
       startKeyFromFilename for why <Id> is unusable.
       The whole session is the unit: a TCX's repeated <Activity> blocks are just
       its stop-go segments, and are not imported separately.
     - The TCX's <Trackpoint><Position> fixes → one 'location' item each, timed
       by that trackpoint's own <Time>. These are the export's only coordinates
       (the session JSON has no geometry), so they are read even when the
       workout itself deduped away against its JSON twin.
*/
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

const DAILY_DIR = 'daily activity metrics';
const SESSIONS_DIR = 'all sessions';
const ACTIVITIES_DIR = 'activities';
// Daily-metrics filenames are bare ISO dates: 2018-04-03.csv
const DAILY_CSV = /^(\d{4}-\d{2}-\d{2})\.csv$/i;
const SESSION_JSON = /\.json$/i;
const SESSION_TCX = /\.tcx$/i;
// Session JSON / TCX filenames both LEAD with the local ISO start (':' rewritten
// to '_'), then diverge:
//   2019-09-04T18_30_00-07_00_FENCING.json
//   2019-09-04T18_30_00-07_00_PT1H5M_Fencing.tcx
// Only the leading timestamp is matched, never the tail: Takeout clips long
// names, so the trailing sport arrives truncated ("Walkin", "Walking,R").
const FILENAME_START = /^(\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}_\d{2}))/;

function num(v: string | undefined): number | undefined {
  if (v == null || v === '') {
    return undefined;
  }

  const n = Number(v);

  return Number.isFinite(n) ? n : undefined;
}

// "1234.5" → "1,235" style integer formatting for the title.
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

interface SessionJSON {
  fitnessActivity?: string;
  startTime?: string;
  endTime?: string;
  duration?: string;
  aggregate?: Array<{ metricName?: string; intValue?: number; floatValue?: number }>;
}

function aggValue(s: SessionJSON, metricName: string): number | undefined {
  const a = s.aggregate?.find((x) => x.metricName === metricName);
  if (!a) {
    return undefined;
  }

  return a.intValue ?? a.floatValue;
}

function titleCase(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Takeout writes the same instant two ways — a session JSON says "…T01:30:00Z"
// where its own TCX says "…T01:30:00.000Z" — so every key goes through Date to
// land on one canonical spelling. Without this the pair never compares equal.
function normalizeInstant(s: string | undefined): string | undefined {
  if (!s) {
    return undefined;
  }

  const d = new Date(s);

  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

// The dedupe key: the workout's start instant, read off the FILENAME.
// The TCX <Id> cannot serve here. It is the first trackpoint's time, so it
// drifts from the session start by seconds; and in a multi-<Activity> file it
// belongs to whichever segment leads the document, which can be hours or days
// from the session start. The filename is the one thing both folders agree on.
function startKeyFromFilename(base: string): string | undefined {
  const m = FILENAME_START.exec(base);
  if (!m) {
    return undefined;
  }

  return normalizeInstant(m[1].replace(/_/g, ':'));
}

// Pull the Sport / first <Id> timestamp out of a TCX without a full XML parse.
// A file often carries several <Activity> blocks, but they are only the stop-go
// segments of one session — a walk paused at a crossing is still one walk — so
// they are deliberately not enumerated: the session is the unit we import.
// `start` is a fallback for files the filename can't date; see startKeyFromFilename.
function parseTcx(text: string): { activity?: string; start?: string } {
  const sport = /<Activity[^>]*\bSport="([^"]*)"/i.exec(text);
  const id = /<Id>([^<]*)<\/Id>/i.exec(text);

  return { activity: sport?.[1], start: id?.[1] };
}

/**
 * A usable position fix pulled from a TCX. The schema puts a <Position> in
 * exactly two places, and both land here:
 *   - <Trackpoint> — a recorded point on the track that got a satellite fix;
 *   - <CoursePoint> — a named waypoint on a planned course (Summit, Water, a
 *     turn), which additionally carries a name, a type and free notes.
 */
interface TcxFix {
  time: string;
  lat: number;
  lon: number;
  altitude?: number;
  name?: string; // <CoursePoint><Name>
  pointType?: string; // <CoursePoint><PointType>
  notes?: string; // <CoursePoint><Notes>
  course?: string; // the enclosing <Course>'s own <Name>
}

/** Reports a <Position> we could not use, for the job's drop ledger. */
type DropFn = (reason: string, detail?: string) => void;

const TRACKPOINT_RE = /<Trackpoint\b[^>]*>([\s\S]*?)<\/Trackpoint>/gi;
// `<Course\b` cannot match `<CoursePoint` (no word boundary between "Course"
// and "P"), and `</Course>` cannot match `</CoursePoint>` (the '>' must follow
// "Course"), so the outer scan never swallows the inner elements.
const COURSE_RE = /<Course\b[^>]*>([\s\S]*?)<\/Course>/gi;
const COURSEPOINT_RE = /<CoursePoint\b[^>]*>([\s\S]*?)<\/CoursePoint>/gi;
const TP_TIME = /<Time>([^<]*)<\/Time>/i;
const TP_LAT = /<LatitudeDegrees>([^<]*)<\/LatitudeDegrees>/i;
const TP_LON = /<LongitudeDegrees>([^<]*)<\/LongitudeDegrees>/i;
const TP_ALT = /<AltitudeMeters>([^<]*)<\/AltitudeMeters>/i;
const CP_NAME = /<Name>([^<]*)<\/Name>/i;
const CP_TYPE = /<PointType>([^<]*)<\/PointType>/i;
const CP_NOTES = /<Notes>([^<]*)<\/Notes>/i;

// The captured text of one tag, trimmed, or undefined when the tag is absent or
// empty. Going through num() matters: `Number('')` is 0, so an empty
// <LatitudeDegrees/> read naively becomes a fix on the equator.
function tagNum(body: string, re: RegExp): number | undefined {
  return num(re.exec(body)?.[1]?.trim());
}

function tagStr(body: string, re: RegExp): string | undefined {
  return re.exec(body)?.[1]?.trim() || undefined;
}

// The <Time> + <Position> common to both element types. Returns undefined —
// and reports why — when the block carries a <Position> that isn't a fix.
function fixFrom(body: string, label: string, drop?: DropFn): TcxFix | undefined {
  const time = tagStr(body, TP_TIME);
  const lat = tagNum(body, TP_LAT);
  const lon = tagNum(body, TP_LON);
  // A <Position> missing either coordinate is not a fix — drop it rather than
  // emit a point at 0,0 off the coast of Africa.
  if (lat == null || lon == null) {
    drop?.('position_without_fix', label);

    return undefined;
  }

  if (!time) {
    drop?.('position_without_time', label);

    return undefined;
  }

  return { time, lat, lon, altitude: tagNum(body, TP_ALT) };
}

/**
 * Every <Trackpoint> carrying a <Position>, in document order. A TCX logs a
 * point every few seconds but only some of them hold a satellite fix — on a
 * six-year export ~3.5% do (20,702 of 598,367) — so the substring test rejects
 * the overwhelming majority before any of the field regexes run.
 *
 * These coordinates are the export's only geometry: the parallel session JSON
 * carries aggregates and no coordinates at all.
 */
function parseTrackpoints(text: string, drop?: DropFn): TcxFix[] {
  const out: TcxFix[] = [];
  TRACKPOINT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRACKPOINT_RE.exec(text)) !== null) {
    const body = m[1];
    // Not a drop: the great majority of trackpoints simply never got a fix.
    if (!body.includes('<Position>')) {
      continue;
    }

    const fix = fixFrom(body, 'trackpoint', drop);
    if (fix) {
      out.push(fix);
    }
  }

  return out;
}

/**
 * Every <CoursePoint> in the file's <Courses> section — the named waypoints of a
 * planned route. The schema makes <Name>, <Time> and <Position> mandatory here,
 * so unlike a trackpoint a course point without coordinates is malformed rather
 * than ordinary, and is reported to the drop ledger.
 *
 * Google Fit's own exports carry no courses today; this exists so a TCX from a
 * device that does write them (a Garmin route, anything round-tripped through
 * route-planning software) does not quietly lose its waypoints.
 */
function parseCoursePoints(text: string, drop?: DropFn): TcxFix[] {
  const out: TcxFix[] = [];
  if (!text.includes('<CoursePoint')) {
    return out;
  }

  COURSE_RE.lastIndex = 0;
  let c: RegExpExecArray | null;
  while ((c = COURSE_RE.exec(text)) !== null) {
    const courseBody = c[1];
    // Course_t orders <Name> before any <CoursePoint>, so the course's own name
    // is the first <Name> in the text preceding the first waypoint. Reading it
    // from the whole block would pick up a waypoint's name on a nameless course.
    const firstPoint = courseBody.search(/<CoursePoint\b/i);
    const course = tagStr(firstPoint >= 0 ? courseBody.slice(0, firstPoint) : courseBody, CP_NAME);
    COURSEPOINT_RE.lastIndex = 0;
    let p: RegExpExecArray | null;
    while ((p = COURSEPOINT_RE.exec(courseBody)) !== null) {
      const body = p[1];
      const name = tagStr(body, CP_NAME);
      const fix = fixFrom(body, name ? `course point "${name}"` : 'course point', drop);
      if (!fix) {
        continue;
      }

      fix.name = name;
      fix.pointType = tagStr(body, CP_TYPE);
      fix.notes = tagStr(body, CP_NOTES);
      fix.course = course;
      out.push(fix);
    }
  }

  return out;
}

export class GoogleFitFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
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
      const base = path.basename(root);
      // A bare YYYY-MM-DD.csv whose parent is the daily-metrics folder.
      if (DAILY_CSV.test(base) && path.basename(path.dirname(root)).toLowerCase() === DAILY_DIR) {
        return { confidence: 0.9 };
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      // The Fit root, or any directory whose tree contains the Fit subfolders.
      if (await this.findFitRoot(root)) {
        return { confidence: 0.95 };
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  /**
   * Find a directory that has the Google Fit signature subfolders. Accepts the
   * Fit folder itself, a Takeout root directly containing it, or a
   * daily-metrics folder — checking only `root`'s own immediate children, not
   * an unbounded recursive walk of the whole subtree below it.
   *
   * A prior version, on finding none of these at `root`, recursed into EVERY
   * child directory (`Drive/`, `Photos/`, …) hunting for a `Fit` folder or the
   * daily/sessions names arbitrarily deep, and returned confidence for `root`
   * itself when it found one — so a folder that merely happened to be named
   * "Fit" anywhere inside an unrelated multi-GB export claimed the entire tree
   * above it. Real Takeout data ships `Fit/` as a direct child of the export
   * root, which this single-level check already covers; anything deeper is
   * left for the recognition system's own `descend` walk (registry.ts) to
   * find and attribute correctly when it visits that directory itself.
   */
  private async findFitRoot(root: string): Promise<string | undefined> {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return undefined;
    }

    const lower = names.map((n) => n.toLowerCase());
    if (lower.includes(DAILY_DIR) || lower.includes(SESSIONS_DIR)) {
      return root;
    }

    if (path.basename(root).toLowerCase() === DAILY_DIR) {
      return root;
    }

    for (const n of names) {
      if (n.toLowerCase() !== 'fit') {
        continue;
      }

      const p = path.join(root, n);
      try {
        if ((await stat(p)).isDirectory()) {
          return p;
        }
      } catch {
        /* ignore */
      }
    }

    return undefined;
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
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
      if (DAILY_CSV.test(path.basename(root))) {
        await this.processDailyCsv(root, params);
      }

      return;
    }

    const fitRoot = (await this.findFitRoot(root)) || root;
    // Daily metrics.
    const dailyDir = this.childDir(fitRoot, DAILY_DIR);
    if (dailyDir) {
      let names: string[];
      try {
        names = fs.readdirSync(dailyDir).sort();
      } catch {
        names = [];
      }

      for (const n of names) {
        if (DAILY_CSV.test(n)) {
          await this.processDailyCsv(path.join(dailyDir, n), params);
        }
      }
    }

    // Workout sessions. Prefer the rich JSON; fall back to the parallel TCX for
    // any workout the JSON folder is missing (keyed on the shared start time).
    const seen = new Set<string>();
    const seenPositions = new Set<string>();
    const sessionsDir = this.childDir(fitRoot, SESSIONS_DIR);
    if (sessionsDir) {
      let names: string[];
      try {
        names = fs.readdirSync(sessionsDir).sort();
      } catch {
        names = [];
      }

      for (const n of names) {
        if (SESSION_JSON.test(n)) {
          await this.processSessionJson(path.join(sessionsDir, n), params, seen);
        }
      }
    }

    const activitiesDir = this.childDir(fitRoot, ACTIVITIES_DIR);
    if (activitiesDir) {
      let names: string[];
      try {
        names = fs.readdirSync(activitiesDir).sort();
      } catch {
        names = [];
      }

      for (const n of names) {
        if (SESSION_TCX.test(n)) {
          await this.processSessionTcx(path.join(activitiesDir, n), params, seen, seenPositions);
        }
      }
    }
  }

  private childDir(root: string, lowerName: string): string | undefined {
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return undefined;
    }

    const match = names.find((n) => n.toLowerCase() === lowerName);
    if (!match) {
      return undefined;
    }

    const p = path.join(root, match);
    try {
      return fs.statSync(p).isDirectory() ? p : undefined;
    } catch {
      return undefined;
    }
  }

  // One day's quarter-hour rows → a single daily 'observation'.
  private async processDailyCsv(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    const m = DAILY_CSV.exec(base);
    if (!m) {
      return;
    }

    const date = m[1]; // YYYY-MM-DD
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    if (raw.charCodeAt(0) === 0xfeff) {
      raw = raw.slice(1);
    }

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    let steps = 0,
      calories = 0,
      distance = 0,
      moveMin = 0;
    let hrSum = 0,
      hrCount = 0,
      hrMax: number | undefined,
      hrMin: number | undefined;
    let hasData = false;
    for (const r of rows) {
      const s = num(r['Step count']);
      if (s != null) {
        steps += s;
        hasData = true;
      }

      const c = num(r['Calories (kcal)']);
      if (c != null) {
        calories += c;
        hasData = true;
      }

      const d = num(r['Distance (m)']);
      if (d != null) {
        distance += d;
        hasData = true;
      }

      const mm = num(r['Move Minutes count']);
      if (mm != null) {
        moveMin += mm;
        hasData = true;
      }

      const avg = num(r['Average heart rate (bpm)']);
      if (avg != null) {
        hrSum += avg;
        hrCount++;
        hasData = true;
      }

      const mx = num(r['Max heart rate (bpm)']);
      if (mx != null) {
        hrMax = hrMax == null ? mx : Math.max(hrMax, mx);
      }

      const mn = num(r['Min heart rate (bpm)']);
      if (mn != null) {
        hrMin = hrMin == null ? mn : Math.min(hrMin, mn);
      }
    }

    // A day of all-blank rows carries no signal; skip it.
    if (!hasData) {
      return;
    }

    // Date is local midnight of the file's day; the per-row offset is dropped.
    let ts: Date | undefined = new Date(`${date}T00:00:00`);
    if (isNaN(ts.getTime())) {
      ts = undefined;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const avgHr = hrCount ? hrSum / hrCount : undefined;
    const title = steps > 0 ? `Activity ${date} (${fmtInt(steps)} steps)` : `Activity ${date}`;

    params.pipeline.push({
      item: {
        id: `google_fit:${date}`,
        classification: 'observation',
        timestamp: ts,
        content: { filename: 'activity.txt', mediaType: 'text/plain', data: async () => Buffer.from(title) },
        metadata: {
          Title: title,
          Source: 'Google Fit',
          Date: date,
          Steps: steps > 0 ? Math.round(steps) : undefined,
          Calories: calories > 0 ? Math.round(calories) : undefined,
          Distance: distance > 0 ? Math.round(distance) : undefined,
          'Move Minutes': moveMin > 0 ? Math.round(moveMin) : undefined,
          HeartRate: avgHr != null ? Math.round(avgHr) : undefined,
          'Max Heart Rate': hrMax,
          'Min Heart Rate': hrMin,
        },
      },
    });
  }

  private async processSessionJson(fpath: string, params: ImportParams, seen: Set<string>): Promise<void> {
    const base = path.basename(fpath);
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    let s: SessionJSON;
    try {
      s = JSON.parse(raw);
    } catch {
      return;
    }

    const start = s.startTime;
    if (!start) {
      return;
    }

    let ts: Date | undefined = new Date(start);
    if (isNaN(ts.getTime())) {
      ts = undefined;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const key = normalizeInstant(start) ?? start;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    // The TCX side keys off its filename, so register that spelling too — the
    // pair still collapses even if a session's filename and startTime disagree.
    const fileKey = startKeyFromFilename(base);
    if (fileKey) {
      seen.add(fileKey);
    }

    const activity = s.fitnessActivity || 'workout';
    const title = titleCase(activity);
    const steps = aggValue(s, 'com.google.step_count.delta');
    const calories = aggValue(s, 'com.google.calories.expended');
    const distance = aggValue(s, 'com.google.distance.delta');
    let end: Date | undefined = s.endTime ? new Date(s.endTime) : undefined;
    if (end && isNaN(end.getTime())) {
      end = undefined;
    }

    params.pipeline.push({
      item: {
        id: `google_fit:session:${key}`,
        classification: 'workout',
        timestamp: ts,
        timespanEnd: end,
        content: { filename: 'workout.txt', mediaType: 'text/plain', data: async () => Buffer.from(title) },
        metadata: {
          Title: title,
          'Activity Type': activity,
          Source: 'Google Fit',
          Duration: s.duration || undefined,
          Steps: steps != null ? Math.round(steps) : undefined,
          Calories: calories != null ? Math.round(calories) : undefined,
          Distance: distance != null ? Math.round(distance) : undefined,
        },
      },
    });
  }

  private async processSessionTcx(
    fpath: string,
    params: ImportParams,
    seen: Set<string>,
    seenPositions: Set<string>,
  ): Promise<void> {
    const base = path.basename(fpath);
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    const { activity, start } = parseTcx(raw);
    const fileKey = startKeyFromFilename(base);

    // Position fixes come FIRST and unconditionally: the coordinates exist only
    // in this file, so they must be emitted even when the workout itself is
    // about to be skipped as already covered by its session-JSON twin.
    const drop: DropFn = (reason, detail) =>
      params.pipeline.drop?.(reason, detail ? `${base}: ${detail}` : base);
    for (const fix of parseTrackpoints(raw, drop)) {
      this.pushPosition(fix, 'position', activity, params, seenPositions);
    }

    for (const fix of parseCoursePoints(raw, drop)) {
      this.pushPosition(fix, 'coursepoint', activity, params, seenPositions);
    }

    // Only fall back to the leading <Id> when the filename carried no usable
    // start — an unnamed or renamed file, not the normal Takeout layout.
    const key = fileKey ?? normalizeInstant(start);
    if (!key) {
      return;
    }

    let ts: Date | undefined = new Date(key);
    if (isNaN(ts.getTime())) {
      ts = undefined;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    const title = titleCase(activity || 'workout');
    params.pipeline.push({
      item: {
        id: `google_fit:session:${key}`,
        classification: 'workout',
        timestamp: ts,
        content: { filename: 'workout.txt', mediaType: 'text/plain', data: async () => Buffer.from(title) },
        metadata: {
          Title: title,
          'Activity Type': activity || undefined,
          Source: 'Google Fit',
        },
      },
    });
  }

  /**
   * One 'location' item per fix, from a trackpoint or a course point. That
   * classification is what the CI-Server mapping resolves to `location.fix`,
   * which routes both to the position table ONLY — neither lands as a timeline
   * event (see mapping.ts destinationsFor). A named waypoint is a point on a
   * route, not somewhere the user was, so it stays 'location' rather than
   * becoming a 'place' that would also mint an event.
   *
   * The timestamp is the point's own <Time>, never the session start, so a
   * track keeps its real shape in time.
   */
  private pushPosition(
    fix: TcxFix,
    kind: 'position' | 'coursepoint',
    activity: string | undefined,
    params: ImportParams,
    seen: Set<string>,
  ): void {
    const iso = normalizeInstant(fix.time);
    if (!iso) {
      params.pipeline.drop?.('position_without_time', fix.name ?? kind);

      return;
    }

    const ts = new Date(iso);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    // Keyed on the fix's instant, in a namespace per kind so a waypoint and a
    // track fix recorded at the same moment stay distinct. Re-importing the
    // same export is idempotent; sub-second precision separates real fixes.
    const id = `google_fit:${kind}:${iso}`;
    if (seen.has(id)) {
      return;
    }

    seen.add(id);

    const coords = `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}`;
    const title = fix.name || coords;
    params.pipeline.push({
      item: {
        id,
        classification: 'location',
        timestamp: ts,
        location: { latitude: fix.lat, longitude: fix.lon },
        content: { filename: 'position.txt', mediaType: 'text/plain', data: async () => Buffer.from(title) },
        metadata: {
          Title: title,
          Source: 'Google Fit',
          'Activity Type': activity || undefined,
          // `Elevation` is the key toPositionInput reads for altitudeMeters —
          // same spelling gpx.ts uses, so both sources map identically.
          Elevation: fix.altitude,
          // `Name` steers the mapping's location.fix naming (it prefers m.Name
          // over the filename), so a waypoint reaches CI-Server as "Summit"
          // rather than as bare coordinates. Undefined for trackpoints.
          Name: fix.name,
          'Point Type': fix.pointType,
          Notes: fix.notes,
          Course: fix.course,
        },
      },
    });
  }
}

registerDataSource({
  name: 'google_fit',
  title: 'Google Fit',
  icon: '',
  description: 'Daily activity metrics and logged workout sessions from a Google Takeout Fit export.',
  newFileImporter: () => new GoogleFitFileImporter(),
});

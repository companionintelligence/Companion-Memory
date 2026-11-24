/* Withings — body measurement CSV export (weight.csv and related CSVs).
   A Withings export is a set of CSVs (weight.csv, height.csv, blood_pressure.csv,
   activities.csv, ...). Every file has a leading "Date" column; we emit one
   'observation' per row, carrying every non-empty column as metadata. The
   signature is generic (*.csv) so recognition sniffs the header to avoid
   false-matching other CSV importers. */
import fs from 'node:fs';
import path from 'node:path';

import { parseCSV, parseCSVRows } from './csv';
import { CsvExportImporter, type CsvExportSpec } from './csvImporter';
import { registerDataSource } from './registry';
import { readHead, stripBom } from './sniff';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains, timeframeIsEmpty } from './timeline';

// Extract the header line from raw CSV text (BOM already stripped by caller).
function headerLine(text: string): string {
  const nl = text.indexOf('\n');

  return (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, '');
}

// A statistic ABOUT a measurement is not a measurement.
//
// Google Fit's aggregate `Daily activity metrics.csv` begins with "Date," and
// carries "Average weight (kg)", "Max weight (kg)" and "Min weight (kg)" — which
// is all the old `header.includes('(kg)')` needed. A Google Takeout's Fit data
// therefore staged as 1,661 rows of `data_source='withings'` carrying
// `Source: "Withings"`, and Withings appeared in the run's services as though
// the user had exported from it. Withings names its columns outright
// ("Weight (kg)", "Fat mass (kg)"); no Withings export prefixes one with an
// aggregate.
const AGGREGATE_COLUMN = /^(average|max|min|total|mean|median)\b/i;

function isMeasurementColumn(column: string): boolean {
  const name = column.trim();

  if (AGGREGATE_COLUMN.test(name)) {
    return false;
  }

  // Withings writes the unit into the column name: "Weight (kg)", "Weight (lb)".
  // A bare "Weight" is another app's column. MyFitnessPal's measurement export
  // is "Date,Weight", and counting it let Withings claim that whole export and
  // import every one of its CSVs as Withings measurements.
  return name.includes('(kg)') || /^"?weight\s*\(/i.test(name);
}

// A Withings CSV header begins with "Date," and carries a body-measurement
// column with its unit, such as "Weight (kg)". This is specific enough to avoid
// matching other CSV importers (e.g. Netflix's "Start Time,...").
function headerLooksLikeWithings(header: string): boolean {
  if (!header.startsWith('Date,') && header.trim() !== 'Date') {
    return false;
  }

  return header.split(',').some(isMeasurementColumn);
}

// Read the first ~4KB and inspect the CSV header row.
async function sniffHeader(fpath: string): Promise<string | undefined> {
  const head = await readHead(fpath);

  return head == null ? undefined : headerLine(stripBom(head));
}

async function csvMatches(fpath: string): Promise<boolean> {
  const header = await sniffHeader(fpath);

  return header !== undefined && headerLooksLikeWithings(header);
}

// Parse a Withings "YYYY-MM-DD HH:MM:SS" date (treated as UTC). Returns
// undefined for anything unparseable.
function parseWithingsDate(raw: string): Date | undefined {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  // "2024-01-15 08:30:00" -> ISO; also tolerate values already containing 'T'/'Z'.
  let candidate = trimmed;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(candidate)) {
    candidate = candidate.replace(' ', 'T') + 'Z';
  }

  let d = new Date(candidate);
  if (isNaN(d.getTime())) {
    d = new Date(trimmed);
  }

  return isNaN(d.getTime()) ? undefined : d;
}

export class WithingsFileImporter extends CsvExportImporter {
  protected readonly spec: CsvExportSpec = {
    isNamed: (name) => name === 'weight.csv',
    headerMatches: (fpath) => csvMatches(fpath),
    confidence: { named: 0.95, sniffed: 0.85 },
    importInDir: 'all-csv',
  };

  protected async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    // The per-reading raw_*.csv samples, often the export's largest files:
    // counted as dropped, by file, without reading them.
    if (/^raw_.+\.csv$/i.test(base)) {
      params.pipeline.drop?.('unread_export_file', base);

      return;
    }

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

    if (readNamedExportFile(base, raw, params)) {
      return;
    }

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    if (!rows.length) {
      return;
    }

    // Only process files that carry a Date column (every Withings CSV does).
    if (!('Date' in rows[0])) {
      return;
    }

    rows.forEach((row, i) => {
      try {
        this.pushRow(row, base, i, params);
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    });
  }

  private pushRow(row: Record<string, string>, base: string, index: number, params: ImportParams): void {
    const ts = parseWithingsDate(row['Date'] || '');
    // An undated row has no timestamp to test; timeframeContains() returns true
    // for an undefined ts (platform convention), which would leak malformed rows
    // through an active since/until filter. Drop undated rows when a timeframe is
    // actually set, but keep them when no filter is requested.
    if (!ts && !timeframeIsEmpty(params.timeframe)) {
      return;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    // Carry every non-empty column as metadata; numeric columns become numbers.
    const metadata: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'Date') {
        continue;
      }

      if (value === undefined || value === '') {
        continue;
      }

      const num = Number(value);
      // Coerce to a number only when the value round-trips losslessly. This keeps
      // genuine floats numeric (e.g. "82.4") while preserving string-ID columns
      // such as zero-padded "007" (which would otherwise become 7). Number('1,234')
      // is already NaN, so thousands-separated values stay strings.
      const numeric = value !== '' && !isNaN(num) && /^[-+]?[0-9.]+$/.test(value) && String(num) === value;
      metadata[key] = numeric ? num : value;
    }

    metadata.File = base;
    metadata.Source = 'Withings';
    // Without a title key, titleFor() falls back to the constant 'observation.txt'
    // filename. Derive a label from the file + row Date so each measurement reads
    // e.g. "weight — 2024-01-15 08:30:00".
    const measure = base.replace(/\.csv$/i, '').replace(/[_-]+/g, ' ');
    metadata.Title = row['Date'] ? `${measure} — ${row['Date']}` : measure;

    // Human-readable text body summarizing the measurement.
    const summaryParts = Object.entries(row)
      .filter(([k, v]) => k !== 'Date' && v !== '')
      .map(([k, v]) => `${k}: ${v}`);
    const text = [row['Date'] ? `Date: ${row['Date']}` : '', ...summaryParts].filter(Boolean).join('\n');

    params.pipeline.push({
      item: {
        // Stable natural key: source file + raw Date + per-file row index. The
        // file name and Date alone collide across CSVs synced at the same instant
        // (weight.csv vs blood_pressure.csv) and undated rows share an empty Date,
        // so the parse-order index disambiguates without depending on timestamp.
        id: `withings:${base}:${(row['Date'] || '').trim()}:${index}`,
        classification: 'observation',
        timestamp: ts,
        content: textContent('observation.txt', text),
        metadata,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// The export's files that have no `Date` column. Withings translates the first
// headers into the account's language (a German sleep.csv starts
// `von,bis,"leicht (s)"`), so these are read by file name and column position.
// ---------------------------------------------------------------------------

/** A cell as a number, or undefined when blank or not numeric. */
function cellNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : undefined;
}

/** Every non-empty cell keyed by its header, numbers as numbers. */
function cellsAsMetadata(header: string[], row: string[], skip: number[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  header.forEach((key, i) => {
    const value = (row[i] ?? '').trim();
    if (skip.includes(i) || !key || value === '') {
      return;
    }

    out[key] = cellNumber(value) ?? value;
  });

  return out;
}

/** Undated rows are kept only when no timeframe is set, as for the Date-column files. */
function inTimeframe(params: ImportParams, ts: Date | undefined): boolean {
  if (!ts && !timeframeIsEmpty(params.timeframe)) {
    return false;
  }

  return timeframeContains(params.timeframe, ts);
}

/**
 * sleep.csv: one night per row. Columns 0 and 1 are the start and end, 2 to 5
 * the seconds of light, deep, REM and awake. `Minutes Asleep` is what the daily
 * sleep total adds up.
 */
function readSleep(base: string, rows: string[][], params: ImportParams): void {
  const [header, ...body] = rows;
  body.forEach((row, index) => {
    const start = parseWithingsDate(row[0] ?? '');
    if (!inTimeframe(params, start)) {
      return;
    }

    const staged = [2, 3, 4].map((i) => cellNumber(row[i]) ?? 0).reduce((a, b) => a + b, 0);
    const awake = cellNumber(row[5]);
    const end = parseWithingsDate(row[1] ?? '');
    // Nights from before the device tracked stages have none, only the time
    // awake: count the night less that, rather than a night of no sleep.
    const inBed = start && end && end > start ? (end.getTime() - start.getTime()) / 1000 : undefined;
    const asleep =
      staged > 0
        ? Math.round(staged / 60)
        : inBed !== undefined
          ? Math.round(Math.max(0, inBed - (awake ?? 0)) / 60)
          : undefined;
    const night = (row[1] || row[0] || '').slice(0, 10);
    const title = `Slept ${asleep ?? '?'} min` + (night ? ` on ${night}` : '');

    params.pipeline.push({
      item: {
        id: `withings:${base}:${(row[0] ?? '').trim()}:${index}`,
        classification: 'sleep',
        timestamp: start,
        timespanEnd: end,
        content: textContent('sleep.txt', title),
        metadata: {
          ...cellsAsMetadata(header, row, [0, 1]),
          Title: title,
          'Minutes Asleep': asleep,
          'Minutes Awake': awake !== undefined ? Math.round(awake / 60) : undefined,
          File: base,
          Source: 'Withings',
        },
      },
    });
  });
}

interface WithingsActivityData {
  calories?: number;
  distance?: number;
  steps?: number;
  elevation?: number;
  hr_average?: number;
  hr_min?: number;
  hr_max?: number;
}

/** A positive number from the activity's Data JSON (Withings writes 0 for "not measured"). */
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * activities.csv: one workout per row. Columns: start, end, start and end as
 * edited by hand, time zone, activity type, a `Data` JSON of totals (distance
 * in metres), GPS JSON, last modified.
 */
function readActivities(base: string, rows: string[][], params: ImportParams): void {
  const [, ...body] = rows;
  body.forEach((row, index) => {
    // A time the person corrected by hand wins over the recorded one.
    const recordedStart = parseWithingsDate(row[0] ?? '');
    const recordedEnd = parseWithingsDate(row[1] ?? '');
    const manualStart = parseWithingsDate(row[2] ?? '');
    const manualEnd = parseWithingsDate(row[3] ?? '');
    const start = manualStart ?? recordedStart;
    if (!inTimeframe(params, start)) {
      return;
    }

    // A start moved by hand with no end moved alongside it keeps the recorded
    // length, rather than ending where the workout was before it moved.
    let end = manualEnd ?? recordedEnd;
    if (manualStart && !manualEnd && recordedStart && recordedEnd) {
      end = new Date(recordedEnd.getTime() + (manualStart.getTime() - recordedStart.getTime()));
    }

    if (start && end && end <= start) {
      end = undefined;
    }

    const type = (row[5] ?? '').trim();
    let data: WithingsActivityData = {};
    try {
      const parsed: unknown = JSON.parse(row[6] || '{}');
      if (parsed && typeof parsed === 'object') {
        data = parsed as WithingsActivityData;
      }
    } catch {
      // Keep the workout without its totals rather than drop it.
    }

    const metres = positive(data.distance);
    const title = type || 'Workout';

    params.pipeline.push({
      item: {
        id: `withings:${base}:${(row[0] ?? '').trim()}:${index}`,
        classification: 'workout',
        timestamp: start,
        timespanEnd: end,
        content: textContent('workout.txt', title),
        metadata: {
          Title: title,
          'Activity Type': type || undefined,
          'Distance (km)': metres !== undefined ? Math.round(metres) / 1000 : undefined,
          Calories: positive(data.calories),
          Steps: positive(data.steps),
          // Floors, as in Withings' API and aggregates_elevation.csv, not metres.
          'Floors Climbed': positive(data.elevation),
          'Average Heart Rate': positive(data.hr_average),
          'Min Heart Rate': positive(data.hr_min),
          'Max Heart Rate': positive(data.hr_max),
          'Time Zone': (row[4] ?? '').trim() || undefined,
          File: base,
          Source: 'Withings',
        },
      },
    });
  });
}

/** What each daily aggregates_<name>.csv holds, by <name>. */
const AGGREGATE_METRICS: Record<string, { key: string; scale?: number }> = {
  steps: { key: 'Steps' },
  distance: { key: 'Distance (km)', scale: 1 / 1000 },
  calories_earned: { key: 'Active Calories' },
  calories_passive: { key: 'Passive Calories' },
  elevation: { key: 'Floors Climbed' },
};

/** aggregates_<name>.csv: `date,value`, one day per row. */
function readAggregate(base: string, name: string, rows: string[][], params: ImportParams): void {
  const metric = AGGREGATE_METRICS[name] ?? { key: name.replace(/[_-]+/g, ' ') };
  rows.slice(1).forEach((row, index) => {
    const date = (row[0] ?? '').trim();
    const raw = cellNumber(row[1]);
    const ts = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : undefined;
    if (raw === undefined || !inTimeframe(params, ts)) {
      return;
    }

    const value = metric.scale ? Math.round(raw * metric.scale * 1000) / 1000 : raw;
    const title = `${metric.key} on ${date}: ${value}`;

    params.pipeline.push({
      item: {
        id: `withings:${base}:${date}:${index}`,
        classification: 'observation',
        timestamp: ts,
        content: textContent('observation.txt', title),
        metadata: { Title: title, Date: date, [metric.key]: value, File: base, Source: 'Withings' },
      },
    });
  });
}

/**
 * Read one of the export's files that the `Date`-column path can't: sleep,
 * workouts and the daily totals. Returns false for any other file, which then
 * goes through the `Date`-column path as before.
 */
function readNamedExportFile(base: string, raw: string, params: ImportParams): boolean {
  const name = base.toLowerCase();
  const aggregate = /^aggregates_(.+)\.csv$/.exec(name);
  if (name !== 'sleep.csv' && name !== 'activities.csv' && !aggregate) {
    return false;
  }

  const rows = parseCSVRows(raw);
  const header = (rows[0] ?? []).map((h) => h.trim());
  if (aggregate && header.length === 2) {
    readAggregate(base, aggregate[1], rows, params);

    return true;
  }

  // The columns these files are read by: four stage durations in seconds for
  // sleep, a time zone before the activity type for workouts. Anything else
  // with the same name (another service's activities.csv) is left alone.
  if (name === 'sleep.csv' && header.length >= 6 && header.slice(2, 6).every((h) => h.endsWith('(s)'))) {
    readSleep(base, rows, params);

    return true;
  }

  if (name === 'activities.csv' && looksLikeWithingsActivities(header, rows[1])) {
    readActivities(base, rows, params);

    return true;
  }

  return false;
}

/** An IANA zone name such as `Europe/London` or `America/Argentina/Buenos_Aires`. */
const IANA_ZONE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/;

/**
 * Withings' activities.csv: a `Timezone` header in column 4, or, for an
 * account whose headers are translated, a first row with a date in column 0,
 * an IANA zone in column 4 and a JSON object in column 6. Strava's
 * activities.csv (`Activity ID,Activity Date,...`) has neither.
 */
function looksLikeWithingsActivities(header: string[], first: string[] | undefined): boolean {
  if (header.length < 7) {
    return false;
  }

  if (/^timezone$/i.test(header[4])) {
    return true;
  }

  return (
    first !== undefined &&
    parseWithingsDate(first[0] ?? '') !== undefined &&
    IANA_ZONE.test((first[4] ?? '').trim()) &&
    (first[6] ?? '').trim().startsWith('{')
  );
}

registerDataSource({
  name: 'withings',
  title: 'Withings',
  icon: '',
  description: 'Body measurements from a Withings data export (weight.csv and related CSVs).',
  newFileImporter: () => new WithingsFileImporter(),
});

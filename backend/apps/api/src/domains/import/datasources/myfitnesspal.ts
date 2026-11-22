/* MyFitnessPal — the Premium "download your data" export.
   Three CSVs: Nutrition-Summary-*.csv (one 'observation' per logged meal),
   Exercise-Summary-*.csv (one 'workout' per exercise) and
   Measurement-Summary-*.csv (one 'observation' per day of measurements).
   Nutrition columns may vary slightly between exports, so an unnamed CSV is
   recognized by sniffing its header for "Calories", "Protein (g)" and a "Date"
   column rather than matching an exact filename.
*/
import fs from 'node:fs';
import path from 'node:path';

import { parseCSV } from './csv';
import { CsvExportImporter, type CsvExportSpec } from './csvImporter';
import { registerDataSource } from './registry';
import { readHead } from './sniff';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains } from './timeline';

// A MyFitnessPal Nutrition-Summary header carries a Date column plus the core
// macro columns. Match these rather than the exact filename so slightly varying
// Premium exports (and other importers' generic CSVs) don't collide.
function headerHasNutritionCols(text: string): boolean {
  const nl = text.indexOf('\n');
  const header = (nl === -1 ? text : text.slice(0, nl)).replace(/^\uFEFF/, '');
  const cols = header.split(',').map((h) => h.trim());

  return cols.includes('Date') && cols.includes('Calories') && cols.includes('Protein (g)');
}

// Read only the first ~4KB to inspect the CSV header row.
async function headerMatches(fpath: string): Promise<boolean> {
  const head = await readHead(fpath);

  return head != null && headerHasNutritionCols(head);
}

function looksLikeNutritionName(name: string): boolean {
  const b = name.toLowerCase();

  return b.endsWith('.csv') && b.includes('nutrition-summary');
}

type SummaryKind = 'nutrition' | 'exercise' | 'measurement';

/** Which of the export's three files a name is, by its `<Kind>-Summary` prefix. */
function summaryKind(name: string): SummaryKind | undefined {
  const b = name.toLowerCase();
  if (!b.endsWith('.csv')) {
    return undefined;
  }

  if (b.includes('exercise-summary')) {
    return 'exercise';
  }

  if (b.includes('measurement-summary')) {
    return 'measurement';
  }

  return looksLikeNutritionName(b) ? 'nutrition' : undefined;
}

function headerCols(text: string): string[] {
  const nl = text.indexOf('\n');

  return (nl === -1 ? text : text.slice(0, nl))
    .replace(/^\uFEFF/, '')
    .split(',')
    .map((h) => h.trim().replace(/^"|"$/g, ''));
}

// A known file name must also carry its own columns before it is read.
async function namedHeaderMatches(fpath: string): Promise<boolean> {
  const head = await readHead(fpath);
  if (head == null) {
    return false;
  }

  const cols = headerCols(head);
  switch (summaryKind(path.basename(fpath))) {
    case 'exercise':
      return cols.includes('Date') && cols.includes('Exercise');
    case 'measurement':
      return cols[0] === 'Date' && cols.length > 1;
    default:
      return headerHasNutritionCols(head);
  }
}

// Exercise rows a linked tracker or phone writes to settle the day's calorie
// burn ("MFP iOS calorie adjustment", "Fitbit calorie adjustment"). They are a
// day's step and calorie total, not a workout.
const CALORIE_ADJUSTMENT = /calorie adjustment/i;

function toNumber(v: string | undefined): number | undefined {
  if (v == null || v === '') {
    return undefined;
  }

  const n = Number(v.replace(/,/g, ''));

  return Number.isFinite(n) ? n : undefined;
}

export class MyfitnesspalFileImporter extends CsvExportImporter {
  protected readonly spec: CsvExportSpec = {
    isNamed: (name) => summaryKind(name) !== undefined,
    headerMatches: (fpath) => headerMatches(fpath),
    namedHeaderMatches: (fpath) => namedHeaderMatches(fpath),
    namedNeedsHeader: true,
    confidence: { named: 0.95, sniffed: 0.85 },
    // Every file of the export, not just the first known one.
    importInDir: 'all-matches',
  };

  protected async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    // Strip a UTF-8 BOM if present before parsing.
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

    // Per-(date,meal) sequence so two entries logged under the same meal on the
    // same date stay distinct (and re-import deterministically) — see id below.
    const seen = new Map<string, number>();
    const kind = summaryKind(base);
    for (const row of rows) {
      try {
        if (kind === 'exercise') {
          this.pushExercise(row, seen, params);
        } else if (kind === 'measurement') {
          this.pushMeasurement(row, seen, params);
        } else {
          this.pushRow(row, seen, params);
        }
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private pushRow(row: Record<string, string>, seen: Map<string, number>, params: ImportParams): void {
    const dateStr = row['Date'];
    if (!dateStr) {
      return;
    }

    const ts = new Date(dateStr);
    // Spec: timestamp = Date. Skip rows whose Date is unparseable rather than
    // emitting an item with timestamp:undefined (which timeframeContains treats
    // as "always in range").
    if (isNaN(ts.getTime())) {
      return;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const meal = row['Meal'] || undefined;
    const calories = toNumber(row['Calories']);
    const carbs = toNumber(row['Carbohydrates (g)']);
    const protein = toNumber(row['Protein (g)']);
    const fat = toNumber(row['Fat (g)']);

    const summaryParts = [
      dateStr,
      meal ? `(${meal})` : undefined,
      calories != null ? `${calories} kcal` : undefined,
    ].filter(Boolean);
    const summary = summaryParts.join(' ');

    // Date is bare 'YYYY-MM-DD' (midnight UTC), so (date, meal) is the natural
    // key; without it Breakfast/Lunch/Dinner/Snacks on one day collapse to one
    // hash. Suffix a per-(date,meal) sequence for the rare same-meal duplicate.
    const key = `${dateStr}:${meal || ''}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const id = n > 0 ? `myfitnesspal:${key}:${n}` : `myfitnesspal:${key}`;

    params.pipeline.push({
      item: {
        id,
        classification: 'observation',
        timestamp: ts,
        content: textContent('nutrition.txt', summary),
        metadata: {
          Title: `${dateStr} ${meal ?? 'Meal'}${calories != null ? ` — ${calories} kcal` : ''}`,
          Meal: meal,
          Calories: calories,
          'Carbohydrates (g)': carbs,
          'Protein (g)': protein,
          'Fat (g)': fat,
          Source: 'MyFitnessPal',
        },
      },
    });
  }

  /** The row's date (bare 'YYYY-MM-DD', read as midnight UTC like the meals), or undefined to skip it. */
  private rowDate(row: Record<string, string>, params: ImportParams): Date | undefined {
    const ts = row['Date'] ? new Date(row['Date']) : undefined;
    if (!ts || isNaN(ts.getTime()) || !timeframeContains(params.timeframe, ts)) {
      return undefined;
    }

    return ts;
  }

  /** A per-key sequence, so repeated rows on one day keep distinct, stable ids. */
  private nextId(prefix: string, key: string, seen: Map<string, number>): string {
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);

    return n > 0 ? `${prefix}:${key}:${n}` : `${prefix}:${key}`;
  }

  private pushExercise(row: Record<string, string>, seen: Map<string, number>, params: ImportParams): void {
    const ts = this.rowDate(row, params);
    const name = (row['Exercise'] ?? '').trim();
    if (!ts || !name) {
      return;
    }

    const date = row['Date'];
    const calories = toNumber(row['Exercise Calories']);
    const steps = toNumber(row['Steps']);
    const id = this.nextId('myfitnesspal:exercise', `${date}:${name}`, seen);

    if (CALORIE_ADJUSTMENT.test(name)) {
      const title = `${name} on ${date}`;
      params.pipeline.push({
        item: {
          id,
          classification: 'observation',
          timestamp: ts,
          content: textContent('observation.txt', title),
          metadata: { Title: title, Steps: steps, Calories: calories, Source: 'MyFitnessPal' },
        },
      });

      return;
    }

    // The weight column is named for the account's unit.
    const lifted = toNumber(row['Kilograms']) ?? toNumber(row['Pounds']);
    const liftedKey = row['Kilograms'] ? 'Weight Lifted (kg)' : 'Weight Lifted (lb)';

    params.pipeline.push({
      item: {
        id,
        classification: 'workout',
        timestamp: ts,
        content: textContent('workout.txt', name),
        metadata: {
          Title: name,
          'Activity Type': row['Type'] || undefined,
          Calories: calories,
          'Duration (min)': toNumber(row['Exercise Minutes']),
          Sets: toNumber(row['Sets']),
          'Reps Per Set': toNumber(row['Reps Per Set']),
          [liftedKey]: lifted,
          Steps: steps,
          Note: row['Note'] || undefined,
          Source: 'MyFitnessPal',
        },
      },
    });
  }

  /** One observation per day, carrying every measurement logged that day. */
  private pushMeasurement(
    row: Record<string, string>,
    seen: Map<string, number>,
    params: ImportParams,
  ): void {
    const ts = this.rowDate(row, params);
    if (!ts) {
      return;
    }

    const date = row['Date'];
    const values: Record<string, number | string> = {};
    for (const [key, raw] of Object.entries(row)) {
      if (key !== 'Date' && raw !== '') {
        values[key] = toNumber(raw) ?? raw;
      }
    }

    const keys = Object.keys(values);
    if (!keys.length) {
      return;
    }

    // MyFitnessPal does not write the unit; the number is stored as given.
    const title = keys.length === 1 ? `${keys[0]} on ${date}: ${values[keys[0]]}` : `Measurements on ${date}`;
    params.pipeline.push({
      item: {
        id: this.nextId('myfitnesspal:measurement', date, seen),
        classification: 'observation',
        timestamp: ts,
        content: textContent('observation.txt', title),
        metadata: { Title: title, ...values, Source: 'MyFitnessPal' },
      },
    });
  }
}

registerDataSource({
  name: 'myfitnesspal',
  title: 'MyFitnessPal',
  icon: '',
  description: 'Meals, exercise and measurements from a MyFitnessPal export (the Summary CSVs).',
  newFileImporter: () => new MyfitnesspalFileImporter(),
});

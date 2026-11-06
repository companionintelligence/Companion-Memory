/* MyFitnessPal — nutrition export (Nutrition-Summary-*.csv).
   The export is a MyFitnessPal Premium feature. One 'observation' event is
   emitted per logged row; columns may vary slightly between exports, so we
   recognize by sniffing the header for "Calories", "Protein (g)" and a "Date"
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

function toNumber(v: string | undefined): number | undefined {
  if (v == null || v === '') {
    return undefined;
  }

  const n = Number(v.replace(/,/g, ''));

  return Number.isFinite(n) ? n : undefined;
}

export class MyfitnesspalFileImporter extends CsvExportImporter {
  protected readonly spec: CsvExportSpec = {
    isNamed: (name) => looksLikeNutritionName(name),
    headerMatches: (fpath) => headerMatches(fpath),
    namedNeedsHeader: true,
    confidence: { named: 0.95, sniffed: 0.85 },
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
    for (const row of rows) {
      try {
        this.pushRow(row, seen, params);
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
}

registerDataSource({
  name: 'myfitnesspal',
  title: 'MyFitnessPal',
  icon: '',
  description: 'Nutrition logs from a MyFitnessPal export (Nutrition-Summary CSV).',
  newFileImporter: () => new MyfitnesspalFileImporter(),
});

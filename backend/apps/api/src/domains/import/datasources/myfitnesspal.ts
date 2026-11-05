/* MyFitnessPal — nutrition export (Nutrition-Summary-*.csv).
   The export is a MyFitnessPal Premium feature. One 'observation' event is
   emitted per logged row; columns may vary slightly between exports, so we
   recognize by sniffing the header for "Calories", "Protein (g)" and a "Date"
   column rather than matching an exact filename.
*/
import fs from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
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
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(fpath, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, 4096, 0);

    return headerHasNutritionCols(buf.toString('utf8', 0, bytesRead));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
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

export class MyfitnesspalFileImporter implements FileImporter {
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
      if (path.extname(base).toLowerCase() !== '.csv') {
        return { confidence: 0 };
      }

      if (!(await headerMatches(root))) {
        return { confidence: 0 };
      }

      return { confidence: looksLikeNutritionName(base) ? 0.95 : 0.85 };
    }

    if (st.isDirectory()) {
      try {
        const names = await readdir(root);
        // Prefer an obviously named Nutrition-Summary csv whose header also matches.
        for (const name of names) {
          if (!looksLikeNutritionName(name)) {
            continue;
          }

          if (await headerMatches(path.join(root, name))) {
            return { confidence: 0.95 };
          }
        }

        // Otherwise accept any csv whose header carries the nutrition columns.
        for (const name of names) {
          if (path.extname(name).toLowerCase() !== '.csv') {
            continue;
          }

          if (await headerMatches(path.join(root, name))) {
            return { confidence: 0.85 };
          }
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
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
      await this.processFile(root, params);
    } else if (stat.isDirectory()) {
      let names: string[];
      try {
        names = fs.readdirSync(root);
      } catch {
        return;
      }

      let named: string | undefined;
      for (const n of names) {
        if (looksLikeNutritionName(n) && (await headerMatches(path.join(root, n)))) {
          named = n;
          break;
        }
      }

      if (named) {
        await this.processFile(path.join(root, named), params);
      } else {
        for (const name of names) {
          if (path.extname(name).toLowerCase() !== '.csv') {
            continue;
          }

          const fpath = path.join(root, name);
          if (await headerMatches(fpath)) {
            await this.processFile(fpath, params);
          }
        }
      }
    }
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

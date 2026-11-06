/* Garmin Connect — Activities.csv exported from the Activities list.
   Header: "Activity Type,Date,Favorite,Title,Distance,Calories,Time,Avg HR,..."
   with Date "2023-01-15 10:30:00". One 'workout' event per row.

   Garmin also ships a complex DI_CONNECT JSON archive; this importer targets the
   simple Activities.csv only. Recognition is hardened so it does not collide with
   the Strava export, whose activities.csv also carries "Activity Type"/"Distance"
   columns — we additionally require a Garmin-distinctive column.
*/
import fs from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains } from './timeline';

// A Garmin Activities.csv header has "Activity Type" AND "Distance" (case-insensitive),
// plus at least one Garmin-distinctive column. The extra column is what keeps this from
// matching a Strava activities.csv, which also carries Activity Type/Distance but lacks
// these fields (Strava uses "Activity Date", "Activity ID", "Max Heart Rate", etc.).
const GARMIN_MARKERS = ['favorite', 'calories', 'avg hr', 'aerobic te'];
function headerIsGarmin(text: string): boolean {
  let header = text;
  const nl = header.indexOf('\n');
  if (nl !== -1) {
    header = header.slice(0, nl);
  }

  if (header.charCodeAt(0) === 0xfeff) {
    header = header.slice(1);
  }

  const lower = header.toLowerCase();
  if (!lower.includes('activity type') || !lower.includes('distance')) {
    return false;
  }

  return GARMIN_MARKERS.some((m) => lower.includes(m));
}

export class GarminFileImporter implements FileImporter {
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
      const base = path.basename(root).toLowerCase();
      if (path.extname(base) !== '.csv') {
        return { confidence: 0 };
      }

      if (!(await this.headerMatches(root))) {
        return { confidence: 0 };
      }

      // Exact "Activities.csv" name is a stronger signal than a generic .csv match.
      return base === 'activities.csv' ? { confidence: 0.95 } : { confidence: 0.85 };
    }

    if (st.isDirectory()) {
      try {
        const names = await readdir(root);
        const exact = names.find((n) => n.toLowerCase() === 'activities.csv');
        if (exact && (await this.headerMatches(path.join(root, exact)))) {
          return { confidence: 0.95 };
        }

        for (const name of names) {
          if (path.extname(name).toLowerCase() !== '.csv') {
            continue;
          }

          if (await this.headerMatches(path.join(root, name))) {
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

  // Read only the first ~4KB to inspect the CSV header row.
  private async headerMatches(fpath: string): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(fpath, 'r');
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buf, 0, 4096, 0);

      return headerIsGarmin(buf.toString('utf8', 0, bytesRead));
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
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

      const exact = names.find((n) => n.toLowerCase() === 'activities.csv');
      if (exact && (await this.headerMatches(path.join(root, exact)))) {
        await this.processFile(path.join(root, exact), params);
      } else {
        for (const name of names) {
          if (path.extname(name).toLowerCase() !== '.csv') {
            continue;
          }

          const fpath = path.join(root, name);
          if (await this.headerMatches(fpath)) {
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

    // Strip UTF-8 BOM if present.
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

    rows.forEach((row, index) => {
      try {
        this.pushRow(row, base, index, params);
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    });
  }

  private pushRow(row: Record<string, string>, base: string, index: number, params: ImportParams): void {
    const dateStr = row['Date'] || '';
    // Garmin Date is local "2023-01-15 10:30:00" — parse as a date (no timezone marker).
    let ts: Date | undefined = dateStr ? new Date(dateStr.replace(' ', 'T')) : undefined;
    if (ts && isNaN(ts.getTime())) {
      ts = undefined;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const activityType = row['Activity Type'] || '';
    const title = row['Title'] || '';
    const text = title || activityType;

    params.pipeline.push({
      item: {
        // Stable natural key: source file + raw Date + per-file row index. The
        // constant content.filename ('workout.txt') means hashItem's fallback
        // hash would otherwise be dataSource+classification+ISO(timestamp)
        // alone, so two activities recorded in the same second (plausible for
        // back-to-back Garmin activities) would collide under the staging
        // table's ON CONFLICT and one would be silently dropped.
        id: `garmin:${base}:${(row['Date'] || '').trim()}:${index}`,
        classification: 'workout',
        timestamp: ts,
        content: textContent('workout.txt', text),
        metadata: {
          'Activity Type': activityType || undefined,
          Title: title || activityType || undefined,
          Distance: row['Distance'] || undefined,
          Calories: row['Calories'] || undefined,
          Time: row['Time'] || undefined,
          'Avg HR': row['Avg HR'] || undefined,
          Source: 'Garmin Connect',
        },
      },
    });
  }
}

registerDataSource({
  name: 'garmin',
  title: 'Garmin Connect',
  icon: '',
  description: 'Activities from a Garmin Connect export (Activities.csv).',
  newFileImporter: () => new GarminFileImporter(),
});

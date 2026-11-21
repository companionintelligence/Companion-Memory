/* Garmin Connect — Activities.csv exported from the Activities list.
   Header: "Activity Type,Date,Favorite,Title,Distance,Calories,Time,Avg HR,..."
   with Date "2023-01-15 10:30:00". One 'workout' event per row.

   Garmin also ships a complex DI_CONNECT JSON archive; this importer targets the
   simple Activities.csv only. Recognition is hardened so it does not collide with
   the Strava export, whose activities.csv also carries "Activity Type"/"Distance"
   columns — we additionally require a Garmin-distinctive column.
*/
import fs from 'node:fs';
import path from 'node:path';

import { parseCSV } from './csv';
import { CsvExportImporter, type CsvExportSpec } from './csvImporter';
import { registerDataSource } from './registry';
import { readHead } from './sniff';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains } from './timeline';

// A Garmin Activities.csv header has the columns "Activity Type", "Date" and "Distance"
// (whole cells, case-insensitive), plus at least one column only Garmin writes.
//
// Strava's activities.csv also carries Activity Type and Distance, and its full header
// has a "Calories" column too, so a substring test with Calories as a marker claimed it:
// every Strava activity came in a second time as an undated "Garmin Connect" workout,
// because the parser reads "Date" and Strava's column is "Activity Date". Requiring the
// "Date" cell this parser reads, and only markers Strava lacks, keeps the two apart.
const GARMIN_REQUIRED = ['activity type', 'date', 'distance'];
const GARMIN_MARKERS = ['favorite', 'avg hr', 'aerobic te'];
function headerIsGarmin(text: string): boolean {
  let header = text;
  const nl = header.indexOf('\n');
  if (nl !== -1) {
    header = header.slice(0, nl);
  }

  if (header.charCodeAt(0) === 0xfeff) {
    header = header.slice(1);
  }

  const cells = new Set(
    header.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '').trim().toLowerCase()),
  );
  if (!GARMIN_REQUIRED.every((c) => cells.has(c))) {
    return false;
  }

  return GARMIN_MARKERS.some((m) => cells.has(m));
}

export class GarminFileImporter extends CsvExportImporter {
  protected readonly spec: CsvExportSpec = {
    isNamed: (name) => name === 'activities.csv',
    headerMatches: (fpath) => this.headerMatches(fpath),
    namedNeedsHeader: true,
    confidence: { named: 0.95, sniffed: 0.85 },
  };

  // Read only the first ~4KB to inspect the CSV header row.
  private async headerMatches(fpath: string): Promise<boolean> {
    const head = await readHead(fpath);

    return head != null && headerIsGarmin(head);
  }

  protected async processFile(fpath: string, params: ImportParams): Promise<void> {
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

/* Letterboxd — diary/ratings CSV export (diary.csv, ratings.csv). */
import path from 'node:path';

import { CsvExportImporter, type CsvExportSpec } from './csvImporter';
import { readCsvFile } from './readers';
import { registerDataSource } from './registry';
import { readHead } from './sniff';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

const LETTERBOXD_FILES = ['diary.csv', 'ratings.csv'];

function headerHasLetterboxdCols(text: string): boolean {
  const nl = text.indexOf('\n');
  const header = nl === -1 ? text : text.slice(0, nl);

  return header.includes('Letterboxd URI');
}

// Parse YYYY-MM-DD date string → Date (midnight UTC)
function parseYMD(s: string): Date | undefined {
  if (!s) {
    return undefined;
  }

  const d = new Date(`${s}T00:00:00Z`);

  return isNaN(d.getTime()) ? undefined : d;
}

export class LetterboxdFileImporter extends CsvExportImporter {
  protected readonly spec: CsvExportSpec = {
    isNamed: (name) => LETTERBOXD_FILES.includes(name),
    headerMatches: (fpath) => this.headerMatches(fpath),
    namedNeedsHeader: true,
    confidence: { named: 0.95, sniffed: 0 },
    importInDir: 'all-named',
  };

  // Read only the first ~4KB to inspect the CSV header row.
  private async headerMatches(fpath: string): Promise<boolean> {
    const head = await readHead(fpath);

    return head != null && headerHasLetterboxdCols(head);
  }

  protected async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    const rows = await readCsvFile(fpath, { log: params.log });
    if (rows == null) {
      return;
    }

    for (const row of rows) {
      try {
        this.pushRow(row, params);
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private pushRow(row: Record<string, string>, params: ImportParams): void {
    // diary.csv has "Watched Date"; ratings.csv falls back to "Date"
    const ts = parseYMD(row['Watched Date'] || row['Date'] || '');
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const name = row['Name'] || '';
    const uri = row['Letterboxd URI'] || '';
    // Unique per diary entry (boxd.it/<id>) or per film (ratings.csv); fall back
    // to a composite so same-day films can't collapse if a URI is ever blank.
    const id =
      uri ||
      `letterboxd:${name}:${row['Year'] || ''}:${row['Watched Date'] || row['Date'] || ''}:${row['Rating'] || ''}`;
    params.pipeline.push({
      item: {
        id,
        classification: 'watch',
        timestamp: ts,
        // A Letterboxd entry is a film seen anywhere — cinema, disc, any service —
        // so there is no delivery format to name; the generic video container says
        // "a video" without claiming how it was streamed.
        content: { filename: 'watch.txt', mediaType: 'video/mp4', data: async () => Buffer.from(name) },
        metadata: {
          Name: name || undefined,
          Year: row['Year'] || undefined,
          Rating: row['Rating'] || undefined,
          Rewatch: row['Rewatch'] || undefined,
          Tags: row['Tags'] || undefined,
          LetterboxdURI: row['Letterboxd URI'] || undefined,
          Source: 'Letterboxd',
        },
      },
    });
  }
}

registerDataSource({
  name: 'letterboxd',
  title: 'Letterboxd',
  icon: '',
  description: 'Film watch history from a Letterboxd CSV export (diary.csv or ratings.csv).',
  newFileImporter: () => new LetterboxdFileImporter(),
});

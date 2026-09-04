/* Letterboxd — diary/ratings CSV export (diary.csv, ratings.csv). */
import fs from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
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

export class LetterboxdFileImporter implements FileImporter {
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

      // A filename match alone used to be worth 0.8 — higher than most other
      // importers' own *verified* fallback tiers — with no read of the file at
      // all. "diary.csv" and "ratings.csv" are generic enough names (a mood
      // tracker's diary, a beer-rating app's ratings) that a same-named file
      // from an unrelated app must not be claimed as Letterboxd. Require the
      // same header check the top tier already does; a same-named file that
      // fails it now correctly returns 0.
      if (LETTERBOXD_FILES.includes(base)) {
        return (await this.headerMatches(root)) ? { confidence: 0.95 } : { confidence: 0 };
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const names = await readdir(root);
        for (const name of names) {
          if (!LETTERBOXD_FILES.includes(name.toLowerCase())) {
            continue;
          }

          if (await this.headerMatches(path.join(root, name))) {
            return { confidence: 0.95 };
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
      const { bytesRead: n } = await handle.read(buf, 0, 4096, 0);

      return headerHasLetterboxdCols(buf.toString('utf8', 0, n));
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

      for (const name of names) {
        if (LETTERBOXD_FILES.includes(name.toLowerCase())) {
          await this.processFile(path.join(root, name), params);
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

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

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

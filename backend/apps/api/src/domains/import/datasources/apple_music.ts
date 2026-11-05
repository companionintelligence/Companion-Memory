/* Apple Music — play history from an Apple Media Services export.
   The "Apple Music Play Activity.csv" file (also exported as
   "Apple Music - Play Activity.csv") holds one play event per row. */
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import { readHead } from './sniff';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains } from './timeline';

// Filename like "Apple Music Play Activity.csv" / "Apple Music - Play Activity.csv".
function filenameMatches(base: string): boolean {
  return base.toLowerCase().includes('play activity') && path.extname(base).toLowerCase() === '.csv';
}

function headerHasPlayCols(text: string): boolean {
  const nl = text.indexOf('\n');
  const header = (nl === -1 ? text : text.slice(0, nl)).replace(/^\uFEFF/, '');

  return header.includes('Song Name') && header.includes('Event Start Timestamp');
}

export class AppleMusicFileImporter implements FileImporter {
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
      if (filenameMatches(base)) {
        return { confidence: 0.95 };
      }

      if (path.extname(base).toLowerCase() === '.csv' && (await this.headerMatches(root))) {
        return { confidence: 0.85 };
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      for await (const f of this.walkCsvFiles(root)) {
        if (filenameMatches(path.basename(f))) {
          return { confidence: 0.95 };
        }

        if (await this.headerMatches(f)) {
          return { confidence: 0.85 };
        }
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  // Yield .csv files within root, recursing up to two levels (Apple nests the
  // CSV under "Apple Media Services information/Apple Music Activity/").
  private async *walkCsvFiles(root: string, depth = 0): AsyncGenerator<string> {
    if (depth > 2) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(root, e.name);
      if (e.isDirectory()) {
        yield* this.walkCsvFiles(p, depth + 1);
      } else if (e.isFile() && path.extname(e.name).toLowerCase() === '.csv') {
        yield p;
      }
    }
  }

  // Read only the first ~8KB to inspect the CSV header row.
  private async headerMatches(fpath: string): Promise<boolean> {
    const head = await readHead(fpath, 8192);

    return head != null && headerHasPlayCols(head);
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let st: fs.Stats;
    try {
      st = fs.statSync(root);
    } catch {
      return;
    }

    if (st.isFile()) {
      await this.processFile(root, params);
    } else if (st.isDirectory()) {
      for await (const f of this.walkCsvFiles(root)) {
        if (filenameMatches(path.basename(f)) || (await this.headerMatches(f))) {
          await this.processFile(f, params);
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

    // Strip a UTF-8 BOM if present.
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
    const start = row['Event Start Timestamp'];
    let ts: Date | undefined = start ? new Date(start) : undefined;
    if (ts && isNaN(ts.getTime())) {
      ts = undefined;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const track = row['Song Name'] || '';
    const artist = row['Artist Name'] || '';

    const msRaw = row['Play Duration Milliseconds'];
    let msPlayed: number | undefined;
    if (msRaw !== undefined && msRaw !== '') {
      const n = Number(msRaw);
      if (!isNaN(n)) {
        msPlayed = n;
      }
    }

    params.pipeline.push({
      item: {
        // Stable natural key: source file + raw start timestamp + per-file row
        // index. The constant content.filename ('play.txt') means hashItem's
        // fallback hash would otherwise be dataSource+classification+
        // ISO(timestamp) alone, so two tracks logged in the same second
        // (repeated/skip-replayed plays are common in a real listening
        // history) would collide under the staging table's ON CONFLICT and
        // one would be silently dropped.
        id: `apple_music:${base}:${(start || '').trim()}:${index}`,
        classification: 'listen',
        timestamp: ts,
        content: textContent('play.txt', `${artist} — ${track}`),
        metadata: {
          Track: track || undefined,
          Artist: artist || undefined,
          Album: row['Album Name'] || undefined,
          'ms Played': msPlayed,
          'End Reason': row['End Reason Type'] || undefined,
          Source: 'Apple Music',
        },
      },
    });
  }
}

registerDataSource({
  name: 'apple_music',
  title: 'Apple Music',
  icon: '',
  description: 'Play history from an Apple Media Services export (Apple Music Play Activity.csv).',
  newFileImporter: () => new AppleMusicFileImporter(),
});

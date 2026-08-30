/* Last.fm — scrobble CSV export (scrobbles.csv). */
import fs from 'node:fs';
import { open, readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

function headerHasScrobbleCols(text: string): boolean {
  const nl = text.indexOf('\n');
  const header = nl === -1 ? text : text.slice(0, nl);

  return header.includes('uts') && header.includes('utc_time');
}

export class LastFmFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let stat: fs.Stats;
    try {
      stat = await fsStat(root);
    } catch {
      return { confidence: 0 };
    }

    if (stat.isFile()) {
      const base = path.basename(root).toLowerCase();
      if (/^scrobbles.*\.csv$/.test(base)) {
        return { confidence: 0.9 };
      }

      if (path.extname(base) === '.csv' && (await this.headerMatches(root))) {
        return { confidence: 0.85 };
      }

      return { confidence: 0 };
    }

    if (stat.isDirectory()) {
      try {
        const names = await readdir(root);
        if (names.some((n) => /^scrobbles.*\.csv$/i.test(n))) {
          return { confidence: 0.9 };
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
    try {
      const fh = await open(fpath, 'r');
      try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(buf, 0, 4096, 0);

        return headerHasScrobbleCols(buf.toString('utf8', 0, bytesRead));
      } finally {
        await fh.close().catch(() => {});
      }
    } catch {
      return false;
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

      const scrobble = names.find((n) => /^scrobbles.*\.csv$/i.test(n));
      if (scrobble) {
        await this.processFile(path.join(root, scrobble), params);
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

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    // Occurrence counts so a true duplicate scrobble (same track re-played in
    // the same UTC second) still gets a distinct, stable id, matching the
    // pattern netflix.ts/kindle_reading.ts use for the identical problem.
    const seen = new Map<string, number>();
    for (const row of rows) {
      try {
        this.pushRow(row, params, seen);
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private pushRow(row: Record<string, string>, params: ImportParams, seen: Map<string, number>): void {
    // uts is a Unix timestamp in seconds; fall back to utc_time string
    let ts: Date | undefined;
    if (row['uts'] && /^\d+$/.test(row['uts'].trim())) {
      ts = new Date(parseInt(row['uts'], 10) * 1000);
      if (isNaN(ts.getTime())) {
        ts = undefined;
      }
    }

    if (!ts && row['utc_time']) {
      ts = new Date(row['utc_time']);
      if (isNaN(ts.getTime())) {
        ts = undefined;
      }
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const track = row['track'] || '';
    const artist = row['artist'] || '';
    const album = row['album'] || '';

    const idBase = `last_fm:${row['uts'] || row['utc_time'] || ''}:${artist}:${track}`;
    const n = seen.get(idBase) ?? 0;
    seen.set(idBase, n + 1);

    params.pipeline.push({
      item: {
        id: n === 0 ? idBase : `${idBase}:${n}`,
        classification: 'listen',
        timestamp: ts,
        content: {
          filename: 'scrobble.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(`${artist} — ${track}`),
        },
        metadata: {
          Track: track || undefined,
          Artist: artist || undefined,
          Album: album || undefined,
          TrackMBID: row['track_mbid'] || undefined,
          ArtistMBID: row['artist_mbid'] || undefined,
          AlbumMBID: row['album_mbid'] || undefined,
          Source: 'Last.fm',
        },
      },
    });
  }
}

registerDataSource({
  name: 'last_fm',
  title: 'Last.fm',
  icon: '',
  description: 'Music scrobble history from a Last.fm CSV export (scrobbles.csv).',
  newFileImporter: () => new LastFmFileImporter(),
});

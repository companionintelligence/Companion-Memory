/* Last.fm — scrobble CSV export (scrobbles.csv). */
import fs from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import { CsvExportImporter, type CsvExportSpec } from './csvImporter';
import { readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { readCsvFile } from './readers';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import { readHead } from './sniff';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains } from './timeline';

function headerHasScrobbleCols(text: string): boolean {
  const nl = text.indexOf('\n');
  const header = nl === -1 ? text : text.slice(0, nl);

  return header.includes('uts') && header.includes('utc_time');
}

export class LastFmFileImporter extends CsvExportImporter {
  protected readonly spec: CsvExportSpec = {
    isNamed: (name) => /^scrobbles.*\.csv$/.test(name),
    headerMatches: (fpath) => this.headerMatches(fpath),
    confidence: { named: 0.9, sniffed: 0.85 },
  };

  // Read only the first ~4KB to inspect the CSV header row.
  private async headerMatches(fpath: string): Promise<boolean> {
    const head = await readHead(fpath);

    return head != null && headerHasScrobbleCols(head);
  }

  protected async processFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    const rows = await readCsvFile(fpath, { log: params.log });
    if (rows == null) {
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
        content: textContent('scrobble.txt', `${artist} — ${track}`),
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

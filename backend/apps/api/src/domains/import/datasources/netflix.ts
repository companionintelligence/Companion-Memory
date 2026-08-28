/* Netflix — privacy / "Download all" export (ViewingActivity.csv). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

// Full "Get my info" export: ViewingActivity.csv with rich per-event columns.
function headerHasViewingCols(text: string): boolean {
  const header = firstLine(text);

  return header.includes('Start Time') && header.includes('Title') && header.includes('Profile Name');
}

// Quick "Viewing activity → Download all" export: NetflixViewingHistory.csv,
// just a Title and a (locale-formatted, time-less) Date per row. The export has
// exactly these two columns, so we match the header exactly to avoid claiming
// unrelated two-plus-column CSVs that merely happen to have a Title and a Date.
function headerHasSimpleCols(text: string): boolean {
  const cols = firstLine(text)
    .trim()
    .replace(/^\uFEFF/, '')
    .split(',')
    .map((h) => h.trim());

  return cols.length === 2 && cols.includes('Title') && cols.includes('Date');
}

/**
 * Stable per-title identity for the content row: case/whitespace-insensitive
 * hash of the title string, so every viewing of "The Old Guard" (and every
 * re-export) lands on ONE content row while each viewing stays its own event —
 * the prime_video.ts / audible.ts pattern. Without it the importer minted one
 * content row per watch (3,484 rows for 2,682 titles on a real export).
 *
 * sha256, not sha1, so plain Postgres can compute the identical value when
 * legacy per-viewing rows need collapsing onto it by hand (the dev database
 * that had them was fixed that way; nothing shipped with the old identity).
 */
function titleUri(title: string): string {
  const norm = title.replace(/\s+/g, ' ').trim().toLowerCase();

  return `netflix:title:${crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16)}`;
}

// Parse the full export's Duration ("hh:mm:ss") into milliseconds. Hours can
// exceed 24 for long binge sessions, so don't cap them.
function parseDurationMs(s: string): number | undefined {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(s.trim());
  if (!m) {
    return undefined;
  }

  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');

  return nl === -1 ? text : text.slice(0, nl);
}

// Parse the quick export's date, e.g. "6/25/26". Netflix formats this to the
// account's locale; for US accounts that's M/D/YY. We treat a 2-digit year as
// 20YY and anchor to midnight UTC since the quick export carries no time.
function parseSimpleDate(s: string): Date | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s.trim());
  if (!m) {
    return undefined;
  }

  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));

  return isNaN(d.getTime()) ? undefined : d;
}

export class NetflixFileImporter implements FileImporter {
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
      const isKnownFilename = base === 'viewingactivity.csv' || base === 'netflixviewinghistory.csv';

      // The canonical filenames used to be worth 0.9 on their own, no header
      // read at all. Require the same header check the renamed-file fallback
      // below already does, so a same-named file with unrelated content is no
      // longer claimed outright.
      if (isKnownFilename && (await this.headerMatches(root))) {
        return { confidence: 0.9 };
      }

      // The full "Get my info" export's header (Start Time + Title + Profile
      // Name together) is distinctive enough to stand alone under any
      // filename. The quick export's header is just "Title,Date" — that's
      // indistinguishable from any other minimal watchlist/to-do CSV, so on
      // its own it must not grant recognition; it only counts when paired
      // with one of the known filenames above.
      if (path.extname(base) === '.csv' && (await this.headerMatchesFullExport(root))) {
        return { confidence: 0.85 };
      }

      return { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const names = await readdir(root);
        const known = names.find((n) =>
          ['viewingactivity.csv', 'netflixviewinghistory.csv'].includes(n.toLowerCase()),
        );
        if (known && (await this.headerMatches(path.join(root, known)))) {
          return { confidence: 0.9 };
        }

        for (const name of names) {
          if (path.extname(name).toLowerCase() !== '.csv') {
            continue;
          }

          if (await this.headerMatchesFullExport(path.join(root, name))) {
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
  private async readHead(fpath: string): Promise<string | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(fpath, 'r');
      const buf = Buffer.alloc(4096);
      const { bytesRead: n } = await handle.read(buf, 0, 4096, 0);

      return buf.toString('utf8', 0, n);
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  // Matches either the full "Get my info" export or the quick "Download all"
  // history — used only once a known filename has already corroborated it.
  private async headerMatches(fpath: string): Promise<boolean> {
    const head = await this.readHead(fpath);

    return head !== undefined && (headerHasViewingCols(head) || headerHasSimpleCols(head));
  }

  // The full export's header alone, Netflix-specific enough to stand in for a
  // missing/renamed filename.
  private async headerMatchesFullExport(fpath: string): Promise<boolean> {
    const head = await this.readHead(fpath);

    return head !== undefined && headerHasViewingCols(head);
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

      const exact = names.find((n) =>
        ['viewingactivity.csv', 'netflixviewinghistory.csv'].includes(n.toLowerCase()),
      );
      if (exact) {
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

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    // Occurrence counts for identical rows within this file, so true duplicates
    // (same date + profile + title) still get distinct, stable ids.
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
    // Full export has an ISO-ish "Start Time"; the quick export has only a
    // locale-formatted "Date". Prefer the precise timestamp when present.
    const st = row['Start Time'];
    let ts: Date | undefined;
    if (st) {
      ts = new Date(st.replace(' ', 'T') + 'Z');
    } else if (row['Date']) {
      ts = parseSimpleDate(row['Date']);
    }

    if (ts && isNaN(ts.getTime())) {
      ts = undefined;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    // The full export carries the session length; end the event at start + Duration.
    // Sub-minute sessions are trailer autoplays and abandoned previews, not real
    // viewings — drop the row entirely.
    let end: Date | undefined;
    if (row['Duration']) {
      const durMs = parseDurationMs(row['Duration']);
      if (durMs !== undefined && durMs < 60_000) {
        return;
      }

      if (ts && durMs !== undefined) {
        end = new Date(ts.getTime() + durMs);
      }
    }

    const title = row['Title'] || '';

    // Explicit stable id. Without one, persistence hashes only classification +
    // filename + timestamp — and the quick export's day-precision timestamps
    // then collapse every same-day viewing into a single item. Build the id
    // from the row's own content (NOT its file position: Netflix prepends new
    // viewings, so positions shift between exports). The occurrence counter
    // only disambiguates exactly-identical rows; the file lists newest first,
    // and duplicates keep that relative order across exports, so counters stay
    // stable as new rows are prepended... until a NEW duplicate of an old row
    // appears, which claims the low counter and re-numbers its older twins —
    // an acceptable rare miscount, not data loss.
    const when = st || row['Date'] || '';
    const idBase = `netflix:${when}:${row['Profile Name'] || ''}:${title}`;
    const n = seen.get(idBase) ?? 0;
    seen.set(idBase, n + 1);

    params.pipeline.push({
      item: {
        id: n === 0 ? idBase : `${idBase}:${n}`,
        classification: 'watch',
        timestamp: ts,
        timespanEnd: end,
        content: { filename: 'watch.txt', mediaType: 'text/plain', data: async () => Buffer.from(title) },
        metadata: {
          Title: row['Title'] || undefined,
          // One content row per TITLE: the URI replaces the per-viewing item id
          // as the content row's triple identity (mapping.toContentInput).
          URI: title ? titleUri(title) : undefined,
          Profile: row['Profile Name'] || undefined,
          Device: row['Device Type'] || undefined,
          Duration: row['Duration'] || undefined,
          Country: row['Country'] || undefined,
          Source: 'Netflix',
        },
      },
    });
  }
}

registerDataSource({
  name: 'netflix',
  title: 'Netflix',
  icon: '',
  description:
    'Viewing history from Netflix: the full "Get my info" export (ViewingActivity.csv, ' +
    'with precise timestamps, profile, device, and duration) or the quick "Download all" history ' +
    '(NetflixViewingHistory.csv, just title + date).',
  newFileImporter: () => new NetflixFileImporter(),
});

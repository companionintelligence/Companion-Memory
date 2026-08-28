/* Audible — per-session listening history from an Amazon "All Data Categories"
   export ("Your Audible Library & Listening/Listening History.csv"). One
   'listen' item per session (kind media.listen → events + content in
   CI-Server; the type is what verbs the event "Listened to …" downstream).
   The book's ASIN keys the content lane (metadata.URI = audible:asin:<ASIN>),
   so every session of one audiobook collapses into a single content row while
   each session stays its own event — the prime_video.ts pattern, except Audible
   hands us a real catalog id instead of a title to hash.

   The file replicates multi-part titles: one session of a multi-part audiobook
   appears once per part PLUS once for the base title ("Cryptonomicon
   (Unabridged)", "… Part 1" … "… Part 5"), every column except Product Name
   byte-identical. On a real export that inflated 4,443 sessions to 9,702 rows.
   Rows are grouped on (ASIN, dates, positions, duration) and each group emits
   ONE item under the base title.

   Timestamps are date-only (Start Date/End Date, no clock time), so sessions
   land as day-anchored events; the session's length lives in metadata
   ('Seconds Listened'), never in a timespan — a date-only end would render a
   ten-minute session as a day-long span.

   A sibling Library.csv (same export folder) is joined on ASIN to enrich the
   session with Author / Narrator / Series / Subtitle.

   NOT read: Audible.PlaybackMetrics (client telemetry with real clock times,
   but only a recent window of buffering/state churn that would double-count
   everything Listening History already records), Impressions Data, and the
   SearchData files (browse noise, not listening). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { audibleUrl } from './_amazon_urls';
import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

const FILENAME_RE = /Listening History\.csv$/i;
const PART_RE = /\s+Part\s+\d+\s*$/i;

// Header sniff: this column pair appears in no other export's CSV — Spotify's
// endsong is JSON, Apple Music's play activity has no "Product Name", and the
// Audible Purchase History dialect amazon.ts claims has no duration column.
// The filename alone ("Listening History.csv") is too generic to trust.
function headerMatches(text: string): boolean {
  let header = text;
  if (header.charCodeAt(0) === 0xfeff) {
    header = header.slice(1);
  }

  const nl = header.indexOf('\n');
  if (nl !== -1) {
    header = header.slice(0, nl);
  }

  return /event\s*duration\s*milliseconds/i.test(header) && /product\s*name/i.test(header);
}

async function sniffHeader(fpath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(fpath, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead: n } = await handle.read(buf, 0, 4096, 0);

    return headerMatches(buf.toString('utf8', 0, n));
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** A field's value, with Audible's "Not Available" filler read as no value. */
function val(row: Record<string, string>, name: string): string {
  const raw = (row[name] ?? '').trim();

  return /^not available$/i.test(raw) ? '' : raw;
}

function num(row: Record<string, string>, name: string): number | undefined {
  const raw = val(row, name);
  if (!raw) {
    return undefined;
  }

  const n = Number(raw);

  return Number.isFinite(n) ? n : undefined;
}

/** Per-book enrichment from the export's sibling Library.csv, keyed by ASIN. */
interface LibraryEntry {
  author?: string;
  narrator?: string;
  series?: string;
  subtitle?: string;
}

/** "asin:B0757…,title:Realms of the Elderlings,asin:…,title:Tawny Man" →
    "Realms of the Elderlings, Tawny Man". */
function seriesTitles(info: string): string | undefined {
  const titles = [...info.matchAll(/title:(.*?)(?=,asin:|,title:|$)/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);

  return titles.length ? titles.join(', ') : undefined;
}

export class AudibleFileImporter implements FileImporter {
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
      if (path.extname(root).toLowerCase() !== '.csv' || !(await sniffHeader(root))) {
        return { confidence: 0 };
      }

      return { confidence: FILENAME_RE.test(path.basename(root)) ? 0.95 : 0.85 };
    }

    if (st.isDirectory()) {
      if ((await this.findFiles(root)).length) {
        return { confidence: 0.95 };
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  // The export nests the file as Your Audible Library & Listening/…, and a
  // drag-and-drop staging adds an "All Data Categories" wrapper above that —
  // so recurse deep enough to survive a couple of wrapper directories. Every
  // CSV is header-sniffed (a 4KB read) because the filename proves nothing.
  private async findFiles(dir: string, depth = 0): Promise<string[]> {
    const out: string[] = [];
    let names: fs.Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }

    for (const dirent of names) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (depth < 4) {
          out.push(...(await this.findFiles(full, depth + 1)));
        }
      } else if (dirent.isFile()) {
        if (path.extname(dirent.name).toLowerCase() === '.csv' && (await sniffHeader(full))) {
          out.push(full);
        }
      }
    }

    return out;
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

    const files = stat.isFile() ? [root] : stat.isDirectory() ? await this.findFiles(root) : [];
    for (const fpath of files) {
      await this.processFile(fpath, params);
    }
  }

  /** Library.csv sitting next to the listening file, as an ASIN-keyed map. */
  private loadLibrary(listeningPath: string, params: ImportParams): Map<string, LibraryEntry> {
    const lib = new Map<string, LibraryEntry>();
    const fpath = path.join(path.dirname(listeningPath), 'Library.csv');
    let raw: string;
    try {
      raw = fs.readFileSync(fpath, 'utf8');
    } catch {
      return lib;
    }

    try {
      for (const row of parseCSV(raw)) {
        const asin = val(row, 'ASIN');
        if (!asin) {
          continue;
        }

        lib.set(asin, {
          author: val(row, 'Authors') || undefined,
          narrator: val(row, 'Audiobook Narrator') || undefined,
          series: seriesTitles(val(row, 'Book Series Info')),
          subtitle: val(row, 'Subtitle') || undefined,
        });
      }
    } catch (e) {
      params.log?.('warn', 'Failed to parse Library.csv', { error: (e as Error).message });
    }

    return lib;
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

    // Collapse the multi-part replication: rows identical on the session key
    // (ASIN + dates + positions + duration) are one session listed once per
    // part. Map preserves file order, so ids are stable across re-imports.
    const sessions = new Map<string, Record<string, string>[]>();
    for (const row of rows) {
      const key = [
        val(row, 'ASIN'),
        val(row, 'Start Date'),
        val(row, 'End Date'),
        val(row, 'Start Position Milliseconds'),
        val(row, 'End Position Milliseconds'),
        val(row, 'Event Duration Milliseconds'),
      ].join('|');
      const group = sessions.get(key);
      if (group) {
        group.push(row);
      } else {
        sessions.set(key, [row]);
      }
    }

    const library = this.loadLibrary(fpath, params);
    for (const [key, group] of sessions) {
      try {
        this.pushSession(key, group, library, params);
      } catch (e) {
        params.log?.('error', `Failed to import session in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private pushSession(
    key: string,
    group: Record<string, string>[],
    library: Map<string, LibraryEntry>,
    params: ImportParams,
  ): void {
    // The base title carries the group; part rows only repeat it. A group
    // without a base row (never seen on a real export) falls back to a part
    // row with the suffix stripped.
    const primary = group.find((r) => !PART_RE.test(val(r, 'Product Name'))) ?? group[0];
    const title = val(primary, 'Product Name').replace(PART_RE, '');

    const startRaw = val(primary, 'Start Date');
    if (!startRaw) {
      return;
    } // a session without a date is nothing to place

    let ts: Date | undefined = new Date(startRaw);
    if (isNaN(ts.getTime())) {
      ts = undefined;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const asin = val(primary, 'ASIN');
    const durMs = num(primary, 'Event Duration Milliseconds');
    const endPos = num(primary, 'End Position Milliseconds');
    const bookLen = num(primary, 'Book Length Milliseconds');
    const speed = num(primary, 'Narration Speed');
    const endRaw = val(primary, 'End Date');
    const book = asin ? library.get(asin) : undefined;

    // The session key is the identity: groups are unique by construction, so
    // its hash needs no occurrence counter (unlike prime_video, whose rows
    // carry no positions to tell true duplicates apart).
    const id = `audible:${startRaw}:${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`;

    params.pipeline.push({
      item: {
        id,
        classification: 'listen',
        timestamp: ts,
        // The AUDIOBOOK's type — Audible's own format — not the text stub's.
        // The item carries no file path, so this only describes the book on
        // its content row; nothing uploads the stub as audio bytes.
        content: {
          filename: 'listen.txt',
          mediaType: 'audio/vnd.audible.aax',
          data: async () => Buffer.from(title),
        },
        metadata: {
          Title: title || undefined,
          // One content row per BOOK: the ASIN URI replaces the per-session
          // item id as the content row's triple identity (mapping.toContentInput).
          URI: asin ? `audible:asin:${asin}` : undefined,
          ASIN: asin || undefined,
          URL: audibleUrl(asin),
          Author: book?.author,
          Narrator: book?.narrator,
          Series: book?.series,
          Subtitle: book?.subtitle,
          'Seconds Listened': durMs !== undefined ? Math.round(durMs / 1000) : undefined,
          // Where the session left off, as % of the book — "finished it that day".
          Progress:
            bookLen && endPos !== undefined ? Math.min(100, Math.round((endPos / bookLen) * 100)) : undefined,
          'Narration Speed': speed !== undefined && speed !== 1 ? speed : undefined,
          'Listening Mode': val(primary, 'Listening Mode') || undefined,
          // Only worth stating when the session crossed midnight (dates are
          // day-granular, so same-day ends carry no information).
          'End Date': endRaw && endRaw !== startRaw ? endRaw : undefined,
          Timezone: val(primary, 'Local Timezone') || undefined,
          Source: 'Audible',
        },
      },
    });
  }
}

registerDataSource({
  name: 'audible',
  title: 'Audible',
  icon: '',
  description:
    'Per-session listening history from an Amazon data export (Listening History.csv): ' +
    'one play event per session with book progress, enriched with author/narrator/series from Library.csv; ' +
    'multi-part title replication is collapsed.',
  newFileImporter: () => new AudibleFileImporter(),
});

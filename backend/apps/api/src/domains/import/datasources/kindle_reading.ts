/* Kindle reading sessions — per-session telemetry from an Amazon "All Data
   Categories" export (Additional Data/Kindle.Devices.ReadingSession_v0/
   Kindle.Devices.ReadingSession_v0.csv). One 'read' item per session (kind
   media.read → events + content in CI-Server; the type is what verbs the
   event "Read …" downstream). The book's ASIN keys the content lane
   (metadata.URI = kindle:asin:<ASIN>), so every session of one book collapses
   into a single content row while each session stays its own event.

   The session file records only ASINs. Titles are joined from elsewhere in
   the archive: Digital-Ordering.1/Digital Items.csv (ASIN → ProductName,
   covers every purchased book) first, then the ReadingInsights sessions file
   (ASIN → product_name) for anything Digital Items misses. Sessions with a
   UUID pseudo-ASIN or no ASIN at all (sideloaded personal documents) have no
   title anywhere in the archive and import unnamed.

   Timestamps are real datetimes, so sessions carry a start→end timespan.
   A few rows lack start_timestamp: when total_reading_millis is present the
   start is recovered as end − millis; when it too is absent (the observed
   case — those rows carry ONLY an end), the event anchors at the end instant
   with no span, because "not measured" must not be read as "not reading".

   NOT read: Kindle.ReadingInsights/…/Kindle.reading-insights-sessions_with_
   adjustments.csv as a SESSION source — on a real export 142 of its 257 rows
   were the same sessions as ReadingSession_v0 (same ASIN, start within
   minutes), so importing both would double-count; it serves only as the
   secondary title map above. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { kindleUrl } from './_amazon_urls';
import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

const FILENAME_RE = /Kindle\.Devices\.ReadingSession/i;
const DIGITAL_ITEMS_RE = /^Digital Items\.csv$/i;
const INSIGHTS_RE = /reading-insights-sessions/i;

// Header sniff: this column pair appears in no other export's CSV.
function headerMatches(text: string): boolean {
  let header = text;
  if (header.charCodeAt(0) === 0xfeff) {
    header = header.slice(1);
  }

  const nl = header.indexOf('\n');
  if (nl !== -1) {
    header = header.slice(0, nl);
  }

  return /total_reading_millis/i.test(header) && /number_of_page_flips/i.test(header);
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

/** A field's value, with Amazon's "Not Available" filler read as no value. */
function val(row: Record<string, string>, name: string): string {
  const raw = (row[name] ?? '').trim();

  return /^not available$/i.test(raw) ? '' : raw;
}

/** A real Kindle catalog ASIN — not the UUID pseudo-ASIN of a personal doc. */
function isCatalogAsin(asin: string): boolean {
  return /^[A-Z0-9]{10}$/.test(asin);
}

function parseTs(raw: string): Date | undefined {
  if (!raw) {
    return undefined;
  }

  const d = new Date(raw);

  return isNaN(d.getTime()) ? undefined : d;
}

export class KindleReadingFileImporter implements FileImporter {
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
      if ((await this.findSessionFiles(root)).length) {
        return { confidence: 0.95 };
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  // The export nests the file as Additional Data/Kindle.Devices.ReadingSession_v0/…,
  // and a drag-and-drop staging adds an "All Data Categories" wrapper above
  // that — recurse deep enough to survive a couple of wrapper directories.
  private async findSessionFiles(dir: string, depth = 0): Promise<string[]> {
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
          out.push(...(await this.findSessionFiles(full, depth + 1)));
        }
      } else if (dirent.isFile()) {
        if (path.extname(dirent.name).toLowerCase() === '.csv' && (await sniffHeader(full))) {
          out.push(full);
        }
      }
    }

    return out;
  }

  /**
   * ASIN → title map from the rest of the archive. Digital Items.csv is
   * authoritative (every purchased book); the ReadingInsights sessions file
   * fills gaps. The insights file nests four levels deep
   * (Kindle.ReadingInsights/datasets/<set>/<file>) — five under a staged
   * drop's "All Data Categories" wrapper — hence the deeper walk than the
   * session-file search.
   */
  private loadTitles(searchRoot: string, params: ImportParams): Map<string, string> {
    const primary = new Map<string, string>();
    const secondary = new Map<string, string>();
    const walk = (dir: string, depth: number) => {
      let names: fs.Dirent[];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const dirent of names) {
        const full = path.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (depth < 6) {
            walk(full, depth + 1);
          }

          continue;
        }

        if (!dirent.isFile()) {
          continue;
        }

        try {
          if (DIGITAL_ITEMS_RE.test(dirent.name)) {
            for (const row of parseCSV(fs.readFileSync(full, 'utf8'))) {
              const asin = val(row, 'ASIN');
              const title = val(row, 'ProductName');
              if (asin && title && !primary.has(asin)) {
                primary.set(asin, title);
              }
            }
          } else if (INSIGHTS_RE.test(dirent.name) && path.extname(dirent.name).toLowerCase() === '.csv') {
            for (const row of parseCSV(fs.readFileSync(full, 'utf8'))) {
              const asin = val(row, 'ASIN');
              const title = val(row, 'product_name');
              if (asin && title && !secondary.has(asin)) {
                secondary.set(asin, title);
              }
            }
          }
        } catch (e) {
          params.log?.('warn', `Failed to read title source ${dirent.name}`, { error: (e as Error).message });
        }
      }
    };

    walk(searchRoot, 0);
    for (const [asin, title] of secondary) {
      if (!primary.has(asin)) {
        primary.set(asin, title);
      }
    }

    return primary;
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

    const files = stat.isFile() ? [root] : stat.isDirectory() ? await this.findSessionFiles(root) : [];
    if (!files.length) {
      return;
    }

    // A bare-file drop still gets a title map from whatever sits around it.
    const titles = this.loadTitles(stat.isDirectory() ? root : path.dirname(root), params);
    for (const fpath of files) {
      await this.processFile(fpath, titles, params);
    }
  }

  private async processFile(fpath: string, titles: Map<string, string>, params: ImportParams): Promise<void> {
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

    // Occurrence counts so a true duplicate row still gets a distinct, stable
    // id (prime_video.ts uses the same pattern).
    const seen = new Map<string, number>();
    for (const row of rows) {
      try {
        this.pushRow(row, titles, params, seen);
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private pushRow(
    row: Record<string, string>,
    titles: Map<string, string>,
    params: ImportParams,
    seen: Map<string, number>,
  ): void {
    const millisRaw = val(row, 'total_reading_millis');
    const millis = /^\d+$/.test(millisRaw) ? Number(millisRaw) : undefined;

    let ts = parseTs(val(row, 'start_timestamp'));
    let end = parseTs(val(row, 'end_timestamp'));
    if (!ts && end) {
      if (millis !== undefined) {
        ts = new Date(end.getTime() - millis); // recover the start the file dropped
      } else {
        // Only an end survives: anchor there as an instant, spanless event.
        ts = end;
        end = undefined;
      }
    }

    if (!ts) {
      return;
    } // no time at all is nothing to place

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const asin = val(row, 'ASIN');
    const catalog = isCatalogAsin(asin);
    const contentType = val(row, 'content_type');
    const title =
      (catalog ? titles.get(asin) : undefined) ??
      (contentType === 'Personal Document' ? 'Personal document' : undefined);

    const flipsRaw = val(row, 'number_of_page_flips');
    const flips = /^\d+$/.test(flipsRaw) ? Number(flipsRaw) : undefined;

    const idBase =
      `kindle:${ts.toISOString()}:` +
      crypto
        .createHash('sha1')
        .update(`${asin}|${end?.toISOString() ?? ''}|${millisRaw}`)
        .digest('hex')
        .slice(0, 12);
    const n = seen.get(idBase) ?? 0;
    seen.set(idBase, n + 1);

    params.pipeline.push({
      item: {
        id: n === 0 ? idBase : `${idBase}:${n}`,
        classification: 'read',
        timestamp: ts,
        timespanEnd: end,
        // The BOOK's type, not the stub's: anything bought from Amazon is a
        // Kindle-format ebook (application/vnd.amazon.ebook). A sideloaded
        // personal document may really have been an .epub/.pdf, but the export
        // doesn't say, and some ebook type is nearer the truth than text/plain.
        // The item carries no file path, so this only describes the book on its
        // content row — nothing uploads the stub as ebook bytes.
        content: {
          filename: 'read.txt',
          mediaType: 'application/vnd.amazon.ebook',
          data: async () => Buffer.from(title ?? asin ?? ''),
        },
        metadata: {
          Title: title,
          // One content row per BOOK: the ASIN URI replaces the per-session
          // item id as the content row's triple identity (mapping.toContentInput).
          // Personal docs keep their UUID under a doc: URI so their sessions
          // still collapse, even though no title exists for them anywhere.
          URI: catalog ? `kindle:asin:${asin}` : asin ? `kindle:doc:${asin}` : undefined,
          ASIN: catalog ? asin : undefined,
          URL: catalog ? kindleUrl(asin) : undefined,
          'Minutes Read': millis !== undefined ? Math.round(millis / 6000) / 10 : undefined,
          'Page Flips': flips,
          'Content Type': contentType || undefined,
          Device: val(row, 'device_family') || undefined,
          Source: 'Kindle',
        },
      },
    });
  }
}

registerDataSource({
  name: 'kindle_reading',
  title: 'Kindle Reading',
  icon: '',
  description:
    'Per-session reading history from an Amazon data export (Kindle.Devices.ReadingSession_v0.csv): ' +
    'one read event per session with duration and page flips, titles joined from Digital Items.csv.',
  newFileImporter: () => new KindleReadingFileImporter(),
});

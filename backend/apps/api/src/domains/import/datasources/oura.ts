/* Oura — daily trends CSV export from the Oura app ("Export trends").
   The export is a single CSV with a "date" column (YYYY-MM-DD) plus metric
   columns such as "Sleep Score", "Readiness Score", "Activity Score",
   "Average HRV", etc. We emit one 'observation' per row (per day), carrying
   every non-empty metric column as metadata. The signature is generic (*.csv)
   so recognition sniffs the header to avoid false-matching other CSV importers. */
import fs from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

// Extract the header line from raw CSV text (BOM already stripped by caller).
function headerLine(text: string): string {
  const nl = text.indexOf('\n');

  return (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, '');
}

// An Oura trends CSV header carries a "date" column AND at least one of the
// signature Oura score columns. This is specific enough to avoid matching other
// CSV importers (e.g. Netflix's "Start Time,..." or Withings' "Date,...(kg)").
function headerLooksLikeOura(header: string): boolean {
  const cols = header.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  const hasDate = cols.some((c) => c.toLowerCase() === 'date');
  const hasScore = cols.some((c) => c === 'Sleep Score' || c === 'Readiness Score' || c === 'Activity Score');

  return hasDate && hasScore;
}

// Read the first ~4KB and inspect the CSV header row.
async function sniffHeader(fpath: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(fpath, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, 4096, 0);
    let text = buf.toString('utf8', 0, bytesRead);
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }

    return headerLine(text);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function csvMatches(fpath: string): Promise<boolean> {
  const header = await sniffHeader(fpath);

  return header !== undefined && headerLooksLikeOura(header);
}

// Parse an Oura date ("YYYY-MM-DD", treated as UTC midnight). Tolerates values
// that already contain time/'T'/'Z'. Returns undefined for anything unparseable.
function parseOuraDate(raw: string): Date | undefined {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  let candidate = trimmed;
  if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    candidate = candidate + 'T00:00:00Z';
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(candidate)) {
    candidate = candidate.replace(' ', 'T') + 'Z';
  }

  let d = new Date(candidate);
  if (isNaN(d.getTime())) {
    d = new Date(trimmed);
  }

  return isNaN(d.getTime()) ? undefined : d;
}

export class OuraFileImporter implements FileImporter {
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
      if (path.extname(root).toLowerCase() !== '.csv') {
        return { confidence: 0 };
      }

      return (await csvMatches(root)) ? { confidence: 0.9 } : { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const names = await readdir(root);
        for (const name of names) {
          if (path.extname(name).toLowerCase() !== '.csv') {
            continue;
          }

          if (await csvMatches(path.join(root, name))) {
            return { confidence: 0.9 };
          }
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
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
        if (path.extname(name).toLowerCase() !== '.csv') {
          continue;
        }

        const fpath = path.join(root, name);
        if (await csvMatches(fpath)) {
          await this.processFile(fpath, params);
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

    if (!rows.length) {
      return;
    }

    // Find the actual "date" column key (case-insensitive); skip if missing.
    const dateKey = Object.keys(rows[0]).find((k) => k.toLowerCase() === 'date');
    if (!dateKey) {
      return;
    }

    rows.forEach((row, index) => {
      try {
        this.pushRow(row, dateKey, base, index, params);
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    });
  }

  private pushRow(
    row: Record<string, string>,
    dateKey: string,
    base: string,
    index: number,
    params: ImportParams,
  ): void {
    const ts = parseOuraDate(row[dateKey] || '');
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    // Carry every non-empty metric column as metadata; numeric columns become numbers.
    const metadata: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === dateKey) {
        continue;
      }

      if (value === undefined || value === '') {
        continue;
      }

      const num = Number(value);
      // Coerce to a number only when the value round-trips losslessly (mirrors
      // withings.ts's identical guard), so a zero-padded string-id column like
      // "007" isn't silently corrupted into 7.
      const numeric = !isNaN(num) && /^[-+]?[0-9.]+$/.test(value) && String(num) === value;
      metadata[key] = numeric ? num : value;
    }

    metadata.Source = 'Oura';
    metadata.Summary = `Oura ${row[dateKey]} — Sleep ${row['Sleep Score'] || '?'} / Readiness ${row['Readiness Score'] || '?'} / Activity ${row['Activity Score'] || '?'}`;

    // Human-readable text body summarizing the day's metrics.
    const summaryParts = Object.entries(row)
      .filter(([k, v]) => k !== dateKey && v !== '')
      .map(([k, v]) => `${k}: ${v}`);
    const text = [row[dateKey] ? `Date: ${row[dateKey]}` : '', ...summaryParts].filter(Boolean).join('\n');

    params.pipeline.push({
      item: {
        // Stable natural key: source file + raw date + per-file row index. One
        // row per calendar day means the date alone is USUALLY unique, but a
        // re-export with an overlapping date range or a malformed export with
        // a repeated date would otherwise collapse into hashItem's fallback
        // (classification + constant 'observation.txt' filename + timestamp)
        // — the row index disambiguates regardless.
        id: `oura:${base}:${(row[dateKey] || '').trim()}:${index}`,
        classification: 'observation',
        timestamp: ts,
        content: {
          filename: 'observation.txt',
          mediaType: 'text/plain',
          data: async () => Buffer.from(text),
        },
        metadata,
      },
    });
  }
}

registerDataSource({
  name: 'oura',
  title: 'Oura',
  icon: '',
  description: 'Daily readiness/sleep/activity scores from an Oura trends CSV export.',
  newFileImporter: () => new OuraFileImporter(),
});

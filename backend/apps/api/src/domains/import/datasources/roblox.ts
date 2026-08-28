/* Roblox — "Right to Access" data report.
 *
 * Roblox fulfils a Right-to-Access request by posting a download link to the
 * user's Roblox inbox. Unlike most exports here, the on-disk format of that
 * report is NOT publicly documented — Roblox publishes the request flow and the
 * data *categories* (account info, login history, purchase history, chat) but
 * no filenames or schema. So this importer is deliberately defensive: it
 * recognizes a folder/file that looks like a Roblox report and ingests whatever
 * CSV or JSON-array files it contains on a best-effort basis, pulling a
 * timestamp from any date-like column/field it can find. When Roblox's format
 * is eventually documented (or a real sample lands), this can be tightened.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

const DATE_KEY = /date|time|timestamp|created|when/i;

function findDate(rec: Record<string, unknown>): Date | undefined {
  for (const [k, v] of Object.entries(rec)) {
    if (!DATE_KEY.test(k)) {
      continue;
    }

    if (v == null) {
      continue;
    }

    // Unix epoch (seconds or ms) or ISO/locale date string.
    if (typeof v === 'number') {
      const d = new Date(v > 1e12 ? v : v * 1000);
      if (!isNaN(d.getTime())) {
        return d;
      }
    } else if (typeof v === 'string' && v.trim()) {
      const d = new Date(v);
      if (!isNaN(d.getTime())) {
        return d;
      }
    }
  }

  return undefined;
}

// Classify by filename heuristic (Roblox's format is undocumented, so this is
// best-effort): chat/message files → 'message', purchase/billing files →
// 'purchase' (so they reach ci.objects, not social.post), everything else
// → 'social'.
//
// Takes the BASENAME only. Matching the full path lets any ancestor directory
// the user happened to name — an inbox folder, a Downloads subfolder, the
// checkout this runs from — decide the classification for every row in the
// export.
function classify(basename: string): string {
  if (/chat|message|conversation/i.test(basename)) {
    return 'message';
  }

  if (/purchase|transaction|order|payment|billing/i.test(basename)) {
    return 'purchase';
  }

  return 'social';
}

function looksRoblox(name: string): boolean {
  return name.toLowerCase().includes('roblox');
}

export class RobloxFileImporter implements FileImporter {
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
      const base = path.basename(root);
      const ext = path.extname(base).toLowerCase();
      if (looksRoblox(base) && (ext === '.csv' || ext === '.json')) {
        return { confidence: 0.6 };
      }

      return { confidence: 0 };
    }

    if (stat.isDirectory()) {
      if (looksRoblox(path.basename(root))) {
        return { confidence: 0.7 };
      }

      try {
        if ((await readdir(root)).some((n) => looksRoblox(n))) {
          return { confidence: 0.6 };
        }
      } catch {
        /* ignore */
      }

      return { confidence: 0, dir_threshold: 0.6 };
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

    const files: string[] = [];
    if (stat.isFile()) {
      files.push(root);
    } else if (stat.isDirectory()) {
      this.collect(root, files);
    }

    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (ext === '.csv') {
        await this.processCSV(f, params);
      } else if (ext === '.json') {
        await this.processJSON(f, params);
      }
    }
  }

  private collect(dir: string, out: string[], depth = 0): void {
    if (depth > 6) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        this.collect(p, out, depth + 1);
      } else if (e.isFile() && /\.(csv|json)$/i.test(e.name)) {
        out.push(p);
      }
    }
  }

  private async processCSV(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Roblox: failed to read CSV', {
        file: path.basename(fpath),
        error: (e as Error).message,
      });

      return;
    }

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(raw);
    } catch {
      return;
    }

    const kind = path.basename(fpath, path.extname(fpath));
    rows.forEach((row, i) => this.push(row, kind, fpath, params, i));
  }

  private async processJSON(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Roblox: failed to read JSON', {
        file: path.basename(fpath),
        error: (e as Error).message,
      });

      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const kind = path.basename(fpath, path.extname(fpath));
    // Accept a top-level array, or an object with a single array property.
    let arr: unknown[] | undefined;
    if (Array.isArray(parsed)) {
      arr = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const v = Object.values(parsed as Record<string, unknown>).find((x) => Array.isArray(x));
      if (Array.isArray(v)) {
        arr = v;
      }
    }

    if (!arr) {
      return;
    }

    arr.forEach((rec, i) => {
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
        this.push(rec as Record<string, unknown>, kind, fpath, params, i);
      }
    });
  }

  private push(
    rec: Record<string, unknown>,
    kind: string,
    fpath: string,
    params: ImportParams,
    idx: number,
  ): void {
    const ts = findDate(rec);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    // Carry a bounded set of primitive fields as metadata.
    const metadata: Record<string, string | number | boolean> = { Kind: kind, Source: 'Roblox' };
    let n = 0;
    for (const [k, v] of Object.entries(rec)) {
      if (n >= 24) {
        break;
      }

      if (v == null) {
        continue;
      }

      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        metadata[k] = v;
        n++;
      }
    }

    const summary = JSON.stringify(rec);
    // Give every row a human title (Roblox columns are undocumented; pick the
    // most specific present key, else label by Kind) so titleFor doesn't fall
    // back to the bare 'roblox.txt' filename.
    const titleVal =
      metadata.Item ??
      metadata.Product ??
      metadata.Name ??
      metadata.Title ??
      metadata.Message ??
      metadata.Description ??
      metadata.Device ??
      `Roblox ${kind}`;
    if (titleVal != null && typeof titleVal !== 'object') {
      metadata.Title = String(titleVal);
    }

    const rowKey = crypto
      .createHash('sha1')
      .update(path.basename(fpath))
      .update('\0')
      .update(String(idx))
      .update('\0')
      .update(summary)
      .digest('hex');
    params.pipeline.push({
      item: {
        id: `roblox:${rowKey}`,
        classification: classify(path.basename(fpath)),
        timestamp: ts,
        content: { filename: 'roblox.txt', mediaType: 'text/plain', data: async () => Buffer.from(summary) },
        metadata,
      },
    });
  }
}

registerDataSource({
  name: 'roblox',
  title: 'Roblox',
  icon: '',
  description:
    "Roblox 'Right to Access' report — account, login, purchase, and chat history. Best-effort: Roblox does not document the on-disk format, so we ingest any CSV/JSON files in the report.",
  newFileImporter: () => new RobloxFileImporter(),
});

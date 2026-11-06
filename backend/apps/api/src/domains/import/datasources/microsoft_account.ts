/* Microsoft account privacy export — account.microsoft.com/privacy "Download
 * your data". The archive is a flat set of per-category files (search, browse,
 * location, voice, app usage, media consumption); older archives are JSON,
 * current ones (2022+) are CSV. Microsoft does not publish the per-file schema,
 * so this importer is schema-tolerant: it keys off a couple of known filenames
 * for recognition, then walks every JSON/CSV file, unwrapping the common
 * `{ "pages": [...] }` shape (or a top-level array) and pulling a timestamp
 * from any date-like field it finds. Verified anchor files:
 * ProductAndServiceUsage.json, ContentConsumption.json, and from a real 2026
 * archive: ProductAndServiceUsage.csv (DateTime,EndDateTime,DeviceId,
 * Aggregation,AppName,AppPublisher) and SearchRequestsAndQuery.csv (DateTime,
 * DeviceId,AccuracyRadius,Latitude,Longitude,Time,Title,Url,SearchTerms), with
 * quoted "MM/DD/YYYY HH:mm:ss +00:00" timestamps.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { textContent, timeframeContains } from './timeline';

// Files that uniquely identify a Microsoft privacy export.
const ANCHORS = [
  'productandserviceusage.json',
  'contentconsumption.json',
  'productandserviceusage.csv',
  'searchrequestsandquery.csv',
];

const DATE_KEY = /date|time|timestamp|when/i;

// Microsoft sometimes wraps dates as "/Date(1700000000000)/".
function parseMsDate(v: unknown): Date | undefined {
  if (v == null) {
    return undefined;
  }

  if (typeof v === 'number') {
    const d = new Date(v > 1e12 ? v : v * 1000);

    return isNaN(d.getTime()) ? undefined : d;
  }

  if (typeof v === 'string') {
    const m = v.match(/\/Date\((\d+)\)\//);
    if (m) {
      const d = new Date(Number(m[1]));

      return isNaN(d.getTime()) ? undefined : d;
    }

    if (!v.trim()) {
      return undefined;
    }

    const d = new Date(v);

    return isNaN(d.getTime()) ? undefined : d;
  }

  return undefined;
}

// Finite number from a number or numeric string (CSV cells), else undefined.
function num(v: unknown): number | undefined {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }

  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);

    return Number.isFinite(n) ? n : undefined;
  }

  return undefined;
}

// Trimmed non-empty string or undefined (mirrors mapping.ts str()).
function str(v: unknown): string | undefined {
  if (typeof v !== 'string') {
    return undefined;
  }

  const t = v.trim();

  return t ? t : undefined;
}

function findDate(rec: Record<string, unknown>): Date | undefined {
  for (const [k, v] of Object.entries(rec)) {
    if (!DATE_KEY.test(k)) {
      continue;
    }

    const d = parseMsDate(v);
    if (d) {
      return d;
    }
  }

  return undefined;
}

// The Microsoft privacy export ships one file per category (the filename, e.g.
// "Browse", "SearchRequestsAndQuery", "LocationHistory"). Previously everything
// was forced to 'social' (-> social.post), mis-routing browsing/search/usage as
// social media posts. Derive a real classification from the filename, defaulting
// to the neutral 'note' (-> content) rather than falsely claiming a social post.
function classificationForKind(kind: string): string {
  const k = kind.toLowerCase().replace(/[^a-z]/g, '');
  if (k.includes('brows')) {
    return 'page_view';
  } // Browse, BrowseHistory, BrowsingHistory

  if (k.includes('search') || k.includes('query')) {
    return 'search';
  }

  if (k.includes('location')) {
    return 'location';
  }

  if (k.includes('purchase') || k.includes('order') || k.includes('billing')) {
    return 'purchase';
  }

  return 'note';
}

export class MicrosoftAccountFileImporter implements FileImporter {
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
      return ANCHORS.includes(path.basename(root).toLowerCase()) ? { confidence: 0.85 } : { confidence: 0 };
    }

    if (stat.isDirectory()) {
      try {
        const names = (await readdir(root)).map((n) => n.toLowerCase());
        if (ANCHORS.some((a) => names.includes(a))) {
          return { confidence: 0.85 };
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
      try {
        for (const n of fs.readdirSync(root)) {
          const l = n.toLowerCase();
          if (l.endsWith('.json') || l.endsWith('.csv')) {
            files.push(path.join(root, n));
          }
        }
      } catch {
        return;
      }
    }

    for (const f of files) {
      await this.processFile(f, params);
    }
  }

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    // ProductAndServiceUsage stays a recognition anchor but is not imported:
    // its rows are per-day "you used Bing/Edge that day" aggregates — no
    // content, no position, no useful timeline signal.
    if (path.basename(fpath, path.extname(fpath)).toLowerCase() === 'productandserviceusage') {
      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Microsoft: failed to read file', {
        file: path.basename(fpath),
        error: (e as Error).message,
      });

      return;
    }

    let arr: unknown[] | undefined;
    if (fpath.toLowerCase().endsWith('.csv')) {
      // Empty cells are dropped so the sparse union-header CSVs don't litter
      // records with blank fields.
      arr = parseCSV(raw, { omitEmpty: true });
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      // Unwrap: a top-level array, `{ pages: [...] }`, or the first array property.
      if (Array.isArray(parsed)) {
        arr = parsed;
      } else if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.pages)) {
          arr = obj.pages;
        } else {
          const v = Object.values(obj).find((x) => Array.isArray(x));
          if (Array.isArray(v)) {
            arr = v;
          }
        }
      }
    }

    if (!arr) {
      return;
    }

    const kind = path.basename(fpath, path.extname(fpath));
    const base = path.basename(fpath);
    let i = 0;
    for (const rec of arr) {
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
        continue;
      }

      this.push(rec as Record<string, unknown>, kind, params, base, i++);
    }
  }

  private push(
    rec: Record<string, unknown>,
    kind: string,
    params: ImportParams,
    base: string,
    idx: number,
  ): void {
    const ts = findDate(rec);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const metadata: Record<string, string | number | boolean> = { Kind: kind, Source: 'Microsoft' };
    let n = 0;
    for (const [k, v] of Object.entries(rec)) {
      if (n >= 24) {
        break;
      }

      // The alternate BrowsingHistory schema has a 'Source' column (client app
      // id, e.g. "EdgeBrowser"); keep it, but 'Source' is reserved for the
      // datasource stamp that the rest of the pipeline keys on.
      const key = k === 'Source' ? 'ClientSource' : k;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        metadata[key] = v;
        n++;
      }
    }

    // BrowsingHistory has two candidate schemas in the wild — the search-style
    // union header (…,Title,Url,…) and an Edge-style one (DateTime,PageTitle,
    // NavigatedUrl,DeviceType,Source,Latitude,Longitude,Accuracy). Neither is
    // confirmed against hard data, so accept both: normalize the URL onto the
    // Url metadata key that toBrowserActivityInput reads.
    const url = str(rec.Url) ?? str(rec.URL) ?? str(rec.NavigatedUrl) ?? str(rec.NavigatedToUrl);
    if (url && metadata.Url === undefined && metadata.URL === undefined) {
      metadata.Url = url;
    }

    // Microsoft schemas are undocumented, so no title-bearing key is guaranteed;
    // synthesize a recognized Title (falling back to the category Kind) so events
    // don't all render as the bare filename 'microsoft.txt'.
    const label =
      str(rec.Title) ??
      str(rec.PageTitle) ??
      str(rec.Name) ??
      str(rec.AppName) ??
      str(rec.SearchTerm) ??
      str(rec.SearchTerms) ??
      url ??
      str(rec.Subject);
    const classification = classificationForKind(kind);
    // Browse entries get the bare page title — a "BrowsingHistory — " prefix on
    // every visited page is noise. Other kinds keep the prefix because their
    // labels are ambiguous without it (a bare search term or app name).
    metadata.Title = label ? (classification === 'page_view' ? label : `${kind} — ${label}`) : kind;
    // Stable id per (file, row, content): distinct events stay distinct even
    // when no date field is found or many rows share a second, and a re-import
    // of the same file dedups via INSERT OR IGNORE.
    const id =
      'microsoft:' +
      base +
      ':' +
      idx +
      ':' +
      crypto.createHash('sha1').update(JSON.stringify(rec)).digest('hex');
    // Any category can carry a position (verified: the real export's search CSV
    // has Latitude/Longitude columns), so lift coordinates on every record, not
    // just LocationActivity rows.
    const lat = num(rec.Latitude) ?? num(rec.latitude);
    const lon = num(rec.Longitude) ?? num(rec.longitude);
    const location =
      lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        ? { latitude: lat, longitude: lon }
        : undefined;
    params.pipeline.push({
      item: {
        id,
        classification,
        timestamp: ts,
        location,
        content: textContent('microsoft.txt', JSON.stringify(rec)),
        metadata,
      },
    });
  }
}

registerDataSource({
  name: 'microsoft_account',
  title: 'Microsoft account (privacy export)',
  icon: '',
  description:
    'Search, browse, location, voice, and app-usage history from a Microsoft account "Download your data" export.',
  newFileImporter: () => new MicrosoftAccountFileImporter(),
});

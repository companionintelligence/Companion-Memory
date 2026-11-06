/* Prime Video — per-session viewing history from an Amazon "All Data Categories"
   export (PrimeVideo.ViewingHistory.csv). One 'watch' item per playback session
   (kind media.watch → events + content in CI-Server). The watched TITLE is the
   session's metadata.URI, so the content lane collapses every session of one
   title into a single content row (content dedups server-side on the URI-keyed
   triple — see mapping.toContentInput) while each session stays its own event.

   NOT read: PrimeVideo.WatchEvent.*.csv, the account's per-title watch-history
   aggregate. It knows watch-time this file's session telemetry missed, but its
   only timestamp is a last-watched date, so it cannot produce timeline events —
   and importing both would double-count everything they share. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseCSV } from './csv';
import { CsvExportImporter, type CsvExportSpec } from './csvImporter';
import { registerDataSource } from './registry';
import { readHead } from './sniff';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

const FILENAME_RE = /PrimeVideo\.ViewingHistory/i;

function filenameMatches(name: string): boolean {
  return path.extname(name).toLowerCase() === '.csv' && FILENAME_RE.test(name);
}

// Header sniff: "Playback Start Datetime" appears in no other export's CSV —
// not Netflix's (Start Time/Title/Profile Name) and not Amazon's order files.
function headerMatches(text: string): boolean {
  let header = text;
  if (header.charCodeAt(0) === 0xfeff) {
    header = header.slice(1);
  }

  const nl = header.indexOf('\n');
  if (nl !== -1) {
    header = header.slice(0, nl);
  }

  return /playback\s*start\s*datetime/i.test(header) && /seconds\s*viewed/i.test(header);
}

async function sniffHeader(fpath: string): Promise<boolean> {
  const head = await readHead(fpath);

  return head != null && headerMatches(head);
}

/**
 * Unwrap a field's value. This file double-quotes its cells — the CSV parser
 * hands back values still wearing literal quote characters (`"Irvine"`,
 * `"Promo"`) — and fills absent fields with "Not available", which is no value
 * at all. Returns '' for both flavors of nothing.
 */
function val(row: Record<string, string>, name: string): string {
  const raw = (row[name] ?? '')
    .trim()
    .replace(/^"+|"+$/g, '')
    .trim();

  return /^not available$/i.test(raw) ? '' : raw;
}

/**
 * Storefront noise, not viewing: autoplaying carousel promos and trailers.
 * On a real export these were 838 of 2,402 rows totaling ONE hour (median 1s) —
 * imported naively they'd be the majority of recent "watch" events. Matched
 * exactly; the empty value (pre-2015 clients reported no material type, and
 * those rows are real ~16-minute viewings) stays importable.
 */
function isPromoMaterial(material: string): boolean {
  return /^(promo|trailer)$/i.test(material);
}

/** Stable per-title identity for the URI: case/whitespace-insensitive hash. */
function titleUri(title: string): string {
  const norm = title.replace(/\s+/g, ' ').trim().toLowerCase();

  return `primevideo:title:${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16)}`;
}

export class PrimeVideoFileImporter extends CsvExportImporter {
  protected readonly spec: CsvExportSpec = {
    isNamed: (name) => filenameMatches(name),
    headerMatches: (fpath) => sniffHeader(fpath),
    confidence: { named: 0.95, sniffed: 0.85 },
    dirConfidence: { named: 0.95, sniffed: 0.95 },
    scanDepth: 4,
    importInDir: 'all-matches',
  };

  protected async processFile(fpath: string, params: ImportParams): Promise<void> {
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

    // Occurrence counts for identical (start, title) pairs, so a true duplicate
    // row still gets a distinct, stable id (netflix.ts uses the same pattern).
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
    const startRaw = val(row, 'Playback Start Datetime (UTC)');
    if (!startRaw) {
      return;
    } // a session without a start is nothing to place

    let ts: Date | undefined = new Date(startRaw);
    if (isNaN(ts.getTime())) {
      ts = undefined;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const title = val(row, 'Title');
    const material = val(row, 'Material Type Description');
    if (isPromoMaterial(material)) {
      params.pipeline.drop?.('promo_playback', title || undefined);

      return;
    }

    let end: Date | undefined = new Date(val(row, 'Playback End Datetime (UTC)'));
    if (isNaN(end.getTime())) {
      end = undefined;
    }

    const secsRaw = Number(val(row, 'Seconds Viewed'));
    const seconds = Number.isFinite(secsRaw) ? Math.round(secsRaw) : undefined;

    // An abandoned start, not a viewing: zero seconds viewed AND the session's
    // wall clock over in under a minute — play pressed, backed straight out.
    // Both conditions, because zero alone also marks UNMETERED real watching:
    // Live broadcasts run for hours with Seconds Viewed stuck at 0. A zero
    // with no end datetime keeps its item too — the span is unknowable, and
    // "not measured" must not be read as "not watched".
    if (seconds === 0 && ts && end && end.getTime() - ts.getTime() < 60_000) {
      params.pipeline.drop?.('abandoned_playback', title || undefined);

      return;
    }

    // Device context: prefer Amazon's own device name (Fire TV etc.), else the
    // manufacturer/model pair.
    const device =
      val(row, 'Amazon Device Model Name') ||
      [val(row, 'Device Manufacturer Name'), val(row, 'Device Model')].filter(Boolean).join(' ');

    // Content-derived id — never file position (the export is newest-first, so
    // positions shift every time something is watched).
    const idBase = `primevideo:${startRaw}:${crypto.createHash('sha1').update(title).digest('hex').slice(0, 12)}`;
    const n = seen.get(idBase) ?? 0;
    seen.set(idBase, n + 1);

    params.pipeline.push({
      item: {
        id: n === 0 ? idBase : `${idBase}:${n}`,
        classification: 'watch',
        timestamp: ts,
        timespanEnd: end,
        // The VIDEO's type, not the text stub's (streams are assumed mp4, the
        // same as digital video purchases). The item carries no file path, so
        // this only describes the title on its content row; nothing uploads
        // the stub as video bytes.
        content: { filename: 'watch.txt', mediaType: 'video/mp4', data: async () => Buffer.from(title) },
        metadata: {
          Title: title || undefined,
          // One content row per TITLE: the URI replaces the per-session item id
          // as the content row's triple identity (mapping.toContentInput), so
          // seventeen sessions of one show collapse to one content entry while
          // every session keeps its own event.
          URI: title ? titleUri(title) : undefined,
          'Seconds Viewed': seconds,
          Material: material || undefined,
          Device: device || undefined,
          OS: val(row, 'Operating System Name') || undefined,
          Browser: val(row, 'Browser') || undefined,
          City: val(row, 'City') || undefined,
          State: val(row, 'State') || undefined,
          Country: val(row, 'Country Code') || undefined,
          Quality: val(row, 'Content Quality Delivered') || undefined,
          'Audio Language': val(row, 'Audio Language Code') || undefined,
          Source: 'Prime Video',
        },
      },
    });
  }
}

registerDataSource({
  name: 'prime_video',
  title: 'Prime Video',
  icon: '',
  description:
    'Per-session viewing history from an Amazon data export (PrimeVideo.ViewingHistory.csv): ' +
    'one watch event per playback session with device and city context; promos/trailers are dropped.',
  newFileImporter: () => new PrimeVideoFileImporter(),
});

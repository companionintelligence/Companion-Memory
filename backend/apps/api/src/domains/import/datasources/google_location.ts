/* Google Location History (Legacy Takeout) MVP
   Recognizes directory containing Records.json and parses minimal location points.
*/
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { FileImporter, DirEntry, Recognition } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Graph } from './timeline';
import { timeframeContains } from './timeline';

type GoogleLocationOptions = Record<string, never>;

interface LegacyLocationRaw {
  latitudeE7?: number;
  longitudeE7?: number;
  accuracy?: number;
  altitude?: number;
  timestamp?: string | number;
  timestampMs?: string;
}
interface LegacyFile {
  locations?: LegacyLocationRaw[];
}

export class GoogleLocationFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const base = entry.fullPath || entry.fsRoot || entry.filename;
    if (!base) {
      return { confidence: 0 };
    }

    try {
      if ((await stat(base)).isDirectory()) {
        let hasRecords = false;
        try {
          await stat(path.join(base, 'Records.json'));
          hasRecords = true;
        } catch {
          /* Records.json absent */
        }

        if (hasRecords) {
          // heuristic similar to Go: folder name contains "Location History" + file present
          const name = path.basename(base);
          if (/location history/i.test(name)) {
            return { confidence: 0.95 };
          }

          return { confidence: 0.8 };
        }
      }
    } catch {
      /* ignore */
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    const recPath = path.join(root, 'Records.json');
    if (!fs.existsSync(recPath)) {
      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(recPath, 'utf8');
    } catch (e) {
      params.log?.('error', 'read Records.json failed', { error: (e as Error).message });

      return;
    }

    let parsed: LegacyFile;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const list = parsed.locations || [];
    // U-22: report what was READ, not just what survived. `stageSummary.ts`
    // derives `consumed` from `produced + dropped` unless a parser measures it,
    // so a Records.json where every fix fell outside the timeframe used to
    // reconcile perfectly at 0 = 0 + 0 — indistinguishable from a file that was
    // never opened. Every element below either pushes or drops, so this count
    // is the real denominator.
    params.pipeline.consumed?.(list.length);
    let idx = 0;
    for (const loc of list) {
      // Only divide a coordinate that's actually present — a missing axis must
      // stay missing, not become 0 (which would plant the point on null island).
      const lat = loc.latitudeE7 !== undefined ? loc.latitudeE7 / 1e7 : undefined;
      const lon = loc.longitudeE7 !== undefined ? loc.longitudeE7 / 1e7 : undefined;
      // timestamp field variations
      let ts: Date | undefined;
      if (typeof loc.timestamp === 'number') {
        const d = new Date(loc.timestamp);
        if (!isNaN(d.getTime())) {
          ts = d;
        } // ms epoch
      } else if (typeof loc.timestamp === 'string' && loc.timestamp.trim()) {
        // Newer legacy Records.json uses an ISO 8601 string; older numeric-epoch
        // strings still parse as a number.
        const num = Number(loc.timestamp);
        const d = Number.isFinite(num) ? new Date(num) : new Date(loc.timestamp);
        if (!isNaN(d.getTime())) {
          ts = d;
        }
      }

      if (!ts && loc.timestampMs) {
        const num = Number(loc.timestampMs);
        if (!isNaN(num)) {
          ts = new Date(num);
        }
      }

      if (!timeframeContains(params.timeframe, ts)) {
        params.pipeline.drop?.('outside_timeframe');
        continue;
      }

      // Need both axes; (0,0) is null island, not a real fix.
      if (lat === undefined || lon === undefined || (lat === 0 && lon === 0)) {
        params.pipeline.drop?.('position_without_fix');
        continue;
      }

      // Per-file ordinal (only consumed by pushed rows) keeps bit-identical
      // timestamp+coord stationary samples distinct, so they don't collapse on the dedup hash.
      const item = {
        id: `google_location:${ts ? ts.toISOString() : 'nots'}:${lat},${lon}:${idx++}`,
        classification: 'location',
        timestamp: ts,
        location: { latitude: lat, longitude: lon },
        // No `Title`/`Name`: a Records.json fix has no name, and this parser
        // used to invent one — `Location ${lat}, ${lon}` — so the item would
        // not be titled by the synthetic `location.txt` filename. That title
        // was never rendered: a raw GPS `location.fix` routes to `position`
        // ONLY (destinationsFor in push/canonical.ts — it leaves the events
        // timeline entirely), so the string's single effect was to land in
        // `ci.position.name`, where a coordinate pair is not a place name. A
        // position with NO name is precisely what makes the row a candidate
        // for the reverse-geocoder to fill with a real one. Same shape gpx
        // already follows: emit `Name` only when the source actually carries
        // one.
        metadata: {
          Accuracy: loc.accuracy,
          Altitude: loc.altitude,
        },
        content: { filename: 'location.txt', data: async () => Buffer.from('') },
      };
      const g: Graph = { item };
      params.pipeline.push(g);
    }
  }
}

registerDataSource({
  name: 'google_location',
  title: 'Google Location History (Legacy)',
  icon: 'google_location.svg',
  description: 'Legacy Takeout Records.json parser (MVP)',
  newOptions: () => ({}) as GoogleLocationOptions,
  newFileImporter: () => new GoogleLocationFileImporter(),
});

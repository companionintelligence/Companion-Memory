/* GPX (GPS Exchange Format) datasource (TypeScript port) */
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { parseStringPromise } from 'xml2js';

import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Item } from './timeline';
import { timeframeContains } from './timeline';

interface GPXOptions {
  ownerEntityId?: number;
}

interface GPXTrackPoint {
  $: { lat: string; lon: string };
  ele?: string[];
  time?: string[];
  speed?: string[];
  hdop?: string[];
  vdop?: string[];
}

/** A `<trkseg>` as xml2js models it (repeated children arrive as arrays). */
interface GPXTrackSegment {
  trkpt?: GPXTrackPoint | GPXTrackPoint[];
}

/** A `<trk>`; xml2js wraps text nodes in single-element arrays. */
interface GPXTrack {
  name?: string[];
  type?: string[];
  trkseg?: GPXTrackSegment | GPXTrackSegment[];
}

interface GPXWaypoint {
  $: { lat: string; lon: string };
  name?: string[];
  ele?: string[];
  time?: string[];
  hdop?: string[];
  vdop?: string[];
}

/**
 * True when `filePath` sits inside a Strava archive (an `activities.csv` in the
 * file's own directory or an ancestor). Strava exports are per-activity .gpx
 * files under `activities/`, so recognizing them individually would let this
 * importer out-score strava.ts — recognition keeps the highest confidence per
 * data source across the whole tree, and a bare .gpx scores 1.0 against
 * Strava's 0.95. GPX would then win and activities.csv would be dropped.
 */
async function inStravaExport(filePath: string): Promise<boolean> {
  let dir = path.dirname(filePath);
  // activities/<file>.gpx -> activities/ -> export root. Two hops is enough;
  // bounded so a .gpx near the filesystem root can't walk up indefinitely.
  for (let i = 0; i < 3; i++) {
    try {
      await stat(path.join(dir, 'activities.csv'));

      return true;
    } catch {
      /* absent or unreadable — treat as not-Strava */
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }

    dir = parent;
  }

  return false;
}

export class GPXFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const baseDir = entry.fullPath || entry.fsRoot || entry.filename;
    if (!baseDir) {
      return { confidence: 0 };
    }

    // Check if it's a .gpx file
    if (baseDir.toLowerCase().endsWith('.gpx')) {
      // Defer to strava.ts for activity tracks inside a Strava archive.
      return (await inStravaExport(baseDir)) ? { confidence: 0 } : { confidence: 1.0 };
    }

    // Check if it's a directory (will walk it looking for .gpx files)
    try {
      if ((await stat(baseDir)).isDirectory()) {
        return { confidence: 0, dir_threshold: 0.9 };
      }
    } catch {
      /* absent or unreadable — no match */
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const startPath = entry.fullPath || entry.fsRoot || entry.filename;
    if (!startPath) {
      return;
    }

    const stat = fs.statSync(startPath);
    if (!stat.isDirectory()) {
      await this.processGPXFile(startPath, params);

      return;
    }

    // Walk directory for .gpx files
    for await (const fpath of this.walkDir(startPath)) {
      if (fpath.toLowerCase().endsWith('.gpx')) {
        await this.processGPXFile(fpath, params);
      }
    }
  }

  private async *walkDir(root: string): AsyncGenerator<string> {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(root, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.')) {
          continue;
        }

        yield* this.walkDir(full);
      } else if (e.isFile()) {
        yield full;
      }
    }
  }

  private async processGPXFile(fpath: string, params: ImportParams): Promise<void> {
    try {
      const content = await fs.promises.readFile(fpath, 'utf-8');
      const gpxData = await parseStringPromise(content);
      if (!gpxData.gpx) {
        params.log?.('warn', 'Invalid GPX file', { file: path.basename(fpath) });

        return;
      }

      // xml2js returns a bare object for a single child and an array for
      // several, so every repeated element has to be normalised. The caller
      // names the element shape; the parse itself is untyped by nature.
      const ensureArray = <T>(v: unknown): T[] =>
        Array.isArray(v) ? (v as T[]) : ([v].filter(Boolean) as T[]);
      // U-22: every trkpt/wpt read is counted, and every one that does not
      // become a row names the reason. Without this a .gpx whose whole track
      // fell outside the timeframe reported consumed 0 / produced 0 / dropped 0
      // — a perfectly reconciled ledger that accounted for nothing.
      //
      // `createLocationItem`/`createWaypointItem` return null only when the
      // point has no usable lat/lon, which is what `position_without_fix` names.

      // Tracks
      for (const track of ensureArray<GPXTrack>(gpxData.gpx.trk)) {
        for (const segment of ensureArray<GPXTrackSegment>(track?.trkseg)) {
          for (const trkpt of ensureArray<GPXTrackPoint>(segment?.trkpt)) {
            params.pipeline.consumed?.(1);
            const item = this.createLocationItem(trkpt, track?.type?.[0], track?.name?.[0], fpath);
            if (!item) {
              params.pipeline.drop?.('position_without_fix');
              continue;
            }

            if (!timeframeContains(params.timeframe, item.timestamp)) {
              params.pipeline.drop?.('outside_timeframe');
              continue;
            }

            params.pipeline.push({ item });
          }
        }
      }

      // Waypoints
      for (const wpt of ensureArray<GPXWaypoint>(gpxData.gpx.wpt)) {
        params.pipeline.consumed?.(1);
        const item = this.createWaypointItem(wpt, fpath);
        if (!item) {
          params.pipeline.drop?.('position_without_fix');
          continue;
        }

        if (!timeframeContains(params.timeframe, item.timestamp)) {
          params.pipeline.drop?.('outside_timeframe');
          continue;
        }

        params.pipeline.push({ item });
      }
    } catch (error) {
      params.log?.('error', 'Failed to parse GPX file', {
        file: path.basename(fpath),
        error: (error as Error).message,
      });
    }
  }

  private createLocationItem(
    trkpt: GPXTrackPoint,
    activityType: string | undefined,
    trackName: string | undefined,
    sourcePath: string,
  ): Item | null {
    const lat = parseFloat(trkpt.$.lat);
    const lon = parseFloat(trkpt.$.lon);

    if (isNaN(lat) || isNaN(lon)) {
      return null;
    }

    const item: Item = {
      classification: 'location',
      location: { latitude: lat, longitude: lon },
      intermediateLocation: sourcePath,
      content: {
        filename: path.basename(sourcePath),
      },
      metadata: {
        Source: 'GPX',
        // `<trk><name>` names the TRACK, not any point on it. It rides along as
        // `Track Name` — provenance, readable on the row — and deliberately NOT
        // as `Name`, which is the key `toPositionInput` reads as the place name
        // for the fix (push/inputs.ts).
        //
        // Stamped into `Name`, one 10 km run with `<name>Morning Run</name>`
        // gave ~1,000 trackpoints the identical place name; `promote.place_position`
        // then resolves the route into ~90 distinct 0.001-degree cells and mints
        // up to 90 Location entities all called "Morning Run" — one venue per
        // 100 m of pavement, none of them a place.
        //
        // Leaving `Name` unset does not leave the slot empty: `titleFor` falls
        // back to `basename(row.filename)`, so a nameless trkpt titles as
        // 'track.gpx', which `toPositionInput` already rejects as the record's
        // own staged filename. The fix keeps its coordinates and a NULL name,
        // which is what makes it a reverse-geocode candidate.
        //
        // Waypoints are untouched — `<wpt><name>` names a POINT, and
        // createWaypointItem still reads it as `Name`.
        ...(trackName && { 'Track Name': trackName }),
        ...(activityType && { 'Activity Type': activityType }),
      },
    };

    if (trkpt.time && trkpt.time[0]) {
      item.timestamp = new Date(trkpt.time[0]);
    }

    if (trkpt.ele && trkpt.ele[0]) {
      const ele = parseFloat(trkpt.ele[0]);
      if (!isNaN(ele) && item.metadata) {
        item.metadata.Elevation = ele;
      }
    }

    if (trkpt.speed && trkpt.speed[0]) {
      const speed = parseFloat(trkpt.speed[0]);
      if (!isNaN(speed) && item.metadata) {
        item.metadata.Velocity = speed;
      }
    }

    // GPX <hdop>/<vdop> ride along so the canonical mapping can derive a real
    // accuracy_meters for the position pipeline (HDOP * ~5m per unit on consumer
    // receivers). Most GPX writers omit these, so absence is normal — the
    // downstream mapper falls back to undefined and the server can default-on.
    if (trkpt.hdop && trkpt.hdop[0]) {
      const hdop = parseFloat(trkpt.hdop[0]);
      if (!isNaN(hdop) && item.metadata) {
        item.metadata.HDOP = hdop;
      }
    }

    if (trkpt.vdop && trkpt.vdop[0]) {
      const vdop = parseFloat(trkpt.vdop[0]);
      if (!isNaN(vdop) && item.metadata) {
        item.metadata.VDOP = vdop;
      }
    }

    return item;
  }

  private createWaypointItem(wpt: GPXWaypoint, sourcePath: string): Item | null {
    const lat = parseFloat(wpt.$.lat);
    const lon = parseFloat(wpt.$.lon);

    if (isNaN(lat) || isNaN(lon)) {
      return null;
    }

    const item: Item = {
      classification: 'location',
      location: { latitude: lat, longitude: lon },
      intermediateLocation: sourcePath,
      content: {
        filename: path.basename(sourcePath),
      },
      metadata: {
        Source: 'GPX',
        Type: 'Waypoint',
        ...(wpt.name && wpt.name[0] && { Name: wpt.name[0] }),
      },
    };

    if (wpt.time && wpt.time[0]) {
      item.timestamp = new Date(wpt.time[0]);
    }

    if (wpt.ele && wpt.ele[0]) {
      const ele = parseFloat(wpt.ele[0]);
      if (!isNaN(ele) && item.metadata) {
        item.metadata.Elevation = ele;
      }
    }

    if (wpt.hdop && wpt.hdop[0]) {
      const hdop = parseFloat(wpt.hdop[0]);
      if (!isNaN(hdop) && item.metadata) {
        item.metadata.HDOP = hdop;
      }
    }

    if (wpt.vdop && wpt.vdop[0]) {
      const vdop = parseFloat(wpt.vdop[0]);
      if (!isNaN(vdop) && item.metadata) {
        item.metadata.VDOP = vdop;
      }
    }

    return item;
  }
}

registerDataSource({
  name: 'gpx',
  title: 'GPS Exchange (GPX)',
  icon: 'gpx.svg',
  description: 'Import location tracks from .gpx files',
  newOptions: () => ({ ownerEntityId: undefined }) as GPXOptions,
  newFileImporter: () => new GPXFileImporter(),
});

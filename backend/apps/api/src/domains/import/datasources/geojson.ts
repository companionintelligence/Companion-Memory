/* GeoJSON datasource (basic TypeScript port) */
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { asRecord, asString, type JsonRecord } from './json';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

interface GeoJSONOptions {
  ownerEntityId?: number;
  lenient?: boolean;
}

type Position = number[]; // [lon, lat, (alt?)]
interface Geometry {
  type: string;
  coordinates: unknown;
}
interface Feature {
  type: 'Feature';
  properties?: JsonRecord;
  geometry: Geometry;
}
interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

function isFeatureCollection(o: unknown): o is FeatureCollection {
  const rec = asRecord(o);

  return !!rec && rec.type === 'FeatureCollection' && Array.isArray(rec.features);
}

/**
 * The feature's own time. GeoJSON has no time member; the de-facto conventions
 * carry an ISO string or an epoch number under one of these keys.
 */
function featureTime(props: JsonRecord): unknown {
  return props.time || props.timestamp || props.datetime;
}

/**
 * Per-point times, nested like the geometry: flat for a LineString or
 * MultiPoint, one array per line of a MultiLineString. togeojson (behind most
 * GPX and KML to GeoJSON converters) writes them to `coordinateProperties.times`
 * since 4.4, the geojson-coordinate-properties convention, and to `coordTimes`
 * before that. Each entry is an ISO string, epoch milliseconds or null.
 */
function perPointTimes(props: JsonRecord): unknown[] | undefined {
  const times = asRecord(props.coordinateProperties)?.times ?? props.coordTimes;

  return Array.isArray(times) ? times : undefined;
}

function toDate(raw: unknown): Date | undefined {
  // `new Date` takes both the ISO string and the epoch number.
  if (typeof raw === 'string' || typeof raw === 'number') {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return d;
    }
  }

  return undefined;
}

export class GeoJSONFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const full = entry.fullPath || entry.fsRoot || entry.filename;
    if (!full) {
      return { confidence: 0 };
    }

    let st: fs.Stats;
    try {
      st = await stat(full);
    } catch {
      return { confidence: 0 };
    }

    if (st.isFile() && path.extname(full).toLowerCase() === '.geojson') {
      return { confidence: 1.0 };
    }

    if (st.isDirectory()) {
      return { confidence: 0, dir_threshold: 0.9 };
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const start = entry.fullPath || entry.fsRoot || entry.filename;
    if (!start) {
      return;
    }

    const stat = fs.statSync(start);
    if (stat.isDirectory()) {
      for await (const f of this.walkDir(start)) {
        if (f.toLowerCase().endsWith('.geojson')) {
          await this.processFile(f, params);
        }
      }
    } else if (start.toLowerCase().endsWith('.geojson')) {
      await this.processFile(start, params);
    }
  }

  private async *walkDir(root: string): AsyncGenerator<string> {
    const ents = await fs.promises.readdir(root, { withFileTypes: true });
    for (const e of ents) {
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

  private async processFile(fpath: string, params: ImportParams): Promise<void> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', 'read geojson failed', {
        file: path.basename(fpath),
        error: (e as Error).message,
      });

      return;
    }

    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      params.log?.('error', 'parse geojson failed', {
        file: path.basename(fpath),
        error: (e as Error).message,
      });

      return;
    }

    if (!isFeatureCollection(doc)) {
      params.log?.('warn', 'not a FeatureCollection', { file: path.basename(fpath) });

      return;
    }

    let featureIdx = 0;
    for (const feat of doc.features) {
      if (!feat || !feat.geometry) {
        // U-22: a feature with no geometry is one record read that produced
        // nothing. Counted at feature granularity here and at POSITION
        // granularity in emitPosition, because that is the unit each of them
        // actually loses — one LineString feature is N candidate fixes.
        params.pipeline.consumed?.(1);
        params.pipeline.drop?.('position_without_fix');
        featureIdx++;
        continue;
      }

      // The per-point arrays are read here and kept out of `props`, which every
      // point copies into its metadata: a 10,000-point track would otherwise
      // stage 10,000 copies of a 10,000-entry array.
      const featureProps = feat.properties || {};
      const times = perPointTimes(featureProps);
      const { coordinateProperties: _perPoint, coordTimes: _legacyPerPoint, ...props } = featureProps;
      const geom = feat.geometry;
      try {
        switch (geom.type) {
          case 'Point':
            this.emitPosition(
              params,
              fpath,
              geom.coordinates as Position,
              props,
              featureIdx,
              0,
              featureTime(props),
            );
            break;
          case 'MultiPoint':
          case 'LineString':
            this.emitPoints(
              params,
              fpath,
              [geom.coordinates as Position[]],
              times && [times],
              props,
              featureIdx,
            );
            break;
          case 'MultiLineString':
            this.emitPoints(params, fpath, geom.coordinates as Position[][], times, props, featureIdx);
            break;

          default:
            // skip unsupported geometry types
            break;
        }
      } catch (e) {
        params.log?.('warn', 'feature processing failed', { error: (e as Error).message });
      }

      featureIdx++;
    }
  }

  /**
   * The points of a MultiPoint, LineString or MultiLineString, as `lines` of
   * positions with `times` nested the same way.
   *
   * One running counter across every line of the feature, never reset per
   * line, so each position gets a strictly increasing, never-colliding index.
   * A per-line reset combined with a `lineIdx * 100000 + i` compound index
   * looks collision-safe but isn't: it collides as soon as any single line
   * carries 100,000 or more positions.
   *
   * Without per-point times every point would carry the feature's one time,
   * and `ci.position` keeps one fix per user per instant: the store kept the
   * last point and Sync still counted every one as written. So the first point
   * that lands takes the feature's time and each later one is counted as
   * `position_shared_time` instead of being sent to collapse.
   */
  private emitPoints(
    params: ImportParams,
    sourcePath: string,
    lines: Position[][],
    times: unknown[] | undefined,
    props: JsonRecord,
    featureIdx: number,
  ): void {
    const sharedTime = featureTime(props);
    const hasSharedTime = toDate(sharedTime) !== undefined;
    let sharedTimeTaken = false;
    let i = 0;
    let l = 0;
    // for...of rather than counting to `.length`: the coordinates are whatever
    // the file says, and `"coordinates": {"length": 1e15}` would spin here
    // without reading a point. Not iterable throws, and the caller logs it.
    for (const line of lines) {
      const lineTimes = times?.[l++];
      let j = 0;
      for (const pos of line) {
        const posIdx = i++;
        const own = Array.isArray(lineTimes) ? lineTimes[j] : undefined;
        j++;
        if (times) {
          this.emitPosition(params, sourcePath, pos, props, featureIdx, posIdx, own);
        } else if (hasSharedTime && sharedTimeTaken) {
          params.pipeline.consumed?.(1);
          params.pipeline.drop?.('position_shared_time');
        } else if (this.emitPosition(params, sourcePath, pos, props, featureIdx, posIdx, sharedTime)) {
          sharedTimeTaken = true;
        }
      }
    }
  }

  /** Push one position, or count why not. Returns whether it was pushed. */
  private emitPosition(
    params: ImportParams,
    sourcePath: string,
    pos: Position,
    props: JsonRecord,
    featureIdx: number,
    posIdx: number,
    rawTime: unknown,
  ): boolean {
    // One candidate fix read. Every path below either pushes it or drops it, so
    // this is what makes `consumed = produced + dropped` a real equality rather
    // than the 0 = 0 + 0 the parser used to report (U-22).
    params.pipeline.consumed?.(1);

    if (!Array.isArray(pos) || pos.length < 2) {
      params.pipeline.drop?.('position_without_fix');

      return false;
    }

    const lon = parseFloat(String(pos[0]));
    const lat = parseFloat(String(pos[1]));
    if (isNaN(lat) || isNaN(lon)) {
      params.pipeline.drop?.('position_without_fix');

      return false;
    }

    const ts = toDate(rawTime);
    if (!timeframeContains(params.timeframe, ts)) {
      params.pipeline.drop?.('outside_timeframe');

      return false;
    }

    const altitude = pos.length >= 3 && typeof pos[2] === 'number' ? pos[2] : undefined;
    // GeoJSON `name`/simplestyle `title` and `description` are lower-case, but
    // titleFor/descriptionFor only read capitalised keys — promote them so a
    // feature with a name doesn't fall back to the bare filename as its title.
    // Narrowed to strings: these feed titleFor/descriptionFor and land in
    // metadata, both of which want text. A non-string `name` is out of spec.
    const title = asString(props.name) ?? asString(props.title);
    const description = asString(props.description);
    const item = {
      id: `geojson:${path.basename(sourcePath)}:${featureIdx}:${posIdx}`,
      classification: 'location',
      timestamp: ts,
      location: { latitude: lat, longitude: lon },
      intermediateLocation: sourcePath,
      content: { filename: path.basename(sourcePath) },
      metadata: {
        Source: 'GeoJSON',
        ...(title != null && { Name: title }),
        ...(description != null && { Description: description }),
        ...(altitude !== undefined && { Altitude: altitude }),
        ...props,
      },
    };
    params.pipeline.push({ item });

    return true;
  }
}

registerDataSource({
  name: 'geojson',
  title: 'GeoJSON',
  icon: 'geojson.svg',
  description: 'GeoJSON FeatureCollection files of points/lines',
  newOptions: () => ({ ownerEntityId: undefined, lenient: false }) as GeoJSONOptions,
  newFileImporter: () => new GeoJSONFileImporter(),
});

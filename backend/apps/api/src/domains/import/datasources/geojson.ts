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
        featureIdx++;
        continue;
      }

      const props = feat.properties || {};
      const geom = feat.geometry;
      try {
        switch (geom.type) {
          case 'Point':
            this.emitPosition(params, fpath, geom.coordinates as Position, props, featureIdx, 0);
            break;
          case 'MultiPoint':
          case 'LineString': {
            let i = 0;
            for (const pos of geom.coordinates as Position[]) {
              this.emitPosition(params, fpath, pos, props, featureIdx, i++);
            }

            break;
          }

          case 'MultiLineString': {
            // One running counter across every constituent line of this
            // feature — never reset per line — so each position gets a
            // strictly increasing, never-colliding index. A per-line reset
            // combined with a `lineIdx * 100000 + i` compound index looks
            // collision-safe but isn't: it collides as soon as any single
            // line carries 100,000 or more positions.
            let i = 0;
            for (const line of geom.coordinates as Position[][]) {
              for (const pos of line) {
                this.emitPosition(params, fpath, pos, props, featureIdx, i++);
              }
            }

            break;
          }

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

  private emitPosition(
    params: ImportParams,
    sourcePath: string,
    pos: Position,
    props: JsonRecord,
    featureIdx: number,
    posIdx: number,
  ): void {
    if (!Array.isArray(pos) || pos.length < 2) {
      return;
    }

    const lon = parseFloat(String(pos[0]));
    const lat = parseFloat(String(pos[1]));
    if (isNaN(lat) || isNaN(lon)) {
      return;
    }

    let ts: Date | undefined;
    const rawTime = props.time || props.timestamp || props.datetime;
    // GeoJSON has no time member; the de-facto conventions carry an ISO string
    // or an epoch number, which is exactly what `new Date` accepts here.
    if (typeof rawTime === 'string' || typeof rawTime === 'number') {
      const d = new Date(rawTime);
      if (!isNaN(d.getTime())) {
        ts = d;
      }
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
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

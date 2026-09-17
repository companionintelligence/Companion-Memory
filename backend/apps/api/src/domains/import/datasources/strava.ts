/* Strava — activities.csv + per-activity GPX files from a Strava archive request. */
import fs from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { parseCSV } from './csv';
import { GPXFileImporter } from './gpx';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import { csvHeaderHas } from './sniff';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

const gunzip = promisify(zlib.gunzip);

export class StravaFileImporter implements FileImporter {
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

    // The columns the parser reads. 'activities.csv' is a name any fitness
    // export might use; Strava's header is what makes it Strava's.
    const isStravaActivities = (fpath: string) => csvHeaderHas(fpath, ['activity id', 'activity date']);

    if (st.isFile()) {
      return path.basename(root).toLowerCase() === 'activities.csv' && (await isStravaActivities(root))
        ? { confidence: 0.9 }
        : { confidence: 0 };
    }

    if (st.isDirectory()) {
      try {
        const names = (await readdir(root)).map((n) => n.toLowerCase());
        const activitiesOk =
          names.includes('activities.csv') && (await isStravaActivities(path.join(root, 'activities.csv')));
        if (activitiesOk && names.includes('activities')) {
          return { confidence: 0.95 };
        }

        if (activitiesOk) {
          return { confidence: 0.85 };
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

    let csvPath: string;
    let activitiesDir: string | undefined;
    try {
      const stat = fs.statSync(root);
      if (stat.isFile()) {
        csvPath = root;
        activitiesDir = path.join(path.dirname(root), 'activities');
      } else {
        csvPath = path.join(root, 'activities.csv');
        activitiesDir = path.join(root, 'activities');
      }
    } catch {
      return;
    }

    if (!fs.existsSync(csvPath)) {
      return;
    }

    let raw: string;
    try {
      raw = await fs.promises.readFile(csvPath, 'utf8');
    } catch (e) {
      params.log?.('error', 'Failed to read activities.csv', { error: (e as Error).message });

      return;
    }

    const rows = parseCSV(raw);
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const actDate = row['Activity Date'] ? new Date(row['Activity Date']) : undefined;
      if (!timeframeContains(params.timeframe, actDate)) {
        continue;
      }

      const actName = row['Activity Name'] || '';
      const actType = row['Activity Type'] || '';
      const elapsed = row['Elapsed Time'] ? parseInt(row['Elapsed Time'], 10) : undefined;
      const distance = row['Distance'] ? parseFloat(row['Distance']) : undefined;

      // Give the activity summary a map point by reading the first GPS fix from
      // its track file (the full track is still imported as trackpoints below).
      const gpxFilename = row['Filename'];
      const start =
        gpxFilename && activitiesDir && fs.existsSync(activitiesDir)
          ? await this.firstCoordFromActivity(gpxFilename, activitiesDir)
          : undefined;

      params.pipeline.push({
        item: {
          classification: 'workout',
          id: row['Activity ID']
            ? `strava:${row['Activity ID']}`
            : `strava:${path.basename(csvPath)}:${index}`,
          timestamp: actDate,
          ...(start && { location: start }),
          content: {
            filename: 'activity.txt',
            mediaType: 'text/plain',
            data: async () => Buffer.from(actName || actType),
          },
          metadata: {
            'Activity ID': row['Activity ID'] || undefined,
            Name: actName || actType || 'Strava Activity',
            'Activity Type': actType || undefined,
            'Elapsed Time (s)': elapsed,
            Distance: distance,
            ...(start && { Location: `${start.latitude}, ${start.longitude}` }),
            Source: 'Strava',
          },
        },
      });

      if (gpxFilename && activitiesDir && fs.existsSync(activitiesDir)) {
        await this.processGpxFile(gpxFilename, activitiesDir, params);
      }
    }
  }

  // Read just the first GPS fix from an activity's GPX (handling .gpx and
  // .gpx.gz) so the workout summary item can be placed on the map. Only the head
  // of the file is scanned — enough to reach the first trackpoint.
  private async firstCoordFromActivity(
    filename: string,
    activitiesDir: string,
  ): Promise<{ latitude: number; longitude: number } | undefined> {
    const base = path.basename(filename);
    const fullPath = path.join(activitiesDir, base);
    if (!fs.existsSync(fullPath)) {
      return undefined;
    }

    let buf: Buffer;
    try {
      if (base.endsWith('.gpx.gz')) {
        buf = (await gunzip(await fs.promises.readFile(fullPath))) as Buffer;
      } else if (base.endsWith('.gpx')) {
        buf = await fs.promises.readFile(fullPath);
      } else {
        return undefined;
      } // .fit / .fit.gz — no cheap text parse
    } catch {
      return undefined;
    }

    const head = buf.toString('utf8', 0, Math.min(buf.length, 20000));
    const tag = /<(?:trkpt|rtept|wpt)\b[^>]*>/i.exec(head);
    if (!tag) {
      return undefined;
    }

    const lat = /\blat="(-?\d+(?:\.\d+)?)"/i.exec(tag[0]);
    const lon = /\blon="(-?\d+(?:\.\d+)?)"/i.exec(tag[0]);
    if (!lat || !lon) {
      return undefined;
    }

    const latitude = parseFloat(lat[1]);
    const longitude = parseFloat(lon[1]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return undefined;
    }

    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return undefined;
    }

    return { latitude, longitude };
  }

  private async processGpxFile(filename: string, activitiesDir: string, params: ImportParams): Promise<void> {
    const base = path.basename(filename);
    const fullPath = path.join(activitiesDir, base);
    if (!fs.existsSync(fullPath)) {
      return;
    }

    if (base.endsWith('.gpx')) {
      const gpxImporter = new GPXFileImporter();
      await gpxImporter.fileImport({}, { filename: base, fullPath }, params);
    } else if (base.endsWith('.gpx.gz')) {
      try {
        const compressed = await fs.promises.readFile(fullPath);
        const decompressed = (await gunzip(compressed)) as Buffer;
        const tmpPath = path.join(os.tmpdir(), `ci-strava-${Date.now()}-${base.replace('.gz', '')}`);
        await fs.promises.writeFile(tmpPath, decompressed);
        try {
          const gpxImporter = new GPXFileImporter();
          await gpxImporter.fileImport({}, { filename: base, fullPath: tmpPath }, params);
        } finally {
          await fs.promises.unlink(tmpPath).catch(() => {});
        }
      } catch (e) {
        params.log?.('warn', 'Failed to decompress .gpx.gz', { file: base, error: (e as Error).message });
      }
    } else if (!base.endsWith('.fit.gz')) {
      params.log?.('debug', 'Skipping non-GPX activity file', { file: base });
    }
  }
}

registerDataSource({
  name: 'strava',
  title: 'Strava',
  icon: '',
  description: 'Activities (GPS, HR, splits) from a Strava archive request.',
  newFileImporter: () => new StravaFileImporter(),
});

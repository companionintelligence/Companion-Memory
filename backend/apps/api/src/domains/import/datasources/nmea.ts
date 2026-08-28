/* NMEA GPS sentences datasource (MVP) */
import fs from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { FileImporter, DirEntry, Recognition } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, Graph } from './timeline';
import { timeframeContains } from './timeline';

type NMEAOptions = Record<string, never>;

export class NMEAFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const full = entry.fullPath || entry.fsRoot || entry.filename;
    if (!full) {
      return { confidence: 0 };
    }

    try {
      if ((await stat(full)).isFile()) {
        const ext = path.extname(full).toLowerCase();
        if (ext === '.nmea' || ext === '.log' || ext === '.txt') {
          const first = (await readFile(full, 'utf8')).split(/\n/).slice(0, 5).join('\n');
          if (/^\$GP(RMC|GGA)/m.test(first)) {
            return { confidence: 0.8 };
          }
        }
      }
    } catch {
      /* ignore */
    }

    return { confidence: 0 };
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const start = entry.fullPath || entry.fsRoot || entry.filename;
    if (!start) {
      return;
    }

    if (!fs.existsSync(start) || !fs.statSync(start).isFile()) {
      return;
    }

    const lines = fs.readFileSync(start, 'utf8').split(/\r?\n/);
    // Track last-seen RMC date so GPGGA sentences (which carry no date) can
    // inherit it. In a GGA-only file there is nothing to inherit and the fix
    // stays undated — see parseDateTimeUTC for why that beats today's date.
    let lastRmcDate: string | undefined;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('$GP')) {
        continue;
      }

      const parts = line.split(',');
      if (parts[0] === '$GPRMC') {
        if (parts[9]?.length === 6) {
          lastRmcDate = parts[9];
        }

        this.parseGPRMC(parts, params, start, i);
      } else if (parts[0] === '$GPGGA') {
        this.parseGPGGA(parts, params, start, i, lastRmcDate);
      }
    }
  }

  private parseGPRMC(p: string[], params: ImportParams, file: string, lineIndex: number) {
    // $GPRMC,hhmmss.sss,A,llll.ll,a,yyyyy.yy,a,speed,track,date,...
    if (p.length < 10) {
      return;
    }

    if (p[2] !== 'A') {
      return;
    } // data valid

    const timeUTC = p[1];
    const date = p[9];
    const ts = parseDateTimeUTC(date, timeUTC);
    const lat = parseLat(p[3], p[4]);
    const lon = parseLon(p[5], p[6]);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    if (lat === undefined || lon === undefined) {
      return;
    }

    pushLocation(params, ts, lat, lon, undefined, file, lineIndex, 'RMC');
  }

  private parseGPGGA(p: string[], params: ImportParams, file: string, lineIndex: number, rmcDate?: string) {
    // $GPGGA,hhmmss.sss,llll.ll,a,yyyyy.yy,a,fix,...,alt,M,...
    if (p.length < 10) {
      return;
    }

    const timeUTC = p[1];
    // Use the most recently seen RMC date. A pure GGA-only file yields no date
    // at all, and the fix is emitted undated rather than dated today.
    const ts = parseDateTimeUTC(rmcDate, timeUTC);
    const lat = parseLat(p[2], p[3]);
    const lon = parseLon(p[4], p[5]);
    const alt = parseFloat(p[9]);
    if (lat === undefined || lon === undefined) {
      return;
    }

    pushLocation(params, ts, lat, lon, isNaN(alt) ? undefined : alt, file, lineIndex, 'GGA');
  }
}

function parseDateTimeUTC(dateDDMMYY: string | undefined, timeHHMMSS: string): Date | undefined {
  if (!timeHHMMSS) {
    return undefined;
  }

  // A GGA sentence carries a time of day and NO date; only RMC/ZDA carry one.
  // This used to fill the gap with today's UTC date, which turns a log recorded
  // on some past trip into a GPS fix asserting the user was at those
  // coordinates TODAY — and a `location.fix` record's whole content is
  // (lat, lon, time), so a fabricated time makes the whole row a fabrication.
  // Worse than a wrong timeline entry: position rows are
  // LocationEstimateService's primary donors, so the invented fix drags every
  // neighbouring inference with it.
  //
  // Returning undefined is the honest answer. Downstream that is a record with
  // `dated === false`, which `destinationsFor` routes away from `ci.position`
  // entirely (push/canonical.ts withoutFabricatedPositionFix) — the fix is
  // dropped and counted rather than invented. A dateless GGA in a file that
  // ALSO has RMC/ZDA sentences is unaffected: the caller passes the date those
  // carry.
  if (!dateDDMMYY || dateDDMMYY.length !== 6) {
    return undefined;
  }

  const day = parseInt(dateDDMMYY.slice(0, 2), 10);
  const month = parseInt(dateDDMMYY.slice(2, 4), 10) - 1;
  const year = 2000 + parseInt(dateDDMMYY.slice(4, 6), 10);

  const hh = parseInt(timeHHMMSS.slice(0, 2), 10) || 0;
  const mm = parseInt(timeHHMMSS.slice(2, 4), 10) || 0;
  const ss = parseInt(timeHHMMSS.slice(4, 6), 10) || 0;

  return new Date(Date.UTC(year, month, day, hh, mm, ss));
}

function parseLat(raw: string, hemi: string): number | undefined {
  if (!raw) {
    return;
  }

  const deg = parseFloat(raw.slice(0, 2));
  const min = parseFloat(raw.slice(2));
  if (isNaN(deg) || isNaN(min)) {
    return;
  }

  let v = deg + min / 60;
  if (hemi === 'S') {
    v = -v;
  }

  return v;
}

function parseLon(raw: string, hemi: string): number | undefined {
  if (!raw) {
    return;
  }

  const deg = parseFloat(raw.slice(0, 3));
  const min = parseFloat(raw.slice(3));
  if (isNaN(deg) || isNaN(min)) {
    return;
  }

  let v = deg + min / 60;
  if (hemi === 'W') {
    v = -v;
  }

  return v;
}

function pushLocation(
  params: ImportParams,
  ts: Date | undefined,
  lat: number,
  lon: number,
  alt: number | undefined,
  source: string,
  lineIndex: number,
  tag: string,
) {
  if (!timeframeContains(params.timeframe, ts)) {
    return;
  }

  const item = {
    id: `nmea:${path.basename(source)}:${lineIndex}:${tag}`,
    classification: 'location',
    timestamp: ts,
    location: { latitude: lat, longitude: lon },
    // No `Name`: an NMEA sentence has no name to give. The invented
    // `Location ${lat}, ${lon}` was never rendered as a title — a raw GPS
    // `location.fix` routes to `position` ONLY (destinationsFor in
    // push/canonical.ts) — it only ever landed in `ci.position.name`, where a
    // coordinate pair is not a place name. A null name is what makes the row a
    // reverse-geocode candidate.
    metadata: { Altitude: alt },
    content: { filename: path.basename(source), data: async () => Buffer.from('') },
  };
  const g: Graph = { item };
  params.pipeline.push(g);
}

registerDataSource({
  name: 'nmea',
  title: 'NMEA GPS',
  icon: 'nmea.svg',
  description: 'NMEA sentence logs ($GPRMC/$GPGGA) to location items (MVP)',
  newOptions: () => ({}) as NMEAOptions,
  newFileImporter: () => new NMEAFileImporter(),
});

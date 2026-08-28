/* Lyft — ride history from a Lyft GDPR data export.
 *
 * The rides live in `passenger_rides.csv` in a current export; older vintages
 * and hand-rolled extracts name the file and its columns differently, so every
 * column read goes through `pick()` with a candidate list, the same way the
 * Uber importer serves both of its schemas from one code path.
 *
 * One row -> one 'trip' item anchored at the pickup, plus a 'location' item for
 * each of the request / pickup / dropoff fixes the row actually carries. Each
 * fix is independent: a row missing its request coordinates still yields the
 * pickup and dropoff positions. Cancelled rides are skipped.
 *
 * Shape, metadata keys and id strategy deliberately track `uber.ts` — the two
 * sources describe the same kind of event, and a timeline that renders a Lyft
 * ride differently from an Uber one is only telling you which app was open. */
import fs from 'node:fs';
import { open, readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams } from './timeline';
import { timeframeContains } from './timeline';

// True when the CSV header row carries a column hinting at a Lyft ride export.
function headerHasRideCols(text: string): boolean {
  const nl = text.indexOf('\n');
  const header = (nl === -1 ? text : text.slice(0, nl)).toLowerCase();

  return (
    header.includes('pickup') ||
    header.includes('dropoff') ||
    header.includes('requested_at') ||
    header.includes('requested_timestamp')
  );
}

// The filenames a Lyft export uses for its ride history. `passenger_rides.csv`
// is what the current export ships; `rides.csv` covers older/derived extracts.
const RIDES_FILENAMES = ['passenger_rides.csv', 'rides.csv'];

// Case-insensitive lookup of the first present, non-empty column among
// candidates. Returns '' rather than undefined so callers read like uber.ts's.
function pick(row: Record<string, string>, lower: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    const actual = lower[k.toLowerCase()];
    if (actual !== undefined) {
      const v = row[actual];
      if (v !== undefined && v !== '') {
        return v;
      }
    }
  }

  return '';
}

// Parse a Lyft timestamp: "2024-05-15 01:19:41 UTC" (current export), ISO 8601,
// or unix seconds/ms. The epoch test runs first because a bare 10-digit number
// is a date to Lyft and nonsense to Date's string parser.
function parseTimestamp(raw: string | undefined): Date | undefined {
  if (!raw) {
    return undefined;
  }

  const s = raw.trim();
  if (!s) {
    return undefined;
  }

  // Pure-numeric → unix epoch. 13+ digits = ms, otherwise seconds.
  if (/^\d{9,}$/.test(s)) {
    const n = Number(s);
    const ms = s.length >= 13 ? n : n * 1000;
    const d = new Date(ms);

    return isNaN(d.getTime()) ? undefined : d;
  }

  // Handles both ISO 8601 and the export's "YYYY-MM-DD HH:MM:SS UTC".
  const direct = new Date(s);
  if (!isNaN(direct.getTime())) {
    return direct;
  }

  // Last resort: a space-separated stamp with no zone that Date rejected.
  const d = new Date(s.replace(' ', 'T'));

  return isNaN(d.getTime()) ? undefined : d;
}

function toNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const cleaned = raw.replace(/[$,]/g, '').trim();
  if (!cleaned) {
    return undefined;
  }

  const n = Number(cleaned);

  return isNaN(n) ? undefined : n;
}

// Parse a CSV coordinate cell to a finite number, or undefined when blank/junk.
function parseCoord(v: string | undefined): number | undefined {
  if (!v) {
    return undefined;
  }

  const n = parseFloat(v);

  return Number.isFinite(n) ? n : undefined;
}

export class LyftFileImporter implements FileImporter {
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
      const base = path.basename(root).toLowerCase();
      if (path.extname(base) !== '.csv') {
        return { confidence: 0 };
      }

      if (!(await this.headerMatches(root))) {
        return { confidence: 0 };
      }

      return { confidence: RIDES_FILENAMES.includes(base) ? 0.95 : 0.85 };
    }

    if (stat.isDirectory()) {
      const csv = await this.findCsv(root);
      if (csv) {
        return { confidence: RIDES_FILENAMES.includes(path.basename(csv).toLowerCase()) ? 0.95 : 0.85 };
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  /**
   * Locate a matching ride CSV in a directory, recursing up to two levels deep.
   *
   * The exact-filename check (`passenger_rides.csv` / `rides.csv`, still
   * header-validated) is safe to run at every level: it is specific enough
   * that a coincidental hit deep inside an unrelated export is vanishingly
   * unlikely. The generic "any .csv whose header merely mentions a
   * pickup/dropoff column" fallback is a much weaker signal — 'pickup' and
   * 'dropoff' are ordinary English words that turn up in unrelated CSVs (a
   * moving-house checklist, a shipping log) — so it is only trusted at the
   * directory the CALLER actually asked about (`depth === 0`), never at a
   * directory this function walked into on its own. Checking it at every
   * recursion level used to mean one such coincidental CSV, anywhere inside a
   * multi-GB unrelated export, could claim confidence for the entire tree
   * above it — at the path the caller queried, not the file that matched.
   */
  private async findCsv(dir: string, depth = 0): Promise<string | undefined> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return undefined;
    }

    // Prefer a known ride filename at this level over an incidental CSV whose
    // header happens to mention a pickup.
    for (const wanted of RIDES_FILENAMES) {
      const exact = names.find((n) => n.toLowerCase() === wanted);
      if (exact && (await this.headerMatches(path.join(dir, exact)))) {
        return path.join(dir, exact);
      }
    }

    if (depth === 0) {
      for (const name of names) {
        if (path.extname(name).toLowerCase() !== '.csv') {
          continue;
        }

        const fpath = path.join(dir, name);
        if (await this.headerMatches(fpath)) {
          return fpath;
        }
      }
    }

    if (depth < 2) {
      for (const name of names) {
        const sub = path.join(dir, name);
        let s: fs.Stats;
        try {
          s = await fsStat(sub);
        } catch {
          continue;
        }

        if (s.isDirectory()) {
          const found = await this.findCsv(sub, depth + 1);
          if (found) {
            return found;
          }
        }
      }
    }

    return undefined;
  }

  // Read only the first ~8KB to inspect the CSV header row.
  private async headerMatches(fpath: string): Promise<boolean> {
    try {
      const fh = await open(fpath, 'r');
      try {
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await fh.read(buf, 0, 8192, 0);
        let text = buf.toString('utf8', 0, bytesRead);
        if (text.charCodeAt(0) === 0xfeff) {
          text = text.slice(1);
        }

        return headerHasRideCols(text);
      } finally {
        await fh.close().catch(() => {});
      }
    } catch {
      return false;
    }
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

    let fpath: string | undefined;
    if (stat.isFile()) {
      fpath = root;
    } else if (stat.isDirectory()) {
      fpath = await this.findCsv(root);
    }

    if (!fpath) {
      params.log?.('error', 'Lyft: no ride CSV found', { root });

      return;
    }

    await this.processFile(fpath, params);
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
      params.log?.('warn', `Lyft: ${base} parsed 0 rows`);
    }

    for (let i = 0; i < rows.length; i++) {
      try {
        this.pushTrip(rows[i], i, params);
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private pushTrip(row: Record<string, string>, rowIndex: number, params: ImportParams): void {
    // Build a case-insensitive header → actual-key map once per row.
    const lower: Record<string, string> = {};
    for (const k of Object.keys(row)) {
      lower[k.toLowerCase()] = k;
    }

    const get = (...keys: string[]) => pick(row, lower, keys);

    const status = get('status', 'ride_status');
    // A ride that never happened is not a trip. Matched on the stem because the
    // status is spelled several ways (canceled / cancelled / rider_canceled),
    // and reported to the drop ledger rather than silently discarded — the same
    // contract uber.ts keeps.
    if (/cancel/i.test(status)) {
      params.pipeline.drop?.('cancelled_trip', status);

      return;
    }

    const requestedTsRaw = get('requested_timestamp', 'requested_at', 'request_timestamp');
    const pickupTsRaw = get('pickup_timestamp', 'pickup_at', 'picked_up_at');
    const dropoffTsRaw = get('dropoff_timestamp', 'dropoff_at', 'dropped_off_at', 'completed_at');

    const requestedTs = parseTimestamp(requestedTsRaw);
    const pickupTs = parseTimestamp(pickupTsRaw);
    const dropoffTs = parseTimestamp(dropoffTsRaw);

    // The ride begins when the driver picks you up. Where the export has no
    // pickup copy, the request stands in for it — the same fallback uber.ts
    // makes, and safe for the same reason: the request goes out shortly before
    // the pickup even for a ride booked days ahead, so it dates the ride within
    // minutes rather than stretching it back to whenever you scheduled it.
    // Extracts recording only requested_at/completed_at are a real Lyft shape,
    // and dropping them would lose the ride outright. Cancelled rows — the ones
    // that legitimately never got past a request — are already gone by here.
    const ts = pickupTs ?? requestedTs;
    if (!ts) {
      params.pipeline.drop?.('trip_without_start_time', get('pickup_address', 'pickup', 'origin'));

      return;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const seconds = toNumber(get('trip_duration_seconds', 'duration_seconds', 'ride_duration_seconds'));
    const durationSeconds =
      seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;

    // End time and duration each stand in for the other, and where the export
    // gives neither the ride stays a point in time rather than having a span
    // invented for it. When both are present each is read from its own column:
    // see the note in uber.ts — a derived value can contradict the export's own.
    const end =
      dropoffTs ?? (durationSeconds != null ? new Date(ts.getTime() + durationSeconds * 1000) : undefined);
    const elapsedMs = dropoffTs ? dropoffTs.getTime() - ts.getTime() : undefined;
    const durationMinutes =
      durationSeconds != null
        ? Math.round(durationSeconds / 60)
        : elapsedMs != null && elapsedMs >= 0
          ? Math.round(elapsedMs / 60000)
          : undefined;

    // The current export names the dropoff address `destination_address`; the
    // `dropoff_*` spellings cover the other vintages.
    const origin = get('pickup_address', 'pickup', 'origin');
    const dest = get('destination_address', 'dropoff_address', 'dropoff', 'destination');
    const summary = origin && dest ? `${origin} → ${dest}` : origin || dest || 'Lyft trip';
    // The event's own title, phrased for a human timeline. Degrades cleanly when
    // the export recorded only one end of the route.
    const title =
      origin && dest
        ? `Lyft ride from ${origin} to ${dest}`
        : origin
          ? `Lyft ride from ${origin}`
          : dest
            ? `Lyft ride to ${dest}`
            : 'Lyft ride';

    const request = this.coordsOf(
      row,
      lower,
      ['requested_lat', 'request_lat'],
      ['requested_lng', 'request_lng'],
    );
    const pickup = this.coordsOf(row, lower, ['pickup_lat'], ['pickup_lng']);
    const dropoff = this.coordsOf(row, lower, ['dropoff_lat'], ['dropoff_lng']);

    const city = get('city', 'city_name');
    const product = get('ride_type', 'product_type_name', 'product');
    const distance = get('distance_miles', 'distance', 'trip_distance_miles');
    const fare = get('fare', 'total_money', 'amount', 'total', 'fare_amount');
    const currency = get('currency', 'currency_code');
    const rideId = get('ride_id', 'id');

    // Stable id: the export's own ride id where it has one, otherwise the same
    // composite uber.ts builds. Either way it is identical across re-runs — the
    // row's position in the file is not, so it is used only as a last resort.
    const key = rideId
      ? `lyft|${rideId}`
      : pickupTsRaw || requestedTsRaw
        ? ['lyft', pickupTsRaw || requestedTsRaw, origin, dest, fare].join('|')
        : `lyft-row-${rowIndex}`;

    params.pipeline.push({
      item: {
        id: key,
        classification: 'trip',
        timestamp: ts,
        ...(end ? { timespanEnd: end } : {}),
        // The event is anchored where the ride began, or — failing that — where
        // it was requested from, which is within a block of it.
        ...((pickup ?? request) ? { location: pickup ?? request } : {}),
        content: { filename: 'trip.txt', mediaType: 'text/plain', data: async () => Buffer.from(summary) },
        metadata: {
          Title: title,
          'Ride ID': rideId || undefined,
          City: city || undefined,
          'Product Type': product || undefined,
          // Uber's key names, because these are the same fields about the same
          // kind of event — a consumer that reads one ride source reads both.
          'Pickup Address': origin || undefined,
          'Dropoff Address': dest || undefined,
          'Distance (miles)': distance || undefined,
          'Duration (minutes)': durationMinutes,
          'Fare Amount': fare || undefined,
          'Fare Currency': currency || undefined,
          Status: status || undefined,
          Summary: summary,
          Source: 'Lyft',
        },
      },
    });

    // Each recorded fix of the ride as its own position, resolved independently:
    // a row that lost one leg's coordinates still contributes the other two.
    // The trip event carries only the pickup, so without these the request and
    // dropoff coordinates would not reach the position table at all.
    this.pushTripPosition(`${key}|request`, 'Request', request, requestedTs, '', title, params);
    this.pushTripPosition(`${key}|pickup`, 'Pickup', pickup, pickupTs ?? ts, origin, title, params);
    this.pushTripPosition(`${key}|dropoff`, 'Dropoff', dropoff, dropoffTs ?? end, dest, title, params);
  }

  // Every coordinate pair reads the same way: (0,0) is the placeholder for a
  // leg with no recorded GPS, so it is missing rather than a point at sea.
  private coordsOf(
    row: Record<string, string>,
    lower: Record<string, string>,
    latKeys: string[],
    lonKeys: string[],
  ): { latitude: number; longitude: number } | undefined {
    const lat = parseCoord(pick(row, lower, latKeys));
    const lon = parseCoord(pick(row, lower, lonKeys));
    if (lat === undefined || lon === undefined) {
      return undefined;
    }

    if (lat === 0 && lon === 0) {
      return undefined;
    }

    return { latitude: lat, longitude: lon };
  }

  // One 'location' item per recorded fix. 'location' is what the CI-Server
  // mapping resolves to location.fix, which routes to the position table only —
  // so these never double the ride on the events timeline.
  private pushTripPosition(
    id: string,
    leg: 'Request' | 'Pickup' | 'Dropoff',
    coords: { latitude: number; longitude: number } | undefined,
    ts: Date | undefined,
    address: string,
    tripTitle: string,
    params: ImportParams,
  ): void {
    // A leg needs both a fix and its own time. Missing either drops THIS leg
    // and nothing else — the other two are pushed by their own calls.
    if (!coords || !ts) {
      return;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    // Named by its address where the export has one. The request leg never
    // does — Lyft records coordinates for it but no address — so it falls back
    // to the trip's title rather than borrowing the pickup's street.
    const title = address || `${tripTitle} (${leg.toLowerCase()})`;
    params.pipeline.push({
      item: {
        id,
        classification: 'location',
        timestamp: ts,
        location: coords,
        content: { filename: 'position.txt', mediaType: 'text/plain', data: async () => Buffer.from(title) },
        metadata: {
          Title: title,
          // `Name` is what the location.fix mapping prefers for a place name, so
          // the position arrives addressed rather than as bare coordinates.
          Name: address || undefined,
          Leg: leg,
          Trip: tripTitle,
          Source: 'Lyft',
        },
      },
    });
  }
}

registerDataSource({
  name: 'lyft',
  title: 'Lyft',
  icon: '',
  description: 'Ride history and position fixes from a Lyft data export (passenger_rides.csv).',
  newFileImporter: () => new LyftFileImporter(),
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Graph, ImportParams } from '../timeline';
import { UberFileImporter } from '../uber';

import type { EmittedGraph } from './support/emitted';

const HEADER =
  'City,Product Type,Begin Trip Time,Begin Trip Address,Dropoff Address,' +
  'Begin Trip Lat,Begin Trip Lng,Distance (miles),Fare Amount,Fare Currency';

// Write a throwaway trips_data.csv (the file the importer recognizes) and import it.
async function importTrips(rows: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-uber-'));
  const fpath = path.join(dir, 'trips_data.csv');
  fs.writeFileSync(fpath, [HEADER, ...rows].join('\n'));
  const fi = new UberFileImporter();
  const pipeline: EmittedGraph[] = [];
  await fi.fileImport({}, { filename: 'trips_data.csv', fullPath: fpath }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return pipeline.filter((p) => p.item);
}

// Current export schema (snake_case columns, ISO timestamps).
const NEW_HEADER =
  'city_name,product_type_name,begintrip_timestamp_utc,begintrip_address,dropoff_address,' +
  'begintrip_lat,begintrip_lng,trip_distance_miles,fare_amount,currency_code,status';

const EATS_HEADER =
  'City_Name,Restaurant_Name,Request_Time_Local,Final_Delivery_Time_Local,Order_Status,' +
  'Item_Name,Item_quantity,Customizations,Customization_Cost_Local,Special_Instructions,Item_Price,Order_Price,Currency';

// Full current schema: both coordinate pairs, dropoff time, duration, status.
const FULL_HEADER =
  'city_name,product_type_name,status,begintrip_timestamp_utc,begintrip_address,begintrip_lat,begintrip_lng,' +
  'dropoff_timestamp_utc,dropoff_address,dropoff_lat,dropoff_lng,trip_distance_miles,trip_duration_seconds,' +
  'fare_amount,currency_code';
const FULL_ROW =
  'San Francisco,UberX,completed,2023-04-11T18:22:05.000Z,"1 Market St",37.7936,-122.3965,' +
  '2023-04-11T18:41:35.000Z,"900 North Point St",37.8058,-122.4193,3.42,1170,18.73,USD';

// FULL_HEADER plus the request columns the current export carries. Kept separate
// so the existing two-position expectations above keep testing the older shape.
const REQ_HEADER =
  'city_name,product_type_name,status,request_timestamp_utc,request_lat,request_lng,' +
  'begintrip_timestamp_utc,begintrip_address,begintrip_lat,begintrip_lng,' +
  'dropoff_timestamp_utc,dropoff_address,dropoff_lat,dropoff_lng,trip_distance_miles,' +
  'trip_duration_seconds,fare_amount,currency_code';
// Requested at 18:15, picked up at 18:22 — the ~7min wait a real export shows.
const REQ_ROW =
  'San Francisco,UberX,completed,2023-04-11T18:15:00.000Z,37.7901,-122.3901,' +
  '2023-04-11T18:22:05.000Z,"1 Market St",37.7936,-122.3965,' +
  '2023-04-11T18:41:35.000Z,"900 North Point St",37.8058,-122.4193,3.42,1170,18.73,USD';

// Build a nested temp export dir from {rel, content} files and import from its root.
async function importFromDir(files: Array<{ rel: string; content: string }>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-uber-dir-'));
  for (const f of files) {
    const full = path.join(root, f.rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content);
  }

  const fi = new UberFileImporter();
  const pipeline: EmittedGraph[] = [];
  await fi.fileImport({}, { filename: path.basename(root), fullPath: root }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return { root, items: pipeline.filter((p) => p.item) };
}

// Import an Eats CSV while capturing the drop ledger.
async function importEatsWithDrops(rows: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-uber-eats-drop-'));
  const fpath = path.join(dir, 'user_orders-0.csv');
  fs.writeFileSync(fpath, [EATS_HEADER, ...rows].join('\n'));
  const items: Graph[] = [];
  const drops: Array<[string, string | undefined]> = [];
  await new UberFileImporter().fileImport({}, { filename: 'user_orders-0.csv', fullPath: fpath }, {
    pipeline: { push: (g: Graph) => items.push(g), drop: (r: string, d?: string) => drops.push([r, d]) },
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);
  fs.rmSync(dir, { recursive: true, force: true });

  return { items, drops };
}

// Import a trips CSV while capturing the drop ledger.
async function importWithDrops(csv: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-uber-drop-'));
  const fpath = path.join(dir, 'trips_data.csv');
  fs.writeFileSync(fpath, csv);
  const items: Graph[] = [];
  const drops: Array<[string, string | undefined]> = [];
  await new UberFileImporter().fileImport({}, { filename: 'trips_data.csv', fullPath: fpath }, {
    pipeline: { push: (g: Graph) => items.push(g), drop: (r: string, d?: string) => drops.push([r, d]) },
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);
  fs.rmSync(dir, { recursive: true, force: true });

  return { items, drops };
}

describe('Uber datasource', () => {
  it('recognizes a trips_data.csv with trip-coordinate columns', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-uber-'));
    const fpath = path.join(dir, 'trips_data.csv');
    fs.writeFileSync(fpath, `${HEADER}\n`);
    const rec = await new UberFileImporter().recognize({}, { filename: 'trips_data.csv', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('carries the pickup coordinate through as the trip location', async () => {
    const items = await importTrips([
      'SF,UberX,2024-03-04 10:00:00 +0000 UTC,1 Market St,2 Mission St,37.7937,-122.3965,2.5,12.50,USD',
    ]);
    const trips = items.filter((p) => p.item.classification === 'trip');
    expect(trips.length).toBe(1);
    expect(trips[0].item.location!.latitude).toBeCloseTo(37.7937, 4);
    expect(trips[0].item.location!.longitude).toBeCloseTo(-122.3965, 4);
  });

  it("omits location when coordinates are blank or Uber's (0,0) placeholder", async () => {
    const items = await importTrips([
      'SF,UberX,2024-03-04 10:00:00 +0000 UTC,1 Market St,2 Mission St,,,2.5,12.50,USD',
      'SF,UberX,2024-03-05 10:00:00 +0000 UTC,1 Market St,2 Mission St,0,0,2.5,12.50,USD',
    ]);
    const trips = items.filter((p) => p.item.classification === 'trip');
    expect(trips.length).toBe(2);
    expect(trips[0].item.location).toBeUndefined();
    expect(trips[1].item.location).toBeUndefined();
    // No fix on either end -> no position items at all.
    expect(items.filter((p) => p.item.classification === 'location').length).toBe(0);
  });

  it('carries a Summary route as the title so it is not the bare filename', async () => {
    const items = await importTrips([
      'SF,UberX,2024-03-04 10:00:00 +0000 UTC,1 Market St,2 Mission St,37.7937,-122.3965,2.5,12.50,USD',
    ]);
    const trips = items.filter((p) => p.item.classification === 'trip');
    expect(trips.length).toBe(1);
    expect(trips[0].item.metadata!.Summary).toBe('1 Market St → 2 Mission St');
    expect(trips[0].item.metadata!.Summary).not.toBe(trips[0].item.content.filename);
  });

  it('keeps GPS-less same-second trips distinct via stable ids (idempotent re-import)', async () => {
    // Two distinct trips at the SAME begin-second with no GPS: would collapse on a
    // timestamp-only hash. Constant filename 'trip.txt' provides no discrimination.
    const rows = [
      'SF,UberX,2024-03-04 10:00:00 +0000 UTC,1 Market St,2 Mission St,,,2.5,12.50,USD',
      'SF,UberX,2024-03-04 10:00:00 +0000 UTC,5 Howard St,9 Folsom St,,,3.1,15.00,USD',
    ];
    const items = (await importTrips(rows)).filter((p) => p.item.classification === 'trip');
    expect(items.length).toBe(2);
    const ids = items.map((p) => p.item.id);
    // (a) every id truthy
    expect(ids.every(Boolean)).toBe(true);
    // (b) ids are unique
    expect(new Set(ids).size).toBe(items.length);
    // (c) re-import yields identical ids (idempotent)
    const again = (await importTrips(rows)).filter((p) => p.item.classification === 'trip');
    expect(again.map((p) => p.item.id)).toEqual(ids);
  });

  it('parses the current snake_case export at Rider/trips_data-0.csv (partitioned, ISO dates)', async () => {
    const row =
      'Los Angeles,UberX,2019-01-16T11:33:09.000Z,"4611 W 18th St, Los Angeles, CA",500 World Way LAX,' +
      '34.041532,-118.3397428,9.78,26.67,USD,completed';
    const { root, items } = await importFromDir([
      { rel: 'Uber Data/Rider/trips_data-0.csv', content: [NEW_HEADER, row].join('\n') },
    ]);
    const rec = await new UberFileImporter().recognize({}, { filename: path.basename(root), fullPath: root });
    expect(rec.confidence).toBeGreaterThanOrEqual(0.9);
    const trips = items.filter((p) => p.item.classification === 'trip');
    expect(trips.length).toBe(1);
    expect(trips[0].item.timestamp!.toISOString()).toBe('2019-01-16T11:33:09.000Z');
    expect(trips[0].item.location!.latitude).toBeCloseTo(34.041532, 4);
    expect(trips[0].item.metadata!.Summary).toContain('→');
    expect(trips[0].item.metadata['Fare Amount']).toBe('26.67');
  });

  describe('trip event shape', () => {
    const load = async (rows: string[]) => {
      const { items } = await importFromDir([
        { rel: 'Uber Data/Rider/trips_data-0.csv', content: [FULL_HEADER, ...rows].join('\n') },
      ]);

      return items;
    };

    // Same, against the schema that carries the request columns.
    const loadReq = async (rows: string[]) => {
      const { items } = await importFromDir([
        { rel: 'Uber Data/Rider/trips_data-0.csv', content: [REQ_HEADER, ...rows].join('\n') },
      ]);

      return items;
    };

    it('emits exactly one event for the ride, plus a position per end', async () => {
      const items = await load([FULL_ROW]);
      expect(items.filter((p) => p.item.classification === 'trip').length).toBe(1);
      expect(items.filter((p) => p.item.classification === 'location').length).toBe(2);
      // Nothing else — the ride is not also a document.
      expect(new Set(items.map((p) => p.item.classification))).toEqual(new Set(['trip', 'location']));
    });

    it('titles the event "Uber ride from <origin> to <destination>"', async () => {
      const trip = (await load([FULL_ROW])).find((p) => p.item.classification === 'trip')!;
      expect(trip.item.metadata!.Title).toBe('Uber ride from 1 Market St to 900 North Point St');
    });

    it('takes start from begintrip and end from dropoff, with duration in whole minutes', async () => {
      const trip = (await load([FULL_ROW])).find((p) => p.item.classification === 'trip')!;
      expect(trip.item.timestamp!.toISOString()).toBe('2023-04-11T18:22:05.000Z');
      expect(trip.item.timespanEnd!.toISOString()).toBe('2023-04-11T18:41:35.000Z');
      expect(trip.item.metadata['Duration (minutes)']).toBe(20); // 1170s
    });

    it('anchors the event at the pickup coordinate', async () => {
      const trip = (await load([FULL_ROW])).find((p) => p.item.classification === 'trip')!;
      expect(trip.item.location).toEqual({ latitude: 37.7936, longitude: -122.3965 });
    });

    it('emits pickup and dropoff positions at their own times and coordinates', async () => {
      const pos = (await load([FULL_ROW])).filter((p) => p.item.classification === 'location');
      const pickup = pos.find((p) => p.item.metadata!.Leg === 'Pickup')!;
      const dropoff = pos.find((p) => p.item.metadata!.Leg === 'Dropoff')!;
      expect(pickup.item.location).toEqual({ latitude: 37.7936, longitude: -122.3965 });
      expect(pickup.item.timestamp!.toISOString()).toBe('2023-04-11T18:22:05.000Z');
      expect(pickup.item.metadata!.Name).toBe('1 Market St');
      expect(dropoff.item.location).toEqual({ latitude: 37.8058, longitude: -122.4193 });
      expect(dropoff.item.timestamp!.toISOString()).toBe('2023-04-11T18:41:35.000Z');
      expect(dropoff.item.metadata!.Name).toBe('900 North Point St');
      // Distinct, stable ids that cannot collide with the trip's own.
      expect(new Set(pos.map((p) => p.item.id)).size).toBe(2);
      expect(pos.every((p) => p.item.id !== undefined)).toBe(true);
    });

    // The request fix — where you were when you opened the app. Its own columns
    // and its own time, minutes before the ride began. Only newer rows carry the
    // coordinates (38 of 81 in a real export), so absence is normal, not a fault.
    it('emits a request position at the request time and coordinate', async () => {
      const pos = (await loadReq([REQ_ROW])).filter((p) => p.item.classification === 'location');
      const request = pos.find((p) => p.item.metadata!.Leg === 'Request')!;
      expect(request).toBeDefined();
      expect(request.item.location).toEqual({ latitude: 37.7901, longitude: -122.3901 });
      // The request time, NOT the pickup time — the point of the separate fix.
      expect(request.item.timestamp!.toISOString()).toBe('2023-04-11T18:15:00.000Z');
      expect(request.item.timestamp!.getTime()).toBeLessThan(
        pos.find((p) => p.item.metadata!.Leg === 'Pickup')!.item.timestamp!.getTime(),
      );
      // No address column exists for the request, so it stays unnamed rather
      // than borrowing the pickup's.
      expect(request.item.metadata!.Name).toBeUndefined();
      // …and `Title` too, which used to fall back to the ride narration. Both
      // keys are read as the fix's PLACE NAME (titleFor's location.fix arm, then
      // toPositionInput), and a trip narration names the TRIP, not any point
      // along it: 37 positions on a real corpus were named "Uber ride from
      // <addr> to <addr> (request)", and `promote.place_position` turned 7 of
      // them into Location entities the Places list rendered as venues.
      expect(request.item.metadata!.Title).toBeUndefined();
      // The narration is not lost — it stays on `Trip`, which no place-name path
      // reads, alongside `Leg`.
      expect(request.item.metadata!.Trip).toBe('Uber ride from 1 Market St to 900 North Point St');
      expect(request.item.metadata!.Source).toBe('Uber');
    });

    it('still names a leg that DOES have an address', async () => {
      // The other side of the rule: dropping the narration fallback must not
      // cost a leg the address the export actually recorded. 159 of the 203
      // named positions on the corpus are exactly this — a real street address.
      const pos = (await loadReq([REQ_ROW])).filter((p) => p.item.classification === 'location');
      const pickup = pos.find((p) => p.item.metadata!.Leg === 'Pickup')!;
      expect(pickup.item.metadata!.Name).toBe('1 Market St');
      expect(pickup.item.metadata!.Title).toBe('1 Market St');
    });

    // Named for the field it holds, not for Uber's column — lyft.ts writes the
    // same key for the same field.
    it('reports the origin under the Pickup Address key', async () => {
      const trip = (await loadReq([REQ_ROW])).find((p) => p.item.classification === 'trip')!;
      expect(trip.item.metadata['Pickup Address']).toBe('1 Market St');
      expect(trip.item.metadata['Dropoff Address']).toBe('900 North Point St');
    });

    // A ride booked days ahead still has its request go out minutes before the
    // pickup, so the request stamp dates the ride correctly rather than dragging
    // it back to wherever you were when you scheduled it.
    it('falls back to the request time and coordinate when there is no pickup copy', async () => {
      const row = REQ_ROW.replace('2023-04-11T18:22:05.000Z', '').replace(',37.7936,-122.3965,', ',,,');
      const items = await loadReq([row]);
      const trip = items.find((p) => p.item.classification === 'trip')!;
      expect(trip.item.timestamp!.toISOString()).toBe('2023-04-11T18:15:00.000Z');
      expect(trip.item.location).toEqual({ latitude: 37.7901, longitude: -122.3901 });
      // No pickup coordinates means no pickup leg — the request leg stands alone.
      const pos = items.filter((p) => p.item.classification === 'location');
      expect(pos.map((p) => p.item.metadata!.Leg)).toEqual(['Request', 'Dropoff']);
    });

    it('still drops a row that has neither a pickup nor a request time', async () => {
      const row = REQ_ROW.replace('2023-04-11T18:15:00.000Z', '').replace('2023-04-11T18:22:05.000Z', '');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-uber-nostart-'));
      const fpath = path.join(dir, 'trips_data.csv');
      fs.writeFileSync(fpath, [REQ_HEADER, row].join('\n'));
      const items: Graph[] = [];
      const drops: Array<[string, string | undefined]> = [];
      await new UberFileImporter().fileImport({}, { filename: 'trips_data.csv', fullPath: fpath }, {
        pipeline: { push: (g: Graph) => items.push(g), drop: (r: string, d?: string) => drops.push([r, d]) },
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      fs.rmSync(dir, { recursive: true, force: true });
      expect(items.length).toBe(0);
      expect(drops).toEqual([['trip_without_start_time', '1 Market St']]);
    });

    it('gives the request position an id distinct from the other two legs', async () => {
      const pos = (await loadReq([REQ_ROW])).filter((p) => p.item.classification === 'location');
      expect(pos.length).toBe(3);
      expect(new Set(pos.map((p) => p.item.id)).size).toBe(3);
      const trip = (await loadReq([REQ_ROW])).find((p) => p.item.classification === 'trip')!;
      expect(pos.every((p) => p.item.id !== trip.item.id)).toBe(true);
    });

    it('omits the request position when the row has no request coordinates', async () => {
      // Older rows: request_timestamp_utc is populated but the lat/lng are blank.
      const row = REQ_ROW.replace(',37.7901,-122.3901,', ',,,');
      const items = await loadReq([row]);
      // The trip and the other two legs are unaffected.
      expect(items.filter((p) => p.item.classification === 'trip').length).toBe(1);
      const pos = items.filter((p) => p.item.classification === 'location');
      expect(pos.map((p) => p.item.metadata!.Leg).sort()).toEqual(['Dropoff', 'Pickup']);
    });

    it("omits the request position when the coordinates are Uber's (0,0) placeholder", async () => {
      const row = REQ_ROW.replace(',37.7901,-122.3901,', ',0,0,');
      const pos = (await loadReq([row])).filter((p) => p.item.classification === 'location');
      expect(pos.some((p) => p.item.metadata!.Leg === 'Request')).toBe(false);
    });

    it('omits the request position when the request time is missing', async () => {
      // A fix with no time cannot be placed on the timeline.
      const row = REQ_ROW.replace('2023-04-11T18:15:00.000Z,', ',');
      const pos = (await loadReq([row])).filter((p) => p.item.classification === 'location');
      expect(pos.some((p) => p.item.metadata!.Leg === 'Request')).toBe(false);
    });

    it('reads the request fix from the legacy Title-Case column names', async () => {
      const header =
        'City,Product Type,Trip or Order Status,Request Time,Request Lat,Request Lng,' +
        'Begin Trip Time,Begin Trip Address,Begin Trip Lat,Begin Trip Lng';
      const row =
        'San Francisco,UberX,completed,2023-04-11 18:15:00 +0000 UTC,37.7901,-122.3901,' +
        '2023-04-11 18:22:05 +0000 UTC,"1 Market St",37.7936,-122.3965';
      const { items } = await importFromDir([
        { rel: 'Trip Data/trips_data.csv', content: [header, row].join('\n') },
      ]);
      const request = items.find((p) => p.item.metadata?.Leg === 'Request')!;
      expect(request).toBeDefined();
      expect(request.item.location).toEqual({ latitude: 37.7901, longitude: -122.3901 });
      expect(request.item.timestamp!.toISOString()).toBe('2023-04-11T18:15:00.000Z');
    });

    // end_time and duration_minutes fill in for each other; with neither source
    // present, both stay unset rather than being invented.
    //
    // These fall-back arms are DEFENSIVE. In every real Uber export inspected,
    // the only rows missing a dropoff time / duration / dropoff coordinates were
    // the cancelled ones — and those are skipped before any of this runs. The
    // cases below are constructed, not sampled.
    it('derives duration from the dropoff time when the export omits the seconds', async () => {
      const row = FULL_ROW.replace(',3.42,1170,', ',3.42,,');
      const trip = (await load([row])).find((p) => p.item.classification === 'trip')!;
      expect(trip.item.timespanEnd!.toISOString()).toBe('2023-04-11T18:41:35.000Z');
      expect(trip.item.metadata['Duration (minutes)']).toBe(20); // 18:22:05 -> 18:41:35
    });

    it('derives the end time from the duration when the export omits the dropoff time', async () => {
      const row = FULL_ROW.replace(',2023-04-11T18:41:35.000Z,', ',,');
      const trip = (await load([row])).find((p) => p.item.classification === 'trip')!;
      expect(trip.item.timespanEnd!.toISOString()).toBe('2023-04-11T18:41:35.000Z'); // start + 1170s
      expect(trip.item.metadata['Duration (minutes)']).toBe(20);
    });

    it('leaves end time and duration unset when the export has neither', async () => {
      const row = FULL_ROW.replace(',2023-04-11T18:41:35.000Z,', ',,').replace(',3.42,1170,', ',3.42,,');
      const trip = (await load([row])).find((p) => p.item.classification === 'trip')!;
      expect(trip.item.timespanEnd).toBeUndefined();
      expect(trip.item.metadata['Duration (minutes)']).toBeUndefined();
    });

    it('still imports a trip with no dropoff information at all, minus its position', async () => {
      // No dropoff time, duration, address or coordinates — just the pickup.
      const row =
        'San Francisco,UberX,completed,2023-04-11T18:22:05.000Z,"1 Market St",37.7936,-122.3965,' +
        ',,,,3.42,,18.73,USD';
      const items = await load([row]);
      const trip = items.find((p) => p.item.classification === 'trip')!;
      expect(trip).toBeDefined();
      expect(trip.item.metadata!.Title).toBe('Uber ride from 1 Market St');
      expect(trip.item.timespanEnd).toBeUndefined();
      expect(trip.item.metadata['Duration (minutes)']).toBeUndefined();
      const pos = items.filter((p) => p.item.classification === 'location');
      expect(pos.length).toBe(1);
      expect(pos[0].item.metadata!.Leg).toBe('Pickup');
    });

    it('places the dropoff position at the derived end time when only duration is given', async () => {
      const row = FULL_ROW.replace(',2023-04-11T18:41:35.000Z,', ',,');
      const dropoff = (await load([row])).find(
        (p) => p.item.classification === 'location' && p.item.metadata!.Leg === 'Dropoff',
      )!;
      expect(dropoff).toBeDefined();
      expect(dropoff.item.timestamp!.toISOString()).toBe('2023-04-11T18:41:35.000Z');
      expect(dropoff.item.location).toEqual({ latitude: 37.8058, longitude: -122.4193 });
    });

    it('omits the dropoff position when no end time can be established', async () => {
      // Dropoff coordinates present, but neither a dropoff time nor a duration.
      const row = FULL_ROW.replace(',2023-04-11T18:41:35.000Z,', ',,').replace(',3.42,1170,', ',3.42,,');
      const items = await load([row]);
      expect(items.filter((p) => p.item.classification === 'trip').length).toBe(1);
      const pos = items.filter((p) => p.item.classification === 'location');
      expect(pos.length).toBe(1);
      expect(pos[0].item.metadata!.Leg).toBe('Pickup');
    });

    it('ignores a dropoff that precedes the pickup (defensive; never seen in real data)', async () => {
      // 0 of 89 rows across the real exports have dropoff < begintrip. This
      // guards a value that would otherwise reach duration_minutes negative.
      const row = FULL_ROW.replace(',2023-04-11T18:41:35.000Z,', ',2023-04-11T18:00:00.000Z,').replace(
        ',3.42,1170,',
        ',3.42,,',
      );
      const trip = (await load([row])).find((p) => p.item.classification === 'trip')!;
      expect(trip.item.metadata['Duration (minutes)']).toBeUndefined();
    });

    it('skips cancelled trips entirely and reports them', async () => {
      const cancelled = FULL_ROW.replace(',completed,', ',canceled,');
      const { items, drops } = await importWithDrops([FULL_HEADER, cancelled].join('\n'));
      expect(items.length).toBe(0);
      expect(drops).toEqual([['cancelled_trip', 'canceled']]);
    });

    it('skips every spelling Uber uses for a cancellation', async () => {
      const rows = ['CANCELED', 'driver_canceled', 'rider_canceled'].map((st) =>
        FULL_ROW.replace(',completed,', `,${st},`),
      );
      const items = await load(rows);
      expect(items.length).toBe(0);
    });

    it('omits a position for a leg with no fix', async () => {
      // Dropoff coordinates are Uber's (0,0) placeholder.
      const row = FULL_ROW.replace(',37.8058,-122.4193,', ',0,0,');
      const items = await load([row]);
      expect(items.filter((p) => p.item.classification === 'trip').length).toBe(1);
      const pos = items.filter((p) => p.item.classification === 'location');
      expect(pos.length).toBe(1);
      expect(pos[0].item.metadata!.Leg).toBe('Pickup');
    });
  });

  it('groups Uber Eats line items into one transaction per (time, restaurant) order', async () => {
    const rows = [
      'OC,Shwack Grill,2024-01-24T12:44:35.000Z,2024-01-24T13:20:26.000Z,completed,Fish Tacos,1,"",,"",13.25,83.13,USD',
      'OC,Shwack Grill,2024-01-24T12:44:35.000Z,2024-01-24T13:20:26.000Z,completed,Ahi Salad,2,"",,"",14.95,83.13,USD',
      'SF,Chouquets,2022-12-16T14:41:18.000Z,2022-12-16T15:10:00.000Z,completed,Croissant,1,"",,"",4.50,4.50,USD',
    ];
    const { items } = await importFromDir([
      { rel: 'Uber Data/Eats/user_orders-0.csv', content: [EATS_HEADER, ...rows].join('\n') },
    ]);
    // 3 line items -> 2 orders
    expect(items.length).toBe(2);
    const shwack = items.find((p) => p.item.metadata!.Restaurant === 'Shwack Grill')!;
    expect(shwack.item.classification).toBe('transaction');
    expect(shwack.item.metadata!.Title).toBe('Ordered food from Shwack Grill via Uber Eats');
    expect(shwack.item.metadata['Order Price']).toBe('83.13');
    expect(shwack.item.metadata['Item Count']).toBe(2);
    expect(shwack.item.metadata!.Items).toEqual(['Fish Tacos', '2× Ahi Salad']);
    const ids = items.map((p) => p.item.id);
    expect(new Set(ids).size).toBe(items.length);
    expect(ids.every((id) => id!.startsWith('ubereats|'))).toBe(true);
  });

  describe('Uber Eats states a place', () => {
    // ci.receipts.place_entity_id is what ObjectResolutionService's place_prior
    // rung reads, and before this Uber Eats was the only commerce source that
    // reliably names a real location — so this is the test that keeps the
    // receipt->place path REACHABLE rather than merely implemented.
    it('names the restaurant as a canonical Place so the receipt can be located', async () => {
      const { items } = await importFromDir([
        {
          rel: 'Uber Data/Eats/user_orders-0.csv',
          content: [
            EATS_HEADER,
            'OC,Shwack Grill,2024-01-24T12:44:35.000Z,2024-01-24T13:20:26.000Z,completed,Fish Tacos,1,"",,"",13.25,83.13,USD',
          ].join('\n'),
        },
      ]);
      const order = items.find((p) => p.item.metadata!.Restaurant === 'Shwack Grill')!;

      // `Place` (not `Restaurant`) is the key push/canonical.ts locationNameFor
      // reads; qualified by city so two same-named branches stay distinct.
      expect(order.item.metadata!.Place).toBe('Shwack Grill, OC');
    });

    it('falls back to the bare restaurant name when the export states no city', async () => {
      const { items } = await importFromDir([
        {
          rel: 'Uber Data/Eats/user_orders-0.csv',
          content: [
            EATS_HEADER,
            ',Shwack Grill,2024-01-24T12:44:35.000Z,2024-01-24T13:20:26.000Z,completed,Fish Tacos,1,"",,"",13.25,83.13,USD',
          ].join('\n'),
        },
      ]);
      const order = items.find((p) => p.item.metadata!.Restaurant === 'Shwack Grill')!;

      expect(order.item.metadata!.Place).toBe('Shwack Grill');
    });
  });

  describe('Uber Eats food entities', () => {
    // One entity per line item, `includes`-linked to its order.
    const foodEntities = (graph: Graph) =>
      (graph.edges ?? []).filter((edge) => edge.to?.entity?.type === 'food').map((edge) => edge.to.entity!);

    it('emits one food entity per line item, named by Item_Name', async () => {
      const { items } = await importFromDir([
        {
          rel: 'Uber Data/Eats/user_orders-0.csv',
          content: [
            EATS_HEADER,
            'OC,Shwack Grill,2024-01-24T12:44:35.000Z,2024-01-24T13:20:26.000Z,completed,Fish Tacos,1,"",,"",13.25,83.13,USD',
            'OC,Shwack Grill,2024-01-24T12:44:35.000Z,2024-01-24T13:20:26.000Z,completed,Ahi Salad,2,"",,"",14.95,83.13,USD',
          ].join('\n'),
        },
      ]);
      const order = items.find((p) => p.item.metadata!.Restaurant === 'Shwack Grill')!;
      const food = foodEntities(order);
      expect(food.map((e) => e!.name)).toEqual(['Fish Tacos', 'Ahi Salad']);
      expect(order.edges!.every((e) => e.relation === 'includes')).toBe(true);
    });

    it('carries customizations and the line-item price — never the order total — on the entity', async () => {
      const { items } = await importFromDir([
        {
          rel: 'Uber Data/Eats/user_orders-0.csv',
          content: [
            EATS_HEADER,
            'OC,Shwack Grill,2024-01-24T12:44:35.000Z,2024-01-24T13:20:26.000Z,completed,Fish Tacos,1,' +
              '"Extra salsa; no onions",1.50,"Ring the doorbell",13.25,83.13,USD',
          ].join('\n'),
        },
      ]);
      const [taco] = foodEntities(items[0]);
      expect(taco.metadata).toMatchObject({
        Customizations: ['Extra salsa; no onions'],
        'Customization Cost': '1.50',
        'Special Instructions': 'Ring the doorbell',
        Currency: 'USD',
      });
      // When, where and how much, kept together as one entry.
      expect(taco.metadata!.Orders).toEqual([
        { date: '2024-01-24T12:44:35.000Z', restaurant: 'Shwack Grill', price: 13.25 },
      ]);
      // Order_Price belongs to the transaction, not to any one dish.
      expect(JSON.stringify(taco.metadata)).not.toContain('83.13');
      expect(items[0].item.metadata['Order Price']).toBe('83.13');
    });

    it('types a drink as food too, and creates no entity for a customization', async () => {
      const { items } = await importFromDir([
        {
          rel: 'Uber Data/Eats/user_orders-0.csv',
          content: [
            EATS_HEADER,
            'SF,Chouquets,2022-12-16T14:41:18.000Z,2022-12-16T15:10:00.000Z,completed,Iced Latte,1,"Oat milk",0.75,"",5.50,5.50,USD',
          ].join('\n'),
        },
      ]);
      const entities = (items[0].edges ?? []).map((e) => e.to?.entity);
      expect(entities.length).toBe(1);
      expect(entities[0]!.type).toBe('food');
      expect(entities[0]!.name).toBe('Iced Latte');
      expect(entities[0]!.metadata!.Customizations).toEqual(['Oat milk']);
    });

    it('keeps a price that is not a number verbatim rather than dropping the order', async () => {
      const { items } = await importFromDir([
        {
          rel: 'Uber Data/Eats/user_orders-0.csv',
          content: [
            EATS_HEADER,
            'SF,Chouquets,2022-12-16T14:41:18.000Z,2022-12-16T15:10:00.000Z,completed,Croissant,1,"",,"",n/a,4.50,USD',
          ].join('\n'),
        },
      ]);
      expect(foodEntities(items[0])[0].metadata!.Orders).toEqual([
        { date: '2022-12-16T14:41:18.000Z', restaurant: 'Chouquets', price: 'n/a' },
      ]);
    });

    it('skips a line item with no Item_Name', async () => {
      const { items } = await importFromDir([
        {
          rel: 'Uber Data/Eats/user_orders-0.csv',
          content: [
            EATS_HEADER,
            'SF,Chouquets,2022-12-16T14:41:18.000Z,2022-12-16T15:10:00.000Z,completed,,1,"",,"",0,4.50,USD',
            'SF,Chouquets,2022-12-16T14:41:18.000Z,2022-12-16T15:10:00.000Z,completed,Croissant,1,"",,"",4.50,4.50,USD',
          ].join('\n'),
        },
      ]);
      expect(foodEntities(items[0]).map((e) => e!.name)).toEqual(['Croissant']);
    });
  });

  describe('cancelled Uber Eats orders', () => {
    it('imports nothing at all for a cancelled order — no event, no food entity', async () => {
      const { items, drops } = await importEatsWithDrops([
        'OC,Shwack Grill,2024-01-24T12:44:35.000Z,,canceled,Fish Tacos,1,"",,"",13.25,13.25,USD',
      ]);
      expect(items).toEqual([]);
      // A dish you cancelled is not a dish you have had, and 13.25 is not a
      // price you have paid — so nothing reaches the Food entity either.
      expect(drops).toEqual([['cancelled_order', 'canceled']]);
    });

    it.each(['CANCELED', 'cancelled', 'customer_canceled', 'ORDER_CANCELLED'])(
      'matches the cancel stem in %s, as the trips importer does',
      async (status) => {
        const { items, drops } = await importEatsWithDrops([
          `OC,Shwack Grill,2024-01-24T12:44:35.000Z,,${status},Fish Tacos,1,"",,"",13.25,13.25,USD`,
        ]);
        expect(items).toEqual([]);
        expect(drops[0][0]).toBe('cancelled_order');
      },
    );

    it('drops only the cancelled order, keeping the completed ones', async () => {
      const { items, drops } = await importEatsWithDrops([
        'OC,Shwack Grill,2024-01-24T12:44:35.000Z,,canceled,Fish Tacos,1,"",,"",13.25,13.25,USD',
        'SF,Chouquets,2022-12-16T14:41:18.000Z,2022-12-16T15:10:00.000Z,completed,Croissant,1,"",,"",4.50,4.50,USD',
      ]);
      expect(items.map((p) => p.item!.metadata!.Restaurant)).toEqual(['Chouquets']);
      expect(drops).toHaveLength(1);
    });
  });

  it('ingests trips and eats together from a full export', async () => {
    const { items } = await importFromDir([
      {
        rel: 'Uber Data/Rider/trips_data-0.csv',
        content: [
          NEW_HEADER,
          'LA,UberX,2020-05-01T00:00:00.000Z,A St,B St,34.0,-118.0,1,5.00,USD,completed',
        ].join('\n'),
      },
      {
        rel: 'Uber Data/Eats/user_orders-0.csv',
        content: [
          EATS_HEADER,
          'LA,Diner,2020-05-02T00:00:00.000Z,2020-05-02T00:30:00.000Z,completed,Burger,1,"",,"",9.0,9.0,USD',
        ].join('\n'),
      },
    ]);
    expect(items.filter((p) => p.item.classification === 'trip').length).toBe(1);
    expect(items.filter((p) => p.item.classification === 'transaction').length).toBe(1);
  });
});

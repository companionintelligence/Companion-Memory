import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { LyftFileImporter } from '../lyft';
import type { Graph, ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Current export schema: three coordinate pairs, three timestamps, and the
// dropoff address under its real name (`destination_address`, not `dropoff_*`).
const CURRENT_HEADER =
  'status,requested_timestamp,requested_lat,requested_lng,pickup_timestamp,pickup_address,' +
  'pickup_lat,pickup_lng,destination_address,dropoff_timestamp,dropoff_lat,dropoff_lng';
const CURRENT_ROW =
  'finished,2024-05-15 01:19:41 UTC,40.87977,-73.87984,2024-05-15 01:20:42 UTC,' +
  '"111 E 210th St, Bronx, NY, United States",40.87982,-73.87999,' +
  '"4525 Henry Hudson Pkwy W, Bronx, NY, United States",2024-05-15 01:30:59 UTC,40.891744,-73.908903';

// Write a throwaway passenger_rides.csv and import it, capturing the drop ledger.
async function importRows(rows: string[], header = CURRENT_HEADER) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-lyft-'));
  const fpath = path.join(dir, 'passenger_rides.csv');
  fs.writeFileSync(fpath, [header, ...rows].join('\n'));
  const items: EmittedGraph[] = [];
  const drops: Array<[string, string | undefined]> = [];
  await new LyftFileImporter().fileImport({}, { filename: 'passenger_rides.csv', fullPath: fpath }, {
    pipeline: {
      push: (g: Graph) => items.push(g as EmittedGraph),
      drop: (r: string, d?: string) => drops.push([r, d]),
    },
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);
  fs.rmSync(dir, { recursive: true, force: true });

  return { items, drops };
}

const legOf = (items: EmittedGraph[], leg: string) =>
  items.find((p) => p.item.classification === 'location' && p.item.metadata.Leg === leg);
const positions = (items: EmittedGraph[]) => items.filter((p) => p.item.classification === 'location');
const tripOf = (items: EmittedGraph[]) => items.find((p) => p.item.classification === 'trip')!;

// Import the checked-in fixture directory (the older rides.csv schema).
async function importFixture() {
  const root = path.join(FIXTURES_DIR, 'lyft-export');
  const pipeline: EmittedGraph[] = [];
  await new LyftFileImporter().fileImport({}, { filename: 'lyft-export', fullPath: root }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return pipeline;
}

describe('Lyft datasource', () => {
  describe('recognition', () => {
    it('recognizes export directory by rides.csv', async () => {
      const root = path.join(FIXTURES_DIR, 'lyft-export');
      const rec = await new LyftFileImporter().recognize({}, { filename: 'lyft-export', fullPath: root });
      expect(rec.confidence).toBeGreaterThan(0.8);
    });

    it('recognizes a single rides.csv file directly', async () => {
      const fpath = path.join(FIXTURES_DIR, 'lyft-export', 'rides.csv');
      const rec = await new LyftFileImporter().recognize({}, { filename: 'rides.csv', fullPath: fpath });
      expect(rec.confidence).toBeGreaterThan(0.8);
    });

    // passenger_rides.csv is what a real export actually ships, so it earns the
    // same top confidence rides.csv does rather than the generic header score.
    it('recognizes a real export directory by passenger_rides.csv', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-lyft-rec-'));
      fs.writeFileSync(path.join(dir, 'passenger_rides.csv'), [CURRENT_HEADER, CURRENT_ROW].join('\n'));
      // Sibling files from the export that are not ride history.
      fs.writeFileSync(path.join(dir, 'user_ratings.csv'), 'average_rating,role\n4.88,passenger\n');
      try {
        const rec = await new LyftFileImporter().recognize(
          {},
          { filename: path.basename(dir), fullPath: dir },
        );
        expect(rec.confidence).toBe(0.95);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not match an unrelated CSV', async () => {
      const tmp = path.join(FIXTURES_DIR, 'lyft-export', '_notlyft.csv');
      await fs.promises.writeFile(tmp, 'col_a,col_b\n1,2\n');
      try {
        const rec = await new LyftFileImporter().recognize({}, { filename: '_notlyft.csv', fullPath: tmp });
        expect(rec.confidence).toBe(0);
      } finally {
        await fs.promises.unlink(tmp).catch(() => {});
      }
    });

    // Regression: findCsv used to apply its weak "any .csv whose header
    // merely mentions pickup/dropoff" fallback at every recursion level, not
    // just the directory the caller actually asked about — so a coincidental
    // CSV two levels deep in an unrelated multi-GB export (a moving-house
    // checklist, a shipping log — 'pickup'/'dropoff' are ordinary English
    // words) claimed confidence for the WHOLE ancestor tree it was found
    // under, which then wrongly disabled the generic importer for everything
    // else in that tree (see ParseStage.dropGenericWhenSpecialised).
    it('does not match a coincidental pickup/dropoff-shaped CSV deep in an unrelated tree', async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-lyft-fp-'));
      try {
        const deep = path.join(tmpRoot, 'Drive', 'personal', 'moving-plans');
        fs.mkdirSync(deep, { recursive: true });
        fs.writeFileSync(
          path.join(deep, 'checklist.csv'),
          'item,pickup,dropoff\nsofa,2024-06-01,2024-06-02\n',
        );

        const rec = await new LyftFileImporter().recognize(
          {},
          { filename: path.basename(tmpRoot), fullPath: tmpRoot },
        );
        expect(rec.confidence).toBe(0);
        expect(rec.dir_threshold).toBe(0.7);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    // The exact-filename search (double-validated by header) is specific
    // enough to stay safe recursively, and must still work when nested.
    it('still recognizes an exact ride filename nested a couple of levels deep', async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-lyft-nested-'));
      try {
        const deep = path.join(tmpRoot, 'Takeout', 'Lyft');
        fs.mkdirSync(deep, { recursive: true });
        fs.writeFileSync(path.join(deep, 'passenger_rides.csv'), [CURRENT_HEADER, CURRENT_ROW].join('\n'));

        const rec = await new LyftFileImporter().recognize(
          {},
          { filename: path.basename(tmpRoot), fullPath: tmpRoot },
        );
        expect(rec.confidence).toBe(0.95);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  describe('trip event shape', () => {
    // The event mirrors uber.ts: anchored at the pickup, spanning to the
    // dropoff, titled for a human timeline, with Uber's metadata key names.
    it('anchors the event at the pickup time and coordinate', async () => {
      const trip = tripOf((await importRows([CURRENT_ROW])).items).item;
      expect(trip.classification).toBe('trip');
      // The pickup time, not the request time a minute earlier.
      expect(trip.timestamp!.toISOString()).toBe('2024-05-15T01:20:42.000Z');
      expect(trip.location).toEqual({ latitude: 40.87982, longitude: -73.87999 });
    });

    it('spans from pickup to dropoff and reports the duration', async () => {
      const trip = tripOf((await importRows([CURRENT_ROW])).items).item;
      expect(trip.timespanEnd!.toISOString()).toBe('2024-05-15T01:30:59.000Z');
      expect(trip.metadata['Duration (minutes)']).toBe(10); // 01:20:42 -> 01:30:59
    });

    it('carries the same metadata keys an Uber trip does', async () => {
      const trip = tripOf((await importRows([CURRENT_ROW])).items).item;
      expect(trip.metadata.Title).toBe(
        'Lyft ride from 111 E 210th St, Bronx, NY, United States' +
          ' to 4525 Henry Hudson Pkwy W, Bronx, NY, United States',
      );
      expect(trip.metadata['Pickup Address']).toBe('111 E 210th St, Bronx, NY, United States');
      // The real column is destination_address; it must still land on the key
      // Uber uses for the same field.
      expect(trip.metadata['Dropoff Address']).toBe('4525 Henry Hudson Pkwy W, Bronx, NY, United States');
      expect(trip.metadata.Status).toBe('finished');
      expect(trip.metadata.Summary).toBe(
        '111 E 210th St, Bronx, NY, United States → 4525 Henry Hudson Pkwy W, Bronx, NY, United States',
      );
      expect(trip.metadata.Source).toBe('Lyft');
    });

    // A ride booked days ahead still has its request go out minutes before the
    // pickup, so the request stamp dates the ride correctly rather than dragging
    // it back to wherever you were when you scheduled it.
    it('falls back to the request time and coordinate when there is no pickup copy', async () => {
      const row = CURRENT_ROW.replace('2024-05-15 01:20:42 UTC', '').replace(',40.87982,-73.87999,', ',,,');
      const trip = tripOf((await importRows([row])).items).item;
      expect(trip.timestamp!.toISOString()).toBe('2024-05-15T01:19:41.000Z');
      expect(trip.location).toEqual({ latitude: 40.87977, longitude: -73.87984 });
      // The span still runs to the real dropoff.
      expect(trip.timespanEnd!.toISOString()).toBe('2024-05-15T01:30:59.000Z');
    });

    // The fallback is per-field: a row with pickup coordinates but no pickup
    // time takes the request's time without taking its position.
    it('falls back only for the half the export is missing', async () => {
      const noTime = CURRENT_ROW.replace('2024-05-15 01:20:42 UTC', '');
      const trip = tripOf((await importRows([noTime])).items).item;
      expect(trip.timestamp!.toISOString()).toBe('2024-05-15T01:19:41.000Z');
      expect(trip.location).toEqual({ latitude: 40.87982, longitude: -73.87999 });
    });

    it('titles a ride that recorded only one end of the route', async () => {
      const noDest = CURRENT_ROW.replace(',"4525 Henry Hudson Pkwy W, Bronx, NY, United States",', ',,');
      const trip = tripOf((await importRows([noDest])).items).item;
      expect(trip.metadata.Title).toBe('Lyft ride from 111 E 210th St, Bronx, NY, United States');
      expect(trip.metadata['Dropoff Address']).toBeUndefined();
    });

    it('yields the trip summary text lazily', async () => {
      const trip = tripOf((await importRows([CURRENT_ROW])).items);
      const buf = await trip.item.content.data!();
      expect(buf.toString()).toBe(
        '111 E 210th St, Bronx, NY, United States → 4525 Henry Hudson Pkwy W, Bronx, NY, United States',
      );
    });

    it('skips a cancelled ride and reports it to the drop ledger', async () => {
      const rows = ['canceled', 'CANCELED', 'rider_canceled', 'driver_cancelled'].map((s) =>
        CURRENT_ROW.replace(/^finished/, s),
      );
      const { items, drops } = await importRows(rows);
      expect(items.length).toBe(0);
      expect(drops.length).toBe(4);
      expect(drops.every(([reason]) => reason === 'cancelled_trip')).toBe(true);
    });

    it('drops a row with no usable start time rather than importing it undated', async () => {
      const row = CURRENT_ROW.replace('2024-05-15 01:19:41 UTC', '').replace('2024-05-15 01:20:42 UTC', '');
      const { items, drops } = await importRows([row]);
      expect(items.length).toBe(0);
      expect(drops).toEqual([['trip_without_start_time', '111 E 210th St, Bronx, NY, United States']]);
    });

    it('builds an id that survives re-import and never collides across legs', async () => {
      const run = async () => (await importRows([CURRENT_ROW])).items.map((p) => p.item.id!);
      const ids = await run();
      expect(ids.length).toBe(4); // trip + three positions
      expect(new Set(ids).size).toBe(4);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
      // Idempotent: the row's position in the file is not part of the id.
      expect(await run()).toEqual(ids);
    });
  });

  describe('position fixes', () => {
    it('emits a position for each of the request, pickup and dropoff coordinates', async () => {
      const { items } = await importRows([CURRENT_ROW]);
      const pos = positions(items);
      expect(pos.map((p) => p.item.metadata.Leg)).toEqual(['Request', 'Pickup', 'Dropoff']);

      // Each fix carries its OWN coordinate and its OWN time.
      const request = legOf(items, 'Request')!.item;
      expect(request.location).toEqual({ latitude: 40.87977, longitude: -73.87984 });
      expect(request.timestamp!.toISOString()).toBe('2024-05-15T01:19:41.000Z');

      const pickup = legOf(items, 'Pickup')!.item;
      expect(pickup.location).toEqual({ latitude: 40.87982, longitude: -73.87999 });
      expect(pickup.timestamp!.toISOString()).toBe('2024-05-15T01:20:42.000Z');

      const dropoff = legOf(items, 'Dropoff')!.item;
      expect(dropoff.location).toEqual({ latitude: 40.891744, longitude: -73.908903 });
      expect(dropoff.timestamp!.toISOString()).toBe('2024-05-15T01:30:59.000Z');
    });

    it('labels the pickup and dropoff with their addresses', async () => {
      const { items } = await importRows([CURRENT_ROW]);
      const pickup = legOf(items, 'Pickup')!.item;
      expect(pickup.metadata.Name).toBe('111 E 210th St, Bronx, NY, United States');
      expect(pickup.metadata.Title).toBe('111 E 210th St, Bronx, NY, United States');

      const dropoff = legOf(items, 'Dropoff')!.item;
      expect(dropoff.metadata.Name).toBe('4525 Henry Hudson Pkwy W, Bronx, NY, United States');
      expect(dropoff.metadata.Title).toBe('4525 Henry Hudson Pkwy W, Bronx, NY, United States');
    });

    // A real export has rows whose pickup_address is blank while the coordinates
    // are fine. The fix is still worth having; it just goes out unnamed.
    it('falls back to the trip title when an address is blank', async () => {
      const row = CURRENT_ROW.replace(',"111 E 210th St, Bronx, NY, United States",', ',,');
      const pickup = legOf((await importRows([row])).items, 'Pickup')!.item;
      expect(pickup.location).toEqual({ latitude: 40.87982, longitude: -73.87999 });
      expect(pickup.metadata.Name).toBeUndefined();
      expect(pickup.metadata.Title).toBe(
        'Lyft ride to 4525 Henry Hudson Pkwy W, Bronx, NY, United States (pickup)',
      );
    });

    // Lyft records coordinates for the request but never an address for it.
    it('leaves the request fix unnamed rather than borrowing the pickup address', async () => {
      const request = legOf((await importRows([CURRENT_ROW])).items, 'Request')!.item;
      expect(request.metadata.Name).toBeUndefined();
      expect(request.metadata.Trip).toBe(
        'Lyft ride from 111 E 210th St, Bronx, NY, United States' +
          ' to 4525 Henry Hudson Pkwy W, Bronx, NY, United States',
      );
      expect(request.metadata.Source).toBe('Lyft');
    });

    // The point of resolving each leg independently: one missing pair must not
    // take the others down with it.
    it('drops only the leg whose coordinates are missing', async () => {
      const noRequest = CURRENT_ROW.replace(',40.87977,-73.87984,', ',,,');
      expect(positions((await importRows([noRequest])).items).map((p) => p.item.metadata.Leg)).toEqual([
        'Pickup',
        'Dropoff',
      ]);

      const noPickup = CURRENT_ROW.replace(',40.87982,-73.87999,', ',,,');
      expect(positions((await importRows([noPickup])).items).map((p) => p.item.metadata.Leg)).toEqual([
        'Request',
        'Dropoff',
      ]);

      const noDropoff = CURRENT_ROW.replace(',40.891744,-73.908903', ',,');
      expect(positions((await importRows([noDropoff])).items).map((p) => p.item.metadata.Leg)).toEqual([
        'Request',
        'Pickup',
      ]);
    });

    it('still emits the trip when every coordinate is missing', async () => {
      const row = CURRENT_ROW.replace(',40.87977,-73.87984,', ',,,')
        .replace(',40.87982,-73.87999,', ',,,')
        .replace(',40.891744,-73.908903', ',,');
      const { items } = await importRows([row]);
      expect(positions(items).length).toBe(0);
      const trip = tripOf(items).item;
      expect(trip.timestamp!.toISOString()).toBe('2024-05-15T01:20:42.000Z');
      // No pickup fix means the event carries no location of its own.
      expect(trip.location).toBeUndefined();
    });

    it('treats (0,0) as a missing fix rather than a point at sea', async () => {
      const row = CURRENT_ROW.replace(',40.87977,-73.87984,', ',0,0,');
      expect(legOf((await importRows([row])).items, 'Request')).toBeUndefined();
    });

    it('omits a leg whose coordinates are present but whose time is not', async () => {
      const row = CURRENT_ROW.replace('2024-05-15 01:30:59 UTC', '');
      const { items } = await importRows([row]);
      expect(legOf(items, 'Dropoff')).toBeUndefined();
      // ...and the trip, having no end time to derive, stays a point in time.
      expect(tripOf(items).item.timespanEnd).toBeUndefined();
    });
  });

  describe('timestamp formats', () => {
    it('parses the export\'s "YYYY-MM-DD HH:MM:SS UTC" as UTC', async () => {
      const trip = tripOf((await importRows([CURRENT_ROW])).items).item;
      expect(trip.timestamp!.toISOString()).toBe('2024-05-15T01:20:42.000Z');
    });

    it('parses ISO 8601 and unix-seconds stamps', async () => {
      const iso = CURRENT_ROW.replace('2024-05-15 01:20:42 UTC', '2024-05-15T01:20:42.000Z');
      expect(tripOf((await importRows([iso])).items).item.timestamp!.toISOString()).toBe(
        '2024-05-15T01:20:42.000Z',
      );

      const epoch = CURRENT_ROW.replace('2024-05-15 01:20:42 UTC', '1672531200');
      expect(tripOf((await importRows([epoch])).items).item.timestamp!.toISOString()).toBe(
        '2023-01-01T00:00:00.000Z',
      );
    });
  });

  // The older schema: requested_at/completed_at, dropoff_address, a ride_id, and
  // no request coordinates. Still resolves through the same candidate lists.
  describe('older rides.csv schema', () => {
    it('imports every ride in the fixture', async () => {
      const items = await importFixture();
      expect(items.filter((p) => p.item.classification === 'trip').length).toBe(3);
    });

    it("uses the export's own ride id when it has one", async () => {
      const trip = (await importFixture()).find((p) => p.item.classification === 'trip')!;
      expect(trip.item.metadata['Ride ID']).toBe('ride_001');
      expect(trip.item.id).toBe('lyft|ride_001');
    });

    it('falls back to the request time when the schema records no pickup time', async () => {
      const trip = (await importFixture()).find((p) => p.item.classification === 'trip')!;
      expect(trip.item.timestamp!.toISOString()).toBe('2023-08-14T09:15:32.000Z');
      expect(trip.item.timespanEnd!.toISOString()).toBe('2023-08-14T09:41:10.000Z');
    });

    it('reads fare, distance and currency onto the Uber-shaped keys', async () => {
      const trip = (await importFixture()).find((p) => p.item.classification === 'trip')!;
      expect(trip.item.metadata['Distance (miles)']).toBe('12.4');
      expect(trip.item.metadata['Fare Amount']).toBe('28.50');
      expect(trip.item.metadata['Fare Currency']).toBe('USD');
    });

    it('emits pickup and dropoff fixes but no request fix', async () => {
      const items = await importFixture();
      const legs = items
        .filter((p) => p.item.classification === 'location' && p.item.id!.startsWith('lyft|ride_001'))
        .map((p) => p.item.metadata.Leg);
      expect(legs).toEqual(['Pickup', 'Dropoff']);
    });

    it('reads the dropoff_address spelling onto the Dropoff Address key', async () => {
      const trip = (await importFixture()).find((p) => p.item.classification === 'trip')!;
      expect(trip.item.metadata['Dropoff Address']).toBe('456 Broadway, Oakland, CA');
    });

    it('handles a quoted field with an embedded newline', async () => {
      const trips = (await importFixture()).filter((p) => p.item.classification === 'trip');
      expect(trips[1].item.metadata['Ride ID']).toBe('ride_002');
      expect(trips[1].item.metadata['Pickup Address']).toBe('200 Park Ave\nNew York, NY');
    });

    it('parses a unix-seconds timestamp', async () => {
      const trips = (await importFixture()).filter((p) => p.item.classification === 'trip');
      expect(trips[2].item.metadata['Ride ID']).toBe('ride_003');
      expect(trips[2].item.timestamp!.toISOString()).toBe('2023-01-01T00:00:00.000Z');
    });

    it('assigns unique, idempotent ids when timestamps collide and ids are absent', async () => {
      const tmp = path.join(FIXTURES_DIR, 'lyft-export', '_dedup.csv');
      // Two rides share the exact same requested_at second; a third has no ride_id.
      await fs.promises.writeFile(
        tmp,
        'ride_id,requested_at,pickup_address,dropoff_address\n' +
          'ride_a,2023-08-14T09:15:32Z,A1,A2\n' +
          'ride_b,2023-08-14T09:15:32Z,B1,B2\n' +
          ',2023-08-14T09:15:32Z,C1,C2\n',
      );
      try {
        const run = async () => {
          const pipeline: EmittedGraph[] = [];
          await new LyftFileImporter().fileImport({}, { filename: '_dedup.csv', fullPath: tmp }, {
            pipeline,
            timeframe: {},
            log: () => {},
          } as unknown as ImportParams);

          return pipeline.map((g) => g.item.id!);
        };

        const ids = await run();
        expect(ids.length).toBe(3);
        expect(ids.every(Boolean)).toBe(true);
        expect(new Set(ids).size).toBe(3);
        expect(await run()).toEqual(ids);
      } finally {
        await fs.promises.unlink(tmp).catch(() => {});
      }
    });
  });

  it('does not throw on an empty file and emits nothing', async () => {
    const tmp = path.join(FIXTURES_DIR, 'lyft-export', '_empty.csv');
    await fs.promises.writeFile(tmp, '');
    const pipeline: EmittedGraph[] = [];
    try {
      const fi = new LyftFileImporter();
      // recognize must not throw and must not match an empty file
      const rec = await fi.recognize({}, { filename: '_empty.csv', fullPath: tmp });
      expect(rec.confidence).toBe(0);
      await fi.fileImport({}, { filename: '_empty.csv', fullPath: tmp }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);
      expect(pipeline.length).toBe(0);
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
    }
  });
});

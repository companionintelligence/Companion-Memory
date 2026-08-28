import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NMEAFileImporter } from '../nmea';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

function makeNMEAFile(name: string, lines: string[]): string {
  const dir = path.join(os.tmpdir(), 'ci-import-tests');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name + '.nmea');
  fs.writeFileSync(f, lines.join('\n'), 'utf8');

  return f;
}

describe('NMEA datasource', () => {
  it('recognizes file with GPRMC', async () => {
    const f = makeNMEAFile('track1', [
      '$GPRMC,130305.000,A,3745.1234,N,12225.6789,W,0.13,309.62,021125,,,A*7C',
    ]);
    const fi = new NMEAFileImporter();
    const rec = await fi.recognize({}, { filename: path.basename(f), fullPath: f });
    expect(rec.confidence).toBeGreaterThan(0.5);
  });
  it('imports GPRMC + GPGGA points', async () => {
    const f = makeNMEAFile('track2', [
      '$GPRMC,130305.000,A,3745.1234,N,12225.6789,W,0.13,309.62,021125,,,A*7C',
      '$GPGGA,130305.000,3745.1234,N,12225.6789,W,1,08,0.9,15.0,M,,M,,*47',
    ]);
    const fi = new NMEAFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(f), fullPath: f }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].item.location!.latitude).toBeCloseTo(37 + 45.1234 / 60, 6);
    // No fabricated `Name`. An NMEA sentence has no name to give, and the
    // `Location 37.75206, -122.42798` this used to emit was never rendered as a
    // title (raw-GPS location.fix routes to `position` only) — it only ever
    // landed in ci.position.name, where a coordinate pair is not a place name.
    expect(items[0].item.metadata.Name).toBeUndefined();
    expect(items[0].item.metadata.Title).toBeUndefined();
  });
  it('assigns unique, stable, idempotent ids to colliding same-second fixes', async () => {
    // GGA-only file (no RMC date) at the same wall-clock second and identical coords:
    // without an id these collapse via hashItem on (data_source, content_hash).
    const lines = [
      '$GPGGA,130305.000,3745.1234,N,12225.6789,W,1,08,0.9,15.0,M,,M,,*47',
      '$GPGGA,130305.000,3745.1234,N,12225.6789,W,1,08,0.9,15.0,M,,M,,*47',
      '$GPGGA,130305.000,3745.1234,N,12225.6789,W,1,08,0.9,15.0,M,,M,,*47',
    ];
    const f = makeNMEAFile('collide', lines);
    const run = async () => {
      const pipeline: EmittedGraph[] = [];
      const fi = new NMEAFileImporter();
      await fi.fileImport({}, { filename: path.basename(f), fullPath: f }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return pipeline.filter((p) => p.item).map((p) => p.item.id!);
    };

    const ids = await run();
    expect(ids.length).toBe(3);
    expect(ids.every((id) => !!id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    const ids2 = await run();
    expect(ids2).toEqual(ids);
  });

  it('drops a $GPRMC sentence whose status field marks the fix invalid ("V"), not just "A"', async () => {
    const lines = [
      // status 'V' = void/unlocked fix — must not be imported as a real position.
      '$GPRMC,130305.000,V,3745.1234,N,12225.6789,W,0.13,309.62,021125,,,A*7C',
      // status 'A' = valid — the only one that should survive.
      '$GPRMC,140305.000,A,4045.1234,N,12325.6789,W,0.13,309.62,021125,,,A*7C',
    ];
    const f = makeNMEAFile('void-fix', lines);
    const fi = new NMEAFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(f), fullPath: f }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBe(1);
    // The surviving item is the VALID (second) line's position, not the void one.
    expect(items[0].item.location!.latitude).toBeCloseTo(40 + 45.1234 / 60, 6);
  });

  it('inherits the correct calendar date from the preceding $GPRMC sentence for a dateless $GPGGA', async () => {
    // RMC's ddmmyy = "021125" -> 2025-11-02. GGA carries its own time
    // (140000 UTC) but no date at all, and must inherit RMC's DATE while
    // keeping its OWN time.
    const lines = [
      '$GPRMC,130305.000,A,3745.1234,N,12225.6789,W,0.13,309.62,021125,,,A*7C',
      '$GPGGA,140000.000,3745.1234,N,12225.6789,W,1,08,0.9,15.0,M,,M,,*47',
    ];
    const f = makeNMEAFile('gga-date-inherit', lines);
    const fi = new NMEAFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(f), fullPath: f }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBe(2);
    const gga = items[1];
    // Correct: 2025-11-02 (from RMC) at 14:00:00 (GGA's own time) UTC.
    expect(gga.item.timestamp!.toISOString()).toBe('2025-11-02T14:00:00.000Z');
  });

  it('emits a dateless $GPGGA undated rather than dating it today', async () => {
    // A GGA sentence carries a time of day and no date. With no RMC/ZDA
    // anywhere in the file there is nothing to inherit, and this used to fill
    // the gap with TODAY's UTC date — turning a log from some past trip into a
    // GPS fix asserting the user was at those coordinates today. A
    // `location.fix` record's entire content is (lat, lon, time), so a
    // fabricated time makes the whole row a fabrication, and position rows are
    // LocationEstimateService's primary donors, so it drags every neighbouring
    // inference with it.
    //
    // `timestamp: undefined` is the honest answer; push/canonical.ts then
    // routes the undated fix away from ci.position entirely.
    const lines = ['$GPGGA,130305.000,3745.1234,N,12225.6789,W,1,08,0.9,15.0,M,,M,,*47'];
    const f = makeNMEAFile('gga-only-undated', lines);
    const fi = new NMEAFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(f), fullPath: f }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBe(1);
    expect(items[0].item.timestamp).toBeUndefined();
    // The fix itself is still parsed — only the invented date is gone.
    expect(items[0].item.location!.latitude).toBeCloseTo(37 + 45.1234 / 60, 6);
  });
});

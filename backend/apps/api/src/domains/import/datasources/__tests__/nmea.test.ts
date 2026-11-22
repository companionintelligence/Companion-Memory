import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NMEAFileImporter } from '../nmea';
import type { ImportParams } from '../timeline';

import type { EmittedGraph, TestPipeline } from './support/emitted';

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

  it('reads a two-digit year from 80 to 99 as 19xx, since GPS time starts in 1980', async () => {
    // The textbook RMC/GGA pair: 23 March 1994. Every `yy` used to become 20yy,
    // so this fix was stored at 2094-03-23 and read as the newest one there was.
    const lines = [
      '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A',
      '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47',
      '$GPRMC,000000,A,4807.038,N,01131.000,E,022.4,084.4,010180,003.1,W*60',
      '$GPRMC,000000,A,4807.038,N,01131.000,E,022.4,084.4,311279,003.1,W*67',
      '$GPRMC,000000,A,4807.038,N,01131.000,E,022.4,084.4,010100,003.1,W*68',
    ];
    const f = makeNMEAFile('two-digit-year', lines);
    const fi = new NMEAFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: path.basename(f), fullPath: f }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const times = pipeline.filter((p) => p.item).map((p) => p.item.timestamp?.toISOString());
    expect(times).toEqual([
      '1994-03-23T12:35:19.000Z',
      '1994-03-23T12:35:19.000Z',
      '1980-01-01T00:00:00.000Z',
      '2079-12-31T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
    ]);
  });

  describe('talker ids other than $GP', () => {
    // What a u-blox multi-GNSS receiver logs from power-on: a banner of $GNTXT
    // lines, a void fix while it acquires, then $GN fixes.
    const banner = [
      '$GNTXT,01,01,02,u-blox AG - www.u-blox.com*4E',
      '$GNTXT,01,01,02,HW UBX-M8030 00080000*60',
      '$GNTXT,01,01,02,ROM CORE 3.01 (107888)*2B',
      '$GNTXT,01,01,02,FWVER=SPG 3.01*46',
      '$GNTXT,01,01,02,PROTVER=18.00*11',
      '$GNTXT,01,01,02,GPS;GLO;GAL;BDS*77',
      '$GNTXT,01,01,02,SBAS;IMES;QZSS*49',
      '$GNTXT,01,01,02,GNSS OTP=GPS;GLO*37',
      '$GNTXT,01,01,02,ANTSUPERV=AC SD PDoS SR*3E',
      '$GNTXT,01,01,02,ANTSTATUS=OK*25',
      '$GNTXT,01,01,02,PF=3FF*4B',
    ];
    const gnLog = [
      ...banner,
      '$GNRMC,071500.00,V,,,,,,,130926,,,N*6F',
      '$GNRMC,071510.00,A,4736.3906,N,12219.9008,W,2.4,51.3,130926,,,A*6C',
      '$GNGGA,071510.00,4736.3906,N,12219.9008,W,1,09,0.92,54.6,M,-17.3,M,,*4D',
      '$GNGSA,A,3,02,05,12,13,15,18,24,25,29,,,,1.61,0.92,1.32*10',
      '$GNVTG,51.3,T,,M,2.4,N,4.4,K,A*22',
    ];

    async function importLines(name: string, lines: string[]) {
      const f = makeNMEAFile(name, lines);
      const fi = new NMEAFileImporter();
      const rec = await fi.recognize({}, { filename: path.basename(f), fullPath: f });
      const pipeline = [] as unknown as TestPipeline;
      const drops: string[] = [];
      pipeline.drop = (reason) => drops.push(reason);
      await fi.fileImport({}, { filename: path.basename(f), fullPath: f }, {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams);

      return { confidence: rec.confidence, items: pipeline.map((g) => g.item), drops };
    }

    it('recognizes and imports a $GN log that opens with a start-up banner', async () => {
      const { confidence, items, drops } = await importLines('gn-ublox', gnLog);

      expect(confidence).toBe(0.8);
      expect(items.map((i) => [i.id, i.timestamp?.toISOString()])).toEqual([
        ['nmea:gn-ublox.nmea:12:RMC', '2026-09-13T07:15:10.000Z'],
        ['nmea:gn-ublox.nmea:13:GGA', '2026-09-13T07:15:10.000Z'],
      ]);
      expect(items[0].location!.latitude).toBeCloseTo(47 + 36.3906 / 60, 6);
      expect(items[0].location!.longitude).toBeCloseTo(-(122 + 19.9008 / 60), 6);
      expect(items[1].metadata.Altitude).toBe(54.6);
      // The void $GNRMC is counted like a void $GPRMC.
      expect(drops).toEqual(['position_without_fix']);
    });

    it('reads RMC and GGA from every single-system talker and skips other sentences', async () => {
      const { confidence, items } = await importLines('talkers', [
        '$GLRMC,071520.00,A,4736.4092,N,12219.8756,W,2.4,51.3,130926,,,A*63',
        '$GARMC,071530.00,A,4736.4278,N,12219.8504,W,2.4,51.3,130926,,,A*6C',
        '$GBRMC,071540.00,A,4736.4464,N,12219.8252,W,2.4,51.3,130926,,,A*67',
        '$BDGGA,071540.00,4736.4464,N,12219.8252,W,1,09,0.92,55.8,M,-17.3,M,,*4A',
        '$GQRMC,071550.00,A,4736.4650,N,12219.8000,W,2.4,51.3,130926,,,A*75',
        '$GIRMC,071600.00,A,4736.4836,N,12219.7748,W,2.4,51.3,130926,,,A*61',
        '$PUBX,00,071600.00,4736.4836,N,12219.7748,W,55.8,G3,2.1,2.0,0.007,77.52,0.007,,0.92,1.19,0.77,9,0,0*7D',
        '$GNGSA,A,3,02,05,12,13,15,18,24,25,29,,,,1.61,0.92,1.32*10',
      ]);

      expect(confidence).toBe(0.8);
      expect(items.map((i) => [i.id, i.timestamp?.toISOString()])).toEqual([
        ['nmea:talkers.nmea:0:RMC', '2026-09-13T07:15:20.000Z'],
        ['nmea:talkers.nmea:1:RMC', '2026-09-13T07:15:30.000Z'],
        ['nmea:talkers.nmea:2:RMC', '2026-09-13T07:15:40.000Z'],
        // GGA has no date of its own and takes the $GBRMC one before it.
        ['nmea:talkers.nmea:3:GGA', '2026-09-13T07:15:40.000Z'],
        ['nmea:talkers.nmea:4:RMC', '2026-09-13T07:15:50.000Z'],
        ['nmea:talkers.nmea:5:RMC', '2026-09-13T07:16:00.000Z'],
      ]);
    });

    it('looks for a fix in the first 50 lines and no further', async () => {
      const filler = (n: number) =>
        Array.from({ length: n }, () => '$GNGSA,A,1,,,,,,,,,,,,,99.99,99.99,99.99*2E');

      expect((await importLines('fix-line-50', [...filler(49), ...gnLog.slice(-4)])).confidence).toBe(0.8);
      expect((await importLines('fix-line-51', [...filler(50), ...gnLog.slice(-4)])).confidence).toBe(0);
    });

    it('stops looking for a fix after the first 8 KiB', async () => {
      // 30 lines, well under the line bound, but long enough that the fix
      // starts past 8 KiB: a text file that is not NMEA is not read whole.
      const filler = Array.from({ length: 30 }, (_, i) => `line ${i} ${'x'.repeat(300)}`);
      const { confidence } = await importLines('late-bytes', [...filler, ...gnLog.slice(-4)]);

      expect(confidence).toBe(0);
    });
  });
});

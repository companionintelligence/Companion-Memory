import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dropReasonFor } from '../../telemetry/dropReasons';
import { GeoJSONFileImporter } from '../geojson';
import { GoogleLocationFileImporter } from '../google_location';
import { GPXFileImporter } from '../gpx';
import { KMLGXFileImporter } from '../kmlgx';
import { NMEAFileImporter } from '../nmea';
import type { DirEntry } from '../registry';
import type { Graph, ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

/**
 * U-22 — the location parsers' drop ledger was vacuously balanced.
 *
 * `stageSummary.ts` reconciles `consumed = produced + dropped`, but it derives
 * `consumed` FROM the other two unless a parser calls `pipeline.consumed(n)`.
 * The five raw-GPS parsers called neither `drop()` nor `consumed()`, so the
 * equality held by construction no matter how many fixes they threw away: a
 * `.gpx` where every point sat outside the timeframe reported "consumed 0,
 * produced 0" — indistinguishable from a file that was never read.
 *
 * These tests assert the ledger for what it now is: a MEASURED consumed figure
 * that the produced rows and the named drops have to add back up to.
 */

interface Ledger {
  produced: number;
  dropped: number;
  consumed: number;
  drops: Record<string, number>;
}

function harness(timeframe: unknown = {}): { params: ImportParams; ledger: Ledger } {
  const ledger: Ledger = { produced: 0, dropped: 0, consumed: 0, drops: {} };
  const params = {
    options: {},
    timeframe,
    log: () => {},
    pipeline: {
      push: (g: Graph) => {
        if ((g as EmittedGraph).item) {
          ledger.produced += 1;
        }
      },
      drop: (reason: string) => {
        ledger.dropped += 1;
        ledger.drops[reason] = (ledger.drops[reason] ?? 0) + 1;
      },
      consumed: (n: number) => {
        ledger.consumed += n;
      },
    },
  } as unknown as ImportParams;

  return { params, ledger };
}

/** The invariant `stageSummary.buildStageSummary` checks, asserted at the source. */
function expectBalanced(ledger: Ledger): void {
  expect(ledger.consumed).toBe(ledger.produced + ledger.dropped);
  // And the equality must not be the trivial 0 = 0 + 0 it used to be.
  expect(ledger.consumed).toBeGreaterThan(0);
}

function tmpFile(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loc-ledger-'));
  const full = path.join(dir, name);
  fs.writeFileSync(full, body, 'utf8');

  return full;
}

describe('google_location: Records.json ledger', () => {
  function records(locations: unknown[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loc-ledger-gl-'));
    fs.writeFileSync(path.join(dir, 'Records.json'), JSON.stringify({ locations }), 'utf8');

    return dir;
  }

  const good = { latitudeE7: 377749000, longitudeE7: -1224194000, timestamp: '2024-03-02T10:00:00Z' };
  const nullIsland = { latitudeE7: 0, longitudeE7: 0, timestamp: '2024-03-02T10:01:00Z' };
  const oneAxis = { latitudeE7: 377749000, timestamp: '2024-03-02T10:02:00Z' };
  const old = { latitudeE7: 377749000, longitudeE7: -1224194000, timestamp: '2019-01-01T00:00:00Z' };

  it('accounts for every record it read: a fix, a null island, a half fix, a stale one', async () => {
    const root = records([good, nullIsland, oneAxis, old]);
    const { params, ledger } = harness({ since: new Date('2024-01-01T00:00:00Z') });
    await new GoogleLocationFileImporter().fileImport({}, { filename: 'x', fullPath: root }, params);

    expect(ledger.consumed).toBe(4);
    expect(ledger.produced).toBe(1);
    expect(ledger.drops).toEqual({ position_without_fix: 2, outside_timeframe: 1 });
    expectBalanced(ledger);
  });

  it('reports a whole file dropped as consumed>0, not as "never read"', async () => {
    const root = records([old, old, old]);
    const { params, ledger } = harness({ since: new Date('2024-01-01T00:00:00Z') });
    await new GoogleLocationFileImporter().fileImport({}, { filename: 'x', fullPath: root }, params);

    expect(ledger.produced).toBe(0);
    expect(ledger.consumed).toBe(3);
    expect(ledger.drops).toEqual({ outside_timeframe: 3 });
    expectBalanced(ledger);
  });
});

describe('geojson: FeatureCollection ledger', () => {
  const feature = (coords: unknown, time?: string) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: coords },
    properties: time ? { time } : {},
  });

  it('accounts for a good point, a geometry-less feature, an unreadable pair, and a stale point', async () => {
    const fpath = tmpFile(
      'sample.geojson',
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          feature([-122.4194, 37.7749], '2024-03-02T10:00:00Z'),
          { type: 'Feature', properties: {} },
          feature(['not', 'numbers'], '2024-03-02T10:00:00Z'),
          feature([-122.4194, 37.7749], '2019-01-01T00:00:00Z'),
        ],
      }),
    );

    const { params, ledger } = harness({ since: new Date('2024-01-01T00:00:00Z') });
    await new GeoJSONFileImporter().fileImport({}, { filename: 'sample.geojson', fullPath: fpath }, params);

    expect(ledger.consumed).toBe(4);
    expect(ledger.produced).toBe(1);
    expect(ledger.drops).toEqual({ position_without_fix: 2, outside_timeframe: 1 });
    expectBalanced(ledger);
  });

  it('counts each vertex of a LineString, not each feature', async () => {
    const fpath = tmpFile(
      'line.geojson',
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [-122.4194, 37.7749],
                [-122.4084, 37.7858],
                [-122.4, 37.79],
              ],
            },
            properties: {},
          },
        ],
      }),
    );

    const { params, ledger } = harness();
    await new GeoJSONFileImporter().fileImport({}, { filename: 'line.geojson', fullPath: fpath }, params);

    expect(ledger.consumed).toBe(3);
    expect(ledger.produced).toBe(3);
    expectBalanced(ledger);
  });
});

describe('gpx: trackpoint and waypoint ledger', () => {
  it('accounts for a kept point, a stale point and a coordinate-less point', async () => {
    const fpath = tmpFile(
      'track.gpx',
      '<?xml version="1.0"?><gpx><trk><trkseg>' +
        '<trkpt lat="12.34" lon="56.78"><time>2024-03-02T10:00:00Z</time></trkpt>' +
        '<trkpt lat="12.35" lon="56.79"><time>2019-01-01T00:00:00Z</time></trkpt>' +
        '<trkpt lat="nope" lon="56.80"><time>2024-03-02T10:02:00Z</time></trkpt>' +
        '</trkseg></trk>' +
        '<wpt lat="12.40" lon="56.90"><name>Summit</name><time>2024-03-02T11:00:00Z</time></wpt>' +
        '<wpt lat="bad" lon="56.91"><name>Broken</name></wpt>' +
        '</gpx>',
    );

    const { params, ledger } = harness({ since: new Date('2024-01-01T00:00:00Z') });
    await new GPXFileImporter().fileImport(undefined, { fullPath: fpath } as DirEntry, params);

    expect(ledger.consumed).toBe(5);
    expect(ledger.produced).toBe(2);
    expect(ledger.drops).toEqual({ position_without_fix: 2, outside_timeframe: 1 });
    expectBalanced(ledger);
  });
});

describe('nmea: sentence ledger', () => {
  it('accounts for a valid fix, a void fix and a stale fix', async () => {
    // $GPRMC field 2 is the status: 'A' = valid, 'V' = warning (no fix).
    const fpath = tmpFile(
      'track.nmea',
      [
        '$GPRMC,120000.00,A,3742.5000,N,12225.0000,W,0.0,0.0,020324,,,A*00',
        '$GPRMC,120100.00,V,3742.5000,N,12225.0000,W,0.0,0.0,020324,,,N*00',
        '$GPRMC,120000.00,A,3742.5000,N,12225.0000,W,0.0,0.0,010119,,,A*00',
        '',
      ].join('\n'),
    );

    const { params, ledger } = harness({ since: new Date('2024-01-01T00:00:00Z') });
    await new NMEAFileImporter().fileImport({}, { filename: 'track.nmea', fullPath: fpath }, params);

    expect(ledger.consumed).toBe(3);
    expect(ledger.produced).toBe(1);
    expect(ledger.drops).toEqual({ position_without_fix: 1, outside_timeframe: 1 });
    expectBalanced(ledger);
  });
});

describe('kmlgx: gx:Track ledger', () => {
  it('accounts for a kept coord, a stale coord and an unparseable coord', async () => {
    const fpath = tmpFile(
      'history.kml',
      '<?xml version="1.0"?><kml xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Placemark><gx:Track>' +
        '<when>2024-03-02T10:00:00Z</when><gx:coord>-122.4194 37.7749 10</gx:coord>' +
        '<when>2019-01-01T00:00:00Z</when><gx:coord>-122.4084 37.7858 10</gx:coord>' +
        '<when>2024-03-02T10:02:00Z</when><gx:coord>notanumber 37.79 10</gx:coord>' +
        '</gx:Track></Placemark></Document></kml>',
    );

    const { params, ledger } = harness({ since: new Date('2024-01-01T00:00:00Z') });
    await new KMLGXFileImporter().fileImport({}, { filename: 'history.kml', fullPath: fpath }, params);

    expect(ledger.consumed).toBe(3);
    expect(ledger.produced).toBe(1);
    expect(ledger.drops).toEqual({ position_without_fix: 1, outside_timeframe: 1 });
    expectBalanced(ledger);
  });
});

describe('the slugs these parsers emit are in the closed vocabulary', () => {
  // Belt and braces alongside telemetry/__tests__/dropReasons.ts's on-disk scan:
  // an unregistered slug lands in `unclassified`, which is a gap nobody named.
  it.each(['outside_timeframe', 'position_without_fix'])('classifies %s', (slug) => {
    expect(dropReasonFor(slug)).not.toBe('unclassified');
  });
});

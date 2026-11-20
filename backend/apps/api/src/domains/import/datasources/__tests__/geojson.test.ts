import fs from 'fs';
import os from 'os';
import path from 'path';

import { GeoJSONFileImporter } from '../geojson';
import type { ImportParams } from '../timeline';

import type { EmittedGraph, TestPipeline } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** Import one FeatureCollection and return what it pushed, dropped and read. */
async function importDoc(features: unknown[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geojson-times-'));
  const fpath = path.join(dir, 'track.geojson');
  fs.writeFileSync(fpath, JSON.stringify({ type: 'FeatureCollection', features }));
  const pipeline = [] as unknown as TestPipeline;
  const drops: string[] = [];
  let consumed = 0;
  pipeline.drop = (reason) => drops.push(reason);
  pipeline.consumed = (n = 1) => {
    consumed += n;
  };

  try {
    await new GeoJSONFileImporter().fileImport({}, { filename: 'track.geojson', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { items: pipeline.map((g) => g.item), drops, consumed };
}

const iso = (d?: Date) => d?.toISOString();

describe('GeoJSON datasource', () => {
  it('recognizes .geojson file', async () => {
    const geoPath = path.join(FIXTURES_DIR, 'sample.geojson');
    const fi = new GeoJSONFileImporter();
    const rec = await fi.recognize({}, { filename: 'sample.geojson', fullPath: geoPath });
    expect(rec.confidence).toBe(1.0);
  });

  it('imports GeoJSON features', async () => {
    const geoPath = path.join(FIXTURES_DIR, 'sample.geojson');
    const fi = new GeoJSONFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'sample.geojson', fullPath: geoPath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    const items = pipeline.filter((p) => p.item);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].item.classification).toBe('location');
    expect(items[0].item.location).toBeDefined();
    expect(items[0].item.location?.latitude).toBeCloseTo(37.7749, 4);
    expect(items[0].item.location?.longitude).toBeCloseTo(-122.4194, 4);
    expect(items[0].item.metadata?.Source).toBe('GeoJSON');
  });

  it('assigns stable unique ids so revisited/closed-loop coordinates do not collapse', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geojson-dedup-'));
    const fpath = path.join(dir, 'loop.geojson');
    // A closed-loop LineString whose first and last vertices are identical, with
    // no timestamp. Under the old timestamp-only/coord hash (constant filename)
    // the repeated coordinate would collapse to one item.
    const doc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [-122.4194, 37.7749],
              [-122.4084, 37.7858],
              [-122.4194, 37.7749],
            ],
          },
          properties: { name: 'Closed loop' },
        },
      ],
    };
    fs.writeFileSync(fpath, JSON.stringify(doc));

    const fi = new GeoJSONFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'loop.geojson', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(3);
    const ids = pipeline.map((p) => p.item.id!);
    expect(ids.every((id) => !!id)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    // Re-import yields identical ids (idempotent).
    const pipeline2: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'loop.geojson', fullPath: fpath }, {
      pipeline: pipeline2,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);
    expect(pipeline2.map((p) => p.item.id!)).toEqual(ids);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not collide ids across a MultiLineString whose first line carries 100,000+ positions', async () => {
    // `lineIdx * 100000 + i` looks like a collision-safe compound index but
    // isn't: once a single line hits 100,000 positions, its tail
    // (lineIdx=0, i=100000) lands on the same number as the next line's
    // start (lineIdx=1, i=0). A plain running counter across the whole
    // feature can never collide.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geojson-multiline-'));
    const fpath = path.join(dir, 'multi.geojson');
    const longLine: number[][] = [];
    for (let i = 0; i <= 100000; i++) {
      longLine.push([-122 + i * 0.00001, 37 + i * 0.00001]);
    }

    const doc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              longLine,
              [
                [-121, 36],
                [-121.001, 36.001],
              ],
            ],
          },
          properties: {},
        },
      ],
    };
    fs.writeFileSync(fpath, JSON.stringify(doc));

    const fi = new GeoJSONFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'multi.geojson', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(longLine.length + 2);
    const ids = pipeline.map((p) => p.item.id!);
    expect(new Set(ids).size).toBe(ids.length);

    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000);

  it('promotes lower-case name/description props to capitalised metadata keys', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geojson-name-'));
    const fpath = path.join(dir, 'named.geojson');
    const doc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-122.4194, 37.7749] },
          properties: { name: 'Trailhead', description: 'start' },
        },
      ],
    };
    fs.writeFileSync(fpath, JSON.stringify(doc));

    const fi = new GeoJSONFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'named.geojson', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.metadata?.Name).toBe('Trailhead');
    expect(pipeline[0].item.metadata?.Description).toBe('start');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('point times', () => {
    // A GPX track as togeojson converts it: no feature time, one time per point
    // in `coordinateProperties.times`.
    const walk = {
      type: 'Feature',
      properties: {
        name: 'Morning walk',
        _gpxType: 'trk',
        coordinateProperties: {
          times: ['2026-05-04T07:00:00Z', '2026-05-04T07:00:10Z', '2026-05-04T07:00:20Z'],
        },
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-9.15, 38.71],
          [-9.149, 38.7108],
          [-9.1478, 38.7115],
        ],
      },
    };

    it('gives each LineString point its own time from coordinateProperties.times', async () => {
      const { items, drops, consumed } = await importDoc([walk]);

      expect(items.map((i) => iso(i.timestamp))).toEqual([
        '2026-05-04T07:00:00.000Z',
        '2026-05-04T07:00:10.000Z',
        '2026-05-04T07:00:20.000Z',
      ]);
      expect(items[1].location?.latitude).toBeCloseTo(38.7108, 6);
      expect(drops).toEqual([]);
      expect(consumed).toBe(3);
    });

    it('keeps the per-point arrays out of every point metadata', async () => {
      const { items } = await importDoc([
        walk,
        {
          type: 'Feature',
          properties: { coordTimes: ['2026-05-04T08:00:00Z'] },
          geometry: { type: 'LineString', coordinates: [[-9.15, 38.71]] },
        },
      ]);

      expect(items).toHaveLength(4);
      for (const item of items) {
        expect(item.metadata).not.toHaveProperty('coordinateProperties');
        expect(item.metadata).not.toHaveProperty('coordTimes');
      }

      expect(items[0].metadata.Name).toBe('Morning walk');
      expect(items[0].metadata._gpxType).toBe('trk');
    });

    it('reads the nested per-line times of a MultiLineString', async () => {
      const { items } = await importDoc([
        {
          type: 'Feature',
          properties: {
            coordinateProperties: {
              times: [
                ['2026-05-06T10:00:00Z', '2026-05-06T10:00:30Z'],
                [1778061900000, null],
              ],
            },
          },
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [-9.136, 38.712],
                [-9.135, 38.7125],
              ],
              [
                [-9.13, 38.714],
                [-9.129, 38.7146],
              ],
            ],
          },
        },
      ]);

      expect(items.map((i) => iso(i.timestamp))).toEqual([
        '2026-05-06T10:00:00.000Z',
        '2026-05-06T10:00:30.000Z',
        '2026-05-06T10:05:00.000Z',
        // A null entry is a point with no time; it is not given its neighbour's.
        undefined,
      ]);
      expect(items.map((i) => i.id)).toEqual([
        'geojson:track.geojson:0:0',
        'geojson:track.geojson:0:1',
        'geojson:track.geojson:0:2',
        'geojson:track.geojson:0:3',
      ]);
    });

    it('reads coordTimes, the per-point times older togeojson releases write', async () => {
      const { items } = await importDoc([
        {
          type: 'Feature',
          properties: { name: 'Old export', coordTimes: ['2026-05-04T07:00:00Z', '2026-05-04T07:00:10Z'] },
          geometry: {
            type: 'LineString',
            coordinates: [
              [-9.15, 38.71],
              [-9.149, 38.7108],
            ],
          },
        },
      ]);

      expect(items.map((i) => iso(i.timestamp))).toEqual([
        '2026-05-04T07:00:00.000Z',
        '2026-05-04T07:00:10.000Z',
      ]);
    });

    it('gives a shared feature time to the first point only and counts the rest', async () => {
      const { items, drops, consumed } = await importDoc([
        {
          type: 'Feature',
          properties: { name: 'Tram 28 legs', time: '2026-05-06T10:00:00Z' },
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [-9.136, 38.712],
                [-9.135, 38.7125],
              ],
              [
                [-9.13, 38.714],
                [-9.129, 38.7146],
              ],
            ],
          },
        },
        {
          type: 'Feature',
          properties: { name: 'Picnic spots', timestamp: 1777982400000 },
          geometry: {
            type: 'MultiPoint',
            coordinates: [
              [-9.16, 38.726],
              [-9.159, 38.727],
            ],
          },
        },
      ]);

      expect(items.map((i) => [i.id, iso(i.timestamp)])).toEqual([
        ['geojson:track.geojson:0:0', '2026-05-06T10:00:00.000Z'],
        ['geojson:track.geojson:1:0', '2026-05-05T12:00:00.000Z'],
      ]);
      expect(drops).toEqual([
        'position_shared_time',
        'position_shared_time',
        'position_shared_time',
        'position_shared_time',
      ]);
      expect(consumed).toBe(6);
    });

    it('passes the shared time on when the first point has no usable coordinates', async () => {
      const { items, drops } = await importDoc([
        {
          type: 'Feature',
          properties: { time: '2026-05-06T10:00:00Z' },
          geometry: {
            type: 'LineString',
            coordinates: [[-9.136], [-9.135, 38.7125], [-9.13, 38.714]],
          },
        },
      ]);

      expect(items.map((i) => [i.id, iso(i.timestamp)])).toEqual([
        ['geojson:track.geojson:0:1', '2026-05-06T10:00:00.000Z'],
      ]);
      expect(drops).toEqual(['position_without_fix', 'position_shared_time']);
    });

    it('still emits every point of a feature with no time at all', async () => {
      const { items, drops } = await importDoc([
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [-9.136, 38.712],
              [-9.135, 38.7125],
            ],
          },
        },
      ]);

      expect(items.map((i) => i.timestamp)).toEqual([undefined, undefined]);
      expect(drops).toEqual([]);
    });

    it('does not count up to a length the coordinates only claim to have', async () => {
      // Objects, not arrays: nothing to read, however large `length` says it is.
      const { items, drops, consumed } = await importDoc([
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: { length: 1e6 } } },
        {
          type: 'Feature',
          properties: { time: '2026-05-06T10:00:00Z' },
          geometry: { type: 'MultiLineString', coordinates: [{ length: 1e6 }] },
        },
        walk,
      ]);

      expect(items.map((i) => i.id)).toEqual([
        'geojson:track.geojson:2:0',
        'geojson:track.geojson:2:1',
        'geojson:track.geojson:2:2',
      ]);
      expect(drops).toEqual([]);
      expect(consumed).toBe(3);
    });
  });
});

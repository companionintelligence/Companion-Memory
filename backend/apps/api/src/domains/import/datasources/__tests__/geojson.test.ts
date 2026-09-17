import fs from 'fs';
import os from 'os';
import path from 'path';

import { GeoJSONFileImporter } from '../geojson';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

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
});

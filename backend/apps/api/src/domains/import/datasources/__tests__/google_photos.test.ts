import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { allDataSources } from '../registry';
import type { DirEntry } from '../registry';
import type { ImportParams, Relationship } from '../timeline';

import type { EmittedGraph } from './support/emitted';

import '../google_photos';

function getImporter(name: string) {
  const ds = allDataSources().find((d) => d.name === name);
  if (!ds?.newFileImporter) {
    throw new Error('missing importer');
  }

  return ds.newFileImporter();
}

describe('google_photos importer', () => {
  it('recognizes Takeout Google Photos path', async () => {
    const importer = getImporter('google_photos');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'takeout-'));
    const gp = path.join(dir, 'Takeout', 'Google Photos');
    await fs.promises.mkdir(gp, { recursive: true });
    const rec = await importer.recognize({}, { filename: gp, fullPath: gp } as DirEntry, {});
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes a flattened Google Photos root (Takeout/ wrapper stripped)', async () => {
    const importer = getImporter('google_photos');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'takeout-'));
    const gp = path.join(dir, 'Google Photos');
    await fs.promises.mkdir(gp, { recursive: true });
    const rec = await importer.recognize({}, { filename: gp, fullPath: gp } as DirEntry, {});
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('imports an album photo with its photoTakenTime + collection edge', async () => {
    const importer = getImporter('google_photos');
    const root = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-album-'));
    const gp = path.join(root, 'Google Photos');
    const album = path.join(gp, 'Photos from 2020');
    await fs.promises.mkdir(album, { recursive: true });
    const img = path.join(album, 'photo.jpg');
    await fs.promises.writeFile(img, Buffer.from([0xff, 0xd8, 0xff]));
    // 1577836800 = 2020-01-01T00:00:00Z
    await fs.promises.writeFile(
      `${img}.supplemental-metadata.json`,
      JSON.stringify({
        title: 'photo.jpg',
        photoTakenTime: { timestamp: '1577836800' },
      }),
    );
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: gp, fullPath: gp } as DirEntry,
      {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );
    const graph = pipeline.find((p) => p.item?.content?.filename === 'photo.jpg');
    expect(graph).toBeTruthy();
    expect(graph!.item.timestamp!.getTime()).toBe(1577836800 * 1000);
    expect(graph!.item.metadata['Timestamp Source']).toBeUndefined();
    const collection = graph!.edges!.find((e: Relationship) => e.relation === 'in_collection');
    expect(collection?.to?.item?.content?.filename).toBe('Photos from 2020');
  });

  it('dates an -edited copy and a motion clip with their original, and links both to it', async () => {
    const importer = getImporter('google_photos');
    const root = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-edited-'));
    const gp = path.join(root, 'Google Photos');
    const album = path.join(gp, 'Photos from 2026');
    await fs.promises.mkdir(album, { recursive: true });
    // Takeout writes no sidecar for the -edited copy or for the clip of a
    // Live/motion photo; the still's sidecar is the only date either has.
    for (const name of ['PXL_20261003_154211234.jpg', 'PXL_20261003_154211234-edited.jpg']) {
      await fs.promises.writeFile(path.join(album, name), Buffer.from([0xff, 0xd8, 0xff]));
    }

    await fs.promises.writeFile(path.join(album, 'IMG_4821.JPG'), Buffer.from([0xff, 0xd8, 0xff]));
    await fs.promises.writeFile(path.join(album, 'IMG_4821.MP4'), Buffer.from([0x00, 0x00, 0x00]));
    // 1791042131 = 2026-10-03T15:42:11Z, 1791774900 = 2026-10-12T03:15:00Z
    await fs.promises.writeFile(
      path.join(album, 'PXL_20261003_154211234.jpg.supplemental-metadata.json'),
      JSON.stringify({ title: 'PXL_20261003_154211234.jpg', photoTakenTime: { timestamp: '1791042131' } }),
    );
    await fs.promises.writeFile(
      path.join(album, 'IMG_4821.JPG.supplemental-metadata.json'),
      JSON.stringify({ title: 'IMG_4821.JPG', photoTakenTime: { timestamp: '1791774900' } }),
    );
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: gp, fullPath: gp } as DirEntry,
      { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams,
    );

    const original = pipeline.find((p) => p.item?.content?.filename === 'PXL_20261003_154211234.jpg');
    const edit = original!.edges!.find((e: Relationship) => e.relation === 'edit');
    expect(edit?.to?.item?.content?.filename).toBe('PXL_20261003_154211234-edited.jpg');
    expect(edit?.to?.item?.timestamp?.getTime()).toBe(1791042131 * 1000);

    const still = pipeline.find((p) => p.item?.content?.filename === 'IMG_4821.JPG');
    const motion = still!.edges!.find((e: Relationship) => e.relation === 'motion_photo');
    expect(motion?.to?.item?.content?.filename).toBe('IMG_4821.MP4');
    expect(motion?.to?.item?.timestamp?.getTime()).toBe(1791774900 * 1000);
  });

  it('pairs a duplicate-counter photo with its (N) sidecar', async () => {
    const importer = getImporter('google_photos');
    const root = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-dup-'));
    const album = path.join(root, 'Google Photos', 'Photos from 2010');
    await fs.promises.mkdir(album, { recursive: true });
    // Media file carries the (1); the sidecar keeps the counter before .json on
    // the ORIGINAL name — the case the old lookup missed (→ epoch fallback).
    const dupImg = path.join(album, 'IMG_0001(1).jpg');
    await fs.promises.writeFile(dupImg, Buffer.from([0xff, 0xd8, 0xff]));
    // 1262304000 = 2010-01-01T00:00:00Z
    await fs.promises.writeFile(
      path.join(album, 'IMG_0001.jpg.supplemental-metadata(1).json'),
      JSON.stringify({ title: 'IMG_0001.jpg', photoTakenTime: { timestamp: '1262304000' } }),
    );
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: path.join(root, 'Google Photos'), fullPath: path.join(root, 'Google Photos') } as DirEntry,
      {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );
    const graph = pipeline.find((p) => p.item?.content?.filename === 'IMG_0001(1).jpg');
    expect(graph).toBeTruthy();
    expect(graph!.item.timestamp!.getTime()).toBe(1262304000 * 1000);
  });

  it('keeps location + Title/URL on a photo that also has people', async () => {
    const importer = getImporter('google_photos');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-people-'));
    const img = path.join(dir, 'beach.jpg');
    await fs.promises.writeFile(img, Buffer.from([0xff, 0xd8, 0xff]));
    await fs.promises.writeFile(
      `${img}.json`,
      JSON.stringify({
        people: [{ name: 'Alice' }],
        geoData: { latitude: 37.7, longitude: -122.4 },
        title: 'Beach',
        url: 'http://x',
      }),
    );
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );
    const graph = pipeline.find((p) => p.item?.content?.filename === 'beach.jpg');
    expect(graph).toBeTruthy();
    expect(graph!.item.location?.latitude).toBe(37.7);
    expect(graph!.item.metadata.Title).toBe('Beach');
    expect(graph!.item.metadata.URL).toBe('http://x');
  });

  it('lifts geoData.altitude into metadata.Altitude (canonical mapper reads this for the position pipeline)', async () => {
    const importer = getImporter('google_photos');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-alt-'));
    const img = path.join(dir, 'mountain.jpg');
    await fs.promises.writeFile(img, Buffer.from([0xff, 0xd8, 0xff]));
    await fs.promises.writeFile(
      `${img}.json`,
      JSON.stringify({
        geoData: { latitude: 46.5, longitude: 8.5, altitude: 1850.7 },
      }),
    );
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );
    const graph = pipeline.find((p) => p.item?.content?.filename === 'mountain.jpg');
    expect(graph?.item.metadata.Altitude).toBe(1850.7);
  });

  it('treats a Takeout altitude of 0.0 as absent (matches the lat/lon null-island guard)', async () => {
    const importer = getImporter('google_photos');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-alt-zero-'));
    const img = path.join(dir, 'flat.jpg');
    await fs.promises.writeFile(img, Buffer.from([0xff, 0xd8, 0xff]));
    await fs.promises.writeFile(
      `${img}.json`,
      JSON.stringify({
        geoData: { latitude: 37.7, longitude: -122.4, altitude: 0 },
      }),
    );
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );
    const graph = pipeline.find((p) => p.item?.content?.filename === 'flat.jpg');
    expect(graph?.item.location).toBeDefined(); // lat/lon still landed
    expect(graph?.item.metadata.Altitude).toBeUndefined();
  });

  it('reads altitude from the matching geo block (geoDataExif when geoData is absent)', async () => {
    const importer = getImporter('google_photos');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-exif-alt-'));
    const img = path.join(dir, 'roof.jpg');
    await fs.promises.writeFile(img, Buffer.from([0xff, 0xd8, 0xff]));
    await fs.promises.writeFile(
      `${img}.json`,
      JSON.stringify({
        // No top-level geoData; falls back to geoDataExif and lifts its altitude.
        geoDataExif: { latitude: 51.5, longitude: -0.1, altitude: 35 },
      }),
    );
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );
    const graph = pipeline.find((p) => p.item?.content?.filename === 'roof.jpg');
    expect(graph?.item.location?.latitude).toBe(51.5);
    expect(graph?.item.metadata.Altitude).toBe(35);
  });

  it('extracts GPS + altitude from album sidecars under /Takeout/Google Photos (the album loop used to drop both)', async () => {
    // Takeout albums route through importTakeoutAlbums(), which previously
    // only pulled timestamp/title/description/url/people — photos lost their
    // coordinates entirely when imported via an album folder.
    const importer = getImporter('google_photos');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-album-'));
    const albumRoot = path.join(dir, 'Takeout', 'Google Photos', '2024 - Iceland');
    await fs.promises.mkdir(albumRoot, { recursive: true });
    const img = path.join(albumRoot, 'glacier.jpg');
    await fs.promises.writeFile(img, Buffer.from([0xff, 0xd8, 0xff]));
    await fs.promises.writeFile(
      `${img}.json`,
      JSON.stringify({
        title: 'glacier.jpg',
        photoTakenTime: { timestamp: '1704067200' }, // 2024-01-01
        geoData: { latitude: 64.4, longitude: -16.7, altitude: 240 },
      }),
    );
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      {
        filename: path.join(dir, 'Takeout', 'Google Photos'),
        fullPath: path.join(dir, 'Takeout', 'Google Photos'),
      } as DirEntry,
      {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );
    const graph = pipeline.find((p) => p.item?.content?.filename === 'glacier.jpg');
    expect(graph).toBeTruthy();
    expect(graph!.item.location).toEqual({ latitude: 64.4, longitude: -16.7 });
    expect(graph!.item.metadata.Altitude).toBe(240);
  });
});

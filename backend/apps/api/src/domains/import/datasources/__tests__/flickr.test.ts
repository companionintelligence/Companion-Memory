import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { allDataSources } from '../registry';
import type { DirEntry } from '../registry';
import type { ImportParams, Relationship } from '../timeline';

import type { EmittedGraph } from './support/emitted';

import '../flickr';

/**
 * Fixture JSON below reproduces the real field names and shape of
 * `github.com/yaniv-golan/offlickr`'s checked-in
 * `tests/fixtures/mini-export/photo_10000001.json` and `albums.json` — the
 * fullest documented sample of Flickr's own `photo_<id>.json` sidecar found
 * for this importer (see flickr.ts's file header for the full source list).
 * Values are trimmed to the fields this importer reads; nothing here is
 * invented.
 */
function getImporter(name: string) {
  const ds = allDataSources().find((d) => d.name === name);
  if (!ds?.newFileImporter) {
    throw new Error('missing importer');
  }

  return ds.newFileImporter();
}

async function writeMiniExport(dir: string) {
  // test-photo-one_10000001_o.jpg — media filename convention confirmed by
  // offlickr's ingest/media.py: <slug>_<photo id>_o.<ext>.
  await fs.promises.writeFile(
    path.join(dir, 'test-photo-one_10000001_o.jpg'),
    Buffer.from([0xff, 0xd8, 0xff]),
  );
  await fs.promises.writeFile(
    path.join(dir, 'photo_10000001.json'),
    JSON.stringify({
      id: '10000001',
      name: 'Blue sunset',
      description: '',
      count_views: '1',
      count_faves: '0',
      count_comments: '1',
      date_taken: '2020-03-15 17:30:00',
      count_tags: '2',
      count_notes: '1',
      rotation: 0,
      date_imported: '2020-03-15 18:00:00',
      photopage: 'https://www.flickr.com/photos/testuser/10000001/',
      original: 'https://live.staticflickr.com/9999/10000001_aaaaaaaaaa_o.jpg',
      license: 'CC BY-NC-SA 4.0',
      geo: [{ latitude: '32085000', longitude: '34781000', accuracy: '16' }],
      groups: [{ id: '11111111@N00', name: 'Test Group', url: 'https://www.flickr.com/groups/testgroup/' }],
      albums: [
        {
          id: '10000000000000001',
          title: 'Album One',
          url: 'https://www.flickr.com/photos/testuser/sets/10000000000000001/',
        },
      ],
      tags: [
        {
          tag: 'sunset',
          user: 'https://www.flickr.com/photos/testuser/',
          date_create: '2020-03-15 18:00:00',
        },
      ],
      people: [
        {
          nsid: '77777777@N00',
          username: 'testfriend',
          userurl: 'https://www.flickr.com/people/testfriend/',
        },
      ],
      notes: [],
      privacy: 'public',
      safety: 'safe',
      comments: [],
    }),
  );
}

describe('flickr importer', () => {
  it('recognizes a directory containing photo_<id>.json sidecars', async () => {
    const importer = getImporter('flickr');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'flickr-'));
    await writeMiniExport(dir);
    const rec = await importer.recognize({}, { filename: dir, fullPath: dir } as DirEntry, {});
    expect(rec.confidence).toBeGreaterThan(0.7);
  });

  it('does not recognize an unrelated directory', async () => {
    const importer = getImporter('flickr');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'flickr-neg-'));
    await fs.promises.writeFile(path.join(dir, 'random.json'), '{}');
    const rec = await importer.recognize({}, { filename: dir, fullPath: dir } as DirEntry, {});
    expect(rec.confidence).toBe(0);
  });

  it('gives a metadata-only drop (albums.json, no sidecars yet) a soft directory claim', async () => {
    const importer = getImporter('flickr');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'flickr-albums-only-'));
    await fs.promises.writeFile(path.join(dir, 'albums.json'), JSON.stringify({ albums: [] }));
    const rec = await importer.recognize({}, { filename: dir, fullPath: dir } as DirEntry, {});
    expect(rec.confidence).toBeGreaterThan(0);
    expect(rec.confidence).toBeLessThan(0.7);
  });

  it('imports a photo with title, date_taken, geo, license, tags, album and person edges', async () => {
    const importer = getImporter('flickr');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'flickr-import-'));
    await writeMiniExport(dir);

    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams,
    );

    const graph = pipeline.find((p) => p.item?.content?.filename === 'test-photo-one_10000001_o.jpg');
    expect(graph).toBeTruthy();

    const item = graph!.item;
    expect(item.metadata.Title).toBe('Blue sunset');
    expect(item.metadata.License).toBe('CC BY-NC-SA 4.0');
    expect(item.metadata.URL).toBe('https://www.flickr.com/photos/testuser/10000001/');
    expect(item.metadata.Tags).toEqual(['sunset']);
    expect(item.metadata['Timestamp Source']).toBe('date_taken');
    // 2020-03-15 17:30:00 interpreted as UTC (Flickr ships no zone).
    expect(item.timestamp!.toISOString()).toBe('2020-03-15T17:30:00.000Z');

    // Geo ships as millionths of a degree in a one-element array.
    expect(item.location?.latitude).toBeCloseTo(32.085, 5);
    expect(item.location?.longitude).toBeCloseTo(34.781, 5);

    const collection = graph!.edges!.find((e: Relationship) => e.relation === 'in_collection');
    expect(collection?.to?.item?.content?.filename).toBe('Album One');

    const person = graph!.edges!.find((e: Relationship) => e.relation === 'includes');
    expect(person?.to?.entity?.name).toBe('testfriend');
    expect(person?.to?.entity?.attributes?.[0]).toEqual({
      name: 'flickr_nsid',
      value: '77777777@N00',
      identity: true,
    });
  });

  it('falls back to date_imported when date_taken is the "0000-00-00" missing-date sentinel', async () => {
    const importer = getImporter('flickr');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'flickr-noimport-'));
    await fs.promises.writeFile(path.join(dir, 'clip_10000010_o.mp4'), Buffer.from([0x00, 0x00, 0x00]));
    await fs.promises.writeFile(
      path.join(dir, 'photo_10000010.json'),
      JSON.stringify({
        id: '10000010',
        name: 'Test video',
        date_taken: '0000-00-00 00:00:00',
        date_imported: '2020-12-01 10:00:00',
        geo: [],
        albums: [],
        tags: [],
        people: [],
      }),
    );

    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams,
    );

    const graph = pipeline.find((p) => p.item?.content?.filename === 'clip_10000010_o.mp4');
    expect(graph).toBeTruthy();
    expect(graph!.item.metadata['Timestamp Source']).toBe('date_imported');
    expect(graph!.item.timestamp!.toISOString()).toBe('2020-12-01T10:00:00.000Z');
    expect(graph!.item.location).toBeUndefined();
  });

  it('skips a photo_<id>.json sidecar with no matching media file instead of pushing a content-less item', async () => {
    const importer = getImporter('flickr');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'flickr-orphan-'));
    await fs.promises.writeFile(
      path.join(dir, 'photo_10000099.json'),
      JSON.stringify({ id: '10000099', name: 'No bytes for this one' }),
    );

    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams,
    );

    expect(pipeline).toHaveLength(0);
  });

  it('disambiguates the photo id from a secret token between the id and the trailing _o', async () => {
    // Real Flickr export filenames can carry a secret hash token between the
    // id and the trailing _o (e.g. the `original` URL in the fixture above:
    // 10000001_aaaaaaaaaa_o.jpg). The id is the LEFTMOST all-digit token.
    const importer = getImporter('flickr');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'flickr-secret-'));
    await fs.promises.writeFile(path.join(dir, 'my-photo_20000002_bbbb1111_o.jpg'), Buffer.from([0xff]));
    await fs.promises.writeFile(
      path.join(dir, 'photo_20000002.json'),
      JSON.stringify({ id: '20000002', name: 'Secret-token filename', date_taken: '2021-06-01 09:00:00' }),
    );

    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: dir, fullPath: dir } as DirEntry,
      { pipeline, timeframe: {}, log: () => {} } as unknown as ImportParams,
    );

    const graph = pipeline.find((p) => p.item?.content?.filename === 'my-photo_20000002_bbbb1111_o.jpg');
    expect(graph).toBeTruthy();
    expect(graph!.item.metadata.Title).toBe('Secret-token filename');
  });
});

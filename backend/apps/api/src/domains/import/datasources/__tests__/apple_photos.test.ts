import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { allDataSources } from '../registry';
import type { DirEntry } from '../registry';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

import '../apple_photos';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const LIBRARY = path.join(FIXTURES_DIR, 'apple_photos', 'Sample Library.photoslibrary');

function getImporter(name: string) {
  const ds = allDataSources().find((d) => d.name === name);
  if (!ds?.newFileImporter) {
    throw new Error('missing importer');
  }

  return ds.newFileImporter();
}

describe('apple_photos importer', () => {
  it('recognizes a .photoslibrary bundle', async () => {
    const importer = getImporter('apple_photos');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'photoslib-'));
    const bundle = path.join(dir, 'MyLibrary.photoslibrary');
    await fs.promises.mkdir(path.join(bundle, 'database'), { recursive: true });
    await fs.promises.writeFile(path.join(bundle, 'database', 'Photos.sqlite'), '');
    const rec = await importer.recognize({}, { filename: bundle, fullPath: bundle } as DirEntry, {});
    expect(rec.confidence).toBeGreaterThan(0.6);
  });

  it('recognizes a plain dir containing originals/', async () => {
    const importer = getImporter('apple_photos');
    const rec = await importer.recognize({}, { filename: LIBRARY, fullPath: LIBRARY } as DirEntry, {});
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('recognizes and imports the wizard parent containing one .photoslibrary', async () => {
    const importer = getImporter('apple_photos');
    const parent = path.dirname(LIBRARY);
    const rec = await importer.recognize({}, { filename: parent, fullPath: parent } as DirEntry, {});
    expect(rec.confidence).toBeGreaterThan(0);

    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: parent, fullPath: parent } as DirEntry,
      {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );
    expect(pipeline.map((g) => g.item).filter(Boolean)).toHaveLength(2);
  });

  it('walks originals/ and emits one media item per media file', async () => {
    const importer = getImporter('apple_photos');
    const pipeline: EmittedGraph[] = [];
    await importer.fileImport(
      {},
      { filename: 'Sample Library.photoslibrary', fullPath: LIBRARY } as DirEntry,
      {
        pipeline,
        timeframe: {},
        log: () => {},
      } as unknown as ImportParams,
    );

    const items = pipeline.map((g) => g.item);
    // Two media files (.heic + .mov); the .json sidecar must be skipped.
    expect(items.length).toBe(2);

    for (const it of items) {
      // 'media' (not 'photo') so kindFor can branch on image vs video MIME.
      expect(it.classification).toBe('media');
      // Title must be the real filename, never a bare bundle/dir name.
      expect(it.metadata.Title).toBe(it.content.filename);
      expect(it.metadata.Title).not.toBe('Sample Library.photoslibrary');
      // Realm-safe: this timestamp falls back to fs.stat().mtime, a Date built
      // by the Node builtin outside Jest's sandbox, so `toBeInstanceOf(Date)`
      // compares against a different constructor and fails despite being a Date.
      expect(Object.prototype.toString.call(it.timestamp)).toBe('[object Date]');
      expect(Number.isNaN(it.timestamp!.getTime())).toBe(false);
    }

    // Every id is truthy, distinct, and stable on the originals-relative path.
    const ids = items.map((it) => it.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^apple_photos:originals\//);
    }

    const heic = items.find((it) => it.content.filename!.endsWith('.heic'));
    expect(heic).toBeTruthy();
    expect(heic!.content.mediaType).toBe('image/heic');
    const mov = items.find((it) => it.content.filename!.endsWith('.mov'));
    expect(mov).toBeTruthy();
    expect(mov!.content.mediaType).toBe('video/quicktime');
  });

  it('is idempotent — same ids across two runs', async () => {
    const importer = getImporter('apple_photos');
    const run = async () => {
      const pipeline: EmittedGraph[] = [];
      await importer.fileImport(
        {},
        { filename: 'Sample Library.photoslibrary', fullPath: LIBRARY } as DirEntry,
        {
          pipeline,
          timeframe: {},
          log: () => {},
        } as unknown as ImportParams,
      );

      return pipeline.map((g) => g.item.id!).sort();
    };

    expect(await run()).toEqual(await run());
  });

  it('produces nothing for a dir with no originals/', async () => {
    const importer = getImporter('apple_photos');
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'photoslib-empty-'));
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
    expect(pipeline.length).toBe(0);
  });
});

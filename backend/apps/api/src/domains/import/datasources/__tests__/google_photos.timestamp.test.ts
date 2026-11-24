/* eslint-disable import/order -- each jest.mock() is deliberately paired with
   the import it replaces; both are hoisted, so source order does not affect
   behavior and splitting them apart only obscures what is mocked. */
/*
 * Timestamp fallback for sidecar-less photos: EXIF DateTimeOriginal, then file
 * time. Takeout splits media and their JSON sidecars across the export's zip
 * archives, so importing a subset of the zips leaves most photos sidecar-less —
 * previously they all fell straight to file mtime, i.e. the archive-creation
 * date. Deliberately no filename-derived dates (no capture signal guaranteed,
 * and user-renamed files can carry a wrong one).
 */
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Mock exifr for deterministic EXIF reads (mirrors google_photos.exif.test.ts).
jest.mock('exifr', () => ({ __esModule: true, default: { parse: jest.fn() } }));
import exifr from 'exifr';

// Stub child_process.execFile so the video-fallback ffprobe call is
// deterministic without the binary (same pattern + promisify caveat as
// common/media/__tests__/exif.test.ts: the callback must deliver one {stdout, stderr} object).
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof import('node:child_process')>('node:child_process'),
  execFile: jest.fn(),
}));
import { execFile } from 'node:child_process';

// The mock must be created INSIDE the factory: `jest.mock` and the `import`s
// below are both hoisted, so the module under test loads (and promisifies
// execFile) before any `const` in this file initializes. Grab the handle after.
const mockExecFile = execFile as unknown as jest.Mock;

import { _resetFfprobeAvailability } from '@ci/common/media/exif';
import { allDataSources } from '../registry';
import type { ImportParams } from '../timeline';
import '../google_photos';
import type { EmittedGraph } from './support/emitted';
import type { DirEntry } from '../registry';

const parseMock = exifr.parse as unknown as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

function mockFfprobe(json: object | null) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: object, cb?: (...a: unknown[]) => void) => {
      if (typeof cb === 'function') {
        if (json === null) {
          cb(Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' }));
        } else {
          cb(null, { stdout: JSON.stringify(json), stderr: '' });
        }
      }
    },
  );
}

function getImporter() {
  const ds = allDataSources().find((d) => d.name === 'google_photos');
  if (!ds?.newFileImporter) {
    throw new Error('missing importer');
  }

  return ds.newFileImporter();
}

async function runImport(dir: string) {
  const pipeline: EmittedGraph[] = [];
  await getImporter().fileImport(
    {},
    { filename: dir, fullPath: dir } as DirEntry,
    {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams,
  );

  return pipeline.map((g) => g.item);
}

// EXIF wall-clock is revived by exifr with LOCAL Date components; the importer
// re-interprets it as UTC (exifWallClockToUtc) so the instant is host-independent.
const EXIF_LOCAL = new Date(2021, 4, 1, 12, 0, 0);
const EXIF_AS_UTC = '2021-05-01T12:00:00.000Z';

describe('google_photos timestamp fallback (processFile path)', () => {
  beforeEach(() => parseMock.mockReset());

  async function dirWithOneJpeg(sidecar?: object) {
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-ts-'));
    const img = path.join(dir, 'IMG_0001.jpg');
    await fs.promises.writeFile(img, Buffer.from([0xff, 0xd8, 0xff]));
    if (sidecar) {
      await fs.promises.writeFile(`${img}.json`, JSON.stringify(sidecar));
    }

    return dir;
  }

  it('uses EXIF DateTimeOriginal (as UTC wall-clock) when there is no sidecar', async () => {
    parseMock.mockResolvedValue({ DateTimeOriginal: EXIF_LOCAL });
    const [item] = await runImport(await dirWithOneJpeg());
    expect(item.timestamp!.toISOString()).toBe(EXIF_AS_UTC);
    expect(item.metadata['Timestamp Source']).toBe('EXIF');
  });

  it('falls back to file time when there is no sidecar and no DateTimeOriginal', async () => {
    // CreateDate/ModifyDate are write/edit times — deliberately NOT used.
    parseMock.mockResolvedValue({ CreateDate: EXIF_LOCAL, ModifyDate: EXIF_LOCAL });
    const [item] = await runImport(await dirWithOneJpeg());
    expect(item.metadata['Timestamp Source']).toBe('File System');
    // File times are "now"-ish (the test just wrote the file), never the EXIF date.
    expect(item.timestamp!.toISOString()).not.toBe(EXIF_AS_UTC);
  });

  it('applies OffsetTimeOriginal to recover the true instant (matches sidecar photoTakenTime)', async () => {
    // The verified real-world case: DateTimeOriginal 12:00 at +02:00 is
    // 10:00Z — exactly what the photo's sidecar photoTakenTime says.
    parseMock.mockResolvedValue({ DateTimeOriginal: EXIF_LOCAL, OffsetTimeOriginal: '+02:00' });
    const [item] = await runImport(await dirWithOneJpeg());
    expect(item.timestamp!.toISOString()).toBe('2021-05-01T10:00:00.000Z');
    expect(item.metadata['Timestamp Source']).toBe('EXIF');
  });

  it('applies negative offsets too', async () => {
    parseMock.mockResolvedValue({ DateTimeOriginal: EXIF_LOCAL, OffsetTimeOriginal: '-05:00' });
    const [item] = await runImport(await dirWithOneJpeg());
    expect(item.timestamp!.toISOString()).toBe('2021-05-01T17:00:00.000Z');
  });

  it('keeps the wall-clock-as-UTC convention when OffsetTimeOriginal is junk', async () => {
    parseMock.mockResolvedValue({ DateTimeOriginal: EXIF_LOCAL, OffsetTimeOriginal: 'UTC+2' });
    const [item] = await runImport(await dirWithOneJpeg());
    expect(item.timestamp!.toISOString()).toBe(EXIF_AS_UTC);
  });

  it('sidecar photoTakenTime still wins over EXIF', async () => {
    parseMock.mockResolvedValue({ DateTimeOriginal: EXIF_LOCAL });
    const [item] = await runImport(await dirWithOneJpeg({ photoTakenTime: { timestamp: '1620000000' } }));
    expect(item.timestamp!.toISOString()).toBe(new Date(1620000000 * 1000).toISOString());
    expect(item.metadata['Timestamp Source']).toBeUndefined();
  });

  it('face-tagged sidecar-less photos get the EXIF fallback too (people early-return path)', async () => {
    parseMock.mockResolvedValue({ DateTimeOriginal: EXIF_LOCAL });
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-ts-'));
    const img = path.join(dir, 'IMG_0002.jpg');
    await fs.promises.writeFile(img, Buffer.from([0xff, 0xd8, 0xff]));
    // Sidecar with people but NO timestamp fields.
    await fs.promises.writeFile(`${img}.json`, JSON.stringify({ people: [{ name: 'Alice' }] }));
    const [item] = await runImport(dir);
    expect(item.timestamp!.toISOString()).toBe(EXIF_AS_UTC);
    expect(item.metadata['Timestamp Source']).toBe('EXIF');
  });
});

describe('google_photos video timestamp fallback (container creation_time)', () => {
  beforeEach(() => {
    parseMock.mockReset();
    mockExecFile.mockReset();
    _resetFfprobeAvailability();
  });

  async function dirWithOneVideo(sidecar?: object) {
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-ts-vid-'));
    const vid = path.join(dir, '20230713_231419.MP4');
    await fs.promises.writeFile(vid, Buffer.from('not really an mp4'));
    if (sidecar) {
      await fs.promises.writeFile(`${vid}.supplemental-metadata.json`, JSON.stringify(sidecar));
    }

    return dir;
  }

  it('uses the container creation_time (a TZ-aware instant, taken verbatim) when there is no sidecar', async () => {
    mockFfprobe({
      format: { tags: { creation_time: '2023-07-14T06:14:22.000000Z' }, duration: '2.99' },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
    });
    const [item] = await runImport(await dirWithOneVideo());
    expect(item.timestamp!.toISOString()).toBe('2023-07-14T06:14:22.000Z');
    expect(item.metadata['Timestamp Source']).toBe('Container');
  });

  it('takes the container GPS along when the sidecar gave none', async () => {
    mockFfprobe({
      format: {
        tags: {
          creation_time: '2023-07-14T06:14:22.000000Z',
          'com.apple.quicktime.location.ISO6709': '+37.7749-122.4194+011.000/',
        },
      },
      streams: [],
    });
    const [item] = await runImport(await dirWithOneVideo());
    expect(item.location).toEqual({ latitude: 37.7749, longitude: -122.4194 });
  });

  it('rejects an epoch-garbage creation_time (unset camera clock) and falls to file time', async () => {
    mockFfprobe({ format: { tags: { creation_time: '1970-01-01T00:00:00.000000Z' } }, streams: [] });
    const [item] = await runImport(await dirWithOneVideo());
    expect(item.metadata['Timestamp Source']).toBe('File System');
  });

  it('sidecar photoTakenTime still wins — the container is never probed', async () => {
    mockFfprobe({ format: { tags: { creation_time: '2023-07-14T06:14:22.000000Z' } }, streams: [] });
    const [item] = await runImport(await dirWithOneVideo({ photoTakenTime: { timestamp: '1620000000' } }));
    expect(item.timestamp!.toISOString()).toBe(new Date(1620000000 * 1000).toISOString());
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('falls to file time when ffprobe is missing and the exifr fallback has nothing', async () => {
    mockFfprobe(null); // ENOENT — no ffprobe on this host
    parseMock.mockResolvedValue(undefined); // exifr QuickTime fallback finds nothing
    const [item] = await runImport(await dirWithOneVideo());
    expect(item.metadata['Timestamp Source']).toBe('File System');
  });
});

describe('google_photos timestamp fallback (Takeout album path)', () => {
  beforeEach(() => parseMock.mockReset());

  // The album path triggers on a root literally named "Google Photos".
  async function photosRoot() {
    const base = await fs.promises.mkdtemp(path.join(tmpdir(), 'gp-ts-album-'));
    const root = path.join(base, 'Google Photos');
    const album = path.join(root, 'Photos from 2021');
    await fs.promises.mkdir(album, { recursive: true });

    return { root, album };
  }

  it('parses EXIF for a sidecar-less photo and uses DateTimeOriginal', async () => {
    parseMock.mockResolvedValue({ DateTimeOriginal: EXIF_LOCAL });
    const { root, album } = await photosRoot();
    await fs.promises.writeFile(path.join(album, '20210501_120000.jpg'), Buffer.from([0xff, 0xd8]));
    const [item] = await runImport(root);
    expect(item.timestamp!.toISOString()).toBe(EXIF_AS_UTC);
    expect(item.metadata['Timestamp Source']).toBe('EXIF');
    expect(parseMock).toHaveBeenCalledTimes(1);
  });

  it('does not read EXIF at all when the sidecar supplies the timestamp (lazy parse)', async () => {
    const { root, album } = await photosRoot();
    const img = path.join(album, '20210501_120000.jpg');
    await fs.promises.writeFile(img, Buffer.from([0xff, 0xd8]));
    await fs.promises.writeFile(
      `${img}.supplemental-metadata.json`,
      JSON.stringify({ photoTakenTime: { timestamp: '1620000000' } }),
    );
    const [item] = await runImport(root);
    expect(item.timestamp!.toISOString()).toBe(new Date(1620000000 * 1000).toISOString());
    expect(parseMock).not.toHaveBeenCalled();
  });

  it('falls back to file time when EXIF has no DateTimeOriginal', async () => {
    parseMock.mockResolvedValue(undefined);
    const { root, album } = await photosRoot();
    await fs.promises.writeFile(path.join(album, '20210501_120000.jpg'), Buffer.from([0xff, 0xd8]));
    const [item] = await runImport(root);
    expect(item.metadata['Timestamp Source']).toBe('File System');
  });
});

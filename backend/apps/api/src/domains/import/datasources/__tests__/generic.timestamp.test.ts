/* eslint-disable import/order -- each jest.mock() is deliberately paired with
   the import it replaces; both are hoisted, so source order does not affect
   behavior and splitting them apart only obscures what is mocked. */
/*
 * Generic importer timestamps: an embedded date or none at all.
 *
 * The filesystem time used to be the fallback, which for archive-delivered
 * files is noise — a OneDrive "download as zip" stamps every entry with the
 * moment the server built the archive, and `unzip` restores that as mtime, so a
 * 2021 wallpaper and a 4K video both landed on the timeline "two days ago".
 * Worse, the value is host-dependent: fileTimestamp() prefers birthtime where
 * the filesystem reports one, which is the EXTRACTION time. Items with no
 * embedded date now carry a null timestamp and keep the mtime only as labelled
 * metadata.
 */
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';

jest.mock('exifr', () => ({ __esModule: true, default: { parse: jest.fn() } }));
import exifr from 'exifr';

// Stub execFile so the ffprobe call is deterministic without the binary (the
// callback must deliver one {stdout, stderr} object — see common/media/__tests__/exif.test.ts).
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
import '../generic';
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
  const ds = allDataSources().find((d) => d.name === 'generic');
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

async function dirWith(name: string, bytes = Buffer.from([0xff, 0xd8, 0xff])) {
  const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'generic-ts-'));
  await fs.promises.writeFile(path.join(dir, name), bytes);

  return dir;
}

describe('generic importer timestamps', () => {
  beforeEach(() => {
    parseMock.mockReset();
    mockExecFile.mockReset();
    _resetFfprobeAvailability();
  });

  it('leaves the timestamp null when a file carries no embedded date', async () => {
    parseMock.mockResolvedValue({}); // no EXIF
    const dir = await dirWith('wallpaper.jpg');
    // The archive-delivered mtime the old fallback would have used.
    const archiveTime = new Date('2026-07-29T00:02:00Z');
    await fs.promises.utimes(path.join(dir, 'wallpaper.jpg'), archiveTime, archiveTime);

    const [item] = await runImport(dir);

    expect(item.timestamp).toBeUndefined();
    expect(item.metadata['Timestamp Source']).toBe('None');
    // The mtime survives as a labelled hint, not as the item's date.
    expect(item.metadata['File Modified']).toBe(archiveTime.toISOString());
  });

  it('still uses EXIF when the photo has one', async () => {
    parseMock.mockResolvedValue({ DateTimeOriginal: new Date(2021, 9, 21, 13, 18, 46) });
    const [item] = await runImport(await dirWith('IMG_1.jpg'));

    expect(item.timestamp?.toISOString()).toBe('2021-10-21T13:18:46.000Z');
    expect(item.metadata['Timestamp Source']).toBe('EXIF');
    expect(item.metadata['File Modified']).toBeUndefined();
  });

  it('still uses the container creation_time when a video has one', async () => {
    mockFfprobe({
      format: { tags: { creation_time: '2024-03-05T09:30:00.000000Z' }, duration: '12.5' },
      streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
    });
    const [item] = await runImport(await dirWith('clip.mp4', Buffer.from('notreallyanmp4')));

    expect(item.timestamp?.toISOString()).toBe('2024-03-05T09:30:00.000Z');
    expect(item.metadata['Timestamp Source']).toBe('Container');
  });

  it('classifies by what the file IS — media vs plain file', async () => {
    // A directory walk over a real drive is mostly not media. The classification
    // is load-bearing downstream: mapping.kindFor reads 'media' as "photo unless
    // the MIME says video/audio", which is how every OneDrive PDF reached
    // CI-Server as a capture.photo.
    parseMock.mockResolvedValue({});
    const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'generic-cls-'));
    for (const name of ['photo.jpg', 'taxes.pdf', 'vault.kdbx', 'KeePassKey']) {
      await fs.promises.writeFile(path.join(dir, name), Buffer.from([0xff, 0xd8, 0xff]));
    }

    const byName = new Map((await runImport(dir)).map((i) => [i.content.filename, i]));

    expect(byName!.get('photo.jpg')!.classification).toBe('media');
    expect(byName!.get('taxes.pdf')!.classification).toBe('file');
    expect(byName!.get('vault.kdbx')!.classification).toBe('file');
    // No extension → no MIME at all → still a file, never media.
    expect(byName!.get('KeePassKey')!.classification).toBe('file');
    expect(byName!.get('KeePassKey')!.content.mediaType).toBeUndefined();
  });

  it('leaves the timestamp null for a video whose container timestamps are unset', async () => {
    // Both OneDrive videos are exactly this: remuxed by ffmpeg (Lavf), every
    // mvhd/tkhd/mdhd creation field zeroed, so ffprobe emits no creation_time.
    mockFfprobe({
      format: { tags: { major_brand: 'isom', encoder: 'Lavf58.76.100' }, duration: '300' },
      streams: [{ codec_type: 'video', width: 3840, height: 2160 }],
    });
    const [item] = await runImport(await dirWith('Tour of the Moon in 4K.mp4', Buffer.from('x')));

    expect(item.timestamp).toBeUndefined();
    expect(item.metadata['Timestamp Source']).toBe('None');
  });
});

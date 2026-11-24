/* eslint-disable import/order -- each jest.mock() is deliberately paired with
   the import it replaces; both are hoisted, so source order does not affect
   behavior and splitting them apart only obscures what is mocked. */
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Mock the ffprobe shell-out and exifr so the metadata read is deterministic
// without requiring the ffmpeg binary on the test host. Both must be mocked
// because the video path falls back from ffprobe to exifr when ffprobe is
// missing — we want to control which path runs.
jest.mock('node:child_process', () => ({
  ...jest.requireActual<typeof import('node:child_process')>('node:child_process'),
  execFile: jest.fn(),
}));
import { execFile } from 'node:child_process';

// The mock must be created INSIDE the factory: `jest.mock` and the `import`s
// below are both hoisted, so the module under test loads (and promisifies
// execFile) before any `const` in this file initializes. Grab the handle after.
const mockExecFile = execFile as unknown as jest.Mock;
jest.mock('exifr', () => ({ __esModule: true, default: { parse: jest.fn() } }));
import exifr from 'exifr';

import { _resetFfprobeAvailability } from '@ci/common/media/exif';
import { allDataSources } from '../registry';
import type { ImportParams } from '../timeline';
import '../apple_photos';
import type { EmittedGraph } from './support/emitted';
import type { DirEntry } from '../registry';

const parseMock = exifr.parse as unknown as jest.MockedFunction<(...args: unknown[]) => Promise<unknown>>;

function mockFfprobe(stdout: string) {
  // promisify(execFile) on jest.fn() falls back to the default behavior
  // (single-value resolve), so the mock has to deliver one {stdout, stderr}
  // object — not the 3-arg callback shape native execFile uses.
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
    if (typeof cb === 'function') {
      cb(null, { stdout, stderr: '' });
    }
  });
}

function getImporter() {
  const ds = allDataSources().find((d) => d.name === 'apple_photos');
  if (!ds?.newFileImporter) {
    throw new Error('missing importer');
  }

  return ds.newFileImporter();
}

/** A minimal *.photoslibrary with the given filenames under originals/0A. */
async function libraryWith(filenames: string[]): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(tmpdir(), 'ap-video-'));
  const bucket = path.join(dir, 'originals', '0A');
  await fs.promises.mkdir(bucket, { recursive: true });
  for (const name of filenames) {
    await fs.promises.writeFile(path.join(bucket, name), 'not-real-media');
  }

  return dir;
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

beforeEach(() => {
  mockExecFile.mockReset();
  parseMock.mockReset();
  _resetFfprobeAvailability();
});

describe('apple_photos video metadata (ffprobe path)', () => {
  it('captures duration, dimensions, codec, framerate, bitrate, GPS, capture time', async () => {
    mockFfprobe(
      JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'hevc',
            width: 1920,
            height: 1080,
            avg_frame_rate: '30/1',
            bit_rate: '15000000',
          },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
        format: {
          duration: '42.5',
          tags: {
            creation_time: '2024-02-14T20:00:00.000000Z',
            'com.apple.quicktime.location.ISO6709': '+40.7128-074.0060+010.000/',
            'com.apple.quicktime.make': 'Apple',
            'com.apple.quicktime.model': 'iPhone 15 Pro',
          },
        },
      }),
    );
    const [item] = await runImport(await libraryWith(['IMG_9999.mov']));
    expect(item.content.mediaType).toBe('video/quicktime');
    expect(item.metadata.Duration).toBe(42.5);
    expect(item.metadata.Codec).toBe('hevc');
    expect(item.metadata.Width).toBe(1920);
    expect(item.metadata.Height).toBe(1080);
    expect(item.metadata['Frame Rate']).toBe(30);
    expect(item.metadata.Bitrate).toBe(15000000);
    expect(item.metadata.AudioCodec).toBe('aac');
    expect(item.metadata.Make).toBe('Apple');
    expect(item.location).toEqual({ latitude: 40.7128, longitude: -74.006 });
    expect(item.timestamp!.toISOString()).toBe('2024-02-14T20:00:00.000Z');
    expect(item.metadata['Timestamp Source']).toBe('Container');
    // Not a Live Photo pair (no companion .heic), so the flag is absent.
    expect(item.metadata.LivePhoto).toBeUndefined();
    // exifr must NOT run for a video when ffprobe succeeds.
    expect(parseMock).not.toHaveBeenCalled();
  });
});

describe('apple_photos Live Photo pairing', () => {
  it('flags both halves of a basename-matched .heic + .mov pair', async () => {
    mockFfprobe(
      JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1440 }],
        format: { duration: '3', tags: {} },
      }),
    );
    // The .heic carries no real EXIF in this fixture, so the image side falls
    // back to mtime — the Live Photo flag must still be set on both items.
    parseMock.mockResolvedValue(undefined);

    const items = await runImport(await libraryWith(['IMG_1234.heic', 'IMG_1234.mov']));
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.metadata.LivePhoto).toBe(true);
    }
  });

  it('does not flag a .mov that has no matching still', async () => {
    mockFfprobe(
      JSON.stringify({
        streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }],
        format: { duration: '12', tags: {} },
      }),
    );
    parseMock.mockResolvedValue(undefined);

    const items = await runImport(await libraryWith(['IMG_1234.heic', 'IMG_5678.mov']));
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.metadata.LivePhoto).toBeUndefined();
    }
  });
});

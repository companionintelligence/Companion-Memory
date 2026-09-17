import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ffmpegDefault from 'fluent-ffmpeg';

import { vipsCliAvailable } from '../../../__tests__/support/vipsCli';
import { MediaDimensionsService } from '../MediaDimensionsService';
import { VipsService } from '../VipsService';

// Mock fluent-ffmpeg so the video path is driven by scripted ffprobe output
// (no ffmpeg binary / real video fixture needed). The image path runs the real
// `vips` tools on the fixtures below and is skipped on a machine without them.
jest.mock('fluent-ffmpeg', () => ({
  __esModule: true,
  default: { ffprobe: jest.fn() },
}));
const ffmpeg = ffmpegDefault as unknown as { ffprobe: jest.Mock };

const describeIfVips = vipsCliAvailable() ? describe : describe.skip;
const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name));

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeService() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new MediaDimensionsService(new VipsService(makeLogger() as any), makeLogger() as any);
}

/** Make ffprobe resolve with a single video stream carrying the given fields. */
function scriptFfprobe(stream: Record<string, unknown>) {
  ffmpeg.ffprobe.mockImplementation((_path: string, cb: (err: unknown, data: unknown) => void) => {
    cb(null, { streams: [{ codec_type: 'video', ...stream }] });
  });
}

describeIfVips('MediaDimensionsService.fromImageBuffer', () => {
  it('reads width/height from an image header', async () => {
    await expect(makeService().fromImageBuffer(fixture('64x40.jpg'))).resolves.toEqual({
      width: 64,
      height: 40,
    });
  });

  it('swaps dimensions for a 90°/270° EXIF orientation (5–8) to match the displayed image', async () => {
    // Orientation 6 = rotate 90° CW: stored 64×40 displays as 40×64.
    await expect(makeService().fromImageBuffer(fixture('64x40-orientation-6.jpg'))).resolves.toEqual({
      width: 40,
      height: 64,
    });
  });

  it('does not swap for an upright orientation (1)', async () => {
    await expect(makeService().fromImageBuffer(fixture('64x40-orientation-1.jpg'))).resolves.toEqual({
      width: 64,
      height: 40,
    });
  });

  it('reads HEIC, the format the previous decoder could not', async () => {
    await expect(makeService().fromImageBuffer(fixture('64x40.heic'))).resolves.toEqual({
      width: 64,
      height: 40,
    });
  });

  it('returns null (does not throw) for an unreadable buffer', async () => {
    await expect(makeService().fromImageBuffer(Buffer.from('not an image'))).resolves.toBeNull();
  });
});

describe('MediaDimensionsService.fromVideoFile', () => {
  beforeEach(() => ffmpeg.ffprobe.mockReset());

  it('reads the video stream width/height', async () => {
    scriptFfprobe({ width: 1920, height: 1080 });

    await expect(makeService().fromVideoFile('/tmp/whatever')).resolves.toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('swaps dimensions when the container tags a 90° rotation (rotate tag)', async () => {
    scriptFfprobe({ width: 1920, height: 1080, tags: { rotate: '90' } });

    await expect(makeService().fromVideoFile('/tmp/whatever')).resolves.toEqual({
      width: 1080,
      height: 1920,
    });
  });

  it('swaps dimensions for a -90 display rotation field (newer ffmpeg)', async () => {
    scriptFfprobe({ width: 1920, height: 1080, rotation: -90 });

    await expect(makeService().fromVideoFile('/tmp/whatever')).resolves.toEqual({
      width: 1080,
      height: 1920,
    });
  });

  it('does not swap for a 180° rotation', async () => {
    scriptFfprobe({ width: 1920, height: 1080, rotation: 180 });

    await expect(makeService().fromVideoFile('/tmp/whatever')).resolves.toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('returns null when there is no video stream', async () => {
    ffmpeg.ffprobe.mockImplementation((_path: string, cb: (err: unknown, data: unknown) => void) => {
      cb(null, { streams: [{ codec_type: 'audio' }] });
    });

    await expect(makeService().fromVideoFile('/tmp/whatever')).resolves.toBeNull();
  });

  it('returns null (does not throw) when ffprobe errors', async () => {
    ffmpeg.ffprobe.mockImplementation((_path: string, cb: (err: unknown, data: unknown) => void) => {
      cb(new Error('ffprobe failed'), null);
    });

    await expect(makeService().fromVideoFile('/tmp/whatever')).resolves.toBeNull();
  });
});

import ffmpegDefault from 'fluent-ffmpeg';
import sharp from 'sharp';

import { MediaDimensionsService } from '../MediaDimensionsService';

// Mock fluent-ffmpeg so the video path is driven by scripted ffprobe output
// (no ffmpeg binary / real video fixture needed). sharp stays real for images.
jest.mock('fluent-ffmpeg', () => ({
  __esModule: true,
  default: { ffprobe: jest.fn() },
}));
const ffmpeg = ffmpegDefault as unknown as { ffprobe: jest.Mock };

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeService() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new MediaDimensionsService(makeLogger() as any);
}

/** A solid-colour PNG of the given pixel dimensions, optionally tagged with an EXIF orientation. */
async function makeImage(width: number, height: number, orientation?: number): Promise<Buffer> {
  let image = sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  });

  if (orientation != null) {
    image = image.withMetadata({ orientation });
  }

  return image.jpeg().toBuffer();
}

/** Make ffprobe resolve with a single video stream carrying the given fields. */
function scriptFfprobe(stream: Record<string, unknown>) {
  ffmpeg.ffprobe.mockImplementation((_path: string, cb: (err: unknown, data: unknown) => void) => {
    cb(null, { streams: [{ codec_type: 'video', ...stream }] });
  });
}

describe('MediaDimensionsService.fromImageBuffer', () => {
  it('reads width/height from an image header', async () => {
    const service = makeService();

    await expect(service.fromImageBuffer(await makeImage(64, 40))).resolves.toEqual({
      width: 64,
      height: 40,
    });
  });

  it('swaps dimensions for a 90°/270° EXIF orientation (5–8) to match the displayed image', async () => {
    const service = makeService();

    // Orientation 6 = rotate 90° CW: stored 64×40 displays as 40×64.
    await expect(service.fromImageBuffer(await makeImage(64, 40, 6))).resolves.toEqual({
      width: 40,
      height: 64,
    });
  });

  it('does not swap for an upright orientation (1)', async () => {
    const service = makeService();

    await expect(service.fromImageBuffer(await makeImage(64, 40, 1))).resolves.toEqual({
      width: 64,
      height: 40,
    });
  });

  it('returns null (does not throw) for an unreadable buffer', async () => {
    const service = makeService();

    await expect(service.fromImageBuffer(Buffer.from('not an image'))).resolves.toBeNull();
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

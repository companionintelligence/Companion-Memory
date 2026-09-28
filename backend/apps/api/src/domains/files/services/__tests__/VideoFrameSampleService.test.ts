import { existsSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';

import ffmpegDefault from 'fluent-ffmpeg';

import {
  MIN_FRAME_SPACING_SECONDS,
  VideoFrameSampleService,
  frameTimestamps,
  parseIso6709,
  parseRecordedAt,
} from '../VideoFrameSampleService';
import { VipsDecodeError } from '../VipsService';

jest.mock('fluent-ffmpeg', () => {
  const ffmpeg = jest.fn();
  (ffmpeg as unknown as { ffprobe: jest.Mock }).ffprobe = jest.fn();

  return { __esModule: true, default: ffmpeg };
});

const ffmpeg = ffmpegDefault as unknown as jest.Mock & { ffprobe: jest.Mock };

const context = { userId: 'user-1' } as never;
const VIDEO = { id: 'video-1', key: 'video-key', contentType: 'video/mp4' };
const OPTIONS = { maxFrames: 3, maxDimension: 1280, quality: 85 };

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** ffprobe answers with this container: `duration` and `tags` on `format`. */
function scriptFfprobe(format: Record<string, unknown> | Error) {
  ffmpeg.ffprobe.mockImplementation((_path: string, cb: (err: unknown, data?: unknown) => void) => {
    if (format instanceof Error) {
      cb(format);
    } else {
      cb(null, { format, streams: [{ codec_type: 'video', width: 1920, height: 1080 }] });
    }
  });
}

/**
 * The ffmpeg command chain, scripted: `run()` writes a frame named after its
 * seek offset to the output path and fires `end`, or fires `error` for a
 * seek offset in `failAt`. Records every seek so the test can read them back.
 */
function scriptFfmpeg(opts: { failAt?: number[] } = {}) {
  const seeks: number[] = [];
  const outputs: string[] = [];

  ffmpeg.mockImplementation((_input: string) => {
    let seek = -1;
    let output = '';
    const handlers: Record<string, (err?: Error) => void> = {};
    const chain = {
      seekInput: (at: number) => {
        seek = at;
        seeks.push(at);

        return chain;
      },
      frames: () => chain,
      output: (path: string) => {
        output = path;
        outputs.push(path);

        return chain;
      },
      on: (event: string, handler: (err?: Error) => void) => {
        handlers[event] = handler;

        return chain;
      },
      run: () => {
        if (opts.failAt?.includes(seek)) {
          setImmediate(() => handlers.error?.(new Error(`no keyframe at ${seek}`)));

          return;
        }

        writeFileSync(output, `frame@${seek}`);
        setImmediate(() => handlers.end?.());
      },
    };

    return chain;
  });

  return { seeks, outputs };
}

function makeService(renderJpeg?: jest.Mock) {
  const fileService = {
    getFileStream: jest.fn(async () => Readable.from([Buffer.from('spooled-video-bytes')])),
  };
  const vips = {
    renderJpeg:
      renderJpeg ??
      jest.fn(async (raw: Buffer) => ({
        buffer: Buffer.from(`rendered:${raw.toString()}`),
        width: 1,
        height: 1,
      })),
  };
  const logger = makeLogger();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new VideoFrameSampleService(fileService as any, vips as any, logger as any);

  return { service, fileService, vips, logger };
}

beforeEach(() => {
  ffmpeg.mockReset();
  ffmpeg.ffprobe.mockReset();
});

describe('frameTimestamps', () => {
  it('takes the midpoints of equal segments, never the first or last frame', () => {
    expect(frameTimestamps(60, 6)).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it('takes fewer frames from a clip too short to space them out', () => {
    // 5 s fits two frames at MIN_FRAME_SPACING_SECONDS apart, not six.
    expect(MIN_FRAME_SPACING_SECONDS).toBe(2);
    expect(frameTimestamps(5, 6)).toEqual([1.25, 3.75]);
    expect(frameTimestamps(1, 6)).toEqual([0.5]);
  });

  it('takes one frame from the start when the length is unknown or nonsense', () => {
    expect(frameTimestamps(null, 6)).toEqual([0]);
    expect(frameTimestamps(0, 6)).toEqual([0]);
    expect(frameTimestamps(Number.NaN, 6)).toEqual([0]);
  });
});

describe('parseIso6709', () => {
  it('reads the Apple and Android location tag shapes', () => {
    expect(parseIso6709('+33.6893-117.8236+009.870/')).toEqual({ latitude: 33.6893, longitude: -117.8236 });
    expect(parseIso6709('+33.6893-117.8236/')).toEqual({ latitude: 33.6893, longitude: -117.8236 });
  });

  it('rejects anything that is not a coordinate pair', () => {
    expect(parseIso6709('Palermo')).toBeNull();
    expect(parseIso6709(undefined)).toBeNull();
    expect(parseIso6709('+95.0+10.0/')).toBeNull();
  });
});

describe('parseRecordedAt', () => {
  it("prefers Apple's wall-clock tag, which carries the owner's day", () => {
    const when = parseRecordedAt({
      'com.apple.quicktime.creationdate': '2023-10-26T23:03:47-0700',
      creation_time: '2023-10-27T06:03:47.000000Z',
    });

    expect(when).toEqual({
      recordedAt: new Date('2023-10-27T06:03:47.000Z'),
      zoneKnown: true,
      recordedOn: '2023-10-26',
    });
  });

  it('falls back to the UTC creation_time and its UTC day', () => {
    expect(parseRecordedAt({ creation_time: '2023-10-27T06:03:47.000000Z' })).toEqual({
      recordedAt: new Date('2023-10-27T06:03:47.000Z'),
      zoneKnown: false,
      recordedOn: '2023-10-27',
    });
  });

  it('ignores the Unix epoch a clockless camera writes, and absent tags', () => {
    const none = { recordedAt: null, zoneKnown: false, recordedOn: null };

    expect(parseRecordedAt({ creation_time: '1970-01-01T00:00:00.000000Z' })).toEqual(none);
    expect(parseRecordedAt({})).toEqual(none);
    expect(parseRecordedAt(undefined)).toEqual(none);
  });
});

describe('VideoFrameSampleService.sample', () => {
  it('spools once, seeks to each timestamp, renders each frame at the size cap, and cleans up', async () => {
    scriptFfprobe({
      duration: '30.0',
      tags: { creation_time: '2023-10-27T06:03:47.000000Z', location: '+33.6893-117.8236/' },
    });
    const { seeks, outputs } = scriptFfmpeg();
    const { service, fileService, vips } = makeService();

    const sample = await service.sample(context, VIDEO, OPTIONS);

    expect(fileService.getFileStream).toHaveBeenCalledTimes(1);
    expect(fileService.getFileStream).toHaveBeenCalledWith(context, 'video-key');
    expect(seeks).toEqual([5, 15, 25]);
    expect(sample.durationSeconds).toBe(30);
    expect(sample.frames).toEqual([
      { atSeconds: 5, jpeg: Buffer.from('rendered:frame@5') },
      { atSeconds: 15, jpeg: Buffer.from('rendered:frame@15') },
      { atSeconds: 25, jpeg: Buffer.from('rendered:frame@25') },
    ]);
    expect(vips.renderJpeg).toHaveBeenCalledWith(expect.any(Buffer), { maxDimension: 1280, quality: 85 });
    expect(sample.capture).toEqual({
      recordedAt: new Date('2023-10-27T06:03:47.000Z'),
      zoneKnown: false,
      recordedOn: '2023-10-27',
      latitude: 33.6893,
      longitude: -117.8236,
    });
    // Nothing left in the temp dir: the spool and every frame file are gone.
    for (const path of outputs) {
      expect(existsSync(path)).toBe(false);
    }
  });

  it('takes one frame from the start when ffprobe cannot read the container', async () => {
    scriptFfprobe(new Error('Invalid data found when processing input'));
    const { seeks } = scriptFfmpeg();
    const { service, logger } = makeService();

    const sample = await service.sample(context, VIDEO, OPTIONS);

    expect(seeks).toEqual([0]);
    expect(sample.durationSeconds).toBeNull();
    expect(sample.frames).toHaveLength(1);
    expect(sample.capture).toEqual({
      recordedAt: null,
      zoneKnown: false,
      recordedOn: null,
      latitude: null,
      longitude: null,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Video probe failed; sampling one frame from the start',
      expect.objectContaining({ fileId: 'video-1' }),
    );
  });

  it('skips a frame ffmpeg cannot extract and keeps the rest', async () => {
    scriptFfprobe({ duration: '30' });
    scriptFfmpeg({ failAt: [15] });
    const { service, logger } = makeService();

    const sample = await service.sample(context, VIDEO, OPTIONS);

    expect(sample.frames.map((frame) => frame.atSeconds)).toEqual([5, 25]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Video frame extraction failed; skipping it',
      expect.objectContaining({ atSeconds: 15 }),
    );
  });

  it('skips a frame the JPEG decoder rejects, but lets any other decoder fault propagate', async () => {
    scriptFfprobe({ duration: '30' });
    scriptFfmpeg();
    const undecodable = jest.fn(async (raw: Buffer) => {
      if (raw.toString() === 'frame@15') {
        throw new VipsDecodeError('is not a known file format');
      }

      return { buffer: raw, width: 1, height: 1 };
    });
    const { service } = makeService(undecodable);

    const sample = await service.sample(context, VIDEO, OPTIONS);

    expect(sample.frames.map((frame) => frame.atSeconds)).toEqual([5, 25]);

    scriptFfmpeg();
    const broken = jest.fn(async () => {
      throw new Error('vips not found on PATH');
    });
    const { service: withoutVips } = makeService(broken);

    await expect(withoutVips.sample(context, VIDEO, OPTIONS)).rejects.toThrow('vips not found on PATH');
  });
});

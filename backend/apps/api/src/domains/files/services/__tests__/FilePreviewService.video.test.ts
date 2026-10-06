import { writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';

import ffmpegDefault from 'fluent-ffmpeg';

import { VideoPlaybackRequestEvent } from '../../events';
import { FilePreviewService, videoPosterTimestamp } from '../FilePreviewService';

jest.mock('fluent-ffmpeg', () => {
  const ffmpeg = jest.fn();
  (ffmpeg as unknown as { ffprobe: jest.Mock }).ffprobe = jest.fn();

  return { __esModule: true, default: ffmpeg };
});

const ffmpeg = ffmpegDefault as unknown as jest.Mock & { ffprobe: jest.Mock };

const context = { userId: 'user-1' } as never;

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function scriptFfprobe(duration: number | Error) {
  ffmpeg.ffprobe.mockImplementation((_path: string, cb: (err: unknown, data?: unknown) => void) => {
    if (duration instanceof Error) {
      cb(duration);
    } else {
      cb(null, { format: { duration } });
    }
  });
}

function scriptFfmpeg(opts: { fail?: boolean } = {}) {
  const seeks: number[] = [];

  ffmpeg.mockImplementation(() => {
    let output = '';
    const handlers: Record<string, (err?: Error) => void> = {};
    const chain = {
      seekInput: (at: number) => {
        seeks.push(at);

        return chain;
      },
      frames: () => chain,
      output: (path: string) => {
        output = path;

        return chain;
      },
      on: (event: string, handler: (err?: Error) => void) => {
        handlers[event] = handler;

        return chain;
      },
      run: () => {
        if (opts.fail) {
          setImmediate(() => handlers.error?.(new Error('no frame')));

          return;
        }

        writeFileSync(output, 'frame');
        setImmediate(() => handlers.end?.());
      },
    };

    return chain;
  });

  return { seeks };
}

function makeService() {
  const fileService = {
    findVariantByParentId: jest.fn(async () => null),
    findById: jest.fn(async () => ({
      id: 'clip-1',
      bucket: 'files',
      key: 'user/clip-1.mov',
      contentType: 'video/quicktime',
      size: 12,
    })),
    getFileStream: jest.fn(async () => Readable.from([Buffer.from('mov-bytes')])),
    setDimensions: jest.fn(async () => {}),
    create: jest.fn(async () => ({ id: 'preview-1' })),
  };
  const mediaDimensionsService = {
    fromVideoFile: jest.fn(async () => ({ width: 1920, height: 1080 })),
  };
  const vips = {
    renderJpeg: jest.fn(async () => ({ buffer: Buffer.from('jpeg'), width: 300, height: 169 })),
  };
  const eventService = { send: jest.fn(async () => {}) };
  const service = new FilePreviewService(
    fileService as never,
    mediaDimensionsService as never,
    vips as never,
    eventService as never,
    makeLogger() as never,
  );

  return { service, fileService, eventService };
}

beforeEach(() => {
  ffmpeg.mockReset();
  ffmpeg.ffprobe.mockReset();
});

describe('videoPosterTimestamp', () => {
  it('takes the middle of a phone clip, not the black lead-in', () => {
    expect(videoPosterTimestamp(10)).toBe(5);
    expect(videoPosterTimestamp(null)).toBe(0);
  });
});

describe('FilePreviewService video posters', () => {
  it('stills a .mov from inside the clip and asks for a playable rendition', async () => {
    scriptFfprobe(10);
    const { seeks } = scriptFfmpeg();
    const { service, fileService, eventService } = makeService();

    const outcome = await service.generate(context, { fileId: 'clip-1' });

    expect(outcome).toEqual({ outcome: 'generated', previewId: 'preview-1' });
    expect(seeks).toEqual([5]);
    expect(fileService.create).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ contentType: 'image/jpeg', parentId: 'clip-1' }),
    );
    expect(eventService.send).toHaveBeenCalledWith(
      VideoPlaybackRequestEvent,
      { userId: 'user-1', fileId: 'clip-1' },
      expect.objectContaining({ singletonKey: 'video-playback:clip-1' }),
    );
  });

  it('still asks for a playable rendition when the poster cannot be extracted', async () => {
    scriptFfprobe(10);
    scriptFfmpeg({ fail: true });
    const { service, fileService, eventService } = makeService();

    const outcome = await service.generate(context, { fileId: 'clip-1' });

    expect(outcome).toEqual({ outcome: 'skipped', reason: 'undecodable' });
    expect(fileService.create).not.toHaveBeenCalled();
    expect(eventService.send).toHaveBeenCalledWith(
      VideoPlaybackRequestEvent,
      { userId: 'user-1', fileId: 'clip-1' },
      expect.objectContaining({ singletonKey: 'video-playback:clip-1' }),
    );
  });
});

import type { EventEmitter } from 'node:events';

import {
  PlaybackEnvironmentError,
  transcodeTimeoutMs,
  VideoPlaybackService,
  type VideoStreamProbe,
} from '../VideoPlaybackService';

/**
 * The ffmpeg and ffprobe runs, against a fluent-ffmpeg stand-in that records
 * each command's output options and lets a test decide how the run ends. What
 * is pinned: which audio stream a rendition maps (never every one — an iPhone
 * Spatial Audio clip's APAC track failed the whole encode), the silent retry
 * when the mapped track still cannot be decoded, and which failures are the
 * input's (`false`, a permanent skip) versus the machine's (a thrown
 * PlaybackEnvironmentError: a missing filter, a missing binary, the timeout).
 */

interface MockCommand extends EventEmitter {
  options: string[];
  killedWith: string | null;
}

const mockFfmpeg: {
  commands: MockCommand[];
  onRun: (command: MockCommand) => void;
  ffprobe: (path: string, callback: (err: Error | null, data?: unknown) => void) => void;
} = {
  commands: [],
  onRun: () => undefined,
  ffprobe: () => undefined,
};

jest.mock('fluent-ffmpeg', () => {
  const { EventEmitter: Emitter } = jest.requireActual<typeof import('node:events')>('node:events');

  class Command extends Emitter {
    options: string[] = [];

    killedWith: string | null = null;

    outputOptions(options: string[]) {
      this.options = options;

      return this;
    }

    output() {
      return this;
    }

    kill(signal: string) {
      this.killedWith = signal;
    }

    run() {
      mockFfmpeg.onRun(this);
    }
  }

  const ffmpeg = Object.assign(
    () => {
      const command = new Command();
      mockFfmpeg.commands.push(command);

      return command;
    },
    {
      ffprobe: (path: string, callback: (err: Error | null, data?: unknown) => void) =>
        mockFfmpeg.ffprobe(path, callback),
    },
  );

  return { __esModule: true, default: ffmpeg };
});

type Transcode = (input: string, output: string, probe: VideoStreamProbe, fileId: string) => Promise<boolean>;

function makeService() {
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
  const service = new VideoPlaybackService({} as never, logger as never);
  const transcode = (service as unknown as { transcode: Transcode }).transcode.bind(service);

  return {
    service,
    transcode: (probe: VideoStreamProbe) => transcode('/tmp/in', '/tmp/out.mp4', probe, 'file-1'),
  };
}

const PROBE: VideoStreamProbe = {
  codec: 'hevc',
  pixFmt: 'yuv420p10le',
  transfer: 'arib-std-b67',
  width: 3840,
  height: 2160,
  durationSeconds: 12,
  audioStreamIndex: 1,
};

/** Ends each run in turn: `true` succeeds, a string fails with that as ffmpeg's stderr. */
function runsEnd(...ends: (true | string)[]) {
  mockFfmpeg.onRun = (command) => {
    const end = ends.shift();

    setImmediate(() =>
      end === true
        ? command.emit('end')
        : command.emit('error', new Error('ffmpeg exited with code 234'), '', end ?? ''),
    );
  };
}

const mapsOf = (command: MockCommand) => command.options.filter((option) => option.startsWith('-map'));

beforeEach(() => {
  mockFfmpeg.commands = [];
  mockFfmpeg.onRun = () => undefined;
  mockFfmpeg.ffprobe = () => undefined;
});

describe('VideoPlaybackService transcode', () => {
  it('maps the probed audio stream alone, never every audio stream', async () => {
    const { transcode } = makeService();
    runsEnd(true);

    await expect(transcode(PROBE)).resolves.toBe(true);
    expect(mockFfmpeg.commands).toHaveLength(1);
    expect(mapsOf(mockFfmpeg.commands[0])).toEqual(['-map 0:v:0', '-map 0:1']);
  });

  it('retries silent when the mapped audio track still fails to decode, and keeps the video', async () => {
    const { transcode } = makeService();
    runsEnd('Decoder (codec none) not found for input stream #0:1', true);

    await expect(transcode(PROBE)).resolves.toBe(true);
    expect(mockFfmpeg.commands).toHaveLength(2);
    expect(mapsOf(mockFfmpeg.commands[1])).toEqual(['-map 0:v:0']);
    expect(mockFfmpeg.commands[1].options).toContain('-an');
  });

  it('reports an input that fails silent too as undecodable (false), and does not retry a silent clip', async () => {
    const { transcode } = makeService();
    runsEnd('Invalid data found when processing input', 'Invalid data found when processing input');

    await expect(transcode(PROBE)).resolves.toBe(false);
    expect(mockFfmpeg.commands).toHaveLength(2);

    mockFfmpeg.commands = [];
    runsEnd('Invalid data found when processing input');

    await expect(transcode({ ...PROBE, audioStreamIndex: null })).resolves.toBe(false);
    expect(mockFfmpeg.commands).toHaveLength(1);
  });

  // Homebrew's ffmpeg has no zscale: under `make dev` every HDR clip failed,
  // and as a skip none of them would ever have been offered again.
  it('throws a missing filter as a fault of the machine, without the silent retry', async () => {
    const { transcode } = makeService();
    runsEnd("[AVFilterGraph @ 0x7f] No such filter: 'zscale'\nError reinitializing filters!");

    const failure = transcode(PROBE);

    await expect(failure).rejects.toBeInstanceOf(PlaybackEnvironmentError);
    await expect(failure).rejects.toMatchObject({ reason: 'environment' });
    expect(mockFfmpeg.commands).toHaveLength(1);
  });

  describe('timeout', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('kills a run past the clip-scaled limit and throws it as a timeout, not a skip', async () => {
      const { transcode } = makeService();
      const failure = transcode(PROBE);
      const settled = expect(failure).rejects.toMatchObject({ reason: 'timeout' });

      jest.advanceTimersByTime(transcodeTimeoutMs(PROBE.durationSeconds) - 1);
      expect(mockFfmpeg.commands[0].killedWith).toBeNull();

      jest.advanceTimersByTime(1);

      await settled;
      await expect(failure).rejects.toBeInstanceOf(PlaybackEnvironmentError);
      expect(mockFfmpeg.commands[0].killedWith).toBe('SIGKILL');
      // A timed-out encode is not retried silent: it would only time out again.
      expect(mockFfmpeg.commands).toHaveLength(1);
    });
  });
});

describe('VideoPlaybackService.probe', () => {
  it('names the video codec and the one decodable audio track of a Spatial Audio clip', async () => {
    const { service } = makeService();
    mockFfmpeg.ffprobe = (_path, callback) =>
      callback(null, {
        format: { duration: '12.5' },
        streams: [
          {
            index: 0,
            codec_type: 'video',
            codec_name: 'hevc',
            width: 3840,
            height: 2160,
            color_transfer: 'arib-std-b67',
          },
          { index: 1, codec_type: 'audio', codec_name: 'apple_apac', disposition: { default: 1 } },
          { index: 2, codec_type: 'audio', codec_name: 'aac', disposition: { default: 0 } },
        ],
      });

    await expect(service.probe('/tmp/in')).resolves.toMatchObject({
      codec: 'hevc',
      transfer: 'arib-std-b67',
      durationSeconds: 12.5,
      audioStreamIndex: 2,
    });
  });

  it('throws when ffprobe itself is missing: that is not the file’s fault', async () => {
    const { service } = makeService();
    mockFfmpeg.ffprobe = (_path, callback) => callback(new Error('Cannot find ffprobe'));

    await expect(service.probe('/tmp/in')).rejects.toBeInstanceOf(PlaybackEnvironmentError);
  });

  it('is null for bytes ffprobe cannot read', async () => {
    const { service } = makeService();
    mockFfmpeg.ffprobe = (_path, callback) =>
      callback(new Error('ffprobe exited with code 1\n/tmp/in: Invalid data found when processing input'));

    await expect(service.probe('/tmp/in')).resolves.toBeNull();
  });
});

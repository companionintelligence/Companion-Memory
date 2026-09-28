import fs from 'node:fs/promises';
import { Readable } from 'node:stream';

import { FileVariant } from '../../types';
import {
  BROWSER_SAFE_VIDEO_CODECS,
  ORIGINAL_RESOLUTION,
  PLAYBACK_MAX_EDGE,
  PlaybackEnvironmentError,
  isEnvironmentFault,
  needsPlaybackRendition,
  pickAudioStream,
  playbackFilterChain,
  playbackOutputOptions,
  transcodeTimeoutMs,
  VideoPlaybackService,
  type VideoStreamProbe,
} from '../VideoPlaybackService';

/**
 * The service decides WHICH videos get an H.264 rendition and WHAT ffmpeg
 * is asked for; the encode itself is ffmpeg's. So the tests pin the codec
 * rule and the filter chains as text, and the generate() contract around a
 * stubbed probe/transcode: existing rendition short-circuits, non-stored and
 * non-video skip before any bytes move, browser-safe codecs skip as
 * `not_needed`, a transcode that ffmpeg rejects is `transcode_failed`
 * (completed, not retried), a fault of the machine throws, a rendition the
 * other caller wrote first is `exists` at every point it can be found, and a
 * successful run writes a PLAYBACK child of the original. The ffmpeg runs
 * themselves — which stream is mapped, the silent retry, the timeout — are in
 * VideoPlaybackService.ffmpeg.test.ts.
 */
function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

const HEVC_FILE = {
  id: 'file-1',
  bucket: 'companion',
  key: 'k1',
  contentType: 'video/quicktime',
};

function build(file: Record<string, unknown> | null = HEVC_FILE) {
  const fileService = {
    findVariantByParentId: jest.fn().mockResolvedValue(null),
    findById: jest.fn().mockResolvedValue(file),
    getFileStream: jest.fn().mockResolvedValue(Readable.from([Buffer.from('not really a video')])),
    create: jest.fn().mockResolvedValue({ id: 'play-1' }),
  };
  const service = new VideoPlaybackService(fileService as never, makeLogger() as never);

  return { service, fileService };
}

const ctx = { userId: 'user-1' } as never;

const HEVC_PROBE: VideoStreamProbe = {
  codec: 'hevc',
  pixFmt: 'yuv420p',
  transfer: 'bt709',
  width: 3840,
  height: 2160,
  durationSeconds: 4,
  audioStreamIndex: 1,
};

/** A transcode stub that writes an output, as ffmpeg would, and succeeds. */
function stubTranscode(service: VideoPlaybackService) {
  return jest
    .spyOn(
      service as unknown as { transcode: (input: string, output: string) => Promise<boolean> },
      'transcode',
    )
    .mockImplementation(async (_input, output) => {
      await fs.writeFile(output, Buffer.alloc(1234));

      return true;
    });
}

describe('codec rule', () => {
  it('leaves what every browser already decodes alone and renders everything else', () => {
    for (const codec of ['h264', 'vp8', 'vp9', 'av1', 'H264']) {
      expect(needsPlaybackRendition({ codec })).toBe(false);
    }

    for (const codec of ['hevc', 'mpeg4', 'h263', 'prores', 'mjpeg']) {
      expect(needsPlaybackRendition({ codec })).toBe(true);
    }

    expect(BROWSER_SAFE_VIDEO_CODECS.has('hevc')).toBe(false);
  });
});

describe('filter chain', () => {
  it('fits an SDR source inside the max edge with even dimensions and 8-bit 4:2:0', () => {
    const chain = playbackFilterChain({ transfer: 'bt709' });

    expect(chain).toBe(
      `scale=w='min(${PLAYBACK_MAX_EDGE},iw)':h='min(${PLAYBACK_MAX_EDGE},ih)'` +
        ':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p',
    );
    expect(chain).not.toContain('tonemap');
  });

  it('tone-maps PQ and HLG sources to BT.709 before the fit', () => {
    for (const transfer of ['smpte2084', 'arib-std-b67']) {
      const chain = playbackFilterChain({ transfer });

      expect(chain.startsWith('zscale=t=linear:npl=100,')).toBe(true);
      expect(chain).toContain('tonemap=hable:desat=0');
      expect(chain).toContain('zscale=t=bt709:m=bt709:r=tv');
      expect(chain.endsWith(',format=yuv420p')).toBe(true);
      expect(chain.indexOf('tonemap')).toBeLessThan(chain.indexOf('scale=w='));
    }
  });

  it('treats an unknown transfer as SDR', () => {
    expect(playbackFilterChain({ transfer: null })).not.toContain('tonemap');
  });

  it('defaults the edge to the configured setting (1920 out of the box)', () => {
    expect(PLAYBACK_MAX_EDGE).toBe(1920);
    expect(playbackFilterChain({ transfer: 'bt709' })).toContain(`min(1920,iw)`);
  });

  it('honours a different edge, and keeps the original resolution for 0', () => {
    expect(playbackFilterChain({ transfer: 'bt709' }, 1280)).toContain(`min(1280,iw)`);

    const native = playbackFilterChain({ transfer: 'bt709' }, ORIGINAL_RESOLUTION);

    expect(native).not.toContain('min(');
    // Still guards the even dimensions x264 needs.
    expect(native).toBe('scale=w=iw:h=ih:force_divisible_by=2,format=yuv420p');
  });
});

describe('audio track choice', () => {
  const video = { index: 0, codec_type: 'video', codec_name: 'hevc' };

  // iPhone 16/17 Pro Spatial Audio: stereo AAC plus an APAC track nothing can
  // decode. Mapping every audio stream (`0:a?`) failed the whole encode.
  it('keeps the decodable track of a Spatial Audio clip and never the APAC one', () => {
    for (const apac of ['apple_apac', 'apac', 'none', 'unknown']) {
      expect(
        pickAudioStream([
          video,
          { index: 1, codec_type: 'audio', codec_name: apac, disposition: { default: 1 } },
          { index: 2, codec_type: 'audio', codec_name: 'aac', disposition: { default: 0 } },
        ]),
      ).toBe(2);
    }
  });

  it('prefers the default-flagged track, else the first decodable one', () => {
    expect(
      pickAudioStream([
        video,
        { index: 1, codec_type: 'audio', codec_name: 'aac', disposition: { default: 0 } },
        { index: 2, codec_type: 'audio', codec_name: 'ac3', disposition: { default: 1 } },
      ]),
    ).toBe(2);
    expect(
      pickAudioStream([
        video,
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
        { index: 2, codec_type: 'audio', codec_name: 'ac3' },
      ]),
    ).toBe(1);
  });

  it('is none for a silent clip or one whose only audio cannot be decoded', () => {
    expect(pickAudioStream([video])).toBeNull();
    expect(pickAudioStream([video, { index: 1, codec_type: 'audio', codec_name: 'apple_apac' }])).toBeNull();
    expect(pickAudioStream([video, { index: 1, codec_type: 'audio' }])).toBeNull();
  });
});

describe('ffmpeg output options', () => {
  it('maps the first video stream and exactly the chosen audio stream', () => {
    const options = playbackOutputOptions({ transfer: 'bt709' }, 2);

    expect(options.filter((option) => option.startsWith('-map'))).toEqual(['-map 0:v:0', '-map 0:2']);
    expect(options).toEqual(expect.arrayContaining(['-c:a aac', '-b:a 128k']));
    expect(options).not.toContain('-an');
  });

  it('writes a silent rendition when there is no audio track to keep', () => {
    const options = playbackOutputOptions({ transfer: 'bt709' }, null);

    expect(options.filter((option) => option.startsWith('-map'))).toEqual(['-map 0:v:0']);
    expect(options).toContain('-an');
    expect(options.some((option) => option.startsWith('-c:a'))).toBe(false);
  });
});

describe('transcode timeout', () => {
  const MINUTE = 60_000;

  it('gives short and unknown-length clips the 45-minute floor', () => {
    expect(transcodeTimeoutMs(null)).toBe(45 * MINUTE);
    expect(transcodeTimeoutMs(4)).toBe(45 * MINUTE);
  });

  // A flat 45 minutes called an hour-long recording "stuck" when encoding
  // runs at about real time.
  it('scales with the clip: three times its length plus a margin', () => {
    expect(transcodeTimeoutMs(20 * 60)).toBe(70 * MINUTE);
  });

  it('stays under the two-hour job deadline, so the timer and not the deadline stops a runaway encode', () => {
    expect(transcodeTimeoutMs(60 * 60)).toBe(110 * MINUTE);
    expect(transcodeTimeoutMs(6 * 60 * 60)).toBe(110 * MINUTE);
  });
});

describe('environment faults', () => {
  it.each([
    "[AVFilterGraph @ 0x1] No such filter: 'zscale'",
    'Error opening output files: Filter not found',
    'Unknown encoder libx264',
    'Cannot find ffmpeg',
    'spawn ffprobe ENOENT',
    'av_interleaved_write_frame(): No space left on device',
    'ffmpeg was killed with signal SIGKILL',
  ])('blames the machine for %p', (text) => {
    expect(isEnvironmentFault(text)).toBe(true);
  });

  it.each([
    'Decoding requested, but no decoder found for: apple_apac',
    'Decoder (codec none) not found for input stream #0:2',
    'Invalid data found when processing input',
    'moov atom not found',
  ])('blames the input for %p', (text) => {
    expect(isEnvironmentFault(text)).toBe(false);
  });
});

describe('VideoPlaybackService.generate', () => {
  it('returns the existing rendition without reading the original', async () => {
    const { service, fileService } = build();
    fileService.findVariantByParentId.mockResolvedValueOnce({ id: 'play-0' });

    await expect(service.generate(ctx, { fileId: 'file-1' })).resolves.toEqual({
      outcome: 'exists',
      playbackId: 'play-0',
    });
    expect(fileService.findVariantByParentId).toHaveBeenCalledWith(ctx, 'file-1', FileVariant.PLAYBACK);
    expect(fileService.getFileStream).not.toHaveBeenCalled();
  });

  it.each([
    ['file_not_found', null],
    ['not_stored', { ...HEVC_FILE, key: null }],
    ['not_video', { ...HEVC_FILE, contentType: 'image/jpeg' }],
  ])('skips %s before touching object storage', async (reason, file) => {
    const { service, fileService } = build(file);

    await expect(service.generate(ctx, { fileId: 'file-1' })).resolves.toEqual({
      outcome: 'skipped',
      reason,
    });
    expect(fileService.getFileStream).not.toHaveBeenCalled();
  });

  it('skips as unprobeable when ffprobe finds no video stream, and cleans up', async () => {
    const { service, fileService } = build();
    jest.spyOn(service, 'probe').mockResolvedValue(null);

    await expect(service.generate(ctx, { fileId: 'file-1' })).resolves.toEqual({
      outcome: 'skipped',
      reason: 'unprobeable',
    });
    expect(fileService.create).not.toHaveBeenCalled();
  });

  it('skips a browser-safe original as not_needed, naming the codec', async () => {
    const { service, fileService } = build();
    jest.spyOn(service, 'probe').mockResolvedValue({
      codec: 'h264',
      pixFmt: 'yuv420p',
      transfer: 'bt709',
      width: 1920,
      height: 1080,
      durationSeconds: 4,
      audioStreamIndex: 1,
    });

    await expect(service.generate(ctx, { fileId: 'file-1' })).resolves.toEqual({
      outcome: 'skipped',
      reason: 'not_needed',
      codec: 'h264',
    });
    expect(fileService.create).not.toHaveBeenCalled();
  });

  it('records an input ffmpeg rejects as transcode_failed rather than throwing', async () => {
    const { service, fileService } = build();
    jest.spyOn(service, 'probe').mockResolvedValue({
      codec: 'hevc',
      pixFmt: 'yuv420p10le',
      transfer: 'smpte2084',
      width: 3840,
      height: 2160,
      durationSeconds: 4,
      audioStreamIndex: 1,
    });
    jest
      .spyOn(service as unknown as { transcode: () => Promise<boolean> }, 'transcode')
      .mockResolvedValue(false);

    await expect(service.generate(ctx, { fileId: 'file-1' })).resolves.toEqual({
      outcome: 'skipped',
      reason: 'transcode_failed',
      codec: 'hevc',
    });
    expect(fileService.create).not.toHaveBeenCalled();
  });

  it('writes the rendition as a PLAYBACK child of the original with the rendered dimensions', async () => {
    const { service, fileService } = build();
    const probe = jest.spyOn(service, 'probe');
    probe
      .mockResolvedValueOnce({
        codec: 'hevc',
        pixFmt: 'yuv420p',
        transfer: 'bt709',
        width: 3840,
        height: 2160,
        durationSeconds: 4,
        audioStreamIndex: 1,
      })
      .mockResolvedValueOnce({
        codec: 'h264',
        pixFmt: 'yuv420p',
        transfer: 'bt709',
        width: 1920,
        height: 1080,
        durationSeconds: 4,
        audioStreamIndex: 1,
      });
    const transcode = jest
      .spyOn(
        service as unknown as { transcode: (input: string, output: string) => Promise<boolean> },
        'transcode',
      )
      .mockImplementation(async (_input, output) => {
        await fs.writeFile(output, Buffer.alloc(1234));

        return true;
      });

    await expect(service.generate(ctx, { fileId: 'file-1' })).resolves.toEqual({
      outcome: 'generated',
      playbackId: 'play-1',
      codec: 'hevc',
    });

    const output = transcode.mock.calls[0][1];

    expect(fileService.create).toHaveBeenCalledWith(ctx, {
      contentType: 'video/mp4',
      size: 1234,
      width: 1920,
      height: 1080,
      variant: FileVariant.PLAYBACK,
      path: output,
      parentId: 'file-1',
    });
    // Temp files are gone once the row exists.
    await expect(fs.stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lets an object-storage read failure throw (the retryable class)', async () => {
    const { service, fileService } = build();
    fileService.getFileStream.mockRejectedValueOnce(new Error('S3 object body was empty'));

    await expect(service.generate(ctx, { fileId: 'file-1' })).rejects.toThrow('S3 object body was empty');
  });

  // A missing filter or a timed-out encode is not the file's fault: returned
  // as `transcode_failed` it would never be offered again.
  it('lets a fault of the machine throw rather than recording a skip', async () => {
    const { service, fileService } = build();
    jest.spyOn(service, 'probe').mockResolvedValue(HEVC_PROBE);
    const transcode = jest
      .spyOn(
        service as unknown as { transcode: (input: string, output: string) => Promise<boolean> },
        'transcode',
      )
      .mockRejectedValue(new PlaybackEnvironmentError('environment', "No such filter: 'zscale'"));

    await expect(service.generate(ctx, { fileId: 'file-1' })).rejects.toBeInstanceOf(
      PlaybackEnvironmentError,
    );
    expect(fileService.create).not.toHaveBeenCalled();
    await expect(fs.stat(transcode.mock.calls[0][0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // The upload listener (worker) and the sweep (API process) both run this.
  // Hours can pass between the first check and the write — the spool, the
  // wait for the encode slot, the encode — so the check is asked again.
  describe('when the other caller writes the rendition first', () => {
    it('does not encode once the slot is ours and the rendition exists', async () => {
      const { service, fileService } = build();
      jest.spyOn(service, 'probe').mockResolvedValue(HEVC_PROBE);
      const transcode = stubTranscode(service);
      fileService.findVariantByParentId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'play-other' });

      await expect(service.generate(ctx, { fileId: 'file-1' })).resolves.toEqual({
        outcome: 'exists',
        playbackId: 'play-other',
      });
      expect(transcode).not.toHaveBeenCalled();
      expect(fileService.create).not.toHaveBeenCalled();
    });

    it('does not upload a second one when it appeared during the encode', async () => {
      const { service, fileService } = build();
      jest.spyOn(service, 'probe').mockResolvedValue(HEVC_PROBE);
      const transcode = stubTranscode(service);
      fileService.findVariantByParentId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'play-other' });

      await expect(service.generate(ctx, { fileId: 'file-1' })).resolves.toEqual({
        outcome: 'exists',
        playbackId: 'play-other',
      });
      expect(transcode).toHaveBeenCalledTimes(1);
      expect(fileService.create).not.toHaveBeenCalled();
    });

    it('reports the winner when the unique index refuses this write', async () => {
      const { service, fileService } = build();
      jest.spyOn(service, 'probe').mockResolvedValue(HEVC_PROBE);
      stubTranscode(service);
      fileService.findVariantByParentId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'play-other' });
      fileService.create.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          driverError: { code: '23505' },
        }),
      );

      await expect(service.generate(ctx, { fileId: 'file-1' })).resolves.toEqual({
        outcome: 'exists',
        playbackId: 'play-other',
      });
    });

    it('still throws a write failure that is not that race', async () => {
      const { service, fileService } = build();
      jest.spyOn(service, 'probe').mockResolvedValue(HEVC_PROBE);
      stubTranscode(service);
      fileService.create.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));

      await expect(service.generate(ctx, { fileId: 'file-1' })).rejects.toThrow(
        'Connection terminated unexpectedly',
      );
    });
  });
});

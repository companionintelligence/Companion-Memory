import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import plimit from 'p-limit';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { FileVariant } from '../types';

import { FileService } from './FileService';

/**
 * Codecs every current browser decodes without help. Anything else — HEVC
 * above all, but also MPEG-4 part 2, H.263 (3GP), ProRes — gets a PLAYBACK
 * rendition. VP8/VP9/AV1 are listed because a WebM or AV1 MP4 plays in every
 * browser this app targets; re-encoding them would only lose quality.
 */
export const BROWSER_SAFE_VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'vp8', 'vp9', 'av1']);

/**
 * Longest edge of the rendition, in pixels; `0` keeps the original's
 * resolution. The default (1920) turns a 4K phone clip into 1080p — see the
 * measurements on `media.videoPlayback.maxEdge` in `configuration.ts`.
 * Operators set `CI_MEDIA_VIDEO_PLAYBACK_MAX_EDGE`.
 */
export const PLAYBACK_MAX_EDGE: number = config.media.videoPlayback.maxEdge;

/** The setting's meaning, spelled out where the filter chain reads it. */
export const ORIGINAL_RESOLUTION = 0;

/** x264 quality: 23 is the encoder's default and visually transparent for a phone clip at 1080p. */
export const PLAYBACK_CRF = 23;

/** HDR transfer characteristics that need tone mapping before an 8-bit SDR encode. */
const HDR_TRANSFERS: ReadonlySet<string> = new Set(['smpte2084', 'arib-std-b67']);

/** A transcode that has not finished in this long is stuck, not slow. */
const TRANSCODE_TIMEOUT_MS = 45 * 60_000;

/**
 * One ffmpeg encode per process, whoever asks. x264 already uses every core
 * it is given, so two encodes abreast finish no sooner than one after the
 * other and only add memory (a 4K decode is a gigabyte or two). The callers
 * are the upload listener (its queue is one slot) and the pipeline stage —
 * whose slices the enrich queue runs several at a time, which is why the
 * stage's own per-slice limit is not enough. Process-wide, so at most one
 * encode in the API process and one in the worker.
 */
const transcodeSlot = plimit(1);

export type PlaybackSkipReason =
  | 'file_not_found'
  | 'not_stored'
  | 'not_video'
  /** The original already plays everywhere; no rendition is made. */
  | 'not_needed'
  /** ffprobe could not read a video stream out of the bytes. */
  | 'unprobeable'
  /** ffmpeg rejected the input — a codec or container it cannot decode. */
  | 'transcode_failed';

export type PlaybackOutcome =
  | { outcome: 'generated'; playbackId: string; codec: string }
  | { outcome: 'exists'; playbackId: string }
  | { outcome: 'skipped'; reason: PlaybackSkipReason; codec?: string };

export interface VideoStreamProbe {
  codec: string;
  pixFmt: string | null;
  transfer: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

/**
 * Whether a probed stream needs a rendition, and the ffmpeg video filter that
 * produces one. Pure, so the decision and the chains are unit-tested as text.
 *
 * SDR: fit inside a `maxEdge` square (aspect kept, even dimensions because
 * x264 needs them; no scale step at all for {@link ORIGINAL_RESOLUTION},
 * only the even-dimension guard), 8-bit 4:2:0. HDR (PQ or HLG transfer):
 * linearise, tone-map with Hable, convert to BT.709, then the same fit. Both
 * chains were run on real clips 2026-09-22: a 4K 8-bit Samsung clip and a
 * 4K 10-bit PQ one each came out as playable BT.709 H.264 at 1080p in about
 * real time on this CPU. The all-hardware VA-API path was tried and dropped:
 * it needs VRAM the appliance's LLM already holds, and failed here for that
 * reason; software x264 needs nothing the image does not already ship.
 */
export function playbackFilterChain(
  probe: Pick<VideoStreamProbe, 'transfer'>,
  maxEdge: number = PLAYBACK_MAX_EDGE,
): string {
  const fit =
    maxEdge === ORIGINAL_RESOLUTION
      ? `scale=w=iw:h=ih:force_divisible_by=2`
      : `scale=w='min(${maxEdge},iw)':h='min(${maxEdge},ih)'` +
        `:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const toneMap =
    'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,';

  return `${probe.transfer != null && HDR_TRANSFERS.has(probe.transfer) ? toneMap : ''}${fit},format=yuv420p`;
}

export function needsPlaybackRendition(probe: Pick<VideoStreamProbe, 'codec'>): boolean {
  return !BROWSER_SAFE_VIDEO_CODECS.has(probe.codec.toLowerCase());
}

/**
 * Produces the browser-playable H.264 rendition of a stored video — the
 * `PLAYBACK` variant, a child of the ORIGINAL exactly as the PREVIEW JPEG is.
 *
 * Why: browsers play HEVC only through the platform's hardware decoder, and
 * on Linux that path is unreliable — measured 2026-09-22, Chrome 153 on a
 * 7900 XTX fails every HEVC clip (8-bit and 10-bit alike) in its VA-API
 * output path while ffmpeg decodes the same bytes through the same driver.
 * Phone recordings since ~2023 are HEVC, so without this the owner's own
 * videos are the ones that do not play. The server decides, not the client:
 * a browser that claims HEVC support can still fail to render it (Chrome
 * answered "probably" and then failed), so the rule is by codec, and only
 * codecs outside {@link BROWSER_SAFE_VIDEO_CODECS} get a rendition.
 *
 * The original is untouched: it stays the download, the description
 * sampler's input, and the file of record. Same contract as the preview
 * generator: object-storage IO and the spool throw (retryable); an input
 * ffmpeg cannot handle is `skipped: transcode_failed` and is not retried
 * until the stage version is bumped.
 */
@Injectable()
export class VideoPlaybackService {
  constructor(
    private readonly fileService: FileService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(VideoPlaybackService.name);
  }

  async generate(context: UserServiceContext, input: { fileId: string }): Promise<PlaybackOutcome> {
    const existing = await this.fileService.findVariantByParentId(
      context,
      input.fileId,
      FileVariant.PLAYBACK,
    );

    if (existing) {
      return { outcome: 'exists', playbackId: existing.id };
    }

    const file = await this.fileService.findById(context, input.fileId);

    if (file == null) {
      return { outcome: 'skipped', reason: 'file_not_found' };
    }

    if (file.bucket == null || file.key == null) {
      return { outcome: 'skipped', reason: 'not_stored' };
    }

    if (!file.contentType.startsWith('video/')) {
      return { outcome: 'skipped', reason: 'not_video' };
    }

    const stream = await this.fileService.getFileStream(context, file.key);
    const tempInput = join(tmpdir(), `ci-playback-${randomUUID()}`);
    const tempOutput = `${tempInput}.mp4`;

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(tempInput);
        stream.pipe(ws);
        stream.on('error', (err) => reject(err));
        ws.on('finish', () => resolve());
        ws.on('error', (err) => reject(err));
      });

      const probe = await this.probe(tempInput);

      if (probe == null) {
        this.logger.warn('Video could not be probed; no playback rendition', { fileId: file.id });

        return { outcome: 'skipped', reason: 'unprobeable' };
      }

      if (!needsPlaybackRendition(probe)) {
        return { outcome: 'skipped', reason: 'not_needed', codec: probe.codec };
      }

      const transcoded = await transcodeSlot(() => this.transcode(tempInput, tempOutput, probe, file.id));

      if (!transcoded) {
        return { outcome: 'skipped', reason: 'transcode_failed', codec: probe.codec };
      }

      const [rendered, stat] = await Promise.all([this.probe(tempOutput), fs.stat(tempOutput)]);
      const playback = await this.fileService.create(context, {
        contentType: 'video/mp4',
        size: stat.size,
        width: rendered?.width ?? undefined,
        height: rendered?.height ?? undefined,
        variant: FileVariant.PLAYBACK,
        path: tempOutput,
        parentId: file.id,
      });

      this.logger.log('Generated playback rendition', {
        fileId: file.id,
        playbackId: playback.id,
        codec: probe.codec,
        hdr: probe.transfer != null && HDR_TRANSFERS.has(probe.transfer),
        maxEdge: PLAYBACK_MAX_EDGE,
        source: `${probe.width ?? '?'}x${probe.height ?? '?'}`,
        rendition: `${rendered?.width ?? '?'}x${rendered?.height ?? '?'}`,
        bytes: stat.size,
      });

      return { outcome: 'generated', playbackId: playback.id, codec: probe.codec };
    } finally {
      await Promise.all([tempInput, tempOutput].map((path) => fs.unlink(path).catch(() => {})));
    }
  }

  /** The first video stream's codec and colour facts, or null when ffprobe finds none. */
  async probe(path: string): Promise<VideoStreamProbe | null> {
    try {
      const data = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
        ffmpeg.ffprobe(path, (err, probed) => (err ? reject(err) : resolve(probed)));
      });
      const stream = data.streams.find((s) => s.codec_type === 'video');

      if (stream?.codec_name == null) {
        return null;
      }

      const raw = stream as unknown as Record<string, unknown>;
      const duration = Number(data.format?.duration);

      return {
        codec: stream.codec_name,
        pixFmt: typeof raw.pix_fmt === 'string' ? raw.pix_fmt : null,
        transfer: typeof raw.color_transfer === 'string' ? raw.color_transfer : null,
        width: stream.width ?? null,
        height: stream.height ?? null,
        durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * One ffmpeg run. Decode failures come back as `false` (a format gap, not
   * retryable); a run that exceeds {@link TRANSCODE_TIMEOUT_MS} is killed and
   * treated the same way.
   */
  private async transcode(
    input: string,
    output: string,
    probe: VideoStreamProbe,
    fileId: string,
  ): Promise<boolean> {
    const startedAt = Date.now();

    try {
      await new Promise<void>((resolve, reject) => {
        const command = ffmpeg(input)
          .outputOptions([
            '-map 0:v:0',
            '-map 0:a?',
            '-c:v libx264',
            '-preset veryfast',
            `-crf ${PLAYBACK_CRF}`,
            // No `-level`: x264 picks the lowest level the output fits
            // (4.1 at 1080p30, 5.1 at 4K), so the setting above needs no
            // second knob here.
            '-profile:v high',
            '-pix_fmt yuv420p',
            `-vf ${playbackFilterChain(probe)}`,
            '-c:a aac',
            '-b:a 128k',
            '-movflags +faststart',
          ])
          .output(output)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err));
        const timer = setTimeout(() => {
          command.kill('SIGKILL');
          reject(new Error(`transcode exceeded ${TRANSCODE_TIMEOUT_MS / 60_000} min`));
        }, TRANSCODE_TIMEOUT_MS);
        timer.unref?.();
        command.on('end', () => clearTimeout(timer)).on('error', () => clearTimeout(timer));
        command.run();
      });

      return true;
    } catch (err: unknown) {
      this.logger.warn('Video transcode failed; no playback rendition', {
        fileId,
        codec: probe.codec,
        durationSeconds: probe.durationSeconds,
        elapsedMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });

      return false;
    }
  }
}

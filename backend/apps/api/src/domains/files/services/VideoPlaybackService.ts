import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import plimit from 'p-limit';

import { isUniqueViolation } from '@ci/common/constants';
import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { type SignedFile } from '../entities/FileEntity';
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

/** The shortest run any clip is given, however short: a slow machine is slow, not stuck. */
const TRANSCODE_TIMEOUT_FLOOR_MS = 45 * 60_000;

/**
 * Encoding runs at about real time on the measured CPU (see
 * {@link playbackFilterChain}); three times the clip's own length is a machine
 * several times slower than that, which is still slow rather than stuck.
 */
const TRANSCODE_REALTIME_FACTOR = 3;

const TRANSCODE_TIMEOUT_MARGIN_MS = 10 * 60_000;

/**
 * Kept under the job deadline (`queues.jobTimeoutSeconds`: neither caller's
 * queue declares one of its own), so that a runaway encode is KILLED by this
 * timer — releasing the encode slot — rather than abandoned by the deadline
 * and left running behind it.
 */
const TRANSCODE_TIMEOUT_CAP_MS = Math.max(
  TRANSCODE_TIMEOUT_FLOOR_MS,
  config.queues.jobTimeoutSeconds * 1000 - TRANSCODE_TIMEOUT_MARGIN_MS,
);

/**
 * How long one encode may run: scaled with the probed duration, because a flat
 * limit called an hour-long recording "stuck" when the service's own numbers
 * say it takes about an hour. Floored for short and unknown-length clips,
 * capped under the job deadline.
 */
export function transcodeTimeoutMs(durationSeconds: number | null): number {
  const scaled =
    durationSeconds == null
      ? 0
      : durationSeconds * 1000 * TRANSCODE_REALTIME_FACTOR + TRANSCODE_TIMEOUT_MARGIN_MS;

  return Math.min(TRANSCODE_TIMEOUT_CAP_MS, Math.max(TRANSCODE_TIMEOUT_FLOOR_MS, scaled));
}

/**
 * Audio codecs ffprobe can name but no ffmpeg the appliance ships can decode.
 * Apple's spatial-audio APAC — the extra track iPhone 16/17 Pro clips carry
 * next to their stereo AAC by default — reads `apple_apac` on ffmpeg 8+, and
 * has no codec id at all (`none`/`unknown`) on the image's Debian 5.1.
 */
const UNDECODABLE_AUDIO_CODECS: ReadonlySet<string> = new Set(['apac', 'apple_apac', 'none', 'unknown']);

/**
 * Failures that are the machine's, not the input's: ffmpeg or ffprobe missing,
 * a filter or encoder this build lacks (Homebrew's ffmpeg has no `zscale`, so
 * every HDR clip failed under `make dev`), a full disk or exhausted memory, a
 * process killed from outside (the OOM killer). Matched against the error and
 * ffmpeg's stderr, whose `[filter] No such filter` lines fluent-ffmpeg drops
 * from the message. Decode failures ("Decoder not found", "Invalid data found
 * when processing input") are deliberately not here: those are the input's.
 */
const ENVIRONMENT_FAULT =
  /Cannot find ff(?:mpeg|probe)|\bENOENT\b|No such filter|Filter not found|Unknown encoder|Encoder not found|No space left on device|\bENOSPC\b|Cannot allocate memory|\bENOMEM\b|killed with signal/i;

export function isEnvironmentFault(text: string): boolean {
  return ENVIRONMENT_FAULT.test(text);
}

/**
 * A transcode or probe that stopped for a reason that is not the input's —
 * see {@link ENVIRONMENT_FAULT} — or ran past {@link transcodeTimeoutMs}.
 * THROWN rather than returned as a skip, because a retry can succeed without
 * the file changing: recorded as `skipped: transcode_failed` it would never be
 * re-offered until the stage version was bumped, even after the machine was
 * fixed. The stage records it as a `failed` row (`transcode_<reason>`), which
 * the ledger retries and, past its attempt budget, quarantines visibly.
 */
export class PlaybackEnvironmentError extends Error {
  constructor(
    readonly reason: 'timeout' | 'environment',
    message: string,
  ) {
    super(message);
    this.name = 'PlaybackEnvironmentError';
  }
}

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
  /** The input stream index of the one audio track the rendition carries — {@link pickAudioStream}. */
  audioStreamIndex: number | null;
}

interface ProbedStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  disposition?: { default?: number };
}

/**
 * The one audio track the rendition carries: the default-flagged decodable
 * track, else the first decodable one, else none (the rendition is silent).
 *
 * One, not all: `-map 0:a?` mapped every audio stream, `-c:a aac` then had to
 * decode each of them, and an iPhone Spatial Audio clip's APAC track — which
 * nothing can decode — failed the whole encode, so exactly the recent HEVC
 * phone clips this rendition exists for got none. A browser plays one track
 * anyway.
 */
export function pickAudioStream(streams: readonly ProbedStream[]): number | null {
  const decodable = streams.filter(
    (stream) =>
      stream.codec_type === 'audio' &&
      stream.codec_name != null &&
      !UNDECODABLE_AUDIO_CODECS.has(stream.codec_name.toLowerCase()),
  );

  return (decodable.find((stream) => stream.disposition?.default === 1) ?? decodable[0])?.index ?? null;
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
 * The ffmpeg output options for a rendition: the first video stream, and the
 * given audio stream (by input index) or none. Pure, like the filter chain.
 */
export function playbackOutputOptions(
  probe: Pick<VideoStreamProbe, 'transfer'>,
  audioStreamIndex: number | null,
): string[] {
  return [
    '-map 0:v:0',
    ...(audioStreamIndex != null ? [`-map 0:${audioStreamIndex}`] : []),
    '-c:v libx264',
    '-preset veryfast',
    `-crf ${PLAYBACK_CRF}`,
    // No `-level`: x264 picks the lowest level the output fits
    // (4.1 at 1080p30, 5.1 at 4K), so the setting above needs no
    // second knob here.
    '-profile:v high',
    '-pix_fmt yuv420p',
    `-vf ${playbackFilterChain(probe)}`,
    ...(audioStreamIndex != null ? ['-c:a aac', '-b:a 128k'] : ['-an']),
    '-movflags +faststart',
  ];
}

/** One failed ffmpeg run, with what it printed, for {@link isEnvironmentFault}. */
class FfmpegRunError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(message);
  }
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
 * until the stage version is bumped. A fault of the machine rather than the
 * input — a missing filter or binary, a full disk, the timeout — throws
 * {@link PlaybackEnvironmentError}, so it is never recorded as that skip.
 *
 * Two callers run this without coordinating — the upload listener in the
 * worker and the enrich sweep in the API process — so the "already has one?"
 * check is repeated where it matters (after the wait for the encode slot, and
 * again before the write), and a unique index — `files_one_playback_per_parent_uniq`,
 * migration 20260927235655 — makes the write itself exclusive: a caller that
 * encoded the same clip at the same moment loses the insert and reports
 * `exists`.
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
    const existing = await this.findPlayback(context, input.fileId);

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

      // Asked again once the slot is ours: between the check above and here
      // lie the spool, the probe and the wait behind every encode queued in
      // this process, and the other caller may have written it meanwhile.
      const encoded = await transcodeSlot(
        async (): Promise<{ raced: SignedFile } | { raced: null; transcoded: boolean }> => {
          const raced = await this.findPlayback(context, file.id);

          return raced != null
            ? { raced }
            : { raced: null, transcoded: await this.transcode(tempInput, tempOutput, probe, file.id) };
        },
      );

      if (encoded.raced != null) {
        return { outcome: 'exists', playbackId: encoded.raced.id };
      }

      if (!encoded.transcoded) {
        return { outcome: 'skipped', reason: 'transcode_failed', codec: probe.codec };
      }

      // And once more before the write, since the encode took about the clip's
      // length: finding the other caller's rendition here saves uploading a
      // whole second one only for the index to refuse it.
      const beaten = await this.findPlayback(context, file.id);

      if (beaten) {
        return { outcome: 'exists', playbackId: beaten.id };
      }

      const [rendered, stat] = await Promise.all([this.probe(tempOutput), fs.stat(tempOutput)]);
      let playback: SignedFile;

      try {
        playback = await this.fileService.create(context, {
          contentType: 'video/mp4',
          size: stat.size,
          width: rendered?.width ?? undefined,
          height: rendered?.height ?? undefined,
          variant: FileVariant.PLAYBACK,
          path: tempOutput,
          parentId: file.id,
        });
      } catch (err: unknown) {
        // Both callers encoded this clip at the same moment and the other
        // wrote first. The index kept one row; create() already deleted the
        // object it put for this one.
        const winner = isUniqueViolation(err) ? await this.findPlayback(context, file.id) : null;

        if (winner == null) {
          throw err;
        }

        return { outcome: 'exists', playbackId: winner.id };
      }

      this.logger.log('Generated playback rendition', {
        fileId: file.id,
        playbackId: playback.id,
        codec: probe.codec,
        hdr: probe.transfer != null && HDR_TRANSFERS.has(probe.transfer),
        maxEdge: PLAYBACK_MAX_EDGE,
        source: `${probe.width ?? '?'}x${probe.height ?? '?'}`,
        rendition: `${rendered?.width ?? '?'}x${rendered?.height ?? '?'}`,
        audioStreamIndex: probe.audioStreamIndex,
        bytes: stat.size,
      });

      return { outcome: 'generated', playbackId: playback.id, codec: probe.codec };
    } finally {
      await Promise.all([tempInput, tempOutput].map((path) => fs.unlink(path).catch(() => {})));
    }
  }

  /**
   * The first video stream's codec and colour facts, and the audio track to
   * keep; null when ffprobe finds no video stream or cannot read the bytes.
   * A missing ffprobe (or one killed from outside) throws
   * {@link PlaybackEnvironmentError} instead: that is not the file's fault.
   */
  async probe(path: string): Promise<VideoStreamProbe | null> {
    let data: ffmpeg.FfprobeData;

    try {
      data = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
        ffmpeg.ffprobe(path, (err, probed) => (err ? reject(err) : resolve(probed)));
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (isEnvironmentFault(message)) {
        throw new PlaybackEnvironmentError('environment', `ffprobe could not run: ${message}`);
      }

      return null;
    }

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
      audioStreamIndex: pickAudioStream(data.streams),
    };
  }

  private findPlayback(context: UserServiceContext, fileId: string): Promise<SignedFile | null> {
    return this.fileService.findVariantByParentId(context, fileId, FileVariant.PLAYBACK);
  }

  /**
   * The encode. `false` is the input's fault (a codec or container ffmpeg
   * cannot decode) and becomes `skipped: transcode_failed`; a fault of the
   * machine, or a run past {@link transcodeTimeoutMs}, throws
   * {@link PlaybackEnvironmentError}.
   *
   * An input failure with an audio track mapped is tried once more silent:
   * the audio stream the probe picked can still be one ffmpeg fails to
   * decode, and a rendition without sound beats none — the original, sound
   * and all, stays the download.
   */
  private async transcode(
    input: string,
    output: string,
    probe: VideoStreamProbe,
    fileId: string,
  ): Promise<boolean> {
    const attempts = probe.audioStreamIndex != null ? [probe.audioStreamIndex, null] : [null];

    for (const [attempt, audioStreamIndex] of attempts.entries()) {
      const startedAt = Date.now();

      try {
        await this.runFfmpeg(
          input,
          output,
          playbackOutputOptions(probe, audioStreamIndex),
          transcodeTimeoutMs(probe.durationSeconds),
        );

        return true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const stderr = err instanceof FfmpegRunError ? err.stderr : '';
        const timedOut = err instanceof FfmpegRunError && err.timedOut;
        const environment = !timedOut && isEnvironmentFault(`${message}\n${stderr}`);
        const retrying = !timedOut && !environment && attempt < attempts.length - 1;

        this.logger.warn(
          retrying
            ? 'Video transcode failed with its audio track; retrying without audio'
            : 'Video transcode failed; no playback rendition',
          {
            fileId,
            codec: probe.codec,
            durationSeconds: probe.durationSeconds,
            audioStreamIndex,
            attempt: attempt + 1,
            elapsedMs: Date.now() - startedAt,
            fault: timedOut ? 'timeout' : environment ? 'environment' : 'input',
            error: message,
          },
        );

        if (timedOut) {
          throw new PlaybackEnvironmentError('timeout', message);
        }

        if (environment) {
          throw new PlaybackEnvironmentError('environment', message);
        }
      }
    }

    return false;
  }

  /**
   * One ffmpeg run, killed past `timeoutMs`. Rejects with {@link FfmpegRunError}
   * carrying ffmpeg's stderr, which is where the reason usually is.
   */
  private runFfmpeg(input: string, output: string, options: string[], timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timedOut = false;
      const command = ffmpeg(input).outputOptions(options).output(output);
      const timer = setTimeout(() => {
        timedOut = true;
        command.kill('SIGKILL');
        reject(new FfmpegRunError(`transcode exceeded ${Math.round(timeoutMs / 60_000)} min`, '', true));
      }, timeoutMs);
      timer.unref?.();

      command
        .on('end', () => {
          clearTimeout(timer);
          resolve();
        })
        .on('error', (err: Error, _stdout: string | null, stderr: string | null) => {
          clearTimeout(timer);
          reject(new FfmpegRunError(err.message, stderr ?? '', timedOut));
        })
        .run();
    });
  }
}

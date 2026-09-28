import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';

import { type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { FileService } from './FileService';
import { type JpegRenderOptions, VipsDecodeError, VipsService } from './VipsService';

/** One still pulled out of the video, and where in the clip it came from. */
export interface VideoFrame {
  /** Seconds from the start of the clip the frame was taken at. */
  atSeconds: number;
  /** Upright JPEG at the caller's size cap, the same shape a photo rendition has. */
  jpeg: Buffer;
}

/**
 * What the container says about when and where the clip was recorded. Every
 * field is null when the tag is absent; a screen recording or a re-encoded
 * download carries none of them.
 */
export interface VideoCaptureMetadata {
  /** The recording instant, when a creation tag was present. */
  recordedAt: Date | null;
  /** True when the tag carried a zone offset, so `recordedOn` is the owner's day. */
  zoneKnown: boolean;
  /** `YYYY-MM-DD` as the recorder's clock read it, or the UTC day when no offset was tagged. */
  recordedOn: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface VideoFrameSample {
  /** The clip length ffprobe reported, or null when the container did not say. */
  durationSeconds: number | null;
  /** In time order. Empty when nothing could be extracted from a spooled clip. */
  frames: VideoFrame[];
  capture: VideoCaptureMetadata;
}

export interface SampleVideoOptions extends JpegRenderOptions {
  /** How many stills to pull at most; a short clip yields fewer. */
  maxFrames: number;
}

/** The minimum a caller must know about a stored video to sample it. */
export interface SampleableFile {
  id: string;
  key: string;
  contentType: string | null;
}

/**
 * Frames closer together than this say the same thing twice. A clip shorter
 * than `maxFrames` times this gets fewer frames, down to one.
 */
export const MIN_FRAME_SPACING_SECONDS = 2;

/**
 * Where in a clip of `durationSeconds` to take up to `maxFrames` stills.
 *
 * Midpoints of equal segments, so the first still is never frame zero (a
 * fade-in, a black lead-in, or a lens still settling on most phone clips) and
 * the last is never the final frame (the same, in reverse). A clip too short
 * to space `maxFrames` by {@link MIN_FRAME_SPACING_SECONDS} takes fewer; a
 * clip of unknown length takes one from its start, since `-ss` past the end
 * yields nothing at all.
 */
export function frameTimestamps(durationSeconds: number | null, maxFrames: number): number[] {
  const count = Math.max(1, Math.floor(maxFrames));

  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return [0];
  }

  const fit = Math.floor(durationSeconds / MIN_FRAME_SPACING_SECONDS);
  const n = Math.max(1, Math.min(count, fit));

  return Array.from({ length: n }, (_, i) => round3((durationSeconds * (i + 0.5)) / n));
}

/**
 * Coordinates from an ISO 6709 location tag — `+33.6893-117.8236+009.870/` as
 * Apple writes it, `+33.6893-117.8236/` from Android. Null for anything else.
 */
export function parseIso6709(value: unknown): { latitude: number; longitude: number } | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(value.trim());

  if (match == null) {
    return null;
  }

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return null;
  }

  return { latitude, longitude };
}

/**
 * The recording time from the container's tags.
 *
 * QuickTime/MP4 `creation_time` is UTC by spec, so it fixes the instant but
 * not the owner's day. Apple also writes `com.apple.quicktime.creationdate`
 * with the wall clock and its offset; when present it wins, because the day
 * the owner would name is the local one.
 */
export function parseRecordedAt(
  tags: Record<string, unknown> | undefined,
): Pick<VideoCaptureMetadata, 'recordedAt' | 'zoneKnown' | 'recordedOn'> {
  const none = { recordedAt: null, zoneKnown: false, recordedOn: null };

  if (tags == null) {
    return none;
  }

  const local = stringTag(tags, 'com.apple.quicktime.creationdate');

  if (local != null) {
    const instant = new Date(local);

    if (!Number.isNaN(instant.getTime())) {
      return { recordedAt: instant, zoneKnown: true, recordedOn: local.slice(0, 10) };
    }
  }

  const utc = stringTag(tags, 'creation_time');

  if (utc != null) {
    const instant = new Date(utc);

    // Cameras that never set a clock write the Unix epoch. That is not a
    // recording date and would put every such clip "on 1970-01-01".
    if (!Number.isNaN(instant.getTime()) && instant.getTime() > 0) {
      return { recordedAt: instant, zoneKnown: false, recordedOn: instant.toISOString().slice(0, 10) };
    }
  }

  return none;
}

/**
 * Pulls a handful of stills out of a stored video for a vision model.
 *
 * No model served through Ollama takes a video as input — the API carries
 * still images and nothing else — so "describing a video" means describing
 * frames. This service produces them: the clip is spooled to disk once (ffmpeg
 * needs a seekable input for most containers), probed for its length and
 * capture tags, and cut at {@link frameTimestamps} with input seeking, which
 * jumps to each keyframe rather than decoding everything before it.
 *
 * A frame ffmpeg or the JPEG decoder cannot produce is skipped, not thrown:
 * a clip with one bad keyframe still has the others. Only IO — the object
 * store read and the spool — propagates, because that is the retryable class.
 */
@Injectable()
export class VideoFrameSampleService {
  constructor(
    private readonly fileService: FileService,
    private readonly vips: VipsService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(VideoFrameSampleService.name);
  }

  async sample(
    context: ServiceContext,
    file: SampleableFile,
    options: SampleVideoOptions,
  ): Promise<VideoFrameSample> {
    const stream = await this.fileService.getFileStream(context, file.key);
    const tempInput = join(tmpdir(), `ci-frames-${randomUUID()}`);
    const outputs: string[] = [];

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(tempInput);
        stream.pipe(ws);
        stream.on('error', (err) => reject(err));
        ws.on('finish', () => resolve());
        ws.on('error', (err) => reject(err));
      });

      const probe = await this.probe(tempInput, file.id);
      const timestamps = frameTimestamps(probe.durationSeconds, options.maxFrames);
      const frames: VideoFrame[] = [];

      for (const [index, atSeconds] of timestamps.entries()) {
        const tempOutput = `${tempInput}-${index}.jpg`;
        outputs.push(tempOutput);

        const raw = await this.extractFrame(tempInput, tempOutput, atSeconds, file.id);

        if (raw == null) {
          continue;
        }

        try {
          const rendered = await this.vips.renderJpeg(raw, {
            maxDimension: options.maxDimension,
            quality: options.quality,
          });

          frames.push({ atSeconds, jpeg: rendered.buffer });
        } catch (err: unknown) {
          if (!(err instanceof VipsDecodeError)) {
            throw err;
          }

          this.logger.warn('Extracted video frame could not be decoded; skipping it', {
            fileId: file.id,
            atSeconds,
            error: errorMessage(err),
          });
        }
      }

      this.logger.log('Sampled video frames', {
        fileId: file.id,
        durationSeconds: probe.durationSeconds,
        requested: timestamps.length,
        extracted: frames.length,
      });

      return { durationSeconds: probe.durationSeconds, frames, capture: probe.capture };
    } finally {
      await Promise.all([tempInput, ...outputs].map((path) => fs.unlink(path).catch(() => {})));
    }
  }

  private async probe(
    path: string,
    fileId: string,
  ): Promise<{ durationSeconds: number | null; capture: VideoCaptureMetadata }> {
    const none: VideoCaptureMetadata = {
      recordedAt: null,
      zoneKnown: false,
      recordedOn: null,
      latitude: null,
      longitude: null,
    };

    try {
      const data = await new Promise<ffmpeg.FfprobeData>((resolve, reject) => {
        ffmpeg.ffprobe(path, (err, probed) => (err ? reject(err) : resolve(probed)));
      });

      const duration = Number(data.format?.duration);
      const tags = (data.format?.tags ?? undefined) as Record<string, unknown> | undefined;
      const location =
        parseIso6709(tags?.['com.apple.quicktime.location.ISO6709']) ?? parseIso6709(tags?.location);

      return {
        durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
        capture: {
          ...none,
          ...parseRecordedAt(tags),
          latitude: location?.latitude ?? null,
          longitude: location?.longitude ?? null,
        },
      };
    } catch (err: unknown) {
      // Length and tags are conveniences; a clip ffprobe cannot read may still
      // yield a frame from its start.
      this.logger.warn('Video probe failed; sampling one frame from the start', {
        fileId,
        error: errorMessage(err),
      });

      return { durationSeconds: null, capture: none };
    }
  }

  private async extractFrame(
    input: string,
    output: string,
    atSeconds: number,
    fileId: string,
  ): Promise<Buffer | null> {
    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(input)
          .seekInput(atSeconds)
          .frames(1)
          .output(output)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });

      return await fs.readFile(output);
    } catch (err: unknown) {
      this.logger.warn('Video frame extraction failed; skipping it', {
        fileId,
        atSeconds,
        error: errorMessage(err),
      });

      return null;
    }
  }
}

function stringTag(tags: Record<string, unknown>, name: string): string | null {
  const value = tags[name];

  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

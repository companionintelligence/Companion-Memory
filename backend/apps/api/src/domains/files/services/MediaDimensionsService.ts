import { randomUUID } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { type Readable } from 'stream';

import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';

import { LoggerService } from '@ci/common/logging';

/** Intrinsic, display-corrected pixel dimensions of an image or video. */
export interface MediaDimensions {
  width: number;
  height: number;
}

/**
 * EXIF orientation values 5–8 are the 90°/270° rotations: the stored pixel grid
 * is transposed relative to how the image is displayed. A browser `<img>` (and
 * the lightbox) honours the tag, so the *displayed* width/height — the value the
 * "Dimensions" row should show — are the stored dimensions swapped.
 */
const EXIF_ORIENTATION_SWAP_MIN = 5;

/**
 * Reads the intrinsic width/height of an image or video.
 *
 * Shared by the live preview pass ({@link FilePreviewGenerationListener}) and the
 * one-off dimensions backfill ({@link MediaDimensionsBackfillListener}) so both
 * derive dimensions identically. Images are probed from their header via sharp;
 * videos via ffprobe on a local (seekable) file. Every method is best-effort:
 * an unreadable/corrupt source returns `null` rather than throwing, so one bad
 * file never aborts a batch.
 */
@Injectable()
export class MediaDimensionsService {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(MediaDimensionsService.name);
  }

  /**
   * Display dimensions of an encoded image, read from its header. EXIF
   * orientation is applied so the result matches what a browser renders.
   */
  async fromImageBuffer(buffer: Buffer): Promise<MediaDimensions | null> {
    try {
      // Default failOn: rejects undecodable input promptly. (failOn: 'none' makes
      // sharp spend ~9s before giving up on a truly garbage buffer — far worse
      // than skipping the odd corrupt file.)
      const { width, height, orientation } = await sharp(buffer).metadata();

      if (width == null || height == null) {
        return null;
      }

      const swap = (orientation ?? 1) >= EXIF_ORIENTATION_SWAP_MIN;

      return swap ? { width: height, height: width } : { width, height };
    } catch (err) {
      this.logger.warn('Failed to read image dimensions', { error: errorMessage(err) });

      return null;
    }
  }

  /**
   * Display dimensions of a video's source stream, via ffprobe on a local file.
   * The caller already has the bytes on disk (the preview pass spools the
   * original so ffmpeg can seek), so we probe that file directly.
   */
  async fromVideoFile(path: string): Promise<MediaDimensions | null> {
    try {
      const data = await this.ffprobe(path);
      const stream = data.streams.find((s) => s.codec_type === 'video');

      if (stream?.width == null || stream.height == null) {
        return null;
      }

      // ffmpeg auto-rotates the extracted frame, so the displayed video is the
      // coded dimensions swapped when the container tags a 90°/270° rotation.
      const swap = isQuarterTurn(rotationOf(stream));

      return swap
        ? { width: stream.height, height: stream.width }
        : { width: stream.width, height: stream.height };
    } catch (err) {
      this.logger.warn('Failed to read video dimensions', { error: errorMessage(err) });

      return null;
    }
  }

  /**
   * Display dimensions of a video reachable only as a stream (the backfill reads
   * originals straight from object storage). Spools to a temp file first —
   * ffprobe needs a seekable input for most containers — then probes and cleans up.
   */
  async fromVideoStream(stream: Readable): Promise<MediaDimensions | null> {
    const tempInput = join(tmpdir(), `ci-probe-${randomUUID()}`);

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(tempInput);
        stream.pipe(ws);
        stream.on('error', (err) => reject(err));
        ws.on('finish', () => resolve());
        ws.on('error', (err) => reject(err));
      });

      return await this.fromVideoFile(tempInput);
    } catch (err) {
      this.logger.warn('Failed to spool video for dimension probe', { error: errorMessage(err) });

      return null;
    } finally {
      await fs.unlink(tempInput).catch(() => {});
    }
  }

  private ffprobe(path: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(path, (err, data) => (err ? reject(err) : resolve(data)));
    });
  }
}

/**
 * Display rotation of a video stream in [0, 360). ffmpeg exposes it either as a
 * `rotate` tag (older, clockwise degrees) or a top-level `rotation` field
 * (newer, the negative of the display rotation). Normalise both to a positive
 * clockwise angle.
 */
function rotationOf(stream: ffmpeg.FfprobeStream): number {
  const raw = stream.rotation ?? stream.tags?.rotate;
  const degrees = typeof raw === 'number' ? raw : Number(raw);

  if (!Number.isFinite(degrees)) {
    return 0;
  }

  return ((Math.round(degrees) % 360) + 360) % 360;
}

function isQuarterTurn(rotation: number): boolean {
  return rotation === 90 || rotation === 270;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

import { LoggerService } from '@ci/common/logging';

/** Intrinsic, display-corrected pixel dimensions of an image or video frame. */
export interface MediaDimensions {
  width: number;
  height: number;
}

/**
 * EXIF orientation 5-8 are the 90°/270° rotations: the stored pixel grid is
 * transposed relative to how the image is rendered. Browsers honour the tag on
 * the source image, so the *displayed* dimensions are the stored width/height
 * swapped — that's the value the FE thumbnail loader expects.
 */
const EXIF_ORIENTATION_SWAP_MIN = 5;

/**
 * Reads the intrinsic width/height of an image. Best-effort: an unreadable or
 * corrupt source returns `null` (logged with the underlying error so silent
 * regressions surface) rather than throwing, so one bad file never aborts a
 * batch.
 */
@Injectable()
export class MediaDimensionsService {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(MediaDimensionsService.name);
  }

  async fromImageBuffer(buffer: Buffer, contentType?: string): Promise<MediaDimensions | null> {
    try {
      const { width, height, orientation } = await sharp(buffer).metadata();

      if (width == null || height == null) {
        this.logger.warn('sharp returned no dimensions', { contentType, bytes: buffer.length });

        return null;
      }

      const swap = (orientation ?? 1) >= EXIF_ORIENTATION_SWAP_MIN;

      return swap ? { width: height, height: width } : { width, height };
    } catch (err) {
      this.logger.warn('Failed to read image dimensions', {
        contentType,
        bytes: buffer.length,
        error: err instanceof Error ? err.message : String(err),
      });

      return null;
    }
  }
}

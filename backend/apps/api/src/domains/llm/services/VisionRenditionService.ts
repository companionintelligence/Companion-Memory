import { Injectable } from '@nestjs/common';

import { type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { FileService, VipsDecodeError, VipsService } from '@ci/domains/files';

import { VISION_RENDITION_JPEG_QUALITY, VISION_RENDITION_MAX_DIMENSION } from '../constants';

/** The bytes handed to a vision model, and which stored variant they came from. */
export interface VisionRendition {
  /** Upright JPEG, at most {@link VISION_RENDITION_MAX_DIMENSION} on the long edge. */
  jpeg: Buffer;
  source: 'original' | 'preview';
  /**
   * The original's bytes, present only when `source` is 'original' — the same
   * download the rendition was made from, so a caller that wants the file's
   * EXIF (CaptureContextService) does not fetch a 30 MB original twice.
   */
  original?: Buffer;
}

/** The minimum a caller must know about a stored file to render it. */
export interface RenderableFile {
  id: string;
  key: string | null;
  contentType: string | null;
}

/**
 * Turns a stored image into the JPEG a vision model actually sees.
 *
 * Renders from the ORIGINAL, capped at {@link VISION_RENDITION_MAX_DIMENSION}
 * px (1280 since 2026-09-16; the constant's own comment has that measurement),
 * rather than either extreme the code used to pick:
 *
 *  - The 300 px PREVIEW lost subjects. Measured on the same photos, a 4B
 *    model called a squirrel thumbnail "Baby Wild Dog in Brush" and named it
 *    correctly from a larger rendition; the same model titled a 300 px night
 *    shot of a rabbit as a view of a lawn at every size, so small subjects
 *    need pixels but pixels alone are not enough.
 *  - The full ORIGINAL is unbounded. Models whose image tokens scale with
 *    pixels (Qwen3.6 27B: 220 tokens for a thumbnail, 4,172 for a 12 MP
 *    frame) took 18.6 s per 12 MP photo and would take far longer on the
 *    200 MP shots some phones produce; at 1500 px the same model took 9.4 s
 *    with no visible loss in the titles (the later step to 1280 is measured
 *    on the constant). Fixed-budget models (Gemma) are
 *    unaffected either way. And a raw original is often not something the
 *    model can read at all — HEIC, above all.
 *
 * `fallbackKey` (the PREVIEW's object key) is used when the original cannot
 * be decoded: an ICO, or bytes libvips rejects. That preview was itself made
 * by the same decoder, so if it exists it decodes; the only way to end up
 * with nothing is a file that never had a preview, which never reaches the
 * description queue in the first place.
 *
 * A missing `vips` binary is NOT a fallback case — it propagates, so the job
 * fails and retries instead of quietly describing thumbnails forever.
 */
@Injectable()
export class VisionRenditionService {
  constructor(
    private readonly fileService: FileService,
    private readonly vips: VipsService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(VisionRenditionService.name);
  }

  async render(
    context: ServiceContext,
    original: RenderableFile,
    fallbackKey?: string | null,
  ): Promise<VisionRendition | null> {
    // A video original is not something libvips can render, and it is the
    // one kind of file this fetch must never make: 281 MB on average and up
    // to 2 GB in the measured library (2026-09-22), pulled whole into memory
    // to fail. Its frames come from VideoFrameSampleService; here, the
    // PREVIEW (one extracted frame) is the only rendition on offer.
    if (original.key != null && !isVideo(original.contentType)) {
      const bytes = Buffer.from(await this.fileService.getFileContent(context, original.key));

      try {
        const rendered = await this.vips.renderJpeg(bytes, {
          maxDimension: VISION_RENDITION_MAX_DIMENSION,
          quality: VISION_RENDITION_JPEG_QUALITY,
        });

        return { jpeg: rendered.buffer, source: 'original', original: bytes };
      } catch (err: unknown) {
        if (!(err instanceof VipsDecodeError)) {
          throw err;
        }

        this.logger.warn('Original could not be rendered for vision; falling back to preview', {
          fileId: original.id,
          contentType: original.contentType,
          bytes: bytes.length,
          error: err.message,
          hasFallback: fallbackKey != null,
        });
      }
    }

    if (fallbackKey == null) {
      return null;
    }

    const preview = Buffer.from(await this.fileService.getFileContent(context, fallbackKey));

    return { jpeg: preview, source: 'preview' };
  }
}

function isVideo(contentType: string | null): boolean {
  return contentType != null && contentType.startsWith('video/');
}

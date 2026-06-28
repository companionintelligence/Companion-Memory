import { createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';

import { toServiceContext, UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent, EventService } from '@ci/domains/events';

import { type File } from '../entities/FileEntity';
import { FileUploadedEvent, FileUploadedPayload, PreviewGeneratedEvent } from '../events';
import { FileService } from '../services/FileService';
import { MediaDimensions, MediaDimensionsService } from '../services/MediaDimensionsService';
import { FileVariant } from '../types';

const PREVIEW_MAX_DIMENSION = 300;
const IMAGE_MIME_PREFIX = 'image/';
const VIDEO_MIME_PREFIX = 'video/';

/** Generated preview bytes plus the rendered preview's own width/height. */
interface PreviewResult {
  buffer: Buffer;
  previewDimensions: MediaDimensions;
  sourceDimensions: MediaDimensions | null;
}

@Injectable()
export class FilePreviewGenerationListener {
  constructor(
    private readonly fileService: FileService,
    private readonly mediaDimensionsService: MediaDimensionsService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FilePreviewGenerationListener.name);
  }

  @OnEvent(FileUploadedEvent, { queue: 'file-preview-generation' })
  async generatePreview(payload: FileUploadedPayload) {
    const context = toServiceContext({ userId: payload.userId });

    const existingPreview = await this.fileService.findVariantByParentId(
      context,
      payload.fileId,
      FileVariant.PREVIEW,
    );

    if (existingPreview) {
      this.logger.log('Preview already exists, skipping generation', {
        fileId: payload.fileId,
        previewId: existingPreview.id,
      });

      return;
    }

    const file = await this.fileService.findById(context, payload.fileId);

    if (file == null) {
      this.logger.warn('File not found, skipping preview generation', {
        fileId: payload.fileId,
      });

      return;
    }

    if (file.bucket == null || file.key == null) {
      this.logger.log('File is not stored locally, skipping generation', {
        fileId: file.id,
      });

      return;
    }

    const fileWithKey = file as RequiredFields<typeof file, 'key', true>;

    let result: PreviewResult | null = null;

    if (file.contentType.startsWith(IMAGE_MIME_PREFIX)) {
      result = await this.generateImagePreview(context, fileWithKey);
    } else if (file.contentType.startsWith(VIDEO_MIME_PREFIX)) {
      result = await this.generateVideoPreview(context, fileWithKey);
    } else {
      this.logger.log('File type not supported, skipping preview generation', {
        fileId: payload.fileId,
        contentType: file.contentType,
      });

      return;
    }

    if (result == null) {
      this.logger.warn('Failed to generate preview, buffer is null', {
        fileId: payload.fileId,
      });

      return;
    }

    // Backfill the ORIGINAL row's intrinsic dims when we just decoded them.
    // Skips FileUpdatedEvent so we don't re-trigger preview / re-index for
    // every photo we touch.
    if (result.sourceDimensions != null && (file.width == null || file.height == null)) {
      await this.fileService.setDimensions(context, file.id, result.sourceDimensions);
    }

    const preview = await this.fileService.create(context, {
      contentType: 'image/jpeg',
      size: result.buffer.length,
      width: result.previewDimensions.width,
      height: result.previewDimensions.height,
      variant: FileVariant.PREVIEW,
      buffer: result.buffer,
      parentId: file.id,
    });

    await this.eventService.send(PreviewGeneratedEvent, {
      userId: payload.userId,
      previewId: preview.id,
      model: payload.model,
    });

    this.logger.log('Generated preview', {
      fileId: payload.fileId,
      previewId: preview.id,
    });
  }

  private async generateImagePreview(
    context: UserServiceContext,
    file: RequiredFields<File, 'key', true>,
  ): Promise<PreviewResult> {
    // Buffer the original once: the dimensions probe and the resize need to
    // read the same bytes, and sharp's metadata() is unreliable on a
    // partially-consumed stream.
    const original = Buffer.from(await this.fileService.getFileContent(context, file.key));

    const sourceDimensions = await this.mediaDimensionsService.fromImageBuffer(original, file.contentType);

    // .rotate() (no args) reads EXIF orientation, rotates the pixels, and
    // strips the tag — otherwise the JPEG bytes are saved as-is and downstream
    // <img> renders rotated. Must come before .resize() so the resize box
    // applies to the display orientation, not the stored one.
    const { data, info } = await sharp(original)
      .rotate()
      .resize(PREVIEW_MAX_DIMENSION, PREVIEW_MAX_DIMENSION, {
        fit: 'inside',
      })
      .jpeg({
        quality: 80,
      })
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: data,
      previewDimensions: { width: info.width, height: info.height },
      sourceDimensions,
    };
  }

  private async generateVideoPreview(
    context: UserServiceContext,
    file: RequiredFields<File, 'key', true>,
  ): Promise<PreviewResult> {
    const stream = await this.fileService.getFileStream(context, file.key);
    const tempInput = join(tmpdir(), `ci-preview-${crypto.randomUUID()}`);
    const tempOutput = `${tempInput}-frame.jpg`;

    try {
      // Write stream to temp file so ffmpeg can seek (required for most video containers)
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(tempInput);
        stream.pipe(ws);
        stream.on('error', (err) => reject(err));
        ws.on('finish', () => resolve());
        ws.on('error', (err) => reject(err));
      });

      // Extract a single frame
      await new Promise<void>((resolve, reject) => {
        ffmpeg(tempInput)
          .frames(1)
          .output(tempOutput)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });

      const frame = await fs.readFile(tempOutput);

      // ffmpeg auto-rotates the extracted frame, so the frame is already in
      // display orientation; .rotate() here is a no-op safeguard for any
      // frames that still carry an orientation tag.
      const { data, info } = await sharp(frame)
        .rotate()
        .resize(PREVIEW_MAX_DIMENSION, PREVIEW_MAX_DIMENSION, {
          fit: 'inside',
        })
        .jpeg({ quality: 80 })
        .toBuffer({ resolveWithObject: true });

      return {
        buffer: data,
        previewDimensions: { width: info.width, height: info.height },
        // Source-dimension extraction for videos isn't wired up here; the
        // post-extraction frame can't tell us the original encoded size.
        sourceDimensions: null,
      };
    } finally {
      await fs.unlink(tempInput).catch(() => {});
      await fs.unlink(tempOutput).catch(() => {});
    }
  }
}

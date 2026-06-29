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

/** A generated preview plus the source's intrinsic dimensions (null if unreadable). */
interface PreviewResult {
  buffer: Buffer;
  dimensions: MediaDimensions | null;
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

    // Record the source's intrinsic dimensions onto the ORIGINAL row so
    // EventMediaLoader (and the drawer "Dimensions" row) can surface them. A
    // targeted write that doesn't re-trigger preview generation or re-indexing.
    if (result.dimensions != null) {
      await this.fileService.setDimensions(context, file.id, result.dimensions);
    }

    const preview = await this.fileService.create(context, {
      contentType: 'image/jpeg',
      size: result.buffer.length,
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
    // Buffer the original once so the dimensions probe and the resize read the
    // same bytes (one object-storage fetch, and metadata is reliable on a
    // Buffer where it isn't on a partially-consumed stream).
    const original = Buffer.from(await this.fileService.getFileContent(context, file.key));

    const dimensions = await this.mediaDimensionsService.fromImageBuffer(original);

    const buffer = await sharp(original)
      .resize(PREVIEW_MAX_DIMENSION, PREVIEW_MAX_DIMENSION, {
        fit: 'inside',
      })
      .jpeg({
        quality: 80,
      })
      .toBuffer();

    return { buffer, dimensions };
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

      // Probe the source stream's dimensions from the same spooled file, before
      // collapsing it to a single frame.
      const dimensions = await this.mediaDimensionsService.fromVideoFile(tempInput);

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

      const buffer = await sharp(frame)
        .resize(PREVIEW_MAX_DIMENSION, PREVIEW_MAX_DIMENSION, {
          fit: 'inside',
        })
        .jpeg({ quality: 80 })
        .toBuffer();

      return { buffer, dimensions };
    } finally {
      await fs.unlink(tempInput).catch(() => {});
      await fs.unlink(tempOutput).catch(() => {});
    }
  }
}

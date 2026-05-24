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
import { FileVariant } from '../types';

const PREVIEW_MAX_DIMENSION = 300;
const IMAGE_MIME_PREFIX = 'image/';
const VIDEO_MIME_PREFIX = 'video/';

@Injectable()
export class FilePreviewGenerationListener {
  constructor(
    private readonly fileService: FileService,
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

    let buffer: Buffer | null = null;

    if (file.contentType.startsWith(IMAGE_MIME_PREFIX)) {
      buffer = await this.generateImagePreview(context, fileWithKey);
    } else if (file.contentType.startsWith(VIDEO_MIME_PREFIX)) {
      buffer = await this.generateVideoPreview(context, fileWithKey);
    } else {
      this.logger.log('File type not supported, skipping preview generation', {
        fileId: payload.fileId,
        contentType: file.contentType,
      });

      return;
    }

    if (buffer == null) {
      this.logger.warn('Failed to generate preview, buffer is null', {
        fileId: payload.fileId,
      });

      return;
    }

    const preview = await this.fileService.create(context, {
      contentType: 'image/jpeg',
      size: buffer.length,
      variant: FileVariant.PREVIEW,
      buffer,
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
  ): Promise<Buffer> {
    const stream = await this.fileService.getFileStream(context, file.key);

    const transformer = sharp()
      .resize(PREVIEW_MAX_DIMENSION, PREVIEW_MAX_DIMENSION, {
        fit: 'inside',
      })
      .jpeg({
        quality: 80,
      });

    stream.pipe(transformer);

    return transformer.toBuffer();
  }

  private async generateVideoPreview(
    context: UserServiceContext,
    file: RequiredFields<File, 'key', true>,
  ): Promise<Buffer> {
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

      return sharp(frame)
        .resize(PREVIEW_MAX_DIMENSION, PREVIEW_MAX_DIMENSION, {
          fit: 'inside',
        })
        .jpeg({ quality: 80 })
        .toBuffer();
    } finally {
      await fs.unlink(tempInput).catch(() => {});
      await fs.unlink(tempOutput).catch(() => {});
    }
  }
}

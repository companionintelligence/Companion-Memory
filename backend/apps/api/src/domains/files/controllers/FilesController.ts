import { unlink } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { CAPTURE_SCOPE, RequireCapability, RequireScopes, WRITE_CAPABILITY } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { FileService } from '../services/FileService';
import { FileVariant } from '../types';

/** How far back a device's "I just made this" moment may plausibly sit (an outbox replay after a weekend offline). */
const CAPTURED_AT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** How far ahead, for a phone clock that runs a little fast. */
const CAPTURED_AT_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * The `capturedAt` form field as a Date, or undefined when it is missing,
 * unparseable, or not a moment a phone could honestly have just captured at —
 * more than 30 days back or more than five minutes ahead. An implausible
 * value is dropped rather than rejected: the upload itself is fine, it just
 * gets no device-asserted date (see UploadFileDto.capturedAt).
 */
export function parseCapturedAt(value: string | undefined, now = Date.now()): Date | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = new Date(value);
  const ms = parsed.getTime();

  if (Number.isNaN(ms) || ms < now - CAPTURED_AT_MAX_AGE_MS || ms > now + CAPTURED_AT_MAX_SKEW_MS) {
    return undefined;
  }

  return parsed;
}

@Controller('files')
export class FilesController {
  constructor(private readonly fileService: FileService) {}

  // Granted to `capture` keys: this is how Companion Capture and the browser
  // extension hand over screenshots and attachments. Empty-scope keys and
  // session/JWT callers are unaffected — deny-by-default only ever constrained
  // scope-limited keys, and before `capture` existed there was no scope that
  // reached this route at all.
  @UseGuards(JwtOrApiKeyAuthGuard)
  @RequireScopes(CAPTURE_SCOPE)
  @RequireCapability(WRITE_CAPABILITY)
  @Post('upload')
  @UseInterceptors(
    FilesInterceptor('files', undefined, {
      dest: tmpdir(),
      limits: { fileSize: 10 * 1024 * 1024 * 1024 },
    }),
  )
  async upload(
    @Context() context: RequestContext,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('thingCapture') thingCapture?: string | boolean,
    // DEPRECATED form field, kept for capture clients built against the retired
    // inventory feature. Remove once every shipped client posts `thingCapture`
    // (earliest: the release after this one).
    @Body('inventoryCapture') inventoryCapture?: string | boolean,
    @Body('skipDescription') skipDescription?: string | boolean,
    @Body('model') model?: string,
    // Companion Capture screenshot correlation (see FileService.create): a
    // direct eventId wins when the caller has one; captureTickId is the one
    // CI-Capture actually sends, resolved server-side against ci.events.
    @Body('eventId') eventId?: string,
    @Body('captureTickId') captureTickId?: string,
    // The phone's Capture sheet: catalogue the upload as content, not just a
    // file (see UploadFileDto.memoryCapture).
    @Body('memoryCapture') memoryCapture?: string | boolean,
    // When the phone's camera or recorder made the media (ISO 8601). Only
    // meaningful with memoryCapture; see UploadFileDto.capturedAt.
    @Body('capturedAt') capturedAt?: string,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    const capturedAtDate = parseCapturedAt(capturedAt);

    const shouldCaptureThing =
      thingCapture === true ||
      thingCapture === 'true' ||
      inventoryCapture === true ||
      inventoryCapture === 'true';
    const shouldSkipDescription = skipDescription === true || skipDescription === 'true';
    const shouldCatalogue = memoryCapture === true || memoryCapture === 'true';
    const selectedModel = typeof model === 'string' && model.trim().length > 0 ? model.trim() : undefined;
    const linkedEventId =
      typeof eventId === 'string' && eventId.trim().length > 0 ? eventId.trim() : undefined;
    const linkedCaptureTickId =
      typeof captureTickId === 'string' && captureTickId.trim().length > 0 ? captureTickId.trim() : undefined;

    const serviceContext = toServiceContext(context);

    try {
      const filesWithHashes = await Promise.all(
        files.map(async (file) => ({
          file,
          hash: await this.fileService.getFileHash({
            buffer: file.buffer,
            path: file.path,
          }),
        })),
      );

      const uniqueByHash = new Map<string, Express.Multer.File>();

      for (const { file, hash } of filesWithHashes) {
        if (hash && !uniqueByHash.has(hash)) {
          uniqueByHash.set(hash, file);
        } else if (!hash) {
          uniqueByHash.set(file.originalname + Date.now(), file);
        }
      }

      const entities = await Promise.all(
        Array.from(uniqueByHash.entries()).map(async ([, file]) => {
          return this.fileService.upload(serviceContext, {
            filename: file.originalname,
            contentType: file.mimetype,
            size: file.size,
            buffer: file.buffer,
            path: file.path,
            thingCapture: shouldCaptureThing,
            skipDescription: shouldSkipDescription,
            model: selectedModel,
            eventId: linkedEventId,
            captureTickId: linkedCaptureTickId,
            memoryCapture: shouldCatalogue,
            ...(shouldCatalogue && capturedAtDate ? { capturedAt: capturedAtDate } : {}),
          });
        }),
      );

      return entities.map((entity) => ({
        id: entity.id,
      }));
    } finally {
      for (const file of files) {
        if (file.path) {
          unlink(file.path, (err) => {
            if (err) {
              Logger.error(`Failed to delete temporary file ${file.path}`, FilesController.name);
            }
          });
        }
      }
    }
  }

  /**
   * Update a file's user-facing metadata. Capture sources that run their own
   * analysis (e.g. Companion Capture with a configured vision endpoint) call this to
   * write the title/description they generated, in place of the server's Ollama
   * image description.
   */
  // Capture agents set title/description on files they just uploaded, so this
  // travels with the upload grant rather than needing full authority.
  /**
   * The PREVIEW rendition of a file, streamed. What a phone's preview store
   * downloads for every photo and video in its synced search documents
   * (`preview_id` on the device record), one request per file, keyed by the
   * ORIGINAL's id so the key survives a re-rendered preview. A plain
   * authenticated GET rather than the signed object-store URL the GraphQL
   * `previewUrl` field returns: the phone reaches the appliance, not its
   * object store, and the bytes are small (16 kB on average).
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get(':id/preview')
  async preview(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const serviceContext = toServiceContext(context);
    const [preview] = await this.fileService.findVariantsByParentIds(
      serviceContext,
      [id],
      FileVariant.PREVIEW,
    );

    if (preview == null || preview.key == null) {
      throw new NotFoundException('No preview for this file');
    }

    const stream = await this.fileService.getFileStream(serviceContext, preview.key);

    // A preview is immutable under its key: a re-render is a new row. Private,
    // since the response is the caller's own data.
    res.setHeader('Cache-Control', 'private, max-age=86400');

    return new StreamableFile(stream, {
      type: preview.contentType ?? 'image/jpeg',
      length: preview.size ?? undefined,
    });
  }

  @UseGuards(JwtOrApiKeyAuthGuard)
  @RequireScopes(CAPTURE_SCOPE)
  @RequireCapability(WRITE_CAPABILITY)
  @Patch(':id')
  async update(
    @Context() context: RequestContext,
    @Param('id') id: string,
    @Body('title') title?: string,
    @Body('description') description?: string,
  ) {
    const data: { title?: string; description?: string } = {};
    if (typeof title === 'string') {
      data.title = title;
    }

    if (typeof description === 'string') {
      data.description = description;
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('At least one of title or description is required');
    }

    const updated = await this.fileService.update(toServiceContext(context), id, data);

    if (updated == null) {
      throw new NotFoundException('File not found');
    }

    return { id: updated.id };
  }
}

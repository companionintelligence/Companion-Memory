import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import sharp from 'sharp';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import { type File } from '../entities/FileEntity';
import { PreviewGeneratedEvent } from '../events';
import { FileVariant } from '../types';

import { FileService } from './FileService';
import { type MediaDimensions, MediaDimensionsService } from './MediaDimensionsService';

const PREVIEW_MAX_DIMENSION = 300;
const IMAGE_MIME_PREFIX = 'image/';
const VIDEO_MIME_PREFIX = 'video/';

type RequiredFields<T, K extends keyof T, NonNullable extends boolean = false> = Omit<T, K> & {
  [P in K]-?: NonNullable extends true ? Exclude<T[P], null | undefined> : T[P];
};

/**
 * The generated preview bytes plus the intrinsic dimensions of both the
 * preview and its source.
 */
interface PreviewResult {
  buffer: Buffer;
  previewDimensions: MediaDimensions;
  sourceDimensions: MediaDimensions | null;
}

/** Why a preview was not produced for a file that was otherwise reachable. */
export type PreviewSkipReason = 'file_not_found' | 'not_stored' | 'unsupported_content_type' | 'undecodable';

export type PreviewOutcome =
  | { outcome: 'generated'; previewId: string }
  | { outcome: 'exists'; previewId: string }
  | { outcome: 'skipped'; reason: PreviewSkipReason };

export interface GeneratePreviewInput {
  fileId: string;
  /**
   * When true, the capture source produced its own title/description, so the
   * downstream image-description pass is told to stand down.
   */
  skipDescription?: boolean;
  model?: string;
}

/**
 * Produces the 300px JPEG `PREVIEW` variant for one ORIGINAL image or video.
 *
 * Extracted from `FilePreviewGenerationListener` so the same generator serves
 * two callers: the upload path (the listener, on `FileUploadedEvent`) and the
 * `enrich.file_preview` pipeline stage, which is the backfill the upload path
 * never had — a file whose preview was lost (see the dedup note on
 * `FileService.create`) or that predates the listener had no way back in.
 *
 * The contract both callers rely on:
 *
 *  - IO failures (object storage) THROW. They are transient and worth the
 *    caller's retry (pg-boss for the listener, the ledger for the stage).
 *  - Decode failures return `skipped: 'undecodable'`. A corrupt JPEG or a
 *    container ffmpeg cannot read is a format gap; retrying it buys nothing.
 *  - A decode failure on a SHORT read still throws — the bytes that came back
 *    are not the bytes that were stored, so the decode result says nothing
 *    about the file.
 */
@Injectable()
export class FilePreviewService {
  constructor(
    private readonly fileService: FileService,
    private readonly mediaDimensionsService: MediaDimensionsService,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(FilePreviewService.name);
  }

  async generate(context: UserServiceContext, input: GeneratePreviewInput): Promise<PreviewOutcome> {
    const existingPreview = await this.fileService.findVariantByParentId(
      context,
      input.fileId,
      FileVariant.PREVIEW,
    );

    if (existingPreview) {
      this.logger.log('Preview already exists, skipping generation', {
        fileId: input.fileId,
        previewId: existingPreview.id,
      });

      return { outcome: 'exists', previewId: existingPreview.id };
    }

    const file = await this.fileService.findById(context, input.fileId);

    if (file == null) {
      this.logger.warn('File not found, skipping preview generation', { fileId: input.fileId });

      return { outcome: 'skipped', reason: 'file_not_found' };
    }

    if (file.bucket == null || file.key == null) {
      this.logger.log('File is not stored locally, skipping generation', { fileId: file.id });

      return { outcome: 'skipped', reason: 'not_stored' };
    }

    const fileWithKey = file as RequiredFields<typeof file, 'key', true>;

    let result: PreviewResult | null = null;

    if (file.contentType.startsWith(IMAGE_MIME_PREFIX)) {
      result = await this.generateImagePreview(context, fileWithKey);
    } else if (file.contentType.startsWith(VIDEO_MIME_PREFIX)) {
      result = await this.generateVideoPreview(context, fileWithKey);
    } else {
      this.logger.log('File type not supported, skipping preview generation', {
        fileId: input.fileId,
        contentType: file.contentType,
      });

      return { outcome: 'skipped', reason: 'unsupported_content_type' };
    }

    if (result == null) {
      // The generators return null for input they cannot decode; they have
      // already logged the file id, content type and the underlying message.
      this.logger.warn('No preview generated, skipping', {
        fileId: input.fileId,
        contentType: file.contentType,
      });

      return { outcome: 'skipped', reason: 'undecodable' };
    }

    // Record the source's intrinsic dimensions onto the ORIGINAL row so
    // EventMediaLoader (and the drawer "Dimensions" row) can surface them. A
    // targeted write that doesn't re-trigger preview generation or re-indexing.
    if (result.sourceDimensions != null) {
      await this.fileService.setDimensions(context, file.id, result.sourceDimensions);
    }

    const preview = await this.fileService.create(context, {
      contentType: 'image/jpeg',
      size: result.buffer.length,
      // Always known — captured from sharp's resolveWithObject. Lets the FE
      // thumbnail loader size the slot before the image decodes.
      width: result.previewDimensions.width,
      height: result.previewDimensions.height,
      variant: FileVariant.PREVIEW,
      buffer: result.buffer,
      parentId: file.id,
    });

    // `preview.generated` is registered on the `image-description` queue alone,
    // and that queue declares `policy: 'short'` — under which pg-boss's unique
    // index folds every KEYLESS job on the queue into one row
    // (COALESCE(singleton_key,'')) and discards the rest via ON CONFLICT DO
    // NOTHING, silently. The key is what keeps concurrent previews distinct,
    // and it matches ImageDescriptionBackfillListener's so a re-drive of a
    // preview already queued here is refused instead of described twice.
    await this.eventService.send(
      PreviewGeneratedEvent,
      {
        userId: context.userId,
        previewId: preview.id,
        model: input.model,
        skipDescription: input.skipDescription,
      },
      { singletonKey: `image-description:${preview.id}` },
    );

    this.logger.log('Generated preview', {
      fileId: input.fileId,
      previewId: preview.id,
    });

    return { outcome: 'generated', previewId: preview.id };
  }

  private async generateImagePreview(
    context: UserServiceContext,
    file: RequiredFields<File, 'key', true>,
  ): Promise<PreviewResult | null> {
    // Buffer the original once so the dimensions probe and the resize read the
    // same bytes (one object-storage fetch, and metadata is reliable on a
    // Buffer where it isn't on a partially-consumed stream).
    //
    // Deliberately OUTSIDE the try below: an object-storage read failure is
    // transient and worth the queue's retries, a decode failure is not. Same
    // split MediaDimensionsStage makes between `object_storage_read_failed`
    // and `probe_failed`.
    const original = Buffer.from(await this.fileService.getFileContent(context, file.key));
    const sourceDimensions = await this.mediaDimensionsService.fromImageBuffer(original);

    try {
      // failOn: 'error', not sharp's default 'warning'. Real phone JPEGs —
      // Samsung above all — routinely carry warning-level defects (stray bytes
      // before restart markers) that every viewer decodes fine; the default
      // turned ~8% of a sampled Takeout batch into failed preview jobs.
      const { data, info } = await sharp(original, { failOn: 'error' })
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
    } catch (err: unknown) {
      // A decode failure on bytes that are NOT the whole file says nothing
      // about the file: rethrow so the read is retried. `size` is a Postgres
      // bigint with no transformer, so TypeORM hands it back as a string;
      // Number() makes the comparison honest either way.
      const expected = file.size != null ? Number(file.size) : null;
      const truncated = expected != null && expected > 0 && original.length !== expected;

      if (truncated) {
        this.logger.warn('Image decode failed on a short read; retrying', {
          fileId: file.id,
          contentType: file.contentType,
          bytes: original.length,
          expectedBytes: expected,
          error: errorMessage(err),
        });

        throw err;
      }

      // The probe read the header even though the full decode failed; the
      // drawer's "Dimensions" row is the one thing a preview-less file can still
      // show.
      if (sourceDimensions != null) {
        await this.fileService.setDimensions(context, file.id, sourceDimensions);
      }

      this.logger.warn('Image decode failed, skipping preview generation', {
        fileId: file.id,
        contentType: file.contentType,
        bytes: original.length,
        error: errorMessage(err),
      });

      return null;
    }
  }

  private async generateVideoPreview(
    context: UserServiceContext,
    file: RequiredFields<File, 'key', true>,
  ): Promise<PreviewResult | null> {
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
      const sourceDimensions = await this.mediaDimensionsService.fromVideoFile(tempInput);

      // Extract a single frame. Classified the same way the image path is: a
      // container or codec ffmpeg cannot decode is a FORMAT gap — retrying it
      // three times and dead-lettering buys nothing — while the spool above and
      // the read below are IO and stay retryable, so they deliberately sit
      // outside this catch.
      try {
        await new Promise<void>((resolve, reject) => {
          ffmpeg(tempInput)
            .frames(1)
            .output(tempOutput)
            .on('end', () => resolve())
            .on('error', (err: Error) => reject(err))
            .run();
        });
      } catch (err: unknown) {
        this.logger.warn('Video frame extraction failed, skipping preview generation', {
          fileId: file.id,
          contentType: file.contentType,
          error: errorMessage(err),
        });

        // Dimensions survive a failed frame extract — fromVideoFile read them
        // off the spooled container above and returns null rather than throwing.
        if (sourceDimensions != null) {
          await this.fileService.setDimensions(context, file.id, sourceDimensions);
        }

        return null;
      }

      const frame = await fs.readFile(tempOutput);

      // ffmpeg already auto-rotates the extracted frame, so .rotate() is a
      // safety net for any orientation tag still on the JPEG bytes. Same
      // failOn: 'error' tolerance as the image path, and the same
      // skip-don't-throw contract: an undecodable extracted frame is a file
      // we cannot preview, not a job worth retrying three times and
      // dead-lettering.
      try {
        const { data, info } = await sharp(frame, { failOn: 'error' })
          .rotate()
          .resize(PREVIEW_MAX_DIMENSION, PREVIEW_MAX_DIMENSION, {
            fit: 'inside',
          })
          .jpeg({ quality: 80 })
          .toBuffer({ resolveWithObject: true });

        return {
          buffer: data,
          previewDimensions: { width: info.width, height: info.height },
          sourceDimensions,
        };
      } catch (err: unknown) {
        this.logger.warn('Video frame decode failed, skipping preview generation', {
          fileId: file.id,
          contentType: file.contentType,
          bytes: frame.length,
          error: errorMessage(err),
        });

        if (sourceDimensions != null) {
          await this.fileService.setDimensions(context, file.id, sourceDimensions);
        }

        return null;
      }
    } finally {
      await fs.unlink(tempInput).catch(() => {});
      await fs.unlink(tempOutput).catch(() => {});
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

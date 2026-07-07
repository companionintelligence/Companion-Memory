import { unlink } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { FileService } from '../services/FileService';

/** Hard per-request cap on the batch lane; enforced by Multer's maxCount. */
export const MAX_FILES_PER_BATCH = 50;

/** Per-file size ceiling on the batch lane (the single-file lane allows 10 GB). */
const MAX_BATCH_FILE_SIZE = 1024 * 1024 * 1024; // 1 GB

/**
 * One response entry per INPUT file, in input order — the load-bearing
 * improvement over `POST /files/upload`'s ambiguous `[{ id }]` (which returns
 * one entry per UNIQUE file, in hash order, so a bulk client can't map its
 * inputs to ids). `deduped: true` means this input did not create a new file:
 * either it repeated earlier content within the batch (both entries carry the
 * same id) or the content was already stored server-side (hash match).
 * `sha256` is null only for a file whose content could not be hashed.
 */
export interface BulkFileUploadResult {
  filename: string;
  sha256: string | null;
  id: string;
  deduped: boolean;
}

/**
 * Batch upload lane of the `/v1` bulk-ingest plane: `POST /v1/files`,
 * multipart field `files`, up to {@link MAX_FILES_PER_BATCH} files per request
 * (a 51st file is a 400 from Multer). Reuses the exact `POST /files/upload`
 * pipeline — hash-dedup, object storage, FileUploadedEvent fan-out (preview
 * generation, description) — via {@link FileService.uploadWithDedupInfo};
 * nothing about the single-file lane changes.
 *
 * Unlike `/files/upload`'s parallel Promise.all, unique files upload
 * SEQUENTIALLY: this is the bulk lane (up to 50 × 1 GB per request), so
 * predictable memory/socket use beats latency.
 */
@Controller('v1/files')
export class BulkFilesController {
  constructor(private readonly fileService: FileService) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @Post()
  @UseInterceptors(
    FilesInterceptor('files', MAX_FILES_PER_BATCH, {
      dest: tmpdir(),
      limits: { fileSize: MAX_BATCH_FILE_SIZE },
    }),
  )
  async upload(
    @Context() context: RequestContext,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('inventoryCapture') inventoryCapture?: string | boolean,
    @Body('skipDescription') skipDescription?: string | boolean,
    @Body('model') model?: string,
  ): Promise<BulkFileUploadResult[]> {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    // Same form-field coercions as POST /files/upload.
    const shouldCaptureInventory = inventoryCapture === true || inventoryCapture === 'true';
    const shouldSkipDescription = skipDescription === true || skipDescription === 'true';
    const selectedModel = typeof model === 'string' && model.trim().length > 0 ? model.trim() : undefined;

    const serviceContext = toServiceContext(context);

    try {
      // Hash every input up front so within-batch duplicates can be detected
      // and mapped to the first occurrence's id without re-uploading.
      const hashes = await Promise.all(
        files.map((file) =>
          this.fileService.getFileHash({
            buffer: file.buffer,
            path: file.path,
          }),
        ),
      );

      const results: BulkFileUploadResult[] = [];
      // hash → outcome of the first upload of that content in this batch.
      const uploadedByHash = new Map<string, { id: string; deduped: boolean }>();

      for (const [i, file] of files.entries()) {
        const hash = hashes[i];
        const priorInBatch = hash ? uploadedByHash.get(hash) : undefined;

        if (priorInBatch) {
          // Within-batch duplicate: same id as the first occurrence, no second
          // trip through the upload pipeline (matching /files/upload, which
          // uploads each unique hash once).
          results.push({ filename: file.originalname, sha256: hash, id: priorInBatch.id, deduped: true });
          continue;
        }

        const { file: entity, deduped } = await this.fileService.uploadWithDedupInfo(serviceContext, {
          filename: file.originalname,
          contentType: file.mimetype,
          size: file.size,
          buffer: file.buffer,
          path: file.path,
          inventoryCapture: shouldCaptureInventory,
          skipDescription: shouldSkipDescription,
          model: selectedModel,
        });

        if (hash) {
          uploadedByHash.set(hash, { id: entity.id, deduped });
        }

        results.push({ filename: file.originalname, sha256: hash, id: entity.id, deduped });
      }

      return results;
    } finally {
      // Multer wrote every part to tmpdir; clean up regardless of outcome
      // (same pattern as POST /files/upload).
      for (const file of files) {
        if (file.path) {
          unlink(file.path, (err) => {
            if (err) {
              Logger.error(`Failed to delete temporary file ${file.path}`, BulkFilesController.name);
            }
          });
        }
      }
    }
  }
}

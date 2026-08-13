import { unlink } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  Body,
  BadRequestException,
  Controller,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { CAPTURE_SCOPE, RequireCapability, RequireScopes, WRITE_CAPABILITY } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { FileService } from '../services/FileService';

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
    @Body('inventoryCapture') inventoryCapture?: string | boolean,
    @Body('skipDescription') skipDescription?: string | boolean,
    @Body('model') model?: string,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    const shouldCaptureInventory = inventoryCapture === true || inventoryCapture === 'true';
    const shouldSkipDescription = skipDescription === true || skipDescription === 'true';
    const selectedModel = typeof model === 'string' && model.trim().length > 0 ? model.trim() : undefined;

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
            inventoryCapture: shouldCaptureInventory,
            skipDescription: shouldSkipDescription,
            model: selectedModel,
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

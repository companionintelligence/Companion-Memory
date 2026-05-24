import { unlink } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  Body,
  BadRequestException,
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

@Controller('files')
export class FilesController {
  constructor(private readonly fileService: FileService) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
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
    @Body('model') model?: string,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    const shouldCaptureInventory = inventoryCapture === true || inventoryCapture === 'true';
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
}

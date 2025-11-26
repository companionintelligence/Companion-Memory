import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import type { RequestContext } from '@ci/common/types';

import { FileService } from '../services/FileService';

@Controller('files')
export class FilesController {
  constructor(private readonly fileService: FileService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(@Context() context: RequestContext) {
    return this.fileService.findAll(context);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Context() context: RequestContext, @Param('id') id: string) {
    return this.fileService.findOne(context, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/presign')
  @HttpCode(200)
  async getPresignedLink(@Context() context: RequestContext, @Param('id') id: string) {
    const url = await this.fileService.generatePresignedLink(context, id);

    return {
      url,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('upload')
  @UseInterceptors(FilesInterceptor('files', undefined, { limits: { fileSize: 10 * 1024 * 1024 * 1024 } }))
  async upload(
    @Context() context: RequestContext,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: Request,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    // Parse metadata array from FormData - each file can have its own metadata JSON string
    const metadataArray: Array<Record<string, unknown> | undefined> = [];
    const metadataField = req.body?.metadata;

    if (metadataField) {
      // Handle both single value and array
      const metadataValues = Array.isArray(metadataField) ? metadataField : [metadataField];
      metadataArray.push(
        ...metadataValues.map((meta: string) => {
          try {
            return meta ? JSON.parse(meta) : undefined;
          } catch {
            return undefined;
          }
        }),
      );
    }

    const results = await Promise.all(
      files.map((file, index) => this.fileService.upload(context, file, metadataArray[index])),
    );

    return results;
  }
}

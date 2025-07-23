import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

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
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 * 1024 } }))
  // Note that the literal 'file' is referencing the input with name `file` in a hypothetical form.
  // All other fields would show up in the `body` here.
  async upload(@Context() context: RequestContext, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    return this.fileService.upload(context, file);
  }
}

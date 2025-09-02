import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import type { RequestContext } from '@ci/common/types';
import { FileService } from '@ci/domains/files/services/FileService';

@Controller('mobile/files')
@UseGuards(JwtAuthGuard)
export class MobileFilesController {
  constructor(private readonly fileService: FileService) {}

  @Get()
  async listFiles(@Context() context: RequestContext, @Query('limit') limit?: string) {
    const files = await this.fileService.findAll(context);
    
    // Apply mobile-specific pagination if limit is provided
    const fileList = limit ? files.slice(0, parseInt(limit, 10)) : files;

    return {
      success: true,
      data: fileList.map(file => ({
        id: file.id,
        filename: file.name,
        size: file.size,
        mimeType: file.contentType,
      })),
      meta: {
        total: files.length,
        returned: fileList.length,
      },
    };
  }

  @Get(':id')
  async getFile(@Context() context: RequestContext, @Param('id') id: string) {
    const file = await this.fileService.findOne(context, id);

    return {
      success: true,
      data: {
        id: file.id,
        filename: file.name,
        size: file.size,
        mimeType: file.contentType,
      },
    };
  }

  @Post(':id/download-url')
  @HttpCode(200)
  async getDownloadUrl(@Context() context: RequestContext, @Param('id') id: string) {
    const url = await this.fileService.generatePresignedLink(context, id);

    return {
      success: true,
      data: {
        downloadUrl: url,
        expiresIn: 3600, // 1 hour
      },
    };
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { 
    limits: { 
      fileSize: 50 * 1024 * 1024 // 50MB limit for mobile uploads
    } 
  }))
  async uploadFile(@Context() context: RequestContext, @UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    const uploadedFile = await this.fileService.upload(context, file);

    return {
      success: true,
      data: {
        id: uploadedFile.id,
        filename: uploadedFile.name,
        size: uploadedFile.size,
        mimeType: uploadedFile.contentType,
      },
      message: 'File uploaded successfully',
    };
  }

  @Get('types/supported')
  getSupportedFileTypes() {
    return {
      success: true,
      data: {
        images: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
        documents: ['pdf', 'doc', 'docx', 'txt'],
        audio: ['mp3', 'wav', 'aac', 'm4a'],
        video: ['mp4', 'mov', 'avi', 'webm'],
      },
    };
  }
}
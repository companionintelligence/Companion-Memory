import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { ValidationPipe } from '@ci/common/pipes';
import { LoggerService } from '@ci/common/services';
import type { RequestContext } from '@ci/common/types';

import { MediaAnalysisService } from '../services/MediaAnalysisService';
import type { MediaAnalysisInput, MediaAnalysisResult } from '../types';

const mediaAnalysisSchema = z.object({
  model: z.optional(z.string()),
  analysisType: z
    .enum(['people', 'places', 'objects', 'comprehensive'])
    .default('comprehensive'),
  includeMetadata: z.boolean().default(true),
});

@Controller('llm/media')
export class MediaAnalysisController {
  private logger = new LoggerService(MediaAnalysisController.name);

  constructor(private readonly mediaAnalysisService: MediaAnalysisService) {}

  @UseGuards(AuthGuard('jwt'))
  @Post('analyze')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { 
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
    fileFilter: (req: any, file: any, cb: any) => {
      // Accept images, videos, and audio files
      const allowedMimeTypes = [
        'image/jpeg',
        'image/png', 
        'image/webp',
        'image/gif',
        'video/mp4',
        'video/webm',
        'video/quicktime',
        'audio/mpeg',
        'audio/wav',
        'audio/ogg',
        'audio/webm',
      ];
      
      if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new BadRequestException(`Unsupported file type: ${file.mimetype}`), false);
      }
    },
  }))
  async analyzeMedia(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(mediaAnalysisSchema)) input: MediaAnalysisInput,
    @UploadedFile() file: any,
  ): Promise<MediaAnalysisResult> {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    this.logger.log('Analyzing media file', {
      filename: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
      analysisType: input.analysisType,
    });

    try {
      const result = await this.mediaAnalysisService.analyzeMedia(
        context,
        file,
        input,
      );

      this.logger.log('Media analysis completed', {
        filename: file.originalname,
        analysisType: input.analysisType,
        itemsFound: result.analysis.people?.length + result.analysis.places?.length + result.analysis.objects?.length,
      });

      return result;
    } catch (error) {
      this.logger.error('Media analysis failed', {
        filename: file.originalname,
        error: error instanceof Error ? error.message : String(error),
      });
      
      throw new BadRequestException(
        `Media analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('analyze-url')
  @HttpCode(200)
  async analyzeMediaFromUrl(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(z.object({
      url: z.string().url(),
      ...mediaAnalysisSchema.shape,
    }))) input: MediaAnalysisInput & { url: string },
  ): Promise<MediaAnalysisResult> {
    this.logger.log('Analyzing media from URL', {
      url: input.url,
      analysisType: input.analysisType,
    });

    try {
      const result = await this.mediaAnalysisService.analyzeMediaFromUrl(
        context,
        input.url,
        input,
      );

      this.logger.log('URL media analysis completed', {
        url: input.url,
        analysisType: input.analysisType,
        itemsFound: result.analysis.people?.length + result.analysis.places?.length + result.analysis.objects?.length,
      });

      return result;
    } catch (error) {
      this.logger.error('URL media analysis failed', {
        url: input.url,
        error: error instanceof Error ? error.message : String(error),
      });
      
      throw new BadRequestException(
        `URL media analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}

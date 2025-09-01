import { BadRequestException, Controller, Post, Req, Res, UnauthorizedException, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ProxyService } from '@ci/common/services/ProxyService';
import type { RequestContext } from '@ci/common/types';
import config from '@ci/configuration';

// Common audio MIME types and extensions
const AUDIO_MIME_TYPES = [
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/flac',
  'audio/x-flac',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
];

const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.webm'];

@Controller('stt')
export class STTController {
  constructor(private readonly proxyService: ProxyService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  @UseInterceptors(FileInterceptor('file', { 
    limits: { 
      fileSize: 50 * 1024 * 1024 // 50MB limit for audio files
    }
  }))
  async convert(
    @Context() context: RequestContext, 
    @Req() req: Request, 
    @Res() res: Response
  ) {
    if (context.userId == null) {
      throw new UnauthorizedException();
    }

    // Check if file is provided when using multipart
    const isMultipart = req.headers['content-type']?.includes('multipart/form-data');
    if (isMultipart) {
      const file = (req as any).file;
      if (!file) {
        throw new BadRequestException('Audio file is required');
      }

      // Validate audio file type
      const isValidMimeType = AUDIO_MIME_TYPES.includes(file.mimetype);
      const hasValidExtension = AUDIO_EXTENSIONS.some(ext => 
        file.originalname.toLowerCase().endsWith(ext)
      );

      if (!isValidMimeType && !hasValidExtension) {
        throw new BadRequestException(
          `Invalid audio file format. Supported formats: ${AUDIO_EXTENSIONS.join(', ')}`
        );
      }
    }

    return this.proxyService.proxyRequest(req, res, `${config.services.stt.host}/stt`);
  }
}

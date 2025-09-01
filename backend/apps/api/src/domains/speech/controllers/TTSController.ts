import { BadRequestException, Controller, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ProxyService } from '@ci/common/services/ProxyService';
import type { RequestContext } from '@ci/common/types';
import config from '@ci/configuration';

@Controller('tts')
export class TTSController {
  constructor(private readonly proxyService: ProxyService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  convert(@Context() context: RequestContext, @Req() req: Request, @Res() res: Response) {
    if (context.userId == null) {
      throw new UnauthorizedException();
    }

    // Basic validation for TTS requests
    const isJsonContent = req.headers['content-type']?.includes('application/json');
    if (isJsonContent && (!req.body || typeof req.body.text !== 'string' || req.body.text.trim().length === 0)) {
      throw new BadRequestException('Text is required for text-to-speech conversion');
    }

    return this.proxyService.proxyRequest(req, res, `${config.services.tts.host}/tts`);
  }
}

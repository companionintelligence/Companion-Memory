import { Controller, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ProxyService } from '@ci/common/services/ProxyService';
import type { RequestContext } from '@ci/common/types';
import config from '@ci/configuration';

@Controller('stt')
export class STTController {
  constructor(private readonly proxyService: ProxyService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  convert(@Context() context: RequestContext, @Req() req: Request, @Res() res: Response) {
    if (context.userId == null) {
      throw new UnauthorizedException();
    }

    return this.proxyService.proxyRequest(req, res, `${config.services.stt.host}/stt`);
  }
}

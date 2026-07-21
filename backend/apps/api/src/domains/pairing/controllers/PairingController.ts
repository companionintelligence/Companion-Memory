import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { Context, type RequestContext } from '@ci/common/context';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';

import { PairingService } from '../services/PairingService';

const completePairingSchema = z.object({
  pairingToken: z.string().min(1),
});

@Controller('pairing')
export class PairingController {
  constructor(private readonly pairingService: PairingService) {}

  @Post('complete')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async complete(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(completePairingSchema)) body: z.infer<typeof completePairingSchema>,
  ): Promise<void> {
    if (!context.userId) {
      throw new BadRequestException('User context is missing.');
    }

    await this.pairingService.completePairing(body.pairingToken, context.userId);
  }
}

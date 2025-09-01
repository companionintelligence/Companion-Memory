import { Body, Controller, Post, UseGuards, HttpCode } from '@nestjs/common';
import { z } from 'zod';

import { ValidationPipe } from '@ci/common/pipes';
import { LoggerService } from '@ci/common/services';

import { InternalApiGuard } from '../guards/InternalApiGuard';

const tokenUpdateSchema = z.object({
  userId: z.string().uuid('Invalid user ID'),
  providerId: z.string().uuid('Invalid provider ID'),
  hasToken: z.boolean(),
});

type TokenUpdateDto = z.infer<typeof tokenUpdateSchema>;

@Controller('internal')
export class InternalController {
  private logger = new LoggerService(InternalController.name);

  @UseGuards(InternalApiGuard)
  @Post('oauth-tokens/update')
  @HttpCode(200)
  async updateTokenStatus(@Body(new ValidationPipe(tokenUpdateSchema)) body: TokenUpdateDto) {
    this.logger.log('OAuth token status update received from auth-broker', {
      userId: body.userId,
      providerId: body.providerId,
      hasToken: body.hasToken,
    });

    // TODO: Update user's OAuth provider connection status
    // This could trigger notifications, update UI states, etc.

    return { success: true };
  }
}

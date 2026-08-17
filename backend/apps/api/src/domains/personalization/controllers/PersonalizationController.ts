import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { PersonalizationService } from '../services/PersonalizationService';
import type { TrustMode } from '../types';

@UseGuards(JwtOrApiKeyAuthGuard)
@Controller('personalization')
export class PersonalizationController {
  constructor(private readonly personalizationService: PersonalizationService) {}

  @Get('profile')
  async getProfile(@Context() context: RequestContext) {
    const profile = await this.personalizationService.getProfile(context.userId!);

    return profile;
  }

  @Post('trust-mode')
  async updateTrustMode(@Context() context: RequestContext, @Body() body: { trustMode: TrustMode }) {
    const profile = await this.personalizationService.updateTrustMode(
      toServiceContext(context),
      body.trustMode,
    );

    return profile;
  }
}

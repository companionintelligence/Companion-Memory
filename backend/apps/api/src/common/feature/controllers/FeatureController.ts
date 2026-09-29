import { Controller, Get, HttpCode, UseGuards } from '@nestjs/common';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { FeatureService } from '../services/FeatureService';

@Controller('_internal')
export class FeatureController {
  constructor(private readonly featureService: FeatureService) {}

  /**
   * Any signed-in principal of this appliance. The phone holds an API key, not
   * a desktop session, and this map is what decides whether Jobs, Tasks, and
   * Profile exist. A session-only guard hid those pages on mobile.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('features')
  @HttpCode(200)
  async features() {
    const allFeatures = await this.featureService.getAllFeatures();

    return allFeatures;
  }

  /**
   * Unauthenticated on purpose: the SPA reads it before login. It answers with
   * the `PUBLIC_FEATURES` allowlist only — see FeatureService for why the full
   * map stayed behind the guard above.
   */
  @Get('features/global')
  @HttpCode(200)
  async globalFeatures() {
    return this.featureService.getPublicFeatures();
  }
}

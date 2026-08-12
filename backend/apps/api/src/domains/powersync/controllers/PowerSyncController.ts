import { Controller, Get, UseGuards } from '@nestjs/common';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { PowerSyncTokenService, type PowerSyncCredentials } from '../services/PowerSyncTokenService';

@Controller('powersync')
export class PowerSyncController {
  constructor(private readonly tokenService: PowerSyncTokenService) {}

  /**
   * Issues PowerSync credentials for the authenticated user. The client SDK calls
   * this from its `fetchCredentials()` connector.
   *
   * Accepts either a JWT session or an `x-api-key` (`JwtOrApiKeyAuthGuard`, the same
   * guard used across the rest of the API): the native app authenticates data calls
   * with an API key, so the token endpoint must accept one too for the mobile
   * PowerSync client to be able to fetch credentials at all.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('token')
  issueToken(@Context() context: RequestContext): PowerSyncCredentials {
    const { userId } = toServiceContext(context);

    return this.tokenService.issueToken(userId);
  }
}

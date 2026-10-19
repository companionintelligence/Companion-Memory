import { Controller, Get, HttpStatus, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import {
  POWERSYNC_NOT_CONFIGURED_BODY,
  PowerSyncTokenService,
  type PowerSyncCredentials,
  type PowerSyncNotConfigured,
} from '../services/PowerSyncTokenService';

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
   *
   * A deployment without a PowerSync service (every Marketplace install today)
   * answers 503 with `POWERSYNC_NOT_CONFIGURED_BODY`. That is set here rather than
   * thrown: it is the normal answer on those servers, and a thrown 503 goes through
   * GlobalExceptionsFilter, which logs it as an error and reports it to Sentry.
   */
  @UseGuards(JwtOrApiKeyAuthGuard)
  @Get('token')
  issueToken(
    @Context() context: RequestContext,
    @Res({ passthrough: true }) res: Response,
    @Query('cutoff') cutoff?: string,
  ): PowerSyncCredentials | PowerSyncNotConfigured {
    if (!this.tokenService.isConfigured()) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);

      return POWERSYNC_NOT_CONFIGURED_BODY;
    }

    const { userId } = toServiceContext(context);

    return this.tokenService.issueToken(userId, cutoff);
  }
}

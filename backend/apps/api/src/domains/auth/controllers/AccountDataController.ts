import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { BodyLimit, FULL_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { type ApiKeyScopedRequest, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import {
  PORTABILITY_NDJSON_CONTENT_TYPE,
  UserDataPortabilityService,
  isPortabilityNdjsonImport,
  type UserDataArchive,
} from '@ci/domains/portability';
import { UserService } from '@ci/domains/user';

import { isManagedAppPrincipal } from '../types';

const importArchiveSchema = z.object({
  confirmEmail: z.string().min(1),
  archive: z.object({
    version: z.literal(1),
    exportedAt: z.string(),
    userId: z.string().uuid(),
    profile: z.record(z.string(), z.unknown()).nullable(),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
    fileBlobs: z.array(
      z.object({
        id: z.string(),
        bucket: z.string(),
        key: z.string(),
        contentBase64: z.string(),
      }),
    ),
  }),
});

/** Replacing the whole account is the owner's act, never a connected app's. */
function refuseInstalledApp(req: ApiKeyScopedRequest): void {
  if (isManagedAppPrincipal({ managedBy: req.apiKeyManagedBy })) {
    throw new ForbiddenException("An installed app cannot replace this account's data");
  }
}

/**
 * Export / import the authenticated user's Memory data as a portable archive.
 *
 * Large accounts use NDJSON streaming (`application/x-ndjson`) so neither side
 * has to buffer the full archive in memory. Small legacy JSON import remains
 * available for older export files.
 *
 * Both import routes need `full` from an api key and refuse an installed app's
 * key outright. An import first DELETES every row the account owns in every
 * table it restores, so an archive with empty tables empties the account: that
 * is the destructive tier, not the `write` a POST gets by shape. Export is a GET
 * and stays at `read`.
 */
@Controller('account')
@UseGuards(JwtOrApiKeyAuthGuard)
export class AccountDataController {
  constructor(
    private readonly portabilityService: UserDataPortabilityService,
    private readonly userService: UserService,
  ) {}

  @Get('export')
  async export(@Context() context: RequestContext, @Res() res: Response): Promise<void> {
    const serviceContext = toServiceContext(context);
    await this.portabilityService.writeExportStream(serviceContext, res);
  }

  @Post('import/stream')
  @RequireCapability(FULL_CAPABILITY)
  @HttpCode(HttpStatus.OK)
  async importStream(
    @Context() context: RequestContext,
    @Req() req: ApiKeyScopedRequest,
    @Headers('x-confirm-email') confirmEmailHeader?: string,
  ) {
    refuseInstalledApp(req);

    if (!isPortabilityNdjsonImport(req)) {
      throw new BadRequestException(`Expected Content-Type: ${PORTABILITY_NDJSON_CONTENT_TYPE}`);
    }

    const confirmEmail = confirmEmailHeader?.trim();

    if (!confirmEmail) {
      throw new BadRequestException('Missing X-Confirm-Email header');
    }

    const serviceContext = toServiceContext(context);

    return this.portabilityService.importNdjsonStream(serviceContext, req, confirmEmail);
  }

  @Post('import')
  @RequireCapability(FULL_CAPABILITY)
  @BodyLimit('500mb')
  @HttpCode(HttpStatus.OK)
  async importLegacy(
    @Context() context: RequestContext,
    @Req() req: ApiKeyScopedRequest,
    @Body(new ValidationPipe(importArchiveSchema))
    body: z.infer<typeof importArchiveSchema>,
  ) {
    refuseInstalledApp(req);

    const serviceContext = toServiceContext(context);
    const user = await this.userService.findById(serviceContext, serviceContext.userId);

    if (!user) {
      throw new BadRequestException('Account not found');
    }

    if (body.confirmEmail.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
      throw new BadRequestException('Confirmation email does not match this account');
    }

    return this.portabilityService.importArchive(serviceContext, body.archive as UserDataArchive);
  }
}

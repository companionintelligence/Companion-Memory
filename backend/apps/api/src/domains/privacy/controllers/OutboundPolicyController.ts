import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod/v3';

import { Context, type RequestContext } from '@ci/common/context';
import { FULL_CAPABILITY, READ_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { ApplianceAdminGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { OUTBOUND_PATH_KEYS } from '@ci/common/outbound';
import { ValidationPipe } from '@ci/common/pipes';

import { OutboundPolicyService, type OutboundSettingsDto } from '../services/OutboundPolicyService';

const setOutboundSchema = z.object({
  key: z.enum(OUTBOUND_PATH_KEYS),
  enabled: z.boolean(),
});

type SetOutboundBody = z.infer<typeof setOutboundSchema>;

/**
 * The Settings -> Privacy card's REST surface: what leaves the appliance, and
 * the person's switch for each path.
 *
 * Appliance-wide, so changing a switch is gated like the Jobs control plane
 * ({@link ApplianceAdminGuard}); reading is open to any signed-in caller, with
 * `canEdit` answering the same rule so the page can grey a control out instead of
 * letting the click 403.
 */
@Controller('privacy/outbound')
export class OutboundPolicyController {
  constructor(
    private readonly outboundPolicyService: OutboundPolicyService,
    private readonly applianceAdminGuard: ApplianceAdminGuard,
  ) {}

  @UseGuards(JwtOrApiKeyAuthGuard)
  @RequireCapability(READ_CAPABILITY)
  @Get()
  async get(
    @Req() request: { user?: { role?: string }; portalPrincipal?: { admin: boolean } },
  ): Promise<OutboundSettingsDto & { canEdit: boolean }> {
    let canEdit = false;

    try {
      canEdit = await this.applianceAdminGuard.admits(request.user, request);
    } catch {
      // The admin probe fails closed: unknown means "no".
    }

    return { ...this.outboundPolicyService.get(), canEdit };
  }

  @UseGuards(JwtOrApiKeyAuthGuard, ApplianceAdminGuard)
  @RequireCapability(FULL_CAPABILITY)
  @Put()
  set(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(setOutboundSchema)) body: SetOutboundBody,
  ): Promise<OutboundSettingsDto> {
    return this.outboundPolicyService.set(body.key, body.enabled, context.userId);
  }
}

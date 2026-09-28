import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { READ_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { ModelTierRouter } from '../services/ModelTierRouter';
import type { RoutingDecision, TierProfile } from '../types';

const routingRequestSchema = z
  .object({
    estimatedInputTokens: z.number().int().nonnegative().optional(),
    reasoningLevel: z.enum(['light', 'moderate', 'deep']).optional(),
    toolDepth: z.number().int().nonnegative().optional(),
    requiresLargeContext: z.boolean().optional(),
    onDeviceContextTokens: z.number().int().positive().optional(),
    localOnly: z.boolean().optional(),
    cloudAvailable: z.boolean().optional(),
    forceTier: z.enum(['on_device', 'private_cloud']).optional(),
  })
  .strip();

/**
 * Exposes the on-device ↔ private-cloud routing decision so any agent (CI-Hermes,
 * CI-OpenClaw, a client) can ask "which tier should I run this task on?" before a
 * hard call — instead of unconditionally escalating to a third-party API.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
// Mounted without the `api/` prefix its public URL carries: the gateway strips
// `/api` before forwarding (nginx.conf `location /api/`), so a controller that
// bakes it in never matches. See CI-Server#1684 and
// common/__tests__/controllerGatewayPrefix.test.ts.
@Controller('model-routing')
export class ModelRoutingController {
  constructor(private readonly router: ModelTierRouter) {}

  /** The static tier profiles (on-device vs private-cloud). */
  @Get('tiers')
  getTiers(): { tiers: TierProfile[] } {
    return { tiers: this.router.getProfiles() };
  }

  /** Plan the tier for a task described by its characteristics. */
  // A POST because the body is a whole request description, but it only computes a
  // routing decision — nothing is stored. Say so, or the shape rule would demand `write`.
  @Post('plan')
  @RequireCapability(READ_CAPABILITY)
  plan(@Body() body: unknown): RoutingDecision {
    const parsed = routingRequestSchema.safeParse(body ?? {});

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }

    return this.router.decide(parsed.data);
  }
}

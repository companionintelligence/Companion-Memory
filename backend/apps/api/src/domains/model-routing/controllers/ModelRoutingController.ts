import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';

import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { ModelTierRouter } from '../services/ModelTierRouter';
import type { RoutingDecision, TierProfile } from '../types';

const routingRequestSchema = z
  .object({
    estimatedInputTokens: z.number().int().nonnegative().optional(),
    reasoningLevel: z.enum(['light', 'moderate', 'deep']).optional(),
    toolDepth: z.number().int().nonnegative().optional(),
    requiresLargeContext: z.boolean().optional(),
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
@Controller('api/model-routing')
export class ModelRoutingController {
  constructor(private readonly router: ModelTierRouter) {}

  /** The static tier profiles (on-device vs private-cloud). */
  @Get('tiers')
  getTiers(): { tiers: TierProfile[] } {
    return { tiers: this.router.getProfiles() };
  }

  /** Plan the tier for a task described by its characteristics. */
  @Post('plan')
  plan(@Body() body: unknown): RoutingDecision {
    const parsed = routingRequestSchema.safeParse(body ?? {});

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }

    return this.router.decide(parsed.data);
  }
}

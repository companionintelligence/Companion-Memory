import { BadRequestException, Body, Controller, Get, Optional, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod/v3';

import { Context, type RequestContext } from '@ci/common/context';
import { READ_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import {
  ContrastiveDecisionService,
  type ChoiceDecisionResult,
  type NoulDecisionResult,
  type RankDecisionResult,
  type ScoreDecisionResult,
} from '../services/ContrastiveDecisionService';
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

const engineEnum = z.enum(['auto', 'contrastive', 'generative', 'hybrid']).optional();

const noulDecisionSchema = z.object({
  primitive: z.literal('noul'),
  state: z.string().min(1),
  action: z.string().min(1),
  negatedAction: z.string().min(1).optional(),
  engine: engineEnum,
  temperature: z.number().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
  escalationMarginThreshold: z.number().min(0).max(1).optional(),
});

const choiceDecisionSchema = z.object({
  primitive: z.literal('choice'),
  state: z.string().min(1),
  candidates: z
    .array(z.union([z.string().min(1), z.object({ id: z.string().min(1), label: z.string().min(1) })]))
    .min(1),
  engine: engineEnum,
  temperature: z.number().positive().optional(),
  escalationMarginThreshold: z.number().min(0).max(1).optional(),
});

const scoreDecisionSchema = z.object({
  primitive: z.literal('score'),
  state: z.string().min(1),
  criteria: z
    .array(
      z.object({
        name: z.string().min(1),
        positive: z.string().min(1),
        negative: z.string().min(1).optional(),
        weight: z.number().positive().optional(),
      }),
    )
    .min(1),
  engine: engineEnum,
  temperature: z.number().positive().optional(),
});

const decideRequestSchema = z.discriminatedUnion('primitive', [
  noulDecisionSchema,
  choiceDecisionSchema,
  scoreDecisionSchema,
]);

const rankRequestSchema = z
  .object({
    query: z.string().min(1),
    candidates: z
      .array(
        z.object({
          id: z.string().min(1),
          text: z.string().min(1),
          metadata: z.record(z.unknown()).optional(),
        }),
      )
      .min(1),
    topK: z.number().int().positive().optional(),
    engine: engineEnum,
    temperature: z.number().positive().optional(),
  })
  .strip();

/**
 * Exposes the on-device ↔ private-cloud routing decision so any agent (CI-Hermes,
 * CI-OpenClaw, a client) can ask "which tier should I run this task on?" before a
 * hard call — instead of unconditionally escalating to a third-party API.
 *
 * Also exposes the dual-engine Contrastive ("System 1", `CLM` pattern) +
 * Generative ("System 2") decision and reranking endpoints (`/model-routing/decide`,
 * `/model-routing/rank`, `/model-routing/arena`).
 */
@UseGuards(JwtOrApiKeyAuthGuard)
// Mounted without the `api/` prefix its public URL carries: the gateway strips
// `/api` before forwarding (nginx.conf `location /api/`), so a controller that
// bakes it in never matches. See CI-Server#1684 and
// common/__tests__/controllerGatewayPrefix.test.ts.
@Controller('model-routing')
export class ModelRoutingController {
  constructor(
    private readonly router: ModelTierRouter,
    @Optional()
    private readonly decisionService: ContrastiveDecisionService = new ContrastiveDecisionService(),
  ) {}

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

  /**
   * Execute a fast Contrastive (`CLM` System 1) or Generative (System 2)
   * decision primitive (`noul`, `choice`, or `score`).
   */
  @Post('decide')
  @RequireCapability(READ_CAPABILITY)
  async decide(
    @Context() context: RequestContext,
    @Body() body: unknown,
  ): Promise<NoulDecisionResult | ChoiceDecisionResult | ScoreDecisionResult> {
    const parsed = decideRequestSchema.safeParse(body ?? {});

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }

    const data = parsed.data;
    const userId = context?.userId;

    switch (data.primitive) {
      case 'noul':
        return this.decisionService.noul(data.state, data.action, {
          userId,
          negatedAction: data.negatedAction,
          engine: data.engine,
          temperature: data.temperature,
          threshold: data.threshold,
          escalationMarginThreshold: data.escalationMarginThreshold,
        });
      case 'choice':
        return this.decisionService.choice(data.state, data.candidates, {
          userId,
          engine: data.engine,
          temperature: data.temperature,
          escalationMarginThreshold: data.escalationMarginThreshold,
        });
      case 'score':
        return this.decisionService.score(data.state, data.criteria, {
          userId,
          engine: data.engine,
          temperature: data.temperature,
        });
    }
  }

  /**
   * Rerank candidate intents, tools, or memory fragments against a query using
   * the ActionVectorArena (`Contrastive-LM/CLM` pattern) and/or Generative
   * reranker according to user settings.
   */
  @Post('rank')
  @RequireCapability(READ_CAPABILITY)
  async rank(@Context() context: RequestContext, @Body() body: unknown): Promise<RankDecisionResult> {
    const parsed = rankRequestSchema.safeParse(body ?? {});

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }

    const data = parsed.data;

    return this.decisionService.rank(data.query, data.candidates, {
      userId: context?.userId,
      topK: data.topK,
      engine: data.engine,
      temperature: data.temperature,
    });
  }

  /** Inspect the ActionVectorArena cache size. */
  @Get('arena')
  getArena(): { size: number } {
    return this.decisionService.getArenaStats();
  }
}

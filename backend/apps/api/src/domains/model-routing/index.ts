/**
 * Model-tier routing — the on-device ↔ private-cloud escalation decision.
 *
 * Decides the cheapest model tier that can handle a task, lets privacy pin a task
 * on-device, and falls back gracefully when the escalated tier is unavailable.
 * Exposed at `POST /api/model-routing/plan`.
 *
 * @module ModelRoutingModule
 */

import { Module } from '@nestjs/common';

import { ModelRoutingController } from './controllers/ModelRoutingController';
import { ModelTierRouter } from './services/ModelTierRouter';

@Module({
  controllers: [ModelRoutingController],
  providers: [ModelTierRouter],
  exports: [ModelTierRouter],
})
export class ModelRoutingModule {}

export { ModelTierRouter, TIER_PROFILES } from './services/ModelTierRouter';
export type { ModelTier, ReasoningLevel, RoutingDecision, RoutingRequest, TierProfile } from './types';

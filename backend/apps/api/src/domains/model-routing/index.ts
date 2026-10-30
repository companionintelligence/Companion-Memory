/**
 * Model-tier routing — the on-device ↔ private-cloud escalation decision, plus
 * the dual-engine Contrastive ("System 1", `CLM` pattern) + Generative
 * ("System 2") decision and reranking layer.
 *
 * CI's analogue of Apple's Foundation Models tiering (`SystemLanguageModel` vs
 * `PrivateCloudComputeLanguageModel`). Decides the cheapest tier that can handle a
 * task, lets privacy pin a task on-device, and falls back gracefully when the
 * escalated tier is unavailable. Exposed at `POST /api/model-routing/plan`,
 * `POST /api/model-routing/decide`, and `POST /api/model-routing/rank`.
 *
 * @module ModelRoutingModule
 */

import { Module } from '@nestjs/common';

import { EmbeddingModule } from '@ci/common/embeddings';
import { MemoryModule } from '@ci/domains/memory';

import { ModelRoutingController } from './controllers/ModelRoutingController';
import {
  ActionVectorArena,
  ContrastiveDecisionService,
  cosineSimilarity,
  deterministicTextEmbedding,
  normalizeVector,
  type ChoiceCandidateScore,
  type ChoiceDecisionResult,
  type DecisionEngineMode,
  type DecisionEngineUsed,
  type DecisionOptions,
  type GenerativeDecisionEvaluator,
  type NoulDecisionResult,
  type RankCandidateInput,
  type RankDecisionResult,
  type RankedCandidate,
  type ScoreCriterion,
  type ScoreCriterionResult,
  type ScoreDecisionResult,
} from './services/ContrastiveDecisionService';
import { ModelTierRouter, TIER_PROFILES } from './services/ModelTierRouter';
import type { ModelTier, ReasoningLevel, RoutingDecision, RoutingRequest, TierProfile } from './types';

@Module({
  imports: [EmbeddingModule, MemoryModule],
  controllers: [ModelRoutingController],
  providers: [ModelTierRouter, ContrastiveDecisionService],
  exports: [ModelTierRouter, ContrastiveDecisionService],
})
export class ModelRoutingModule {}

export {
  ActionVectorArena,
  ContrastiveDecisionService,
  cosineSimilarity,
  deterministicTextEmbedding,
  ModelTierRouter,
  normalizeVector,
  TIER_PROFILES,
};
export type {
  ChoiceCandidateScore,
  ChoiceDecisionResult,
  DecisionEngineMode,
  DecisionEngineUsed,
  DecisionOptions,
  GenerativeDecisionEvaluator,
  ModelTier,
  NoulDecisionResult,
  RankCandidateInput,
  RankDecisionResult,
  RankedCandidate,
  ReasoningLevel,
  RoutingDecision,
  RoutingRequest,
  ScoreCriterion,
  ScoreCriterionResult,
  ScoreDecisionResult,
  TierProfile,
};

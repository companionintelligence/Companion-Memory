/**
 * The appliance's retrieval policy: the knobs that decide what search returns,
 * versioned in `ci.retrieval_policy` instead of frozen into module-level
 * `const`s.
 *
 * Read by `SearchService` (ts_rank weights, embedding boost, semantic distance
 * floor and LIMIT) and `RecallService` (message-channel K and floor, seed mode,
 * grounded similarity floor, anchored depth multiplier). Both fail open to the
 * compiled-in {@link RETRIEVAL_POLICY_DEFAULTS} when the table is empty or
 * unreachable, so an appliance that has never run the migration behaves exactly
 * as it did before this module existed.
 *
 * @module RetrievalPolicyModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RetrievalPolicyEntity } from './entities/RetrievalPolicyEntity';
import { RetrievalPolicyService } from './services/RetrievalPolicyService';

/**
 * @internal
 */
@Module({
  imports: [TypeOrmModule.forFeature([RetrievalPolicyEntity])],
  providers: [RetrievalPolicyService],
  exports: [RetrievalPolicyService],
})
export class RetrievalPolicyModule {}

export { RetrievalPolicyEntity, RetrievalPolicyService };
export { POLICY_CACHE_TTL_MS } from './services/RetrievalPolicyService';
export {
  RETRIEVAL_POLICY_DEFAULTS,
  RETRIEVAL_SEED_MODES,
  sqlNumberLiteral,
  tsRankWeightsLiteral,
} from './constants';
export type { RetrievalPolicy, RetrievalSeedMode, TsRankWeights } from './constants';

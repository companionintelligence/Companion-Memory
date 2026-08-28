/**
 * The interpersonal **Ask** domain — Phase 0 of the federated ask / decentralized
 * trust graph (CI-Server #1711 → epic #1712).
 *
 * An Ask is a bounded question one user directs at another user's Companion
 * memory. This module owns the ask lifecycle ({@link AskService}), the standing
 * consent grants that gate it ({@link GrantService}), and the per-ask audit log
 * ({@link AskAuditService}). The consent decision and the lifecycle state machine
 * are pure functions ({@link evaluateGrant}, {@link assertAskTransition}) so the
 * security-critical rules are testable without a database.
 *
 * Phase 0 is intra-Hub (multi-user, single box) and returns raw owner-scoped
 * results behind the `ask` feature flag for internal dogfood only — synthesized,
 * disclosure-filtered answers are Epic 1.
 *
 * @module AsksModule
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SearchNextModule } from '@ci/domains/search-next';
import { UserEntity } from '@ci/domains/user';

import { AskExpiryCron } from './cron/AskExpiryCron';
import { AskAnswerEntity } from './entities/AskAnswerEntity';
import { AskAuditEntity } from './entities/AskAuditEntity';
import { AskBroadcastEntity } from './entities/AskBroadcastEntity';
import { AskEntity } from './entities/AskEntity';
import { AskGrantEntity } from './entities/AskGrantEntity';
import { HouseholdTierEntity } from './entities/HouseholdTierEntity';
import { AskAnswerService } from './services/AskAnswerService';
import { AskAuditService } from './services/AskAuditService';
import { AskBroadcastService } from './services/AskBroadcastService';
import { AskExecutorService } from './services/AskExecutorService';
import { AskExpiryService } from './services/AskExpiryService';
import { AskRateLimitService } from './services/AskRateLimitService';
import { AskService } from './services/AskService';
import { GrantService } from './services/GrantService';
import { HouseholdTierService } from './services/HouseholdTierService';
import { SharedSearchConsentService } from './services/SharedSearchConsentService';

/**
 * @internal
 */
@Module({
  imports: [
    // UserEntity is registered read-only: AskService probes it to refuse an ask
    // aimed at an account that does not exist, WITHOUT letting the FK violation
    // answer that question for an attacker.
    TypeOrmModule.forFeature([
      AskEntity,
      AskGrantEntity,
      AskAuditEntity,
      AskAnswerEntity,
      HouseholdTierEntity,
      AskBroadcastEntity,
      UserEntity,
    ]),
    SearchNextModule,
  ],
  providers: [
    AskService,
    GrantService,
    AskAuditService,
    AskRateLimitService,
    AskExecutorService,
    AskAnswerService,
    AskExpiryService,
    SharedSearchConsentService,
    HouseholdTierService,
    AskBroadcastService,
    // Registered as a provider so its @Cron method is discovered by the
    // scheduler; nothing injects it, so it is deliberately NOT exported.
    AskExpiryCron,
  ],
  exports: [
    AskService,
    GrantService,
    AskAuditService,
    AskRateLimitService,
    AskExecutorService,
    AskAnswerService,
    AskExpiryService,
    SharedSearchConsentService,
    HouseholdTierService,
    AskBroadcastService,
  ],
})
export class AsksModule {}

export {
  AskEntity,
  AskGrantEntity,
  AskAuditEntity,
  AskAnswerEntity,
  HouseholdTierEntity,
  AskBroadcastEntity,
};
export {
  AskService,
  GrantService,
  AskAuditService,
  AskRateLimitService,
  AskExecutorService,
  AskAnswerService,
  AskExpiryService,
  SharedSearchConsentService,
  HouseholdTierService,
  AskBroadcastService,
};
export {
  MAX_BROADCAST_RECIPIENTS,
  MIN_BROADCAST_RECIPIENTS,
  normalizeRecipients,
} from './services/AskBroadcastService';
export type { BroadcastMember } from './services/AskBroadcastService';
export type { AskBroadcast } from './entities/AskBroadcastEntity';
export { DEFAULT_HOUSEHOLD_TIER } from './services/HouseholdTierService';
export type { HouseholdTier } from './entities/HouseholdTierEntity';
export {
  SAVED_SEARCH_RESOURCE,
  SHARE_QUERY_TYPE,
  shareAuditQuery,
} from './services/SharedSearchConsentService';
export type { ShareAuthorization } from './services/SharedSearchConsentService';
export { SHARE_DISCLOSURE, applySearchCeiling, ceilingForShare } from './searchCeiling';
export type { ClampableConnection, ShareDisclosure } from './searchCeiling';
export { evaluateGrant, canonicalDataClass, canonicalQueryType, isGrantActive } from './grantMatch';
export { TRUST_TIERS } from './types';
export { checkSlidingWindow } from './rateLimit';
export {
  DEFAULT_WINDOW_MS,
  UNATTRIBUTED,
  counterpartyOf,
  recentShare,
  summarizeDisclosures,
} from './disclosureSummary';
export type { DisclosureCounterparty, DisclosureSummary } from './disclosureSummary';
export { MAX_AUDIT_ROWS } from './services/AskAuditService';
export type { AuditFilter, GrantUsage, ListedAudit } from './services/AskAuditService';
export {
  MAX_ASK_DATA_CLASS_LENGTH,
  MAX_ASK_PROMPT_LENGTH,
  parseAskDataClass,
  parseAskPrompt,
  parseAskQueryInput,
  parseAskQueryType,
  parseAskActor,
  parseDisclosureRung,
  parseGrantQueryType,
  ASK_ACTOR_KINDS,
  MAX_ACTOR_LABEL_LENGTH,
} from './askInput';
export { ASK_TTL_HOURS_ENV_VAR, DEFAULT_ASK_TTL_HOURS, askTtlHours, defaultAskExpiry } from './askDeadline';
export { inferAnswerForm, buildDisclosedAnswer, formDisclosesItems, countFreeSummary } from './disclosure';
export {
  DISCLOSURE_RUNGS,
  applyDisclosureCeiling,
  disclosureCeiling,
  minRung,
  narrowerForm,
  narrowestRung,
  rungAtLeast,
  rungForForm,
} from './policy';
export {
  ASK_ARCHETYPES,
  askGrammarSchema,
  dataClassesIn,
  formForArchetype,
  parseAskGrammar,
  toAskQuery,
} from './askGrammar';
export type { AskArchetype, AskGrammar, AskQuerySpec, ClaimQuery } from './askGrammar';
export {
  ASK_TRANSITIONS,
  TERMINAL_ASK_STATUSES,
  assertAskTransition,
  canTransitionAsk,
  isAnswerable,
  isTerminalAskStatus,
  IllegalAskTransitionError,
} from './askStatus';

export type { Ask } from './entities/AskEntity';
export type { AskGrant } from './entities/AskGrantEntity';
export type { AskAudit } from './entities/AskAuditEntity';
export type { AskAnswer } from './entities/AskAnswerEntity';
export type {
  AskStatus,
  AskAuditOutcome,
  GrantMode,
  GrantDecision,
  GrantRevocationReason,
  AskQuery,
  AskGrantScope,
  GrantEvaluation,
  CreateAskDto,
  AskChannelProvenance,
  CreateAskGrantDto,
  UpdateAskGrantDto,
  RecordAskAuditDto,
  AnswerForm,
  AnswerSource,
  DisclosedItem,
  DisclosedAnswer,
  CreateAskAnswerDto,
  TrustTier,
  DisclosureRung,
  AskGrantResourceType,
  AskDelegation,
  AskActor,
  AskActorKind,
} from './types';

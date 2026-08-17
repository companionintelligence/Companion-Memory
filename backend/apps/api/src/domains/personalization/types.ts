import { z } from 'zod';

export const TRUST_MODES = ['cautious', 'balanced', 'hands_off'] as const;
export type TrustMode = (typeof TRUST_MODES)[number];

export const TrustModeSchema = z.enum(TRUST_MODES);

export const PERSONALIZATION_ACTION_KINDS = [
  'graph_edge',
  'graph_entity',
  'schedule_accept',
  'inferred_fact',
  'agent_write',
  'feed_action',
  'memory_compaction',
  'insights_generation',
] as const;

export type PersonalizationActionKind = (typeof PERSONALIZATION_ACTION_KINDS)[number];

export type PersonalizationDecision = 'auto' | 'review' | 'skip';

export interface PersonalizationProfile {
  readonly trustMode: TrustMode;
  readonly autoPromoteThreshold: number;
  readonly autoSchedule: boolean;
  readonly requireReviewForUserInput: boolean;
  readonly feedActionLimit: number;
  readonly insightVolumeMultiplier: number;
}

export interface DecideActionInput {
  readonly kind: PersonalizationActionKind;
  readonly confidence: number;
  readonly hasUserInput?: boolean;
}

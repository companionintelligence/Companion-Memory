import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { type UserServiceContext } from '@ci/common/context';
import config from '@ci/configuration';
import { PersonService, UserContextService, ensureSelfEntityId } from '@ci/domains/memory';

import {
  type DecideActionInput,
  type PersonalizationActionKind,
  type PersonalizationDecision,
  type PersonalizationProfile,
  type TrustMode,
} from '../types';

const DEFAULT_TRUST_MODE: TrustMode = 'balanced';

/**
 * Below this confidence, always ask the user before applying (all trust
 * modes) — env-configurable, see `config.reflection.alwaysReviewBelowConfidence`
 * (`CI_REFLECTION_ALWAYS_REVIEW_BELOW_CONFIDENCE`).
 */
export const ALWAYS_REVIEW_BELOW_CONFIDENCE = config.reflection.alwaysReviewBelowConfidence;

const GRAPH_CONNECTION_KINDS = new Set<PersonalizationActionKind>([
  'graph_edge',
  'graph_entity',
  // Same trust family as graph identity work: cautious/balanced → review; hands_off may auto.
  'person_self_merge',
]);

const PLANNING_ACTION_KINDS = new Set<PersonalizationActionKind>([
  'task_create',
  'task_mutate',
  'task_complete',
  'event_revise',
  'schedule_accept',
]);

/**
 * Confidence at/above which `task_complete` auto-applies in balanced mode.
 * Deliberately decoupled from `autoPromoteThreshold` — see `TodoProcessService`
 * (`ATTRIBUTED_DONE_CONFIDENCE`, 0.8), which is only ever reported for
 * completion evidence that names the task and postdates its calendar block,
 * and is picked to sit below this bar so completing a task (and marking its
 * block done) still asks for confirmation in the default trust mode; only
 * hands_off's lower threshold (0.7) auto-applies it.
 *
 * `autoPromoteThresholdBalanced` was lowered from 0.85 to 0.55 for the
 * reflection-answer use case (see its schema comment) — completing a task is
 * a different, less reversible action than writing an inferred answer, so it
 * keeps the original bar rather than sharing that lower one.
 */
const TASK_COMPLETE_AUTO_PROMOTE_THRESHOLD_BALANCED = 0.85;

@Injectable()
export class PersonalizationService {
  private readonly profileCache = new Map<string, { profile: PersonalizationProfile; expiresAt: number }>();

  constructor(
    private readonly personService: PersonService,
    private readonly userContextService: UserContextService,
    /**
     * For `SELF_ENTITY_PROVISIONER`, resolved lazily by `ensureSelfEntityId`.
     * Optional so a hand-built service (the unit tests) still constructs; without
     * it a user who has no self entity gets the old error rather than a new one.
     */
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  invalidateCache(userId: string): void {
    this.profileCache.delete(userId);
  }

  async getProfile(userId: string): Promise<PersonalizationProfile> {
    const cached = this.profileCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.profile;
    }

    const context = { userId } as UserServiceContext;
    const selfIdentity = await this.userContextService.getSelfIdentity(userId);
    if (!selfIdentity) {
      return PersonalizationService.profileForTrustMode(DEFAULT_TRUST_MODE);
    }

    const self = await this.personService.findById(context, selfIdentity.entityId);
    const planner = (self?.properties?.planner ?? {}) as Record<string, unknown>;
    const rawTrust = planner.trust_mode;
    const trustMode: TrustMode =
      rawTrust === 'cautious' || rawTrust === 'balanced' || rawTrust === 'hands_off'
        ? rawTrust
        : DEFAULT_TRUST_MODE;

    const profile = PersonalizationService.profileForTrustMode(trustMode);
    this.profileCache.set(userId, { profile, expiresAt: Date.now() + 60_000 });

    return profile;
  }

  async getTrustMode(userId: string): Promise<TrustMode> {
    return (await this.getProfile(userId)).trustMode;
  }

  async updateTrustMode(context: UserServiceContext, trustMode: TrustMode): Promise<PersonalizationProfile> {
    // Provisioned when the user has none: an imported account has no self entity
    // to store the dial on, so Settings → Autonomy could not be saved at all (a
    // 500). Only this WRITE provisions; `getProfile` still answers the default
    // for a user with no self entity, without creating one.
    const selfEntityId = await ensureSelfEntityId(context, this.userContextService, this.moduleRef);

    const self = await this.personService.findById(context, selfEntityId);
    if (!self) {
      throw new Error('Self entity not found');
    }

    // Write the two leaves we own, never the whole `planner` sub-object: a
    // read-modify-write of `planner` here loses whatever another writer (e.g.
    // ImageDescriptionPreferenceService) committed to a different leaf in
    // between our read and our write.
    await this.personService.patchPropertyLeaves(context, self.id, [
      { path: ['planner', 'trust_mode'], value: trustMode },
      { path: ['planner', 'source'], value: 'settings' },
    ]);
    this.invalidateCache(context.userId!);

    return PersonalizationService.profileForTrustMode(trustMode);
  }

  async decideAction(userId: string, input: DecideActionInput): Promise<PersonalizationDecision> {
    const profile = await this.getProfile(userId);

    return PersonalizationService.decide(profile, input);
  }

  static profileForTrustMode(trustMode: TrustMode): PersonalizationProfile {
    switch (trustMode) {
      case 'cautious':
        return {
          trustMode,
          autoPromoteThreshold: config.reflection.autoPromoteThresholdCautious,
          autoSchedule: false,
          requireReviewForUserInput: true,
          feedActionLimit: 50,
          insightVolumeMultiplier: 0.5,
        };
      case 'hands_off':
        return {
          trustMode,
          autoPromoteThreshold: config.reflection.autoPromoteThresholdHandsOff,
          autoSchedule: true,
          requireReviewForUserInput: false,
          feedActionLimit: 10,
          insightVolumeMultiplier: 1.5,
        };
      case 'balanced':
      default:
        return {
          trustMode,
          autoPromoteThreshold: config.reflection.autoPromoteThresholdBalanced,
          autoSchedule: false,
          requireReviewForUserInput: false,
          feedActionLimit: 25,
          insightVolumeMultiplier: 1,
        };
    }
  }

  static decide(profile: PersonalizationProfile, input: DecideActionInput): PersonalizationDecision {
    const { kind, confidence, hasUserInput = true } = input;
    const isGraphConnection = GRAPH_CONNECTION_KINDS.has(kind);
    const isLowConfidence = confidence < ALWAYS_REVIEW_BELOW_CONFIDENCE;

    if (isLowConfidence && hasUserInput) {
      return 'review';
    }

    if (profile.trustMode === 'cautious') {
      if (kind === 'insights_generation' || kind === 'feed_action') {
        return confidence >= profile.autoPromoteThreshold ? 'auto' : 'skip';
      }

      // Planning kinds always surface for review in cautious — never silent skip.
      if (PLANNING_ACTION_KINDS.has(kind)) {
        return 'review';
      }

      return hasUserInput ? 'review' : 'skip';
    }

    if (profile.trustMode === 'hands_off') {
      if (kind === 'schedule_accept' && !profile.autoSchedule) {
        return confidence >= 0.9 ? 'auto' : 'review';
      }

      return confidence >= profile.autoPromoteThreshold ? 'auto' : 'review';
    }

    // balanced — never auto-apply graph connections; only hands_off does at lower confidence.
    if (isGraphConnection) {
      return 'review';
    }

    if (kind === 'schedule_accept') {
      return profile.autoSchedule && confidence >= 0.9 ? 'auto' : 'review';
    }

    if (kind === 'inferred_fact' || PLANNING_ACTION_KINDS.has(kind)) {
      const threshold =
        kind === 'task_complete'
          ? TASK_COMPLETE_AUTO_PROMOTE_THRESHOLD_BALANCED
          : profile.autoPromoteThreshold;

      return confidence >= threshold ? 'auto' : 'review';
    }

    if (confidence >= profile.autoPromoteThreshold) {
      return 'auto';
    }

    return kind === 'insights_generation' || kind === 'feed_action' ? 'skip' : 'review';
  }

  static thresholdForKind(profile: PersonalizationProfile, kind: PersonalizationActionKind): number {
    if (GRAPH_CONNECTION_KINDS.has(kind) && profile.trustMode !== 'hands_off') {
      return 1;
    }

    if (kind === 'schedule_accept') {
      return profile.autoSchedule ? 0.7 : 0.95;
    }

    if (kind === 'task_complete' && profile.trustMode === 'balanced') {
      return TASK_COMPLETE_AUTO_PROMOTE_THRESHOLD_BALANCED;
    }

    return profile.autoPromoteThreshold;
  }
}

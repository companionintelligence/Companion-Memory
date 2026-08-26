import { Injectable } from '@nestjs/common';

import type { ModelTier, ReasoningLevel, RoutingDecision, RoutingRequest, TierProfile } from '../types';

/**
 * Tier capability profiles. Context sizes mirror Apple's Foundation Models split
 * (on-device ~4K, private-cloud ~32K); the on-device window is set to 8K to match
 * typical local Ollama defaults on the appliance.
 */
export const TIER_PROFILES: Record<ModelTier, TierProfile> = {
  on_device: {
    tier: 'on_device',
    title: 'On-device (local Ollama)',
    maxContextTokens: 8_192,
    offline: true,
    external: false,
    description: 'Local model on the appliance. Private, offline, unlimited; smaller context.',
  },
  private_cloud: {
    tier: 'private_cloud',
    title: 'Private cloud (escalated)',
    maxContextTokens: 32_768,
    offline: false,
    external: true,
    description: 'Escalated model for hard/large-context tasks. Larger context, deeper reasoning.',
  },
};

/** Tool-call depth at/above which an agentic task is considered "hard". */
const DEEP_TOOL_DEPTH = 8;

/**
 * Decides whether a task runs on-device or escalates to the private-cloud tier —
 * CI's analogue of choosing `SystemLanguageModel` vs `PrivateCloudComputeLanguageModel`.
 *
 * Precedence:
 *  1. `localOnly` (privacy) — always pins on-device; downgrades if escalation was wanted.
 *  2. `forceTier` — explicit caller override (a forced cloud tier still yields to localOnly).
 *  3. Heuristics — large context / deep reasoning / deep tool chains escalate.
 *  4. Cloud availability — an escalation falls back on-device when the cloud tier is down
 *     (mirrors Apple PCC `.unavailable` → on-device fallback).
 */
@Injectable()
export class ModelTierRouter {
  decide(request: RoutingRequest): RoutingDecision {
    const reasoningLevel: ReasoningLevel = request.reasoningLevel ?? 'moderate';
    const reasons: string[] = [];

    const { wantsEscalation, escalationReasons } = this.assessEscalation(request);
    reasons.push(...escalationReasons);

    // 1. Privacy pin wins over everything. Mark downgraded if the task wanted the
    //    cloud tier (heuristically or by explicit forceTier) but privacy kept it local.
    if (request.localOnly) {
      const wantedCloud = wantsEscalation || request.forceTier === 'private_cloud';
      reasons.push('localOnly: privacy pins this task on-device');

      return this.decision('on_device', reasoningLevel, reasons, wantedCloud, request);
    }

    // 2. Explicit override (not privacy-pinned).
    if (request.forceTier) {
      reasons.push(`forceTier: caller requested ${request.forceTier}`);

      // A forced cloud tier still needs the cloud to be reachable.
      if (request.forceTier === 'private_cloud' && request.cloudAvailable === false) {
        reasons.push('cloud unavailable: falling back on-device');

        return this.decision('on_device', reasoningLevel, reasons, true, request);
      }

      return this.decision(request.forceTier, reasoningLevel, reasons, false, request);
    }

    // 3. Heuristic escalation.
    if (!wantsEscalation) {
      reasons.push('task fits on-device limits');

      return this.decision('on_device', reasoningLevel, reasons, false, request);
    }

    // 4. Escalate if the cloud tier is reachable, else fall back.
    if (request.cloudAvailable === false) {
      reasons.push('cloud unavailable: falling back on-device (may truncate)');

      return this.decision('on_device', reasoningLevel, reasons, true, request);
    }

    return this.decision('private_cloud', reasoningLevel, reasons, false, request);
  }

  /** Decide whether the task's shape calls for the escalated tier. */
  private assessEscalation(request: RoutingRequest): {
    wantsEscalation: boolean;
    escalationReasons: string[];
  } {
    const reasons: string[] = [];
    const onDeviceCtx = this.onDeviceContextTokens(request);

    if (request.requiresLargeContext) {
      reasons.push('caller requires large context');
    }

    if (typeof request.estimatedInputTokens === 'number' && request.estimatedInputTokens > onDeviceCtx) {
      reasons.push(`estimated ${request.estimatedInputTokens} tokens exceeds on-device ${onDeviceCtx}`);
    }

    if (request.reasoningLevel === 'deep') {
      reasons.push('deep reasoning requested');
    }

    if (typeof request.toolDepth === 'number' && request.toolDepth >= DEEP_TOOL_DEPTH) {
      reasons.push(`deep tool chain (${request.toolDepth} >= ${DEEP_TOOL_DEPTH})`);
    }

    return { wantsEscalation: reasons.length > 0, escalationReasons: reasons };
  }

  /**
   * The on-device context window this request should be judged against: the
   * caller's measured value when it supplied one, else the estimated profile.
   */
  private onDeviceContextTokens(request: RoutingRequest): number {
    const override = request.onDeviceContextTokens;

    return typeof override === 'number' && override > 0 ? override : TIER_PROFILES.on_device.maxContextTokens;
  }

  private decision(
    tier: ModelTier,
    reasoningLevel: ReasoningLevel,
    reasons: string[],
    downgraded: boolean,
    request: RoutingRequest,
  ): RoutingDecision {
    const base = TIER_PROFILES[tier];
    const onDeviceCtx = this.onDeviceContextTokens(request);
    // Report the window the decision was actually made against, so a caller that
    // told us the real on-device size does not read back the estimate.
    const profile =
      tier === 'on_device' && onDeviceCtx !== base.maxContextTokens
        ? { ...base, maxContextTokens: onDeviceCtx }
        : base;

    return { tier, reasoningLevel, profile, reasons, downgraded };
  }

  /** The static tier profiles, for discovery. */
  getProfiles(): TierProfile[] {
    return [TIER_PROFILES.on_device, TIER_PROFILES.private_cloud];
  }
}

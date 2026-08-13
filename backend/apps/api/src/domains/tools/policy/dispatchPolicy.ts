import { type ApiKeyCapability, FULL_CAPABILITY } from '@ci/common/decorators';

import type { IntentDefinition } from '../core/types';

import { capabilityAllows, capabilityRequiredFor, removesData } from './capabilityPolicy';

/**
 * Where an intent is being dispatched from.
 *
 * - `appliance` — the CI-Server itself: full corpus, network, and the user's own authority.
 * - `local` — the on-device tier (the mobile Local Hub sidecar / on-device model), running against
 *   a partial mirror, possibly offline, and with no way to ask the appliance anything right now.
 */
export const DISPATCH_TIERS = ['appliance', 'local'] as const;

export type DispatchTier = (typeof DISPATCH_TIERS)[number];

/**
 * What a dispatcher should do with an intent.
 *
 * - `execute` — run it now, in this tier.
 * - `queue` — do not run it here; record it as a pending action for the appliance to run once
 *   reachable, **after the user confirms**. The intent is legitimate; this tier is the wrong place.
 * - `deny` — refuse outright. The caller lacks the authority; no amount of confirmation or
 *   reconnection changes that, so queuing would only launder a refusal into a pending action.
 */
export type DispatchDecision = 'execute' | 'queue' | 'deny';

export type DispatchReason =
  | 'allowed'
  | 'capability-insufficient'
  | 'destructive-requires-confirmation'
  | 'external-leaves-appliance'
  | 'not-local-capable';

export interface DispatchRuling {
  decision: DispatchDecision;
  reason: DispatchReason;
  /** One line, safe to show a user or hand back to a model as a refusal message. */
  explanation: string;
}

/** The part of an intent this policy reads. Keeps callers (and the published manifest) free to
 *  pass a `ManifestIntent` rather than a full tool schema. */
export type DispatchableIntent = Pick<IntentDefinition, 'name' | 'privacy' | 'localCapable'>;

export interface DispatchOptions {
  tier: DispatchTier;
  /** Authority of the principal on whose behalf the intent would run. Defaults to full — the
   *  device owner acting as themselves, which is the on-device tier's normal case. */
  capability?: ApiKeyCapability;
}

/**
 * The one rule for "may this intent run here, now?" — shared by both tiers.
 *
 * The product commitment it encodes: **destructive or external intents never execute in the local
 * tier.** Not "usually", not "unless the model is confident": a device that is offline cannot show
 * the user the appliance's view of what is about to be deleted, and cannot honour a "no" once the
 * third-party call has left. Both queue for confirmation against the appliance instead.
 *
 * It lives in the backend, and is published through the intent manifest (`privacy` + `localCapable`
 * per intent), so the on-device dispatcher consumes the same rule rather than reimplementing it in
 * Kotlin and Swift and drifting. Two copies of a security rule are two rules.
 *
 * Precedence is deliberate and load-bearing:
 *
 * 1. **Capability first.** A read-only key is refused a delete in either tier. Checking the tier
 *    first would turn that refusal into a queued action awaiting confirmation — i.e. an
 *    unauthorized call that merely takes one extra tap to succeed.
 * 2. **Appliance executes** whatever capability allowed. It is the authoritative tier.
 * 3. **Local: data-loss, then egress, then coverage.** When more than one applies the most
 *    alarming reason is reported, because the reason is what a confirmation prompt shows.
 *
 * `sensitivity` intentionally changes nothing here. It grades how carefully an answer should be
 * *displayed*, not where it may run — and the local tier is the more private place to run
 * anything, so letting 'sensitive' push work to the appliance would invert the guarantee.
 */
export function resolveDispatch(intent: DispatchableIntent, options: DispatchOptions): DispatchRuling {
  const { tier, capability = FULL_CAPABILITY } = options;
  const { privacy } = intent;

  if (!capabilityAllows(privacy, capability)) {
    return {
      decision: 'deny',
      reason: 'capability-insufficient',
      explanation: `"${intent.name}" requires "${capabilityRequiredFor(privacy)}" access, but this caller is "${capability}"`,
    };
  }

  if (tier === 'appliance') {
    return { decision: 'execute', reason: 'allowed', explanation: `"${intent.name}" may run here` };
  }

  if (removesData(privacy)) {
    return {
      decision: 'queue',
      reason: 'destructive-requires-confirmation',
      explanation: `"${intent.name}" removes data and must be confirmed against the appliance before it runs`,
    };
  }

  if (privacy.external) {
    return {
      decision: 'queue',
      reason: 'external-leaves-appliance',
      explanation: `"${intent.name}" sends data to a third-party service and must be confirmed against the appliance before it runs`,
    };
  }

  if (!intent.localCapable) {
    return {
      decision: 'queue',
      reason: 'not-local-capable',
      explanation: `"${intent.name}" cannot be served from on-device data and will run when the appliance is reachable`,
    };
  }

  return { decision: 'execute', reason: 'allowed', explanation: `"${intent.name}" may run on-device` };
}

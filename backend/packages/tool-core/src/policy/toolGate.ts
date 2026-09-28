import type { ToolCapability } from '../capability';
import type { ToolPrincipal } from '../core/types';

import { removesData } from './capabilityPolicy';
import {
  resolveDispatch,
  type DispatchReason,
  type DispatchRuling,
  type DispatchTier,
  type DispatchableIntent,
} from './dispatchPolicy';

/**
 * The owner's trust dial, as the API's `PersonalizationService.decide` answers it.
 *
 * Mirrored here for the same reason {@link ToolCapability} is: the gate reads the dial, but the
 * dial itself is personalization's concern and lives in a domain full of Nest services. The two
 * unions are held identical by a compile-time assertion on the API side
 * (`domains/tools/toolCoreContract.ts`).
 */
export type TrustDecision = 'auto' | 'review' | 'skip';

/**
 * Why the gate answered as it did. The three {@link DispatchReason} queue
 * reasons come straight from {@link resolveDispatch}; the fourth is the
 * appliance-tier one this module adds.
 */
export type ToolGateReason = DispatchReason | 'confirmation-required';

export interface ToolGateRuling extends Omit<DispatchRuling, 'reason'> {
  reason: ToolGateReason;
}

export interface ToolGateOptions {
  tier: DispatchTier;
  capability: ToolCapability;
  /**
   * WHO is calling. Defaults to `'owner'` when omitted, so every existing caller
   * keeps today's behaviour exactly.
   */
  principal?: ToolPrincipal;
  /**
   * The owner's trust dial as the API's `PersonalizationService.decide`
   * answered it, or `null` when the dial was not consulted (feature flag off,
   * or no owner to consult it for). `null` means "execute" — the flag-off path
   * must be byte-identical to today's behaviour.
   */
  trust: TrustDecision | null;
}

/**
 * Does this intent need a human to say yes before it fires on the appliance?
 *
 * The same two properties {@link resolveDispatch} refuses to run in the local
 * tier: work that removes data, and work that leaves the appliance. They are the
 * two the product already promises to confirm — `MessagingSendTool`'s docblock
 * ("a dispatcher must confirm before this one fires") and `ToolRegistry`'s
 * `privacy.external` warn ("It gates nothing today") are the two in-repo
 * admissions that nothing did.
 */
export function needsConfirmation(intent: DispatchableIntent): boolean {
  return removesData(intent.privacy) || intent.privacy.external;
}

/**
 * The full "may this caller run this intent, here, now?" ruling — the one
 * `ToolRegistry.executeTool` consults.
 *
 * Pure, and a strict extension of {@link resolveDispatch}: it calls it first and
 * NEVER overrides its answer, only ever adding a queue where dispatch said
 * execute. Two guarantees follow, and both are load-bearing:
 *
 * 1. **A `deny` is never laundered into a queue.** `resolveDispatch` orders
 *    capability before tier precisely so that a refusal cannot become "a pending
 *    action that succeeds after one extra tap". This function returns a `deny`
 *    verbatim and never inspects the trust dial after one. (`ToolRegistry` also
 *    runs `capabilityAllows` itself, before ever reaching here, so a refused
 *    call leaves this module untouched — belt and braces, on purpose.)
 * 2. **The trust dial can only make the gate stricter.** It is consulted last,
 *    it applies only to intents {@link needsConfirmation} already flags, and its
 *    only possible effect is `execute` → `queue`.
 *
 * The trust mapping, as the API's `PendingActionService.trustForToolCall` makes
 * it (the dial is read directly for a tool call, not through the inference
 * scorer — an explicit intent has no confidence to grade):
 *
 * | trust mode  | trust                                  | destructive / external intent              |
 * |-------------|----------------------------------------|--------------------------------------------|
 * | `hands_off` | auto                                   | executes unattended                        |
 * | `balanced`  | auto for an external read, else review | an external read executes; the rest queues |
 * | `cautious`  | review                                 | queues for confirmation                    |
 *
 * `skip` queues rather than executing or silently dropping. The dial's `skip`
 * means "don't apply this inference"; there is no such thing as declining a
 * tool call the user asked for on their behalf without telling them, so the
 * safe reading of `skip` here is "ask".
 */
export function resolveToolGate(intent: DispatchableIntent, options: ToolGateOptions): ToolGateRuling {
  const { tier, capability, trust, principal = 'owner' } = options;

  const dispatch = resolveDispatch(intent, { tier, capability });

  if (dispatch.decision !== 'execute') {
    return dispatch;
  }

  if (!needsConfirmation(intent)) {
    return dispatch;
  }

  // A borrowed agent is confirmed before anything irreversible, whatever the
  // owner's dial says — and WITHOUT consulting the feature flag, which is why
  // this sits above the trust check rather than inside it.
  //
  // The dial is an owner convenience: it grades how much of the appliance's own
  // inference the owner wants to wave through. It was never a delegation policy,
  // and defaulting to `balanced` means it answers `auto`. Letting that decide
  // whether an installed harness may delete unattended would make the owner's
  // convenience setting into the agent's authorisation.
  //
  // This is also the compensating control that makes `capabilityForApp`'s `full`
  // safe (see ConnectService): the harness can now REACH destructive intents,
  // and reaching them produces a card instead of running them.
  if (principal === 'managed-app') {
    return {
      decision: 'queue',
      reason: 'confirmation-required',
      explanation: `"${intent.name}" ${removesData(intent.privacy) ? 'removes data' : 'sends data to a third-party service'} and an installed app must be confirmed before acting`,
    };
  }

  if (trust == null || trust === 'auto') {
    return dispatch;
  }

  return {
    decision: 'queue',
    reason: 'confirmation-required',
    explanation: `"${intent.name}" ${removesData(intent.privacy) ? 'removes data' : 'sends data to a third-party service'} and this appliance is set to confirm before acting`,
  };
}

import type { ApiKeyCapability } from '@ci/common/decorators';
import type { PersonalizationDecision } from '@ci/domains/personalization/types';

import { removesData } from './capabilityPolicy';
import {
  resolveDispatch,
  type DispatchReason,
  type DispatchRuling,
  type DispatchTier,
  type DispatchableIntent,
} from './dispatchPolicy';

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
  capability: ApiKeyCapability;
  /**
   * The owner's trust dial as {@link PersonalizationService.decide} answered it,
   * or `null` when the dial was not consulted (feature flag off, or no owner to
   * consult it for). `null` means "execute" — the flag-off path must be
   * byte-identical to today's behaviour.
   */
  trust: PersonalizationDecision | null;
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
 * The trust mapping, with `kind: 'agent_write'`, `confidence: 1` and
 * `hasUserInput: true` (see `PendingActionService.evaluate` for why 1 is the
 * honest confidence for an explicit tool call rather than an inference):
 *
 * | trust mode  | decide() | destructive / external intent |
 * |-------------|----------|-------------------------------|
 * | `hands_off` | auto     | executes — today's behaviour, exactly |
 * | `balanced`  | auto     | executes — today's behaviour, exactly |
 * | `cautious`  | review   | queues for confirmation |
 *
 * `skip` queues rather than executing or silently dropping. The dial's `skip`
 * means "don't apply this inference"; there is no such thing as declining a
 * tool call the user asked for on their behalf without telling them, so the
 * safe reading of `skip` here is "ask".
 */
export function resolveToolGate(intent: DispatchableIntent, options: ToolGateOptions): ToolGateRuling {
  const { tier, capability, trust } = options;

  const dispatch = resolveDispatch(intent, { tier, capability });

  if (dispatch.decision !== 'execute') {
    return dispatch;
  }

  if (trust == null || trust === 'auto') {
    return dispatch;
  }

  if (!needsConfirmation(intent)) {
    return dispatch;
  }

  return {
    decision: 'queue',
    reason: 'confirmation-required',
    explanation: `"${intent.name}" ${removesData(intent.privacy) ? 'removes data' : 'sends data to a third-party service'} and this appliance is set to confirm before acting`,
  };
}

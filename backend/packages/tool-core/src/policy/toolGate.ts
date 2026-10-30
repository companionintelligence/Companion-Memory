import type { ToolCapability } from '../capability';
import type { ToolPrincipal } from '../core/types';

import { reachesThirdParty, removesData } from './capabilityPolicy';
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
 * reasons come straight from {@link resolveDispatch}; the other three are the
 * appliance-tier ones this module adds. `confirmation-required` is for work
 * that removes data or leaves the appliance. `write-after-lookup` is for any
 * other write a chat turn makes once it has looked something up, and
 * `read-after-lookup` for a read from a third-party service made the same way
 * (see {@link ToolGateOptions.followsLookup}).
 */
export type ToolGateReason =
  DispatchReason | 'confirmation-required' | 'write-after-lookup' | 'read-after-lookup';

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
  /**
   * The call comes from a chat round after the turn already ran a lookup, so
   * what it does may have been steered by text the lookup returned: a mail, a
   * note or a page someone else wrote. Under a dial that asks before a delete,
   * such a call asks before any write (not only a destructive or external one)
   * and before a read from a third-party service, whose query can carry what
   * the lookup found to an outside party. A read that reaches only the owner's
   * own server (`IntentPrivacy.ownServer`) is judged as before. Whether a read
   * asks is the dial's answer: the API's `trustForToolCall` answers review for
   * it, and this module only names the reason. A call the person asked for
   * directly comes from the turn's first round and is judged as before. Absent
   * means false.
   */
  followsLookup?: boolean;
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
 *
 * With `followsLookup`, any write too: see {@link ToolGateOptions.followsLookup}.
 */
export function needsConfirmation(
  intent: DispatchableIntent,
  { followsLookup = false }: Pick<ToolGateOptions, 'followsLookup'> = {},
): boolean {
  return removesData(intent.privacy) || intent.privacy.external || writesAfterLookup(intent, followsLookup);
}

/** Any write, destructive and external ones included, from a chat round after a lookup. */
function writesAfterLookup(intent: DispatchableIntent, followsLookup: boolean): boolean {
  return followsLookup && intent.privacy.access !== 'read';
}

/**
 * A read from a third-party service, from a chat round after a lookup. It changes nothing, but what
 * it sends (a search term, a title) may come from text the lookup returned. A read that reaches only
 * the owner's own server, such as listing their texts off their own Mac, sends that party nothing.
 */
function readsOutsideAfterLookup(intent: DispatchableIntent, followsLookup: boolean): boolean {
  return (
    followsLookup &&
    intent.privacy.access === 'read' &&
    reachesThirdParty(intent.privacy) &&
    !removesData(intent.privacy)
  );
}

/** What makes a flagged intent need a yes, in the words its explanation uses. */
function whatItDoes(intent: DispatchableIntent): string {
  if (removesData(intent.privacy)) {
    return 'removes data';
  }

  return reachesThirdParty(intent.privacy)
    ? 'sends data to a third-party service'
    : 'reaches a server outside the appliance';
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
 * A third-party read that follows a lookup is not the `balanced` exception:
 * the dial answers review for it and it queues with the reason
 * `read-after-lookup`. A read that reaches only the owner's own server
 * (`IntentPrivacy.ownServer`) still is. A write that is flagged only because it follows a lookup
 * is queued the same way under the same dial, with the reason
 * `write-after-lookup`. The managed-app rule below does not apply to that
 * write (the rule is about irreversible work).
 *
 * `skip` queues rather than executing or silently dropping. The dial's `skip`
 * means "don't apply this inference"; there is no such thing as declining a
 * tool call the user asked for on their behalf without telling them, so the
 * safe reading of `skip` here is "ask".
 */
export function resolveToolGate(intent: DispatchableIntent, options: ToolGateOptions): ToolGateRuling {
  const { tier, capability, trust, principal = 'owner', followsLookup = false } = options;

  const dispatch = resolveDispatch(intent, { tier, capability });

  if (dispatch.decision !== 'execute') {
    return dispatch;
  }

  // Flagged for removing data or leaving the appliance, or else only for following a lookup.
  const flagged = needsConfirmation(intent);
  const afterLookupOnly = !flagged && writesAfterLookup(intent, followsLookup);

  if (!flagged && !afterLookupOnly) {
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
  if (principal === 'managed-app' && !afterLookupOnly) {
    return {
      decision: 'queue',
      reason: 'confirmation-required',
      explanation: `"${intent.name}" ${whatItDoes(intent)} and an installed app must be confirmed before acting`,
    };
  }

  if (trust == null || trust === 'auto') {
    return dispatch;
  }

  if (afterLookupOnly) {
    return {
      decision: 'queue',
      reason: 'write-after-lookup',
      explanation: `"${intent.name}" would change your data right after a lookup in the same chat turn, which this appliance is set to confirm first`,
    };
  }

  if (readsOutsideAfterLookup(intent, followsLookup)) {
    return {
      decision: 'queue',
      reason: 'read-after-lookup',
      explanation: `"${intent.name}" would ask a third-party service something right after a lookup in the same chat turn, which this appliance is set to confirm first`,
    };
  }

  return {
    decision: 'queue',
    reason: 'confirmation-required',
    explanation: `"${intent.name}" ${whatItDoes(intent)} and this appliance is set to confirm before acting`,
  };
}

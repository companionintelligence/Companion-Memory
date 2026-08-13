import {
  type ApiKeyCapability,
  FULL_CAPABILITY,
  READ_CAPABILITY,
  WRITE_CAPABILITY,
} from '@ci/common/decorators';

import type { IntentPrivacy } from '../core/types';

/**
 * The part of a privacy label that decides authority.
 *
 * Typed off {@link IntentPrivacy} rather than restated as `{ access: string }`: `access` is a
 * closed union ('read' | 'write' | 'delete'), and a structural copy that widens it to `string`
 * would let a typo — 'deleted', 'READ' — compile here and silently fall through to the permissive
 * branch. The gate should not be the one place that stops believing the label's type.
 */
export type GatedPrivacy = Pick<IntentPrivacy, 'access' | 'destructive'>;

/**
 * Whether running this intent can lose data.
 *
 * `delete` and `destructive` are collapsed here deliberately. They are separate fields because
 * they answer different questions, but both answer "can this lose data?" with yes, and a level
 * that allowed one while refusing the other would be a distinction no user could act on.
 */
export function removesData(privacy: GatedPrivacy): boolean {
  return privacy.access === 'delete' || privacy.destructive;
}

/**
 * Whether a principal at `capability` may run a tool with this privacy label.
 *
 * The labels already exist and are derived structurally — a GraphQL query IS a read, a mutation
 * named `delete*` IS destructive (see GraphQLToolAdapter) — but they were long advisory: emitted
 * as MCP annotation hints for the client's benefit, enforced nowhere. A client that ignored the
 * hint and called `deleteMemory` succeeded.
 *
 * This is the single implementation of that rule. It lives in the tools domain rather than in
 * `McpToolService`, where it was born, because it is not MCP's rule: it is the intent catalog's,
 * and MCP was merely the first dispatcher to apply it. `ToolRegistry.executeTool` now calls it on
 * every execution regardless of transport, so a second dispatcher (the in-house chat model) and a
 * third (the on-device tier) cannot each re-decide it — or skip it.
 */
export function capabilityAllows(privacy: GatedPrivacy, capability: ApiKeyCapability): boolean {
  if (capability === FULL_CAPABILITY) {
    return true;
  }

  if (removesData(privacy)) {
    return false;
  }

  if (capability === WRITE_CAPABILITY) {
    return true;
  }

  return privacy.access === 'read';
}

/**
 * The lowest capability that could run this tool — named in a refusal so an operator is told which
 * level to grant, rather than being left to guess between 'write' and 'full'.
 */
export function capabilityRequiredFor(privacy: GatedPrivacy): ApiKeyCapability {
  if (removesData(privacy)) {
    return FULL_CAPABILITY;
  }

  return privacy.access === 'read' ? READ_CAPABILITY : WRITE_CAPABILITY;
}

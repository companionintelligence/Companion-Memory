import { FULL_CAPABILITY, READ_CAPABILITY, WRITE_CAPABILITY, type ToolCapability } from '../capability';
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
 * This is the single implementation of that rule. It lives in the tool core rather than in
 * `McpToolService`, where it was born, because it is not MCP's rule: it is the intent catalog's,
 * and MCP was merely the first dispatcher to apply it. `ToolRegistryCore.executeTool` now calls it
 * on every execution regardless of transport, so a second dispatcher (the in-house chat model) and
 * a third (the on-device tier) cannot each re-decide it — or skip it. Moving it OUT of the
 * transport is the property this package exists to keep; extracting the package must not quietly
 * hand it back.
 */
export function capabilityAllows(privacy: GatedPrivacy, capability: ToolCapability): boolean {
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

const ACCESS_RANK: Record<IntentPrivacy['access'], number> = { read: 0, write: 1, delete: 2 };

const SENSITIVITY_RANK: Record<IntentPrivacy['sensitivity'], number> = { low: 0, personal: 1, sensitive: 2 };

/**
 * The stricter of two labels, facet by facet: the wider access, the higher sensitivity, and
 * destructive or external when either says so.
 *
 * How a tool's per-call label (`ToolHandle.privacyFor`) meets its declared one. Taking the
 * stricter of the two rather than trusting the per-call answer means a tool can only ever raise
 * what its declaration allows. A per-call label that claimed `read` for a declared `delete` is a
 * bug, and the gate must not be the place it turns into a hole.
 */
export function stricterPrivacy(declared: IntentPrivacy, perCall: IntentPrivacy | undefined): IntentPrivacy {
  if (perCall == null) {
    return declared;
  }

  return {
    access: ACCESS_RANK[perCall.access] > ACCESS_RANK[declared.access] ? perCall.access : declared.access,
    sensitivity:
      SENSITIVITY_RANK[perCall.sensitivity] > SENSITIVITY_RANK[declared.sensitivity]
        ? perCall.sensitivity
        : declared.sensitivity,
    destructive: declared.destructive || perCall.destructive,
    external: declared.external || perCall.external,
  };
}

/**
 * The lowest capability that could run this tool — named in a refusal so an operator is told which
 * level to grant, rather than being left to guess between 'write' and 'full'.
 */
export function capabilityRequiredFor(privacy: GatedPrivacy): ToolCapability {
  if (removesData(privacy)) {
    return FULL_CAPABILITY;
  }

  return privacy.access === 'read' ? READ_CAPABILITY : WRITE_CAPABILITY;
}

import { SetMetadata } from '@nestjs/common';

/**
 * What an API key may DO on the surfaces its scopes let it reach.
 *
 * Two independent axes, each with one job: `scopes` say *which surface* a key opens
 * (`memory`, `intents`, `mcp` — see RequireScopes), `capability` says *what it may do*
 * there. Keeping them apart matters here in particular, because an EMPTY scope array
 * already means full authority: folding verbs into that list would make "empty" mean
 * full surface *and* full capability, with no way to express one without the other.
 *
 * - `read`  — read-only tools. Nothing the key can call changes stored data.
 * - `write` — read + mutating tools, but nothing that deletes.
 * - `full`  — everything, including destructive tools (delete/remove/purge/drop).
 *
 * These are the same three levels CI-Hub uses for the same purpose, deliberately: a user
 * granting a connected agent access to both should meet one concept, not two dialects.
 */
export const API_KEY_CAPABILITIES = ['read', 'write', 'full'] as const;

export type ApiKeyCapability = (typeof API_KEY_CAPABILITIES)[number];

export const READ_CAPABILITY: ApiKeyCapability = 'read';
export const WRITE_CAPABILITY: ApiKeyCapability = 'write';
export const FULL_CAPABILITY: ApiKeyCapability = 'full';

/**
 * Capability a key gets when none is stated — what every key could already do before the
 * column existed, so upgrading narrows nobody.
 *
 * `read` would break the "create a key, connect an agent" flow (an agent that can record
 * nothing looks broken, not restricted); `full` would hand every new key the ability to
 * delete memories, which is the thing worth asking about.
 */
export const DEFAULT_API_KEY_CAPABILITY: ApiKeyCapability = WRITE_CAPABILITY;

/** Ascending authority. Only ordering lives here; which tools each level reaches is the
 *  MCP layer's business (see McpToolService). */
const CAPABILITY_RANK: Record<ApiKeyCapability, number> = { read: 0, write: 1, full: 2 };

export function isApiKeyCapability(value: unknown): value is ApiKeyCapability {
  return typeof value === 'string' && (API_KEY_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Narrow a stored value to a capability, falling back to the STRICTEST level rather than the
 * default. A row whose capability we cannot read is a row we do not understand, and the safe
 * reading of an unreadable authority level is the smallest one.
 */
export function coerceApiKeyCapability(value: unknown): ApiKeyCapability {
  return isApiKeyCapability(value) ? value : READ_CAPABILITY;
}

/**
 * True when moving from `from` to `to` grants authority the key did not have — the test for
 * whether a change needs an explicit confirmation. A demotion only ever removes authority, so
 * making one harder would just discourage tightening a key.
 */
export function isCapabilityPromotion(from: ApiKeyCapability, to: ApiKeyCapability): boolean {
  return CAPABILITY_RANK[to] > CAPABILITY_RANK[from];
}

/** True when `capability` is at least `required` — the one comparison enforcement makes. */
export function capabilitySatisfies(capability: ApiKeyCapability, required: ApiKeyCapability): boolean {
  return CAPABILITY_RANK[capability] >= CAPABILITY_RANK[required];
}

/** Metadata key under which a route's minimum capability is stored. */
export const REQUIRE_CAPABILITY_KEY = 'require_capability';

/**
 * Declares the minimum capability an api-key needs to reach a route.
 *
 * The companion to {@link RequireScopes}, and it must be applied wherever that is: `@RequireScopes`
 * marks a route as reachable by a scope-limited key, and a scope-limited key can reach NOTHING else
 * (deny-by-default), so annotating every scoped route makes capability enforcement complete for
 * those keys. Miss one and a read-only key can still act there — which is worse than not offering
 * read-only at all, because the UI has already promised otherwise.
 *
 * Stated per route rather than inferred from the HTTP method, which would be wrong here in both
 * directions: `POST /memory/recall` only searches, and a future `GET` that triggers work would read
 * as harmless.
 *
 * An empty-scope (grandfathered full-access) key is subject to this too: "reaches every surface"
 * and "may write on it" are separate grants. A route with no annotation is priced by its shape
 * (`capabilityImpliedByShape`: GET reads, DELETE needs `full`, everything else writes), so the
 * annotation is only needed where the shape gives the wrong answer: a POST that destroys data asks
 * for `full`, a POST that only computes drops to `read`.
 */
export const RequireCapability = (capability: ApiKeyCapability) =>
  SetMetadata(REQUIRE_CAPABILITY_KEY, capability);

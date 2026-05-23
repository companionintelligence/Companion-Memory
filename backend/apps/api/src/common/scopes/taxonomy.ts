/**
 * Scope taxonomy for API keys and (later) external-agent OAuth tokens.
 *
 * Implements the foundations from
 * [docs/architecture/plan/07-auth-scopes-throttling.md](../../../../../docs/architecture/plan/07-auth-scopes-throttling.md).
 *
 * Scope strings follow `<family>:<verb>[:<qualifier>]`. Wildcards are supported
 * by the `matchScope` helper:
 *  - `*` matches anything.
 *  - `<family>:*` matches every scope in that family.
 *  - `*:read` matches every read across families.
 *  - Trailing `*` matches a prefix, e.g. `tools:invoke:*`.
 */

export const SCOPES = {
  // memory
  MEMORY_READ: 'memory:read',
  MEMORY_READ_SEMANTIC: 'memory:read:semantic',
  MEMORY_READ_EPISODIC: 'memory:read:episodic',
  MEMORY_READ_PROCEDURAL: 'memory:read:procedural',
  MEMORY_WRITE: 'memory:write',
  MEMORY_WRITE_SEMANTIC: 'memory:write:semantic',
  MEMORY_DELETE: 'memory:delete',

  // files
  FILES_READ: 'files:read',
  FILES_WRITE: 'files:write',
  FILES_DELETE: 'files:delete',

  // chat / conversations
  CHAT_READ: 'chat:read',
  CHAT_WRITE: 'chat:write',
  CHAT_STREAM: 'chat:stream',

  // profile / dossier
  PROFILE_READ: 'profile:read',
  PROFILE_WRITE: 'profile:write',

  // tools and skills (per-name granularity supported via wildcards)
  TOOLS_INVOKE: 'tools:invoke',
  SKILL_INVOKE: 'skill:invoke',
  SKILL_INSTALL: 'skill:install',
  SKILL_AUTHOR: 'skill:author',

  // devices / ingest
  DEVICES_INGEST: 'devices:ingest',
  DEVICES_ADMIN: 'devices:admin',

  // privacy / consent (plan 09)
  PRIVACY_READ: 'privacy:read',
  PRIVACY_WRITE: 'privacy:write',

  // agent memory provider — Hermes / OpenClaw external integration (ci-memory-plan)
  AGENT_MEMORY_WRITE: 'agent_memory:write',
  AGENT_MEMORY_READ: 'agent_memory:read',

  // admin
  ADMIN_READ: 'admin:read',
  ADMIN_WRITE: 'admin:write',
  ADMIN_ALL: 'admin:*',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES] | string;

/**
 * The default scope set granted to a key created from the SPA with no explicit
 * choice. Deliberately read-mostly — the user must opt into write keys.
 */
export const DEFAULT_READ_SCOPES: readonly string[] = [
  SCOPES.MEMORY_READ,
  SCOPES.PROFILE_READ,
  SCOPES.CHAT_READ,
  SCOPES.CHAT_WRITE,
  SCOPES.FILES_READ,
];

/**
 * Returns true if a single granted scope satisfies a single required scope,
 * accounting for wildcard semantics.
 */
function singleMatch(granted: string, required: string): boolean {
  if (granted === required) {
    return true;
  }

  if (granted === '*') {
    return true;
  }

  // family-wildcard: e.g. granted = 'memory:*' covers required = 'memory:read'.
  // Also handles tools:invoke:* matching tools:invoke:foo.
  if (granted.endsWith(':*')) {
    const prefix = granted.slice(0, -1); // keep trailing ':'

    return required.startsWith(prefix);
  }

  // verb-wildcard: granted = '*:read' covers required = 'memory:read'.
  if (granted.startsWith('*:')) {
    const suffix = granted.slice(1); // ':read'

    return required.endsWith(suffix);
  }

  return false;
}

/**
 * Returns true if `granted` contains a scope that satisfies `required`.
 */
export function matchScope(granted: readonly string[], required: string): boolean {
  return granted.some((g) => singleMatch(g, required));
}

/**
 * Returns true if every required scope is satisfied by some granted scope.
 */
export function matchScopes(granted: readonly string[], required: readonly string[]): boolean {
  if (required.length === 0) {
    return true;
  }

  return required.every((r) => matchScope(granted, r));
}

/**
 * Convenience: produce a human-readable description of why a scope check
 * failed, listing which required scopes were not matched.
 */
export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  return required.filter((r) => !matchScope(granted, r));
}

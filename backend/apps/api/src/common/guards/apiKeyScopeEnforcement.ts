import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { REQUIRE_SCOPES_KEY } from '@ci/common/decorators';

/**
 * Request augmentation set by {@link ApiKeyStrategy} once an api-key has been
 * validated. `undefined` means the caller did not authenticate with an api-key
 * (e.g. a session/JWT/Portal principal), which carries full authority.
 */
export interface ApiKeyScopedRequest extends Request {
  apiKeyScopes?: string[];
  /**
   * The id of the key that authenticated. Identifies WHICH key, where
   * {@link ApiKeyScopedRequest.apiKeyScopes} only describes what it may do — two keys
   * can hold identical scopes, so state bound to a single caller's authority (the MCP
   * session map) must key on this.
   */
  apiKeyId?: string;
}

/**
 * Whether the caller is a **scope-limited** api-key principal — i.e. one confined
 * by {@link enforceApiKeyScopes} to the routes its scopes name.
 *
 * The single source of truth for that question, so surfaces which decide what a
 * caller may *see* (e.g. the MCP tool/resource catalog) stay in lockstep with the
 * guard that decides what it may *do*. Session/JWT/Portal principals and
 * empty-scope (legacy/full-access) keys are NOT scope-limited.
 */
export function isScopeLimitedApiKey(request: ApiKeyScopedRequest): boolean {
  const scopes = request.apiKeyScopes;

  return scopes !== undefined && scopes.length > 0;
}

/**
 * Deny-by-default scope enforcement for api-key principals.
 *
 * Runs from inside the api-key auth guards ({@link ApiKeyGuard},
 * {@link JwtOrApiKeyAuthGuard}) *after* the strategy has populated
 * `req.apiKeyScopes` — it MUST NOT be a global `APP_GUARD`, which would run
 * before authentication sets the scopes.
 *
 * This inverts the old opt-in model (enforce only on routes that pair a guard
 * with `@RequireScopes`): instead, a **scope-limited** key is confined to routes
 * that explicitly grant one of its scopes. Precedence:
 *
 * - `apiKeyScopes === undefined` — not an api-key principal (session/JWT/Portal)
 *   → full authority, unaffected.
 * - `apiKeyScopes.length === 0` — an empty-scope key: legacy full-access keys and
 *   the connect keys minted for broad-access apps (e.g. the bulk importer) →
 *   full authority, unaffected.
 * - non-empty scopes → the route MUST declare `@RequireScopes` and the key must
 *   carry every required scope, else 403. A scoped key on an un-annotated route
 *   is denied (this is what confines e.g. a memory-scoped chat-agent key to the
 *   memory endpoints and off `/graphql`, `/files`, `/v1`, …).
 */
export function enforceApiKeyScopes(
  reflector: Reflector,
  context: ExecutionContext,
  request: ApiKeyScopedRequest,
): void {
  const scopes = request.apiKeyScopes;

  // Non-api-key principal, or an empty-scope (full-access) key → nothing to enforce.
  // Narrowing on `scopes` (rather than re-testing the request) keeps the compiler,
  // not a cast, guaranteeing it is defined below.
  if (!isScopeLimitedApiKey(request) || !scopes) {
    return;
  }

  const required = reflector.getAllAndOverride<string[] | undefined>(REQUIRE_SCOPES_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);

  // Scope-limited key on a route that grants no scope → deny.
  if (!required || required.length === 0) {
    throw new ForbiddenException('This API key is scope-limited and cannot access this endpoint');
  }

  const missing = required.filter((scope) => !scopes.includes(scope));

  if (missing.length > 0) {
    throw new ForbiddenException(`API key is missing required scope(s): ${missing.join(', ')}`);
  }
}

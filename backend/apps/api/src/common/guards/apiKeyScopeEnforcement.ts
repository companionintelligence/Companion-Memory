import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { Request } from 'express';

import {
  type ApiKeyCapability,
  FULL_CAPABILITY,
  READ_CAPABILITY,
  REQUIRE_CAPABILITY_KEY,
  REQUIRE_SCOPES_KEY,
  WRITE_CAPABILITY,
  capabilitySatisfies,
  coerceApiKeyCapability,
} from '@ci/common/decorators';

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
  /**
   * What the key may DO on the surfaces its scopes reach. The second axis: scopes decide
   * WHICH tools are visible, capability decides which of THOSE may run. Absent for
   * non-api-key principals (sessions/JWT/Portal), who carry full authority.
   */
  apiKeyCapability?: ApiKeyCapability;
  /**
   * Where the key came from. `'connect'` means CI-Hub minted it for an installed
   * app, so the caller is a borrowed harness acting for the owner rather than the
   * owner themselves.
   *
   * Capability cannot express this: an owner's hand-made key and a connect-minted
   * harness key can hold identical powers. Two rules turn on it — a harness is
   * confirmed before anything irreversible regardless of the owner's trust dial,
   * and it may not answer its own approval card.
   *
   * Provenance from `api_keys.managed_by`, never from the `app:` name prefix,
   * which a user can hand-create.
   */
  apiKeyManagedBy?: 'connect' | 'sign_in' | null;
  /** The key's name (`app:<appUrn>` for connect keys), for LABELLING a card once
   *  {@link ApiKeyScopedRequest.apiKeyManagedBy} has already established trust. */
  apiKeyName?: string | null;
}

/**
 * The capability of the caller behind a request — full authority for anything that did not
 * authenticate with an api key (a session is the user themselves), and otherwise the key's
 * own level, read strictly: an api-key request that somehow reached here without a capability
 * is treated as read-only rather than trusted.
 */
export function apiKeyCapabilityOf(request: ApiKeyScopedRequest): ApiKeyCapability {
  if (request.apiKeyScopes === undefined) {
    return FULL_CAPABILITY;
  }

  return coerceApiKeyCapability(request.apiKeyCapability);
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

/**
 * What an operation requires when its route declares nothing: the shape of the
 * request decides. A GraphQL mutation or a non-GET HTTP verb changes state, so
 * it needs `write`; a query or a GET needs `read`; an HTTP DELETE removes
 * something, so it needs `full`. `@RequireCapability` on the handler or class
 * overrides this in either direction: up to `full` for an operator action or
 * a POST that destroys, or down to `read` for a POST that only computes
 * (`/llm/generate`, `/import/recognize`, `/model-routing/plan`, MCP) and for
 * `DELETE /mcp`, which ends a protocol session and deletes nothing.
 *
 * DELETE is priced at `full` because that is what the levels promise: `write`
 * is "nothing that deletes" (see {@link ApiKeyCapability}), and MCP already
 * refuses a `write` key every tool labelled destructive. Before this, every
 * undeclared `@Delete` route (connections, chat threads, import runs and
 * uploads, questions, answers, positions, devices) ran for a `write` key.
 *
 * GraphQL is priced per field rather than per verb: a resolver whose
 * `@GraphqlPrivacy` label loses data also declares `full` (the decorator
 * writes both), so it arrives here as a declaration, not a shape.
 *
 * HEAD and OPTIONS are reads; every other verb that is not GET or DELETE is a write.
 */
export function capabilityImpliedByShape(
  context: ExecutionContext,
  request: ApiKeyScopedRequest,
): ApiKeyCapability {
  if (context.getType<string>() === 'graphql') {
    const operation = GqlExecutionContext.create(context).getInfo<{ operation?: { operation?: string } }>()
      ?.operation?.operation;

    return operation === 'query' ? READ_CAPABILITY : WRITE_CAPABILITY;
  }

  const method = (request.method ?? '').toUpperCase();

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return READ_CAPABILITY;
  }

  return method === 'DELETE' ? FULL_CAPABILITY : WRITE_CAPABILITY;
}

/**
 * Capability enforcement for api-key principals — the second axis, run alongside
 * {@link enforceApiKeyScopes} from the same guards.
 *
 * Scopes decide WHICH routes a key may reach; capability decides what it may do when it gets
 * there. Every operation a key can reach is vetted: a route that declares `@RequireCapability`
 * requires that level, and one that declares nothing requires the level its shape implies
 * ({@link capabilityImpliedByShape}: queries and GETs read, mutations and other verbs write,
 * an HTTP DELETE needs full).
 *
 * This used to be opt-in per route, and 334 GraphQL operations plus 74 REST writes declared
 * nothing, so a key issued as "read-only" could run every mutation. The shape rule closes all of
 * them at once and stays closed for routes added later; the decorator remains the way to say a
 * route is an exception, in either direction.
 */
export function enforceApiKeyCapability(
  reflector: Reflector,
  context: ExecutionContext,
  request: ApiKeyScopedRequest,
): void {
  // Not an api-key principal (session/JWT/Portal) → full user authority, nothing to enforce.
  if (request.apiKeyScopes === undefined) {
    return;
  }

  const declared = reflector.getAllAndOverride<ApiKeyCapability | undefined>(REQUIRE_CAPABILITY_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);
  const required = declared ?? capabilityImpliedByShape(context, request);

  const capability = apiKeyCapabilityOf(request);

  if (!capabilitySatisfies(capability, required)) {
    throw new ForbiddenException(
      `This API key is "${capability}" and cannot perform this action, which requires "${required}" access`,
    );
  }
}

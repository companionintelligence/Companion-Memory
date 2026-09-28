import { InternalServerErrorException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { REQUIRE_SCOPES_KEY } from '@ci/common/decorators';

import { ApiKeyGuard } from '../ApiKeyGuard';

/**
 * `ApiKeyGuard extends AuthGuard('api-key')` and layers deny-by-default scope/
 * capability enforcement on top — untested before this file. Simpler than
 * `JwtOrApiKeyAuthGuard` (no portal short-circuit), but the same two things
 * were unverified: the `getRequest` context dispatch, and that scope
 * enforcement runs if-and-only-if the underlying strategy actually
 * authenticated (`ok === true`).
 */

function httpContext(req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

function graphqlContext(req: unknown): ExecutionContext {
  return {
    getType: () => 'graphql',
    getArgs: () => [{}, {}, { req }, {}],
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

function unsupportedContext(): ExecutionContext {
  return { getType: () => 'ws' } as unknown as ExecutionContext;
}

/** See JwtOrApiKeyAuthGuard.test.ts for why this discriminates by metadata key. */
function makeReflector(requiredScopes?: string[]): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) => (key === REQUIRE_SCOPES_KEY ? requiredScopes : undefined)),
  } as unknown as Reflector;
}

function spyOnMixinCanActivate() {
  return jest.spyOn(Object.getPrototypeOf(ApiKeyGuard.prototype), 'canActivate');
}

describe('ApiKeyGuard.getRequest', () => {
  const guard = new ApiKeyGuard(makeReflector());

  it('returns the request for an http context', () => {
    const req = { headers: {} };
    expect(guard.getRequest(httpContext(req))).toBe(req);
  });

  it('returns req from the GraphQL context for a graphql context', () => {
    const req = { headers: {} };
    expect(guard.getRequest(graphqlContext(req))).toBe(req);
  });

  it('throws InternalServerErrorException when the GraphQL context carries no req', () => {
    expect(() => guard.getRequest(graphqlContext(null))).toThrow(InternalServerErrorException);
    expect(() => guard.getRequest(graphqlContext(null))).toThrow(/Request object not found/);
  });

  it('throws InternalServerErrorException naming the guard and the unsupported context type', () => {
    expect(() => guard.getRequest(unsupportedContext())).toThrow(InternalServerErrorException);
    expect(() => guard.getRequest(unsupportedContext())).toThrow(
      /ApiKeyGuard does not support context type: ws/,
    );
  });
});

describe('ApiKeyGuard.canActivate — scope enforcement gated on strategy success', () => {
  afterEach(() => jest.restoreAllMocks());

  it('DENIES a scope-limited key missing a route-required scope once the strategy authenticates', async () => {
    spyOnMixinCanActivate().mockResolvedValue(true);
    const guard = new ApiKeyGuard(makeReflector(['memory']));
    const req = { headers: {}, method: 'GET', apiKeyScopes: ['other'] };

    await expect(guard.canActivate(httpContext(req))).rejects.toThrow(/scope/i);
  });

  it('allows a scope-limited key that carries the required scope', async () => {
    spyOnMixinCanActivate().mockResolvedValue(true);
    const guard = new ApiKeyGuard(makeReflector(['memory']));
    const req = { headers: {}, method: 'GET', apiKeyScopes: ['memory'] };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);
  });

  it('does NOT run scope enforcement when the underlying strategy rejected (ok=false)', async () => {
    spyOnMixinCanActivate().mockResolvedValue(false);
    const guard = new ApiKeyGuard(makeReflector(['memory']));
    // If enforcement ran regardless, this would reject with ForbiddenException
    // rather than resolving to false.
    const req = { headers: {}, method: 'GET', apiKeyScopes: ['other'] };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(false);
  });

  it('propagates the strategy result unchanged when the request is not scope-limited (full-authority key)', async () => {
    spyOnMixinCanActivate().mockResolvedValue(true);
    const guard = new ApiKeyGuard(makeReflector(['memory']));
    // apiKeyScopes: [] — an empty-scope (legacy/full-access) key, unaffected by
    // deny-by-default scoping even on a route that requires one.
    const req = { headers: {}, method: 'GET', apiKeyScopes: [] };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);
  });
});

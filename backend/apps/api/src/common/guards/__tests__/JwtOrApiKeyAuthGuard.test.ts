import { InternalServerErrorException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { REQUIRE_SCOPES_KEY } from '@ci/common/decorators';

import { JwtOrApiKeyAuthGuard } from '../JwtOrApiKeyAuthGuard';
import type { PortalTokenVerifier } from '../PortalTokenVerifier';

/**
 * Nothing exercised this guard's OWN branching logic before this file — the
 * e2e route tests that touch it only ever hit its HTTP happy path. Untested
 * before now: the `getRequest` GraphQL/HTTP/unsupported-context dispatch (the
 * `InternalServerErrorException` for an unrecognized context type and for a
 * missing GraphQL req), `handleRequest`'s err/no-user → `UnauthorizedException`,
 * and — the one most worth pinning down — the ORDERING between the
 * portal-brokered short-circuit and the legacy JWT/api-key fallback: a portal
 * token must win outright (no fallback call at all), while a disabled/absent/
 * invalid portal token must fall through cleanly, every time.
 */

function httpContext(req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

/** Mimics what `GqlExecutionContext.create` sees: resolver args `(root, args, context, info)`. */
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

/**
 * `getAllAndOverride` is called twice inside `canActivate` — once for
 * `REQUIRE_SCOPES_KEY` (enforceApiKeyScopes) and once for
 * `REQUIRE_CAPABILITY_KEY` (enforceApiKeyCapability). A single flat
 * `mockReturnValue` would answer BOTH calls with the same value, which fed the
 * scopes array back as a capability and tripped capability enforcement too —
 * so this discriminates by which metadata key was asked for, leaving
 * capability unset (undefined = "no capability requirement") unless a test
 * says otherwise.
 */
function makeReflector(requiredScopes?: string[]): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) => (key === REQUIRE_SCOPES_KEY ? requiredScopes : undefined)),
  } as unknown as Reflector;
}

function makePortal(overrides: Partial<PortalTokenVerifier> = {}): PortalTokenVerifier {
  return {
    enabled: false,
    verifyAndProvision: jest.fn().mockResolvedValue(null),
    verifyClaims: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

/**
 * `JwtOrApiKeyAuthGuard extends AuthGuard(['jwt', 'api-key'])` — spying on the
 * mixin's OWN `canActivate` (one level up the prototype chain from the guard's
 * override) is what `super.canActivate(context)` resolves to at runtime, so
 * this intercepts the legacy-strategy fallback without booting real passport
 * strategies.
 */
function spyOnMixinCanActivate() {
  return jest.spyOn(Object.getPrototypeOf(JwtOrApiKeyAuthGuard.prototype), 'canActivate');
}

describe('JwtOrApiKeyAuthGuard.getRequest', () => {
  const guard = new JwtOrApiKeyAuthGuard(makePortal(), makeReflector());

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
      /JwtOrApiKeyAuthGuard does not support context type: ws/,
    );
  });
});

describe('JwtOrApiKeyAuthGuard.handleRequest', () => {
  const guard = new JwtOrApiKeyAuthGuard(makePortal(), makeReflector());

  it('throws UnauthorizedException when passport reports an error, even with a user present', () => {
    expect(() => guard.handleRequest(new Error('boom'), { id: 'u1' })).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when there is no user and no error', () => {
    expect(() => guard.handleRequest(null, null)).toThrow(UnauthorizedException);
  });

  it('returns the user unchanged when there is no error', () => {
    const user = { id: 'u1' };
    expect(guard.handleRequest(null, user)).toBe(user);
  });
});

describe('JwtOrApiKeyAuthGuard.canActivate — portal short-circuit ordering', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a valid portal token short-circuits to true WITHOUT ever calling the JWT/api-key fallback', async () => {
    const spy = spyOnMixinCanActivate();
    const user = { id: 'portal-user' };
    const portal = makePortal({ enabled: true, verifyAndProvision: jest.fn().mockResolvedValue(user) });
    const guard = new JwtOrApiKeyAuthGuard(portal, makeReflector());
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer good-token' } };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);

    expect(spy).not.toHaveBeenCalled();
    expect(req.user).toBe(user);
    expect(portal.verifyAndProvision).toHaveBeenCalledWith('good-token');
  });

  it('falls through to the JWT/api-key strategies when portal auth is disabled', async () => {
    const spy = spyOnMixinCanActivate().mockResolvedValue(true);
    const portal = makePortal({ enabled: false });
    const guard = new JwtOrApiKeyAuthGuard(portal, makeReflector());
    const req = { headers: { authorization: 'Bearer some-token' } };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);

    expect(portal.verifyAndProvision).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('falls through when portal is enabled but no bearer token is present on the request', async () => {
    const spy = spyOnMixinCanActivate().mockResolvedValue(true);
    const portal = makePortal({ enabled: true });
    const guard = new JwtOrApiKeyAuthGuard(portal, makeReflector());
    const req = { headers: {} };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);

    expect(portal.verifyAndProvision).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('falls through when the portal token does not verify (verifyAndProvision returns null)', async () => {
    const spy = spyOnMixinCanActivate().mockResolvedValue(true);
    const portal = makePortal({ enabled: true, verifyAndProvision: jest.fn().mockResolvedValue(null) });
    const guard = new JwtOrApiKeyAuthGuard(portal, makeReflector());
    const req = { headers: { authorization: 'Bearer bad-token' } };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);

    expect(portal.verifyAndProvision).toHaveBeenCalledWith('bad-token');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('JwtOrApiKeyAuthGuard.canActivate — scope enforcement runs only when the fallback authenticated', () => {
  afterEach(() => jest.restoreAllMocks());

  it('DENIES a scope-limited key missing a route-required scope, once the fallback returns ok=true', async () => {
    spyOnMixinCanActivate().mockResolvedValue(true);
    const reflector = makeReflector(['memory']); // route requires 'memory'
    const guard = new JwtOrApiKeyAuthGuard(makePortal(), reflector);
    const req = { headers: {}, method: 'GET', apiKeyScopes: ['other'] };

    await expect(guard.canActivate(httpContext(req))).rejects.toThrow(/scope/i);
  });

  it('allows a scope-limited key that DOES carry the required scope', async () => {
    spyOnMixinCanActivate().mockResolvedValue(true);
    const reflector = makeReflector(['memory']);
    const guard = new JwtOrApiKeyAuthGuard(makePortal(), reflector);
    const req = { headers: {}, method: 'GET', apiKeyScopes: ['memory'] };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);
  });

  it('does NOT run scope enforcement when the fallback strategy rejected (ok=false)', async () => {
    spyOnMixinCanActivate().mockResolvedValue(false);
    const reflector = makeReflector(['memory']);
    const guard = new JwtOrApiKeyAuthGuard(makePortal(), reflector);
    // If enforcement ran regardless of `ok`, this would throw ForbiddenException
    // instead of resolving to false.
    const req = { headers: {}, method: 'GET', apiKeyScopes: ['other'] };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(false);
  });
});

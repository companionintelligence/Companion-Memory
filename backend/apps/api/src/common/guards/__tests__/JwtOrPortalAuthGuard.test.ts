import { InternalServerErrorException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';

import { JwtOrPortalAuthGuard } from '../JwtOrPortalAuthGuard';
import type { PortalTokenVerifier } from '../PortalTokenVerifier';

/**
 * This guard deliberately accepts a session JWT or a portal OIDC bearer and
 * NOT an api key (see the class doc — credential-management routes must stay
 * anchored to an interactive sign-in). Nothing exercised its own branching
 * before this file: the `getRequest` context dispatch, `handleRequest`'s
 * err/no-user rejection, and — the part worth pinning down precisely — that
 * the portal short-circuit and the legacy JWT fallback never both fire for one
 * request.
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

function makePortal(overrides: Partial<PortalTokenVerifier> = {}): PortalTokenVerifier {
  return {
    enabled: false,
    verifyAndProvision: jest.fn().mockResolvedValue(null),
    verifyClaims: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

/** Intercepts `super.canActivate(context)` — the `AuthGuard('jwt')` mixin's own method. */
function spyOnMixinCanActivate() {
  return jest.spyOn(Object.getPrototypeOf(JwtOrPortalAuthGuard.prototype), 'canActivate');
}

describe('JwtOrPortalAuthGuard.getRequest', () => {
  const guard = new JwtOrPortalAuthGuard(makePortal());

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
      /JwtOrPortalAuthGuard does not support context type: ws/,
    );
  });
});

describe('JwtOrPortalAuthGuard.handleRequest', () => {
  const guard = new JwtOrPortalAuthGuard(makePortal());

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

describe('JwtOrPortalAuthGuard.canActivate — portal short-circuit vs. JWT fallback', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a valid portal token short-circuits to true WITHOUT ever calling the JWT fallback', async () => {
    const spy = spyOnMixinCanActivate();
    const user = { id: 'portal-user' };
    const portal = makePortal({ enabled: true, verifyAndProvision: jest.fn().mockResolvedValue(user) });
    const guard = new JwtOrPortalAuthGuard(portal);
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer good-token' } };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);

    expect(spy).not.toHaveBeenCalled();
    expect(req.user).toBe(user);
  });

  it('falls through to the JWT strategy when portal auth is disabled', async () => {
    const spy = spyOnMixinCanActivate().mockResolvedValue(true);
    const portal = makePortal({ enabled: false });
    const guard = new JwtOrPortalAuthGuard(portal);
    const req = { headers: { authorization: 'Bearer some-token' } };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);

    expect(portal.verifyAndProvision).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('falls through when portal is enabled but no bearer token is present', async () => {
    const spy = spyOnMixinCanActivate().mockResolvedValue(true);
    const portal = makePortal({ enabled: true });
    const guard = new JwtOrPortalAuthGuard(portal);
    const req = { headers: {} };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);

    expect(portal.verifyAndProvision).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('falls through when the portal token does not verify (verifyAndProvision returns null)', async () => {
    const spy = spyOnMixinCanActivate().mockResolvedValue(true);
    const portal = makePortal({ enabled: true, verifyAndProvision: jest.fn().mockResolvedValue(null) });
    const guard = new JwtOrPortalAuthGuard(portal);
    const req = { headers: { authorization: 'Bearer bad-token' } };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(true);

    expect(portal.verifyAndProvision).toHaveBeenCalledWith('bad-token');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('propagates a JWT-fallback rejection unchanged (no api-key path exists here to rescue it)', async () => {
    const spy = spyOnMixinCanActivate().mockResolvedValue(false);
    const portal = makePortal({ enabled: false });
    const guard = new JwtOrPortalAuthGuard(portal);
    const req = { headers: {} };

    await expect(guard.canActivate(httpContext(req))).resolves.toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

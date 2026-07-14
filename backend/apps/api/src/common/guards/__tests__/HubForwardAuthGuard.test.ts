const hubForwardAuth = {
  enabled: true,
  secret: 'shared-secret',
  maxSkewMs: 300000,
};

jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      auth: {
        ...actual.auth,
        get hubForwardAuth() {
          return hubForwardAuth;
        },
      },
    },
  };
});

import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';

import { signForwardAuthUser } from '@ci/common/crypto';

import { HubForwardAuthGuard } from '../HubForwardAuthGuard';

function contextWithHeaders(headers: Record<string, string | undefined>): {
  ctx: ExecutionContext;
  req: { headers: Record<string, string | undefined>; hubForwardAuthUser?: string };
} {
  const req = { headers } as { headers: Record<string, string | undefined>; hubForwardAuthUser?: string };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;

  return { ctx, req };
}

function signedHeaders(username: string, secret = 'shared-secret', now = Date.now()) {
  return {
    'x-ci-hub-user': username,
    'x-ci-hub-user-timestamp': String(now),
    'x-ci-hub-user-signature': signForwardAuthUser(secret, username, now),
  };
}

describe('HubForwardAuthGuard', () => {
  let guard: HubForwardAuthGuard;

  beforeEach(() => {
    guard = new HubForwardAuthGuard();
    hubForwardAuth.enabled = true;
    hubForwardAuth.secret = 'shared-secret';
    hubForwardAuth.maxSkewMs = 300000;
  });

  it('allows a request carrying a validly signed header and attaches the username', () => {
    const { ctx, req } = contextWithHeaders(signedHeaders('alice'));
    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.hubForwardAuthUser).toBe('alice');
  });

  it('rejects a FORGED header (signed with a secret the attacker guessed)', () => {
    const { ctx } = contextWithHeaders(signedHeaders('admin', 'attacker-secret'));
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('rejects an unsigned header (only x-ci-hub-user set, as the old Hub sent)', () => {
    const { ctx } = contextWithHeaders({ 'x-ci-hub-user': 'admin' });
    expect(() => guard.canActivate(ctx)).toThrow(/missing_headers/);
  });

  it('rejects when a real signature is reused with a swapped username', () => {
    const headers = signedHeaders('alice');
    headers['x-ci-hub-user'] = 'admin';
    const { ctx } = contextWithHeaders(headers);
    expect(() => guard.canActivate(ctx)).toThrow(/bad_signature/);
  });

  it('fails closed when the feature is disabled', () => {
    hubForwardAuth.enabled = false;
    const { ctx } = contextWithHeaders(signedHeaders('alice'));
    expect(() => guard.canActivate(ctx)).toThrow(/not enabled/);
  });
});

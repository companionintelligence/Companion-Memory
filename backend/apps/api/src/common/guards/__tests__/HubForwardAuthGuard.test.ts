const hubForwardAuth = {
  enabled: true,
  secret: 'shared-secret',
  identitySecret: '',
  audience: '',
  requireAudience: 'auto' as const,
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

import { formatForwardAuthAssertion, signForwardAuthAssertion, signForwardAuthUser } from '@ci/common/crypto';

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
    hubForwardAuth.identitySecret = '';
    hubForwardAuth.audience = '';
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

  describe('once the Hub has given this app its own key', () => {
    const audience = 'ci-memory:ci-marketplace';
    const nonce = 'nB7cS0fTq3kz1XyH9wA2eQ';

    function boundHeaders(username: string, forAudience = audience) {
      const now = Date.now();
      const signature = signForwardAuthAssertion('memory-own-secret', forAudience, nonce, now, username);

      return {
        ...signedHeaders(username, 'shared-secret', now),
        'x-ci-hub-user-assertion': formatForwardAuthAssertion(nonce, signature),
      };
    }

    beforeEach(() => {
      hubForwardAuth.identitySecret = 'memory-own-secret';
      hubForwardAuth.audience = audience;
    });

    it('accepts the bound assertion', () => {
      const { ctx, req } = contextWithHeaders(boundHeaders('alice'));
      expect(guard.canActivate(ctx)).toBe(true);
      expect(req.hubForwardAuthUser).toBe('alice');
    });

    it('rejects headers signed only with the shared secret', () => {
      const { ctx } = contextWithHeaders(signedHeaders('alice'));
      expect(() => guard.canActivate(ctx)).toThrow(/unbound/);
    });

    it('rejects an assertion signed for another app', () => {
      const { ctx } = contextWithHeaders(boundHeaders('alice', 'importer:ci-marketplace'));
      expect(() => guard.canActivate(ctx)).toThrow(/bad_signature/);
    });
  });
});

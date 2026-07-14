const hubForwardAuth = { enabled: true, secret: 'shared-secret', maxSkewMs: 60000 };

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

import { type ExecutionContext } from '@nestjs/common';

import {
  CONNECT_NONCE_HEADER,
  CONNECT_SIGNATURE_HEADER,
  CONNECT_TIMESTAMP_HEADER,
  signConnectRequest,
} from '@ci/common/crypto';

import { ConnectRequestAuthGuard } from '../guards/ConnectRequestAuthGuard';

function ctxFor(req: {
  method: string;
  originalUrl: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

function signedRequest(opts: {
  method?: string;
  path?: string;
  body?: unknown;
  nonce?: string;
  now?: number;
  secret?: string;
}) {
  const method = opts.method ?? 'POST';
  const path = opts.path ?? '/api/connect/revoke';
  const body = opts.body ?? { app: 'ci-openclaw:local' };
  const nonce = opts.nonce ?? Math.random().toString(16).slice(2);
  const ts = opts.now ?? Date.now();
  const sig = signConnectRequest(opts.secret ?? 'shared-secret', method, path, ts, nonce, body);

  return ctxFor({
    method,
    originalUrl: path,
    body,
    headers: {
      [CONNECT_TIMESTAMP_HEADER]: String(ts),
      [CONNECT_NONCE_HEADER]: nonce,
      [CONNECT_SIGNATURE_HEADER]: sig,
    },
  });
}

describe('ConnectRequestAuthGuard', () => {
  let guard: ConnectRequestAuthGuard;

  beforeEach(() => {
    guard = new ConnectRequestAuthGuard();
    hubForwardAuth.enabled = true;
    hubForwardAuth.secret = 'shared-secret';
    hubForwardAuth.maxSkewMs = 60000;
  });

  it('allows a validly signed request', () => {
    expect(guard.canActivate(signedRequest({}))).toBe(true);
  });

  it('rejects a replay of the same nonce (single-use)', () => {
    const ctx = signedRequest({ nonce: 'fixed-nonce' });
    expect(guard.canActivate(ctx)).toBe(true);
    // A second request reusing the same nonce (even freshly signed) is rejected.
    const replay = signedRequest({ nonce: 'fixed-nonce' });
    expect(() => guard.canActivate(replay)).toThrow(/replay/i);
  });

  it('rejects a body swap (signature binds the body hash)', () => {
    // Sign for app X, then present app Y with the same signature/nonce.
    const ts = Date.now();
    const sig = signConnectRequest('shared-secret', 'POST', '/api/connect/revoke', ts, 'n1', {
      app: 'victim:local',
    });
    const ctx = ctxFor({
      method: 'POST',
      originalUrl: '/api/connect/revoke',
      body: { app: 'attacker-target:local' },
      headers: {
        [CONNECT_TIMESTAMP_HEADER]: String(ts),
        [CONNECT_NONCE_HEADER]: 'n1',
        [CONNECT_SIGNATURE_HEADER]: sig,
      },
    });
    expect(() => guard.canActivate(ctx)).toThrow(/bad_signature/);
  });

  it('rejects a path swap (signature binds the path)', () => {
    const ts = Date.now();
    const sig = signConnectRequest('shared-secret', 'POST', '/api/connect/revoke', ts, 'n2', {
      app: 'x:local',
    });
    const ctx = ctxFor({
      method: 'POST',
      originalUrl: '/api/connect/exchange', // different endpoint, same signature
      body: { app: 'x:local' },
      headers: {
        [CONNECT_TIMESTAMP_HEADER]: String(ts),
        [CONNECT_NONCE_HEADER]: 'n2',
        [CONNECT_SIGNATURE_HEADER]: sig,
      },
    });
    expect(() => guard.canActivate(ctx)).toThrow(/bad_signature/);
  });

  it('rejects an expired timestamp', () => {
    expect(() => guard.canActivate(signedRequest({ now: Date.now() - 5 * 60 * 1000 }))).toThrow(/expired/);
  });

  it('rejects a forged signature (wrong secret)', () => {
    expect(() => guard.canActivate(signedRequest({ secret: 'attacker' }))).toThrow(/bad_signature/);
  });

  it('rejects missing headers', () => {
    const ctx = ctxFor({ method: 'POST', originalUrl: '/api/connect/revoke', body: {}, headers: {} });
    expect(() => guard.canActivate(ctx)).toThrow(/missing_headers/);
  });

  it('fails closed when the feature is disabled', () => {
    hubForwardAuth.enabled = false;
    expect(() => guard.canActivate(signedRequest({}))).toThrow(/not enabled/);
  });
});

import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import type { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { AuthService } from '../../services/AuthService';
import { type CsrfService, CsrfValidationError } from '../../services/CsrfService';
import { CsrfGuard } from '../CsrfGuard';

const CSRF_COOKIE = config.auth.cookies.csrfTokenName;
const SESSION_COOKIE = config.auth.cookies.sessionTokenName;
const SID = '0198a5c2-0000-7abc-8def-0123456789ab';

const jwtService = new JwtService({});

/** Sign a session-cookie JWT with the real refresh secret. */
function sessionJwt(payload: Record<string, unknown>, expiresIn = '7d', secret?: string): string {
  return jwtService.sign(payload, {
    secret: secret ?? config.auth.jwt.refreshTokenSecret,
    expiresIn,
  });
}

function ctxFor(req: {
  cookies?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  method?: string;
  path?: string;
}): ExecutionContext {
  const request = {
    cookies: req.cookies ?? {},
    headers: req.headers ?? {},
    method: req.method ?? 'POST',
    path: req.path ?? '/authenticate/refresh',
  };

  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

/**
 * Unit tests for the CSRF guard's principal resolution and logging. The guard
 * composes a REAL AuthService (real JWT verification, so the session-cookie →
 * scope mapping is exercised end to end; the session repository is never
 * touched by resolveCsrfScope) with a mocked CsrfService, whose own binding
 * matrix is unit-tested separately.
 */
describe('CsrfGuard', () => {
  const mockCsrfService = {
    validateToken: jest.fn(),
  };

  const mockLogger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  // resolveCsrfScope never touches the repository, so a bare object suffices.
  const authService = new AuthService(jwtService, {} as never);

  let guard: CsrfGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCsrfService.validateToken.mockImplementation(() => undefined);
    guard = new CsrfGuard(
      mockCsrfService as unknown as CsrfService,
      authService,
      mockLogger as unknown as LoggerService,
    );
  });

  it('resolves the session id from the session cookie and passes it to validateToken', () => {
    const ctx = ctxFor({
      cookies: {
        [SESSION_COOKIE]: sessionJwt({ sub: 'user-1', sid: SID }),
        [CSRF_COOKIE]: 'cookie-token',
      },
      headers: { 'x-csrf-token': 'header-token' },
    });

    expect(guard.canActivate(ctx)).toBe(true);
    expect(mockCsrfService.validateToken).toHaveBeenCalledWith('cookie-token', 'header-token', SID);
  });

  it('resolves the anon scope (null) when there is no session cookie', () => {
    const ctx = ctxFor({
      cookies: { [CSRF_COOKIE]: 'cookie-token' },
      headers: { 'x-csrf-token': 'header-token' },
    });

    expect(guard.canActivate(ctx)).toBe(true);
    expect(mockCsrfService.validateToken).toHaveBeenCalledWith('cookie-token', 'header-token', null);
  });

  it('resolves the anon scope for a garbage session cookie', () => {
    // An unverifiable cookie must not 500 and must not be trusted for a scope.
    for (const garbage of ['not-a-jwt', '', { j: 'son' }, sessionJwt({ sub: 'u' }, '7d', 'wrong-secret')]) {
      mockCsrfService.validateToken.mockClear();

      const ctx = ctxFor({
        cookies: { [SESSION_COOKIE]: garbage, [CSRF_COOKIE]: 'cookie-token' },
        headers: { 'x-csrf-token': 'header-token' },
      });

      expect(guard.canActivate(ctx)).toBe(true);
      expect(mockCsrfService.validateToken).toHaveBeenCalledWith('cookie-token', 'header-token', null);
    }
  });

  it('resolves the anon scope for a legacy sid-less session JWT', () => {
    // Pre-binding session cookies carry only `sub`. They map to the anon scope
    // until their first refresh rotation embeds a sid.
    const ctx = ctxFor({
      cookies: {
        [SESSION_COOKIE]: sessionJwt({ sub: 'user-1' }),
        [CSRF_COOKIE]: 'cookie-token',
      },
      headers: { 'x-csrf-token': 'header-token' },
    });

    expect(guard.canActivate(ctx)).toBe(true);
    expect(mockCsrfService.validateToken).toHaveBeenCalledWith('cookie-token', 'header-token', null);
  });

  it('still yields the sid for an EXPIRED but validly-signed session JWT', () => {
    // CSRF scope identifies the minting principal; session validity is enforced
    // where sessions are consumed. Strict expiry here would 403 the very
    // /authenticate/refresh call an expired-session SPA makes to recover — and
    // burn its one-shot 403 retry on a request that could never succeed.
    const ctx = ctxFor({
      cookies: {
        [SESSION_COOKIE]: sessionJwt({ sub: 'user-1', sid: SID }, '-1h'),
        [CSRF_COOKIE]: 'cookie-token',
      },
      headers: { 'x-csrf-token': 'header-token' },
    });

    expect(guard.canActivate(ctx)).toBe(true);
    expect(mockCsrfService.validateToken).toHaveBeenCalledWith('cookie-token', 'header-token', SID);
  });

  it('logs the rejection reason (never the tokens or the sid) and rethrows the 403', () => {
    mockCsrfService.validateToken.mockImplementation(() => {
      throw new CsrfValidationError('session-mismatch', 'CSRF token is not bound to this session');
    });

    const ctx = ctxFor({
      cookies: {
        [SESSION_COOKIE]: sessionJwt({ sub: 'user-1', sid: SID }),
        [CSRF_COOKIE]: 'cookie-token-value',
      },
      headers: { 'x-csrf-token': 'header-token-value' },
      method: 'POST',
      path: '/authenticate/refresh',
    });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    const [message, data] = mockLogger.warn.mock.calls[0] as [string, Record<string, unknown>];

    expect(data).toEqual({
      reason: 'session-mismatch',
      method: 'POST',
      path: '/authenticate/refresh',
      authed: true,
    });

    // Neither half of the double-submit pair nor the session id may reach the
    // logs — they are credentials (or halves of one).
    const logged = JSON.stringify([message, data]);
    expect(logged).not.toContain('cookie-token-value');
    expect(logged).not.toContain('header-token-value');
    expect(logged).not.toContain(SID);
  });

  it('marks pre-auth rejections authed: false', () => {
    mockCsrfService.validateToken.mockImplementation(() => {
      throw new CsrfValidationError('missing', 'Missing CSRF token');
    });

    expect(() => guard.canActivate(ctxFor({ path: '/authenticate' }))).toThrow(ForbiddenException);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'CSRF validation failed',
      expect.objectContaining({ reason: 'missing', authed: false }),
    );
  });

  it('rethrows a non-CSRF fault without logging it as a CSRF rejection', () => {
    mockCsrfService.validateToken.mockImplementation(() => {
      throw new TypeError('unexpected fault');
    });

    expect(() => guard.canActivate(ctxFor({}))).toThrow(TypeError);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

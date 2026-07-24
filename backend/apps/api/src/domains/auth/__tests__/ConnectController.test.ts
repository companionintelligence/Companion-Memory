import {
  ForbiddenException,
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { LoggerService } from '@ci/common/logging';
import { BodyParserMiddleware } from '@ci/common/middleware';
import config from '@ci/configuration';

import { ConnectController } from '../controllers/ConnectController';
import { ConnectRequestAuthGuard } from '../guards/ConnectRequestAuthGuard';
import { CsrfGuard } from '../guards/CsrfGuard';
import { AuthService } from '../services/AuthService';
import { ConnectService } from '../services/ConnectService';
import { CsrfService, CsrfValidationError } from '../services/CsrfService';

const SESSION_COOKIE = config.auth.cookies.sessionTokenName;
const RETURN_URL = 'https://hub.example.com/apps/urn:app:x/memory-connect/callback';

const mockConnectService = {
  resolveSessionUser: jest.fn(),
  isReturnUrlAllowed: jest.fn(),
  approve: jest.fn(),
  exchange: jest.fn(),
  revokeByApp: jest.fn(),
  rotateByApp: jest.fn(),
  buildReturnUrl: jest.fn(),
  buildDenyUrl: jest.fn(),
};

const mockAuthService = {
  resolveCsrfScope: jest.fn().mockReturnValue(null),
};

const mockCsrfService = {
  generateToken: jest.fn().mockReturnValue('csrf-token-value'),
  // No-op by default (valid). Individual tests override to throw for the
  // mismatch case.
  validateToken: jest.fn(),
  verifyToken: jest.fn().mockReturnValue(true),
  // Mirrors the real reuse-if-valid implementation on top of the mocked
  // primitives, so tests steer behavior via verifyToken/generateToken (scope
  // matching itself is unit-tested in CsrfService.test.ts). The explicit
  // return type is required: the body references `mockCsrfService` while it is
  // still being initialised, so inference would be circular.
  ensureToken: jest.fn((value: unknown, _sessionId: string | null): string =>
    value && mockCsrfService.verifyToken(value)
      ? (value as string)
      : mockCsrfService.generateToken(_sessionId),
  ),
};

const mockLogger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};

@Module({
  controllers: [ConnectController],
  providers: [
    { provide: ConnectService, useValue: mockConnectService },
    { provide: CsrfService, useValue: mockCsrfService },
    { provide: AuthService, useValue: mockAuthService },
    { provide: LoggerService, useValue: mockLogger },
  ],
})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(BodyParserMiddleware).forRoutes('*');
  }
}

/**
 * HTTP-level tests for the connect endpoints. ConnectService and CsrfService are
 * mocked (their logic is unit-tested separately) and the forward-auth guard is
 * overridden to true, so these tests focus on the controller's routing,
 * validation, session gating, CSRF check, and redirect behaviour. The consent
 * "Allow" flow is a no-JS form POST that 302-redirects back to CI-Hub.
 */
describe('ConnectController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [TestModule] })
      .overrideGuard(CsrfGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ConnectRequestAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication({ bodyParser: false, logger: false });
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnectService.isReturnUrlAllowed.mockReturnValue(true);
    mockConnectService.buildReturnUrl.mockImplementation(
      (url: string, code: string, state: string) => `${url}?code=${code}&state=${state}`,
    );
    mockConnectService.buildDenyUrl.mockImplementation(
      (url: string, state: string, error = 'access_denied') => `${url}?error=${error}&state=${state}`,
    );
    // Valid CSRF by default; the mismatch test overrides this to throw.
    mockCsrfService.generateToken.mockReturnValue('csrf-token-value');
    mockCsrfService.validateToken.mockImplementation(() => undefined);
    mockCsrfService.verifyToken.mockReturnValue(true);
    mockAuthService.resolveCsrfScope.mockReturnValue(null);
  });

  describe('GET /connect', () => {
    it('400s when required params are missing', async () => {
      await request(app.getHttpServer()).get('/connect').query({ app: 'urn:app:x' }).expect(400);
    });

    it('400s when the return URL origin is not allowlisted', async () => {
      mockConnectService.isReturnUrlAllowed.mockReturnValue(false);

      await request(app.getHttpServer())
        .get('/connect')
        .query({ app: 'urn:app:x', state: 's', return: 'https://evil.example.com/cb' })
        .expect(400);

      expect(mockConnectService.resolveSessionUser).not.toHaveBeenCalled();
    });

    it('redirects to OIDC sign-in (returning to itself) when there is no session', async () => {
      mockConnectService.resolveSessionUser.mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .get('/connect')
        .query({ app: 'urn:app:x', state: 's', return: RETURN_URL })
        .expect(302);

      expect(res.headers.location).toContain('/api/authenticate/oidc?redirect=');
      expect(decodeURIComponent(res.headers.location)).toContain('/api/connect?');
    });

    it('does NOT carry csrf_retry through the OIDC sign-in bounce', async () => {
      // Signing in mints a fresh csrf cookie (OidcController.finishLogin), so the
      // page rendered afterwards is a genuine first attempt whose token matches
      // by construction. Forwarding a spent retry budget onto it would make its
      // first real mismatch dead-end instead of self-healing.
      mockConnectService.resolveSessionUser.mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .get('/connect')
        .query({ app: 'urn:app:x', state: 's', return: RETURN_URL, csrf_retry: '1' })
        .expect(302);

      const redirectTarget = decodeURIComponent(res.headers.location.split('redirect=')[1]);
      expect(redirectTarget).toContain('/api/connect?');
      expect(redirectTarget).not.toContain('csrf_retry');
    });

    it('ignores a duplicated query key instead of crashing on the array', async () => {
      // Express yields an array for repeated keys, so an unguarded `.trim()` on
      // app_name (or escapeHtml on state) would TypeError into a 500.
      mockConnectService.resolveSessionUser.mockResolvedValue({
        userId: 'user-1',
        email: 'owner@example.com',
      });

      const res = await request(app.getHttpServer())
        .get(
          '/connect?app=urn:app:x&state=s&return=' +
            encodeURIComponent(RETURN_URL) +
            '&app_name=a&app_name=b',
        )
        .set('Cookie', [`${SESSION_COOKIE}=tok`])
        .expect(200);

      // Falls back to the URN rather than honouring either injected duplicate.
      expect(res.text).toContain('urn:app:x');
      expect(res.text).not.toContain('name="app_name"');
    });

    it('renders the no-JS consent page with anti-framing headers when signed in', async () => {
      mockConnectService.resolveSessionUser.mockResolvedValue({
        userId: 'user-1',
        email: 'owner@example.com',
      });

      const res = await request(app.getHttpServer())
        .get('/connect')
        .query({ app: 'urn:app:x', state: 's', return: RETURN_URL })
        .set('Cookie', [`${SESSION_COOKIE}=tok`])
        .expect(200);

      const csp = res.headers['content-security-policy'];
      expect(csp).toContain("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.text).toContain('Connect to Companion Memory');

      // No client JavaScript: no script-src (falls back to default-src 'none'),
      // and the page carries no <script> at all. Styles are nonce'd inline; the
      // memory logo is an inlined data: image; the Allow form posts same-origin.
      expect(csp).not.toContain('script-src');
      expect(res.text).not.toContain('<script');
      expect(csp).toContain('img-src data:');
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toContain("'unsafe-inline'");

      const styleNonce = /style-src 'nonce-([^']+)'/.exec(csp)?.[1];
      expect(styleNonce).toBeTruthy();
      expect(res.text).toContain(`<style nonce="${styleNonce}">`);

      // Allow = same-origin form with the CSRF token + hidden state; Not now =
      // a link to the CI-Hub deny URL; the Companion Memory logo is inlined.
      expect(res.text).toContain('action="/api/connect/approve"');
      expect(res.text).toContain('name="csrf"');
      expect(res.text).toContain('src="data:image/webp;base64,');
      expect(res.text).toContain('>Allow</button>');
      // The signed-in account is surfaced so it's never ambiguous which memory
      // the app is being granted access to. The address is wrapped in Cloudflare
      // `email_off` markers so the zone's email obfuscation doesn't turn it into a
      // dead "/cdn-cgi/l/email-protection" link (its decoder script is CSP-blocked).
      expect(res.text).toContain(
        'Signed in as <strong><!--email_off-->owner@example.com<!--/email_off--></strong>',
      );
      // The href is HTML-attribute-escaped (& → &amp;).
      expect(res.text).toContain(`href="${RETURN_URL}?error=access_denied&amp;state=s"`);
    });

    it('REUSES a valid existing csrf cookie instead of minting (CI-Server#1740)', async () => {
      // The embedded hidden field and the cookie must stay converged with every
      // other tab: rendering this page may not rotate the browser's token, and a
      // background session refresh may not invalidate this page. Both hold when
      // every site reuses the same valid cookie.
      mockConnectService.resolveSessionUser.mockResolvedValue({
        userId: 'user-1',
        email: 'owner@example.com',
      });
      const existingToken = 'existing-random.existing-signature';

      const res = await request(app.getHttpServer())
        .get('/connect')
        .query({ app: 'urn:app:x', state: 's', return: RETURN_URL })
        .set('Cookie', [`${SESSION_COOKIE}=tok`, `${config.auth.cookies.csrfTokenName}=${existingToken}`])
        .expect(200);

      expect(res.text).toContain(`name="csrf" value="${existingToken}"`);
      expect(mockCsrfService.generateToken).not.toHaveBeenCalled();
    });

    it('ensures the csrf token under the scope resolved from the session cookie', async () => {
      // The consent page is only rendered signed-in, so the ensured token must
      // be bound to that session — the ensure receives the resolved scope, not
      // a hardcoded anon.
      mockConnectService.resolveSessionUser.mockResolvedValue({
        userId: 'user-1',
        email: 'owner@example.com',
      });
      mockAuthService.resolveCsrfScope.mockReturnValue('session-id-1');

      await request(app.getHttpServer())
        .get('/connect')
        .query({ app: 'urn:app:x', state: 's', return: RETURN_URL })
        .set('Cookie', [`${SESSION_COOKIE}=tok`])
        .expect(200);

      expect(mockCsrfService.ensureToken).toHaveBeenCalledWith(undefined, 'session-id-1');
    });

    it('round-trips csrf_retry and app_name into the re-rendered form', async () => {
      mockConnectService.resolveSessionUser.mockResolvedValue({
        userId: 'user-1',
        email: 'owner@example.com',
      });

      const res = await request(app.getHttpServer())
        .get('/connect')
        .query({ app: 'urn:app:x', state: 's', return: RETURN_URL, app_name: 'OpenClaw', csrf_retry: '1' })
        .set('Cookie', [`${SESSION_COOKIE}=tok`])
        .expect(200);

      expect(res.text).toContain('name="app_name" value="OpenClaw"');
      expect(res.text).toContain('name="csrf_retry" value="1"');
    });
  });

  describe('POST /connect/approve', () => {
    const approveBody = { app: 'urn:app:x', state: 's', return: RETURN_URL, csrf: 'csrf-token-value' };

    it('mints and returns a meta-refresh page back to CI-Hub with the code when signed in', async () => {
      mockConnectService.resolveSessionUser.mockResolvedValue({
        userId: 'user-1',
        email: 'owner@example.com',
      });
      mockConnectService.approve.mockResolvedValue({ code: 'the-code' });

      // 200 HTML meta-refresh (not a 302): the gateway's `form-action 'self'`
      // would block a cross-origin redirect from this form POST.
      const res = await request(app.getHttpServer()).post('/connect/approve').send(approveBody).expect(200);

      expect(mockCsrfService.validateToken).toHaveBeenCalledWith(undefined, 'csrf-token-value', null);
      expect(mockConnectService.approve).toHaveBeenCalledWith('user-1', 'urn:app:x');
      // URL is HTML-escaped (& → &amp;) in the meta content + href.
      expect(res.text).toContain(
        `<meta http-equiv="refresh" content="0; url=${RETURN_URL}?code=the-code&amp;state=s"`,
      );
      expect(res.text).toContain(`href="${RETURN_URL}?code=the-code&amp;state=s"`);
    });

    it('self-heals a CSRF mismatch: 303 back to the consent GET with csrf_retry (CI-Server#1740)', async () => {
      // A stale hidden field (e.g. the cookie changed after this page rendered)
      // must NOT dead-end on raw JSON — the redirect re-renders the consent page
      // against the browser's current cookie, so one extra click recovers.
      // Thrown as the service's own CsrfValidationError (a ForbiddenException
      // subclass): the self-heal gate is `instanceof ForbiddenException`, and
      // this pins that the binding rejections still pass through it.
      mockCsrfService.validateToken.mockImplementation(() => {
        throw new CsrfValidationError('session-mismatch', 'CSRF token is not bound to this session');
      });

      const res = await request(app.getHttpServer())
        .post('/connect/approve')
        .send({ ...approveBody, csrf: 'wrong', app_name: 'OpenClaw' })
        .expect(303);

      const location = new URL(res.headers.location, 'http://localhost');
      expect(location.pathname).toBe('/api/connect');
      expect(location.searchParams.get('app')).toBe('urn:app:x');
      expect(location.searchParams.get('state')).toBe('s');
      expect(location.searchParams.get('return')).toBe(RETURN_URL);
      expect(location.searchParams.get('app_name')).toBe('OpenClaw');
      expect(location.searchParams.get('csrf_retry')).toBe('1');
      expect(mockConnectService.approve).not.toHaveBeenCalled();
    });

    it('self-heals an absent csrf field rather than dead-ending in the validation pipe', async () => {
      // `csrf` is optional in the schema on purpose, so absence reaches
      // CsrfService and takes the self-heal path instead of 400-ing in the pipe.
      mockCsrfService.validateToken.mockImplementation(() => {
        throw new ForbiddenException('Missing CSRF token');
      });

      const bodyWithoutCsrf = { app: approveBody.app, state: approveBody.state, return: approveBody.return };

      const res = await request(app.getHttpServer())
        .post('/connect/approve')
        .send(bodyWithoutCsrf)
        .expect(303);

      expect(new URL(res.headers.location, 'http://localhost').searchParams.get('csrf_retry')).toBe('1');
      expect(mockConnectService.approve).not.toHaveBeenCalled();
    });

    it('propagates a non-CSRF fault instead of mislabelling it as a cookie problem', async () => {
      // The self-heal catch must not swallow unexpected faults: a TypeError here
      // would otherwise surface to the user as "your browser is blocking
      // cookies", sending them chasing a non-existent browser setting.
      mockCsrfService.validateToken.mockImplementation(() => {
        throw new TypeError('unexpected fault');
      });

      const res = await request(app.getHttpServer())
        .post('/connect/approve')
        .send({ ...approveBody, csrf_retry: '1' })
        .expect(500);

      expect(res.text).not.toContain('blocking cookies');
      expect(mockConnectService.approve).not.toHaveBeenCalled();
    });

    it('returns the user to CI-Hub with csrf_failed when CSRF fails on the retry submission', async () => {
      // The Hub interstitial is waiting on this flow; stranding the browser on a
      // terminal error page would leave it waiting forever.
      mockConnectService.resolveSessionUser.mockResolvedValue({
        userId: 'user-1',
        email: 'owner@example.com',
      });
      mockCsrfService.validateToken.mockImplementation(() => {
        throw new ForbiddenException('CSRF token mismatch');
      });

      const res = await request(app.getHttpServer())
        .post('/connect/approve')
        .send({ ...approveBody, csrf: 'wrong', csrf_retry: '1' })
        .expect(200);

      expect(res.text).toContain(`url=${RETURN_URL}?error=csrf_failed&amp;state=s"`);
      expect(mockConnectService.approve).not.toHaveBeenCalled();
    });

    it('returns to CI-Hub rather than 303-ing into a cross-origin OIDC hop when the session is gone', async () => {
      // connect() would bounce a signed-out user to the cross-origin issuer, and
      // Chrome enforces form-action across a form submission's whole redirect
      // chain — that hop is silently refused, leaving a blank page.
      mockConnectService.resolveSessionUser.mockResolvedValue(null);
      mockCsrfService.validateToken.mockImplementation(() => {
        throw new ForbiddenException('CSRF token mismatch');
      });

      const res = await request(app.getHttpServer())
        .post('/connect/approve')
        .send({ ...approveBody, csrf: 'wrong' })
        .expect(200);

      expect(res.text).toContain(`url=${RETURN_URL}?error=login_required&amp;state=s"`);
      expect(mockConnectService.approve).not.toHaveBeenCalled();
    });

    it('sends the user back to CI-Hub with error=login_required when there is no session', async () => {
      mockConnectService.resolveSessionUser.mockResolvedValue(null);

      const res = await request(app.getHttpServer()).post('/connect/approve').send(approveBody).expect(200);

      expect(res.text).toContain(`url=${RETURN_URL}?error=login_required&amp;state=s"`);
      expect(mockConnectService.approve).not.toHaveBeenCalled();
    });

    it('sends the user back to CI-Hub with error=server_error when minting fails', async () => {
      mockConnectService.resolveSessionUser.mockResolvedValue({
        userId: 'user-1',
        email: 'owner@example.com',
      });
      mockConnectService.approve.mockRejectedValue(new Error('mint boom'));

      const res = await request(app.getHttpServer()).post('/connect/approve').send(approveBody).expect(200);

      expect(res.text).toContain(`url=${RETURN_URL}?error=server_error&amp;state=s"`);
    });

    it('400s when the return URL is not a valid URL (validation)', async () => {
      mockConnectService.resolveSessionUser.mockResolvedValue({
        userId: 'user-1',
        email: 'owner@example.com',
      });

      await request(app.getHttpServer())
        .post('/connect/approve')
        .send({ ...approveBody, return: 'not-a-url' })
        .expect(400);
    });
  });

  describe('POST /connect/exchange', () => {
    it('returns the raw key for a valid code', async () => {
      mockConnectService.exchange.mockResolvedValue({
        appUrn: 'urn:app:x',
        key: 'raw-key',
        expiresAt: '2026-10-07T00:00:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post('/connect/exchange')
        .send({ code: 'the-code' })
        .expect(201);

      expect(res.body).toEqual({
        appUrn: 'urn:app:x',
        key: 'raw-key',
        expiresAt: '2026-10-07T00:00:00.000Z',
      });
    });

    it('400s for an invalid/expired code', async () => {
      mockConnectService.exchange.mockResolvedValue(null);

      await request(app.getHttpServer()).post('/connect/exchange').send({ code: 'bad' }).expect(400);
    });
  });

  describe('POST /connect/revoke', () => {
    it('revokes by app and returns the count', async () => {
      mockConnectService.revokeByApp.mockResolvedValue(1);

      const res = await request(app.getHttpServer())
        .post('/connect/revoke')
        .send({ app: 'urn:app:x' })
        .expect(201);

      expect(mockConnectService.revokeByApp).toHaveBeenCalledWith('urn:app:x');
      expect(res.body).toEqual({ revoked: 1 });
    });
  });

  describe('POST /connect/rotate', () => {
    it('rotates the app key and returns the new key', async () => {
      mockConnectService.rotateByApp.mockResolvedValue({
        appUrn: 'urn:app:x',
        key: 'new-key',
        expiresAt: '2026-10-07T00:00:00.000Z',
      });

      const res = await request(app.getHttpServer())
        .post('/connect/rotate')
        .send({ app: 'urn:app:x' })
        .expect(201);

      expect(res.body).toEqual({
        appUrn: 'urn:app:x',
        key: 'new-key',
        expiresAt: '2026-10-07T00:00:00.000Z',
      });
    });

    it('400s when there is no connected key to rotate', async () => {
      mockConnectService.rotateByApp.mockResolvedValue(null);

      await request(app.getHttpServer()).post('/connect/rotate').send({ app: 'urn:app:x' }).expect(400);
    });
  });
});

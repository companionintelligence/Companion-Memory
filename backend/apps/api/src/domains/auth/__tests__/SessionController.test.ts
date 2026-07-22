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

import { BodyParserMiddleware } from '@ci/common/middleware';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { SessionController } from '../controllers/SessionController';
import { AuthService } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';

import { parseCookies } from './utils/parseCookies';

const COOKIE_NAME = config.auth.cookies.sessionTokenName;
const CSRF_COOKIE_NAME = config.auth.cookies.csrfTokenName;

const mockUser = { id: 'user-1', name: 'Test User', email: 'test@example.com' };

const mockAuthService = {
  issueSessionToken: jest.fn().mockResolvedValue('session-token-value'),
  issueAccessToken: jest.fn().mockReturnValue('access-token-value'),
  getSessionMetadata: jest.fn().mockReturnValue({ ip: '127.0.0.1', userAgent: 'test' }),
  validateSessionToken: jest.fn().mockReturnValue({ sub: 'user-1' }),
  rotateSessionToken: jest.fn().mockResolvedValue({ sessionToken: 'rotated-session-token' }),
  invalidateSession: jest.fn().mockResolvedValue(undefined),
};

const MOCK_CSRF_TOKEN = 'test-random.test-signature';

const mockCsrfService = {
  generateToken: jest.fn().mockReturnValue(MOCK_CSRF_TOKEN),
  validateToken: jest.fn(),
  verifyToken: jest.fn().mockReturnValue(true),
  // Mirrors the real implementation on top of the mocked primitives, so tests
  // exercise the reuse-if-valid contract by steering verifyToken/generateToken.
  // The explicit return type is required: the body references `mockCsrfService`
  // while it is still being initialised, so inference would be circular.
  ensureToken: jest.fn((value?: string): string =>
    value && mockCsrfService.verifyToken(value) ? value : mockCsrfService.generateToken(),
  ),
};

const mockUserService = {
  validatePassword: jest.fn().mockResolvedValue(mockUser),
  findById: jest.fn().mockResolvedValue(mockUser),
};

@Module({
  controllers: [SessionController],
  providers: [
    { provide: AuthService, useValue: mockAuthService },
    { provide: UserService, useValue: mockUserService },
    { provide: CsrfService, useValue: mockCsrfService },
  ],
})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(BodyParserMiddleware).forRoutes('*');
  }
}

describe('SessionController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = module.createNestApplication({
      bodyParser: false,
      logger: false,
    });

    app.use(cookieParser());

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserService.validatePassword.mockResolvedValue(mockUser);
    mockUserService.findById.mockResolvedValue(mockUser);
    mockAuthService.issueSessionToken.mockResolvedValue('session-token-value');
    mockAuthService.issueAccessToken.mockReturnValue('access-token-value');
    mockAuthService.validateSessionToken.mockReturnValue({ sub: 'user-1' });
    mockAuthService.rotateSessionToken.mockResolvedValue({ sessionToken: 'rotated-session-token' });
    mockCsrfService.generateToken.mockReturnValue(MOCK_CSRF_TOKEN);
    mockCsrfService.validateToken.mockImplementation(() => {});
    mockCsrfService.verifyToken.mockReturnValue(true);
  });

  describe('POST /authenticate (login)', () => {
    it('should set session token as httpOnly cookie on successful login', async () => {
      const response = await request(app.getHttpServer())
        .post('/authenticate')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .send({ username: 'test@example.com', password: 'password123' })
        .expect(200);

      const cookies = parseCookies(response);
      expect(cookies[COOKIE_NAME]).toBeDefined();
      expect(cookies[COOKIE_NAME].value).toBe('session-token-value');
      expect(cookies[COOKIE_NAME].httpOnly).toBe(true);
      expect(cookies[COOKIE_NAME].path).toBe('/');
    });

    it('should return access token in the response body', async () => {
      const response = await request(app.getHttpServer())
        .post('/authenticate')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .send({ username: 'test@example.com', password: 'password123' })
        .expect(200);

      expect(response.body).toEqual({ accessToken: 'access-token-value' });
    });

    it('should not return session token in the response body', async () => {
      const response = await request(app.getHttpServer())
        .post('/authenticate')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .send({ username: 'test@example.com', password: 'password123' })
        .expect(200);

      expect(response.body.sessionToken).toBeUndefined();
    });

    it('should set cookie with maxAge', async () => {
      const response = await request(app.getHttpServer())
        .post('/authenticate')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .send({ username: 'test@example.com', password: 'password123' })
        .expect(200);

      const cookies = parseCookies(response);
      expect(cookies[COOKIE_NAME].maxAge).toBeDefined();
    });

    it('should return 401 when credentials are invalid', async () => {
      mockUserService.validatePassword.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post('/authenticate')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .send({ username: 'bad@example.com', password: 'wrong' })
        .expect(401);
    });

    it('should ROTATE the CSRF token on login (identity boundary)', async () => {
      // Login is one of the few rotation points; the pre-auth token must not
      // survive into the authenticated session (token-fixation hygiene).
      const preAuthToken = 'pre-auth-random.pre-auth-signature';

      const response = await request(app.getHttpServer())
        .post('/authenticate')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=${preAuthToken}`])
        .set('X-CSRF-Token', preAuthToken)
        .send({ username: 'test@example.com', password: 'password123' })
        .expect(200);

      const cookies = parseCookies(response);
      expect(cookies[CSRF_COOKIE_NAME].value).toBe(MOCK_CSRF_TOKEN);
      expect(cookies[CSRF_COOKIE_NAME].value).not.toBe(preAuthToken);
    });
  });

  describe('POST /authenticate/refresh', () => {
    it('should set a new session token cookie on refresh', async () => {
      const response = await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .set('Cookie', [`${COOKIE_NAME}=session-token-value`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(200);

      const cookies = parseCookies(response);
      expect(cookies[COOKIE_NAME]).toBeDefined();
      expect(cookies[COOKIE_NAME].value).toBe('rotated-session-token');
      expect(cookies[COOKIE_NAME].httpOnly).toBe(true);
    });

    it('should return a new access token in the body', async () => {
      const response = await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .set('Cookie', [`${COOKIE_NAME}=session-token-value`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(200);

      expect(response.body).toEqual({ accessToken: 'access-token-value' });
    });

    it('should return 400 when no session cookie is present', async () => {
      await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(400);
    });

    it('should return 401 when session token is invalid', async () => {
      mockAuthService.validateSessionToken.mockImplementation(() => {
        throw new Error('invalid token');
      });

      await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .set('Cookie', [`${COOKIE_NAME}=invalid-token`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(401);
    });

    it('should return 401 when user no longer exists', async () => {
      mockUserService.findById.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .set('Cookie', [`${COOKIE_NAME}=session-token-value`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(401);
    });

    it('should not set a session cookie on grace-period match', async () => {
      mockAuthService.rotateSessionToken.mockResolvedValue({ sessionToken: null });

      const response = await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .set('Cookie', [`${COOKIE_NAME}=old-session-token`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(200);

      const cookies = parseCookies(response);
      expect(cookies[COOKIE_NAME]).toBeUndefined();
      expect(response.body).toEqual({ accessToken: 'access-token-value' });
    });

    it('should REUSE the incoming CSRF token, even when the session rotates (CI-Server#1740)', async () => {
      // Regression: refresh used to mint a fresh CSRF token on every session
      // rotation, invalidating tokens embedded in open pages (the no-JS connect
      // consent form) and racing concurrent tabs into spurious logouts.
      const existingToken = 'existing-random.existing-signature';

      const response = await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .set('Cookie', [`${COOKIE_NAME}=session-token-value`, `${CSRF_COOKIE_NAME}=${existingToken}`])
        .set('X-CSRF-Token', existingToken)
        .expect(200);

      const cookies = parseCookies(response);
      // Session token rotated…
      expect(cookies[COOKIE_NAME].value).toBe('rotated-session-token');
      // …but the CSRF token was echoed back unchanged, with a sliding maxAge.
      expect(cookies[CSRF_COOKIE_NAME].value).toBe(existingToken);
      expect(cookies[CSRF_COOKIE_NAME].maxAge).toBeDefined();
      expect(mockCsrfService.generateToken).not.toHaveBeenCalled();
    });
  });

  describe('POST /authenticate/logout', () => {
    it('should clear session token cookie', async () => {
      // logout is CsrfGuard-protected, so a real request carries the double-submit
      // pair; send it here rather than relying on the mocked validateToken.
      const response = await request(app.getHttpServer())
        .post('/authenticate/logout')
        .set('Cookie', [`${COOKIE_NAME}=session-token-value`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(204);

      const cookies = parseCookies(response);
      expect(cookies[COOKIE_NAME]).toBeDefined();
      // cleared cookies have an empty value or an expiry in the past
      expect(cookies[COOKIE_NAME].value === '' || cookies[COOKIE_NAME].expires?.getTime() === 0).toBe(true);
    });

    it('should invalidate the session in the database', async () => {
      await request(app.getHttpServer())
        .post('/authenticate/logout')
        .set('Cookie', [`${COOKIE_NAME}=session-token-value`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(204);

      expect(mockAuthService.invalidateSession).toHaveBeenCalledWith(
        'user-1',
        'session-token-value',
        expect.any(Object),
      );
    });

    it('should return 400 when no session cookie is present', async () => {
      await request(app.getHttpServer())
        .post('/authenticate/logout')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(400);
    });

    it('should still clear both cookies when the session is already invalid', async () => {
      // Logging out must always leave the browser clean. The csrf cookie now
      // carries a 7-day maxAge, so skipping the clear on an expired session
      // would leave it outliving the session it belongs to, still reusable by
      // ensureToken.
      const response = await request(app.getHttpServer())
        .post('/authenticate/logout')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(400);

      const cookies = parseCookies(response);
      for (const name of [COOKIE_NAME, CSRF_COOKIE_NAME]) {
        expect(cookies[name]).toBeDefined();
        expect(cookies[name].value === '' || cookies[name].expires?.getTime() === 0).toBe(true);
      }
    });

    it('should NOT clear cookies for a credential-less cross-site POST', async () => {
      // Clearing before validating is only safe behind CsrfGuard. A third-party
      // page can POST here, but sameSite lax/strict means no cookies ride along,
      // so the guard rejects before the handler body runs. Without the guard the
      // clears would already have executed and their deletion Set-Cookie headers
      // would ship on the error response — a repeatable forced-logout primitive
      // for any site the victim visits.
      mockCsrfService.validateToken.mockImplementation(() => {
        throw new ForbiddenException('Missing CSRF token');
      });

      const response = await request(app.getHttpServer()).post('/authenticate/logout').expect(403);

      expect(parseCookies(response)).toEqual({});
      expect(mockAuthService.invalidateSession).not.toHaveBeenCalled();
    });

    it('should return 401 when user no longer exists', async () => {
      mockUserService.findById.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post('/authenticate/logout')
        .set('Cookie', [`${COOKIE_NAME}=session-token-value`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(401);
    });

    it('should clear CSRF token cookie on logout', async () => {
      const response = await request(app.getHttpServer())
        .post('/authenticate/logout')
        .set('Cookie', [`${COOKIE_NAME}=session-token-value`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(204);

      const cookies = parseCookies(response);
      expect(cookies[CSRF_COOKIE_NAME]).toBeDefined();
      expect(
        cookies[CSRF_COOKIE_NAME].value === '' || cookies[CSRF_COOKIE_NAME].expires?.getTime() === 0,
      ).toBe(true);
    });
  });

  describe('GET /authenticate/csrf', () => {
    it('should set an CSRF token cookie', async () => {
      const response = await request(app.getHttpServer()).get('/authenticate/csrf').expect(204);

      expect(mockCsrfService.generateToken).toHaveBeenCalled();
      const cookies = parseCookies(response);
      expect(cookies[CSRF_COOKIE_NAME]).toBeDefined();
      expect(cookies[CSRF_COOKIE_NAME].value).toBe(MOCK_CSRF_TOKEN);
    });

    it('should pin the csrf cookie attributes the double-submit scheme depends on', async () => {
      // These now live in one shared helper, so a single edit could silently
      // break every call site: httpOnly:true would make getCsrfToken() in
      // useAuth return undefined (breaking login/signup/refresh/logout), and
      // sameSite:'lax' would drop the defence that actually stops a cross-site
      // POST against the no-JS consent form.
      const response = await request(app.getHttpServer()).get('/authenticate/csrf').expect(204);

      const cookie = parseCookies(response)[CSRF_COOKIE_NAME];
      expect(cookie.httpOnly).toBeFalsy();
      expect(cookie.sameSite?.toLowerCase()).toBe('strict');
      expect(cookie.path).toBe('/');
      expect(cookie.maxAge).toBeDefined();
    });

    it('should echo a valid existing token instead of minting (idempotent priming)', async () => {
      const existingToken = 'existing-random.existing-signature';

      const response = await request(app.getHttpServer())
        .get('/authenticate/csrf')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=${existingToken}`])
        .expect(204);

      const cookies = parseCookies(response);
      expect(cookies[CSRF_COOKIE_NAME].value).toBe(existingToken);
      expect(mockCsrfService.generateToken).not.toHaveBeenCalled();
    });

    it('should mint a fresh token when the existing cookie is invalid', async () => {
      mockCsrfService.verifyToken.mockReturnValue(false);

      const response = await request(app.getHttpServer())
        .get('/authenticate/csrf')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=stale-or-foreign-token`])
        .expect(204);

      const cookies = parseCookies(response);
      expect(cookies[CSRF_COOKIE_NAME].value).toBe(MOCK_CSRF_TOKEN);
      expect(mockCsrfService.generateToken).toHaveBeenCalled();
    });
  });

  describe('CSRF validation', () => {
    it('should reject login when CSRF validation fails', async () => {
      const { ForbiddenException } = jest.requireActual('@nestjs/common');
      mockCsrfService.validateToken.mockImplementation(() => {
        throw new ForbiddenException('Missing CSRF token');
      });

      await request(app.getHttpServer())
        .post('/authenticate')
        .send({ username: 'test@example.com', password: 'password123' })
        .expect(403);
    });

    it('should reject refresh when CSRF validation fails', async () => {
      const { ForbiddenException } = jest.requireActual('@nestjs/common');
      mockCsrfService.validateToken.mockImplementation(() => {
        throw new ForbiddenException('CSRF token mismatch');
      });

      await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .set('Cookie', [`${COOKIE_NAME}=session-token-value`])
        .expect(403);
    });

    it('should pass cookie and header values to validateToken on login', async () => {
      await request(app.getHttpServer())
        .post('/authenticate')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .send({ username: 'test@example.com', password: 'password123' })
        .expect(200);

      expect(mockCsrfService.validateToken).toHaveBeenCalledWith(MOCK_CSRF_TOKEN, MOCK_CSRF_TOKEN);
    });

    it('should issue a new CSRF cookie after successful login', async () => {
      const response = await request(app.getHttpServer())
        .post('/authenticate')
        .set('Cookie', [`${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .send({ username: 'test@example.com', password: 'password123' })
        .expect(200);

      const cookies = parseCookies(response);
      expect(cookies[CSRF_COOKIE_NAME]).toBeDefined();
      expect(cookies[CSRF_COOKIE_NAME].value).toBe(MOCK_CSRF_TOKEN);
    });

    it('should re-set the same CSRF cookie on session rotation during refresh (sliding maxAge)', async () => {
      const response = await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .set('Cookie', [`${COOKIE_NAME}=session-token-value`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(200);

      const cookies = parseCookies(response);
      expect(cookies[CSRF_COOKIE_NAME]).toBeDefined();
      expect(cookies[CSRF_COOKIE_NAME].value).toBe(MOCK_CSRF_TOKEN);
      expect(mockCsrfService.generateToken).not.toHaveBeenCalled();
    });

    it('should keep the same CSRF token on grace-period match', async () => {
      mockAuthService.rotateSessionToken.mockResolvedValue({ sessionToken: null });

      const response = await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .set('Cookie', [`${COOKIE_NAME}=old-session-token`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
        .expect(200);

      // The cookie is re-set (sliding its maxAge alongside the session), but the
      // value is the incoming token — never a fresh mint.
      const cookies = parseCookies(response);
      expect(cookies[CSRF_COOKIE_NAME].value).toBe(MOCK_CSRF_TOKEN);
      expect(mockCsrfService.generateToken).not.toHaveBeenCalled();
    });
  });
});

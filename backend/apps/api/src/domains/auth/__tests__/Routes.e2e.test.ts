import { type INestApplication, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { BodyParserMiddleware } from '@ci/common/middleware';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { SessionController } from '../controllers/SessionController';
import { SignupController } from '../controllers/SignupController';
import { AuthService } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';
import { HubForwardAuthBridgeService } from '../services/HubForwardAuthBridgeService';
import { LoginThrottleService } from '../services/LoginThrottleService';
import { SignupCodeService } from '../services/SignupCodeService';

// This file previously wired BodyParserMiddleware to a throwaway
// TestAuthController with hand-rolled echo handlers at these same paths. That
// proved BodyParserMiddleware itself enforces a 100kb default (already
// covered generically by
// common/middleware/__tests__/BodyParserMiddleware.test.ts) but could never
// catch a regression where AuthModule's real routes stopped being covered by
// the middleware, moved paths, or picked up a per-route @BodyLimit override —
// because it never touched SessionController or SignupController at all.
//
// This version boots the REAL controllers (mirroring the mocking convention
// established in SessionController.test.ts / SignupController.test.ts) under
// the same `consumer.apply(BodyParserMiddleware).forRoutes('*')` wiring
// application.ts uses, so the 413 boundary is asserted against the actual
// production routes and their actual handlers — and the "normal body"
// counterpart proves the request reaches (not just "doesn't 413", but that
// the real handler ran and the mocked service was called).

const SESSION_COOKIE_NAME = config.auth.cookies.sessionTokenName;
const MOCK_SESSION_ID = 'session-id-1';
const mockUser = { id: 'user-1', name: 'Test User', email: 'test@example.com' };

const mockAuthService = {
  issueSessionToken: jest
    .fn()
    .mockResolvedValue({ sessionToken: 'session-token-value', sessionId: MOCK_SESSION_ID }),
  issueAccessToken: jest.fn().mockReturnValue('access-token-value'),
  getSessionMetadata: jest.fn().mockReturnValue({ ip: '127.0.0.1', userAgent: 'test' }),
  validateSessionToken: jest.fn().mockReturnValue({ sub: 'user-1' }),
  rotateSessionToken: jest
    .fn()
    .mockResolvedValue({ sessionToken: 'rotated-session-token', sessionId: MOCK_SESSION_ID }),
  invalidateSession: jest.fn().mockResolvedValue(undefined),
  resolveCsrfScope: jest.fn().mockReturnValue(null),
};

const mockUserService = {
  validatePassword: jest.fn().mockResolvedValue(mockUser),
  findById: jest.fn().mockResolvedValue(mockUser),
  checkEmailAvailability: jest.fn().mockResolvedValue(false),
  create: jest.fn().mockResolvedValue(mockUser),
};

const mockCsrfService = {
  generateToken: jest.fn().mockReturnValue('csrf-token'),
  // A no-op (never throws) so CsrfGuard's browser-client branch passes
  // without needing a real double-submit cookie pair for these tests — the
  // guard's own contract is covered by CsrfGuard.test.ts.
  validateToken: jest.fn(),
  verifyToken: jest.fn().mockReturnValue(true),
  // Used by ensureCsrfCookie (SessionController.refresh) — mirrors the real
  // reuse-if-valid contract on top of the mocked primitives above.
  ensureToken: jest.fn((value: unknown, sessionId: string | null): string =>
    value && mockCsrfService.verifyToken(value)
      ? (value as string)
      : mockCsrfService.generateToken(sessionId),
  ),
};

const mockSignupCodeService = {
  findOne: jest.fn().mockResolvedValue({ signup_code: 'valid-code', used: false }),
  consume: jest.fn().mockResolvedValue(true),
};

const mockFeatureService = {
  isFeatureEnabled: jest.fn().mockResolvedValue(false),
};

const mockLogger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};

// SessionController.login consults the throttle before validating the password.
// Stubbed open — this file is about body-size enforcement, not the throttle
// (LoginThrottleService.test.ts and SessionController.loginThrottle.test.ts).
const mockLoginThrottle = {
  check: jest.fn().mockReturnValue({ locked: false }),
  recordFailure: jest.fn(),
  recordSuccess: jest.fn(),
};

@Module({
  controllers: [SessionController, SignupController],
  providers: [
    { provide: AuthService, useValue: mockAuthService },
    { provide: UserService, useValue: mockUserService },
    { provide: CsrfService, useValue: mockCsrfService },
    { provide: SignupCodeService, useValue: mockSignupCodeService },
    { provide: FeatureService, useValue: mockFeatureService },
    // CsrfGuard (on login/refresh/signup) injects the logger for its
    // rejection-reason warnings.
    { provide: LoggerService, useValue: mockLogger },
    { provide: LoginThrottleService, useValue: mockLoginThrottle },
    {
      provide: HubForwardAuthBridgeService,
      useValue: {
        verifyUsername: jest.fn().mockReturnValue(null),
        alignSession: jest.fn().mockResolvedValue({ username: null, replaced: false }),
        describeIdentity: jest.fn().mockResolvedValue({ username: null, accountId: null }),
      },
    },
  ],
})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Mirrors application.ts exactly: BodyParserMiddleware is wired globally
    // via forRoutes('*'), not per-controller, so this is the real wiring the
    // auth routes get in production.
    consumer.apply(BodyParserMiddleware).forRoutes('*');
  }
}

describe('Auth routes body-size enforcement (real AuthModule controllers)', () => {
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
    mockUserService.checkEmailAvailability.mockResolvedValue(false);
    mockUserService.create.mockResolvedValue(mockUser);
    mockAuthService.issueSessionToken.mockResolvedValue({
      sessionToken: 'session-token-value',
      sessionId: MOCK_SESSION_ID,
    });
    mockAuthService.issueAccessToken.mockReturnValue('access-token-value');
    mockAuthService.validateSessionToken.mockReturnValue({ sub: 'user-1' });
    mockAuthService.rotateSessionToken.mockResolvedValue({
      sessionToken: 'rotated-session-token',
      sessionId: MOCK_SESSION_ID,
    });
    mockAuthService.resolveCsrfScope.mockReturnValue(null);
    mockCsrfService.verifyToken.mockReturnValue(true);
    mockSignupCodeService.findOne.mockResolvedValue({ signup_code: 'valid-code', used: false });
    mockFeatureService.isFeatureEnabled.mockResolvedValue(false);
    mockLoginThrottle.check.mockReturnValue({ locked: false });
  });

  describe('POST /authenticate (SessionController.login)', () => {
    it('rejects a body over 100kb with 413 before the real login handler runs', async () => {
      const largePayload = {
        username: 'test',
        password: 'x'.repeat(101 * 1024),
      };

      await request(app.getHttpServer()).post('/authenticate').send(largePayload).expect(413);

      expect(mockUserService.validatePassword).not.toHaveBeenCalled();
    });

    it('lets a normal-sized body reach the real login handler and succeed', async () => {
      const response = await request(app.getHttpServer())
        .post('/authenticate')
        .send({ username: 'test@example.com', password: 'password123' })
        .expect(200);

      expect(response.body).toEqual({ accessToken: 'access-token-value' });
      expect(mockUserService.validatePassword).toHaveBeenCalledWith('test@example.com', 'password123');
    });
  });

  describe('POST /signup (SignupController.signup)', () => {
    it('rejects a body over 100kb with 413 before the real signup handler runs', async () => {
      const largePayload = {
        name: 'x'.repeat(101 * 1024),
        email: 'test@example.com',
        password: 'password123',
      };

      await request(app.getHttpServer()).post('/signup').send(largePayload).expect(413);

      expect(mockUserService.create).not.toHaveBeenCalled();
    });

    it('lets a normal-sized body reach the real signup handler and succeed', async () => {
      const response = await request(app.getHttpServer())
        .post('/signup')
        .send({ name: 'Test User', email: 'test@example.com', password: 'password123' })
        .expect(201);

      expect(response.body).toEqual({ accessToken: 'access-token-value' });
      expect(mockUserService.create).toHaveBeenCalled();
    });
  });

  describe('POST /authenticate/refresh (SessionController.refresh)', () => {
    it('rejects a body over 100kb with 413 before the real refresh handler runs', async () => {
      const largePayload = { token: 'x'.repeat(101 * 1024) };

      await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .set('Cookie', [`${SESSION_COOKIE_NAME}=session-token-value`])
        .send(largePayload)
        .expect(413);

      expect(mockAuthService.rotateSessionToken).not.toHaveBeenCalled();
    });

    it('lets a normal-sized body reach the real refresh handler and succeed', async () => {
      const response = await request(app.getHttpServer())
        .post('/authenticate/refresh')
        .set('Cookie', [`${SESSION_COOKIE_NAME}=session-token-value`])
        .send({})
        .expect(200);

      expect(response.body).toEqual({ accessToken: 'access-token-value' });
      expect(mockAuthService.rotateSessionToken).toHaveBeenCalled();
    });
  });
});

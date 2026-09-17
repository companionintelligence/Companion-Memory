// Small numbers so a lockout is three requests away rather than ten; the
// shipped defaults are 10 failures / 900s window / 900s lockout.
const mockLoginThrottleConfig = {
  enabled: true,
  maxAttempts: 3,
  windowSeconds: 60,
  lockoutSeconds: 120,
};

jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      auth: {
        ...actual.auth,
        get loginThrottle() {
          return mockLoginThrottleConfig;
        },
      },
    },
  };
});

import { type INestApplication, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { LoggerService } from '@ci/common/logging';
import { BodyParserMiddleware } from '@ci/common/middleware';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { SessionController } from '../controllers/SessionController';
import { AuthService } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';
import { HubForwardAuthBridgeService } from '../services/HubForwardAuthBridgeService';
import { LoginThrottleService } from '../services/LoginThrottleService';

// This file boots the REAL LoginThrottleService behind the REAL login route, so
// the throttle is asserted end-to-end (status code, Retry-After, and the fact
// that a refused attempt never reaches the password check). SessionController's
// cookie/CSRF contract lives in SessionController.test.ts, which stubs the
// throttle open — deliberately kept apart so a shared in-process counter can
// never make that file's assertions order-dependent.

const CSRF_COOKIE_NAME = config.auth.cookies.csrfTokenName;
const MOCK_CSRF_TOKEN = 'test-random.test-signature';
const MOCK_SESSION_ID = 'session-id-1';

const mockUser = { id: 'user-1', name: 'Test User', email: 'test@example.com' };

const mockAuthService = {
  issueSessionToken: jest
    .fn()
    .mockResolvedValue({ sessionToken: 'session-token-value', sessionId: MOCK_SESSION_ID }),
  issueAccessToken: jest.fn().mockReturnValue('access-token-value'),
  getSessionMetadata: jest.fn().mockReturnValue({ ip: '203.0.113.9', userAgent: 'test' }),
  validateSessionToken: jest.fn().mockReturnValue({ sub: 'user-1' }),
  rotateSessionToken: jest
    .fn()
    .mockResolvedValue({ sessionToken: 'rotated-session-token', sessionId: MOCK_SESSION_ID }),
  invalidateSession: jest.fn().mockResolvedValue(undefined),
  resolveCsrfScope: jest.fn().mockReturnValue(null),
};

const mockCsrfService = {
  generateToken: jest.fn().mockReturnValue(MOCK_CSRF_TOKEN),
  validateToken: jest.fn(),
  verifyToken: jest.fn().mockReturnValue(true),
  ensureToken: jest.fn().mockReturnValue(MOCK_CSRF_TOKEN),
};

const mockUserService = {
  validatePassword: jest.fn().mockResolvedValue(mockUser),
  findById: jest.fn().mockResolvedValue(mockUser),
};

const mockLogger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};

@Module({
  controllers: [SessionController],
  providers: [
    { provide: AuthService, useValue: mockAuthService },
    { provide: UserService, useValue: mockUserService },
    { provide: CsrfService, useValue: mockCsrfService },
    { provide: LoggerService, useValue: mockLogger },
    LoginThrottleService,
    {
      provide: HubForwardAuthBridgeService,
      useValue: {
        verifyUsername: jest.fn().mockReturnValue(null),
        alignSession: jest.fn().mockResolvedValue({ username: null, replaced: false }),
      },
    },
  ],
})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(BodyParserMiddleware).forRoutes('*');
  }
}

describe('SessionController login throttle', () => {
  let app: INestApplication;

  // The throttle keys on (ip, username) and its state is per-process, so every
  // test claims its own username rather than resetting a shared counter.
  let seq = 0;
  const nextUsername = () => `attacker-${(seq += 1)}@example.com`;

  const login = (username: string, password = 'wrong-password') =>
    request(app.getHttpServer())
      .post('/authenticate')
      .set('Cookie', [`${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
      .set('X-CSRF-Token', MOCK_CSRF_TOKEN)
      .send({ username, password });

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [TestModule] }).compile();

    app = module.createNestApplication({ bodyParser: false, logger: false });
    app.use(cookieParser());

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoginThrottleConfig.enabled = true;
    mockLoginThrottleConfig.maxAttempts = 3;
    mockUserService.validatePassword.mockResolvedValue(null);
    mockCsrfService.validateToken.mockImplementation(() => {});
    mockCsrfService.verifyToken.mockReturnValue(true);
    mockAuthService.getSessionMetadata.mockReturnValue({ ip: '203.0.113.9', userAgent: 'test' });
  });

  it('keeps answering 401 while the attempts are under the limit', async () => {
    const username = nextUsername();

    await login(username).expect(401);
    await login(username).expect(401);

    expect(mockUserService.validatePassword).toHaveBeenCalledTimes(2);
  });

  it('answers 429 once the failure budget is spent', async () => {
    const username = nextUsername();

    for (let i = 0; i < 3; i += 1) {
      await login(username).expect(401);
    }

    const response = await login(username).expect(429);

    // Wall-clock, so assert the band rather than the exact second.
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(115);
    expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(120);
    // Refused BEFORE the password check — a throttle that still hashes the
    // guess is not a throttle.
    expect(mockUserService.validatePassword).toHaveBeenCalledTimes(3);
  });

  it('does not reveal whether the account exists in the 429', async () => {
    const username = nextUsername();

    for (let i = 0; i < 3; i += 1) {
      await login(username).expect(401);
    }

    const response = await login(username).expect(429);

    expect(response.body.message).toBe('Too many login attempts. Please try again later.');
    expect(JSON.stringify(response.body)).not.toContain(username);
  });

  it('throttles per identity, not globally — another username still gets in', async () => {
    const locked = nextUsername();
    const other = nextUsername();

    for (let i = 0; i < 3; i += 1) {
      await login(locked).expect(401);
    }

    await login(locked).expect(429);
    // A lockout that spread to every username would be a denial of service on
    // the owner, triggerable by anyone who can reach the login form.
    await login(other).expect(401);
  });

  it('clears the counter on a successful login', async () => {
    const username = nextUsername();

    await login(username).expect(401);
    await login(username).expect(401);

    mockUserService.validatePassword.mockResolvedValue(mockUser);
    await login(username, 'correct-password').expect(200);
    mockUserService.validatePassword.mockResolvedValue(null);

    // Without the reset these two would be failures #3 and #4 and the second
    // would 429 — the owner must not be locked out by the typos that preceded
    // a successful sign-in.
    await login(username).expect(401);
    await login(username).expect(401);
  });

  it('behaves exactly as before when the throttle is disabled', async () => {
    mockLoginThrottleConfig.enabled = false;

    const username = nextUsername();

    for (let i = 0; i < 12; i += 1) {
      await login(username).expect(401);
    }

    expect(mockUserService.validatePassword).toHaveBeenCalledTimes(12);
  });
});

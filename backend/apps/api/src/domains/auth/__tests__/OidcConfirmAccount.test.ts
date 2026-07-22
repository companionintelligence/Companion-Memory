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

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { BodyParserMiddleware } from '@ci/common/middleware';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { OidcController } from '../controllers/OidcController';
import { AuthService } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';

import { parseCookies } from './utils/parseCookies';

const CSRF_COOKIE_NAME = config.auth.cookies.csrfTokenName;
const SIGNUP_INTENT_COOKIE = 'oidc_signup_intent';
const CONFIRM_PATH = '/authenticate/oidc/confirm-account';

const mockUser = { id: 'user-1', name: 'Test User', email: 'new@example.com' };

const mockAuthService = {
  verifySignupIntentToken: jest.fn().mockReturnValue({ email: 'new@example.com', name: 'Test User' }),
  issueSignupIntentToken: jest.fn().mockReturnValue('intent-token'),
  issueSessionToken: jest.fn().mockResolvedValue('session-token-value'),
  issueAccessToken: jest.fn().mockReturnValue('access-token-value'),
  getSessionMetadata: jest.fn().mockReturnValue({ ip: '127.0.0.1', userAgent: 'test' }),
};

const mockUserService = {
  findByEmail: jest.fn().mockResolvedValue(mockUser),
  create: jest.fn().mockResolvedValue(mockUser),
};

const MOCK_CSRF_TOKEN = 'test-random.test-signature';

const mockCsrfService = {
  generateToken: jest.fn().mockReturnValue(MOCK_CSRF_TOKEN),
  validateToken: jest.fn(),
  verifyToken: jest.fn().mockReturnValue(true),
  // Mirrors the real reuse-if-valid implementation. The explicit return type is
  // required: the body references `mockCsrfService` while it is still being
  // initialised, so inference would be circular.
  ensureToken: jest.fn((value?: string): string =>
    value && mockCsrfService.verifyToken(value) ? value : mockCsrfService.generateToken(),
  ),
};

const mockFeatureService = { isFeatureEnabled: jest.fn().mockResolvedValue(false) };

const mockLogger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};

@Module({
  controllers: [OidcController],
  providers: [
    { provide: AuthService, useValue: mockAuthService },
    { provide: UserService, useValue: mockUserService },
    { provide: CsrfService, useValue: mockCsrfService },
    { provide: FeatureService, useValue: mockFeatureService },
    { provide: LoggerService, useValue: mockLogger },
  ],
})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(BodyParserMiddleware).forRoutes('*');
  }
}

/**
 * HTTP-level tests for the first-time-sign-in confirm-account step, focused on
 * its CSRF behaviour: the page reuses a valid cookie (so a background refresh
 * cannot invalidate an open copy), and a CSRF failure self-heals with a 303
 * rather than dead-ending on a raw 403.
 *
 * The 303 assertion is load-bearing: the handler injects a non-passthrough
 * `@Res()`, so Nest's `@HttpCode` never runs and it calls `res.redirect(
 * HttpStatus.SEE_OTHER, …)` explicitly. A plain 302 would leave the request
 * method browser-dependent — only 303 guarantees the POST is re-issued as a GET
 * against the confirm page.
 */
describe('OidcController — confirm-account CSRF', () => {
  let app: INestApplication;

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
    mockAuthService.verifySignupIntentToken.mockReturnValue({
      email: 'new@example.com',
      name: 'Test User',
    });
    mockCsrfService.generateToken.mockReturnValue(MOCK_CSRF_TOKEN);
    mockCsrfService.validateToken.mockImplementation(() => undefined);
    mockCsrfService.verifyToken.mockReturnValue(true);
  });

  describe('GET confirm-account', () => {
    it('reuses a valid existing csrf cookie instead of minting', async () => {
      const existingToken = 'existing-random.existing-signature';

      const res = await request(app.getHttpServer())
        .get(CONFIRM_PATH)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`, `${CSRF_COOKIE_NAME}=${existingToken}`])
        .expect(200);

      expect(res.text).toContain(`name="csrf" value="${existingToken}"`);
      expect(mockCsrfService.generateToken).not.toHaveBeenCalled();

      const cookies = parseCookies(res);
      expect(cookies[CSRF_COOKIE_NAME].value).toBe(existingToken);
      expect(cookies[CSRF_COOKIE_NAME].maxAge).toBeDefined();
    });

    it('mints when no csrf cookie is present', async () => {
      const res = await request(app.getHttpServer())
        .get(CONFIRM_PATH)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`])
        .expect(200);

      expect(res.text).toContain(`name="csrf" value="${MOCK_CSRF_TOKEN}"`);
      expect(mockCsrfService.generateToken).toHaveBeenCalled();
    });

    it('round-trips csrf_retry into the re-rendered form', async () => {
      const res = await request(app.getHttpServer())
        .get(`${CONFIRM_PATH}?csrf_retry=1`)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`])
        .expect(200);

      expect(res.text).toContain('name="csrf_retry" value="1"');
    });

    it('does not render the retry marker on a first render', async () => {
      const res = await request(app.getHttpServer())
        .get(CONFIRM_PATH)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`])
        .expect(200);

      expect(res.text).not.toContain('name="csrf_retry"');
    });

    it('ignores a duplicated csrf_retry (array) so a crafted link cannot burn the self-heal', async () => {
      // A repeated query key arrives as an array; only a single string counts as
      // the marker. An array must be treated as absent so the user still gets
      // their one self-heal retry rather than being forced to /login early.
      const res = await request(app.getHttpServer())
        .get(`${CONFIRM_PATH}?csrf_retry=1&csrf_retry=2`)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`])
        .expect(200);

      expect(res.text).not.toContain('name="csrf_retry"');
    });
  });

  describe('POST confirm-account', () => {
    it('self-heals a CSRF failure with a 303 back to the GET (not a 302)', async () => {
      mockCsrfService.validateToken.mockImplementation(() => {
        throw new ForbiddenException('CSRF token mismatch');
      });

      const res = await request(app.getHttpServer())
        .post(CONFIRM_PATH)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`])
        .send({ csrf: 'stale' })
        .expect(303);

      expect(res.headers.location).toBe('/api/authenticate/oidc/confirm-account?csrf_retry=1');
      expect(mockUserService.create).not.toHaveBeenCalled();
    });

    it('sends the user to login when CSRF fails again on the retry', async () => {
      mockCsrfService.validateToken.mockImplementation(() => {
        throw new ForbiddenException('CSRF token mismatch');
      });

      const res = await request(app.getHttpServer())
        .post(CONFIRM_PATH)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`])
        .send({ csrf: 'stale', csrf_retry: '1' })
        .expect(303);

      expect(res.headers.location).toBe('/login?error=csrf');
      expect(mockUserService.create).not.toHaveBeenCalled();
    });

    it('propagates a non-CSRF fault instead of mislabelling it as a CSRF retry', async () => {
      mockCsrfService.validateToken.mockImplementation(() => {
        throw new TypeError('unexpected fault');
      });

      await request(app.getHttpServer())
        .post(CONFIRM_PATH)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`])
        .send({ csrf: MOCK_CSRF_TOKEN })
        .expect(500);

      expect(mockUserService.create).not.toHaveBeenCalled();
    });

    it('self-heals an absent csrf field rather than dead-ending in the validation pipe', async () => {
      // The schema deliberately leaves `csrf` optional so absence reaches
      // CsrfService and takes the self-heal path; a `min(1)` there would 400
      // in the pipe before the handler ran, defeating the redirect.
      mockCsrfService.validateToken.mockImplementation(() => {
        throw new ForbiddenException('Missing CSRF token');
      });

      const res = await request(app.getHttpServer())
        .post(CONFIRM_PATH)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`])
        .send({})
        .expect(303);

      expect(res.headers.location).toBe('/api/authenticate/oidc/confirm-account?csrf_retry=1');
    });

    it('rejects a non-string csrf field before it reaches the token comparison', async () => {
      // Without body validation a non-string reaches Buffer.from() inside
      // validateToken and surfaces as a 500 instead of a clean rejection.
      await request(app.getHttpServer())
        .post(CONFIRM_PATH)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`])
        .send({ csrf: { nested: 'object' } })
        .expect(400);

      expect(mockCsrfService.validateToken).not.toHaveBeenCalled();
      expect(mockUserService.create).not.toHaveBeenCalled();
    });

    it('redirects to login when the signup intent has expired', async () => {
      mockAuthService.verifySignupIntentToken.mockImplementation(() => {
        throw new Error('expired');
      });

      const res = await request(app.getHttpServer()).post(CONFIRM_PATH).send({ csrf: MOCK_CSRF_TOKEN });

      expect(res.headers.location).toBe('/login?error=signup_expired');
      expect(mockCsrfService.validateToken).not.toHaveBeenCalled();
    });
  });
});

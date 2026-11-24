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
import { FederatedIdentityService } from '../services/FederatedIdentityService';
import { HubForwardAuthBridgeService } from '../services/HubForwardAuthBridgeService';
import { OidcNativeCodeService } from '../services/OidcNativeCodeService';
import { SignupCodeService } from '../services/SignupCodeService';

import { parseCookies } from './utils/parseCookies';

const CSRF_COOKIE_NAME = config.auth.cookies.csrfTokenName;
const SIGNUP_INTENT_COOKIE = 'oidc_signup_intent';
const CONFIRM_PATH = '/authenticate/oidc/confirm-account';

const mockUser = { id: 'user-1', name: 'Test User', email: 'new@example.com' };

const MOCK_SESSION_ID = 'session-id-1';

const mockAuthService = {
  verifySignupIntentToken: jest.fn().mockReturnValue({
    email: 'new@example.com',
    name: 'Test User',
    issuer: 'https://hub.test',
    subject: 'portal-sub-1',
  }),
  issueSignupIntentToken: jest.fn().mockReturnValue('intent-token'),
  issueSessionToken: jest
    .fn()
    .mockResolvedValue({ sessionToken: 'session-token-value', sessionId: MOCK_SESSION_ID }),
  issueAccessToken: jest.fn().mockReturnValue('access-token-value'),
  getSessionMetadata: jest.fn().mockReturnValue({ ip: '127.0.0.1', userAgent: 'test' }),
  resolveCsrfScope: jest.fn().mockReturnValue(null),
};

const mockUserService = {
  // Default: no account for the address yet — the ordinary first-time case.
  findByEmail: jest.fn().mockResolvedValue(null),
  findById: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockResolvedValue(mockUser),
  createFirstAccount: jest.fn().mockResolvedValue(null),
};

/** Stands in for the transaction `UserService.createFirstAccount` runs its `alongside` work in. */
const CLAIM_TRANSACTION = { transaction: 'first-account' };
const mockFederatedIdentityService = {
  findUserId: jest.fn().mockResolvedValue(null),
  listForUser: jest.fn().mockResolvedValue([]),
  bind: jest.fn().mockResolvedValue(undefined),
};

const MOCK_CSRF_TOKEN = 'test-random.test-signature';

const mockCsrfService = {
  generateToken: jest.fn().mockReturnValue(MOCK_CSRF_TOKEN),
  validateToken: jest.fn(),
  verifyToken: jest.fn().mockReturnValue(true),
  // Mirrors the real reuse-if-valid implementation (scope matching itself is
  // unit-tested in CsrfService.test.ts). The explicit return type is required:
  // the body references `mockCsrfService` while it is still being initialised,
  // so inference would be circular.
  ensureToken: jest.fn((value: unknown, _sessionId: string | null): string =>
    value && mockCsrfService.verifyToken(value)
      ? (value as string)
      : mockCsrfService.generateToken(_sessionId),
  ),
};

const mockFeatureService = { isFeatureEnabled: jest.fn().mockResolvedValue(false) };

// Required by OidcController's constructor (the native deep-link one-time-code
// exchange). Unused by the confirm-account flow tested here, but Nest resolves the
// whole constructor, so the provider has to exist.
const mockOidcNativeCodeService = { issue: jest.fn(), redeem: jest.fn() };

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
    { provide: OidcNativeCodeService, useValue: mockOidcNativeCodeService },
    // Confirm-account never reaches the invite path; present so Nest can construct
    // the controller.
    { provide: SignupCodeService, useValue: { findOne: jest.fn(), consume: jest.fn() } },
    { provide: FederatedIdentityService, useValue: mockFederatedIdentityService },
    { provide: HubForwardAuthBridgeService, useValue: { verifyUsername: jest.fn().mockReturnValue(null) } },
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
    mockAuthService.resolveCsrfScope.mockReturnValue(null);
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

    it('validates against the scope resolved from the session cookie', async () => {
      // Usually anon (first-time sign-in has no session yet), but a browser
      // already holding a session must be validated against it.
      mockAuthService.resolveCsrfScope.mockReturnValue(MOCK_SESSION_ID);

      await request(app.getHttpServer())
        .post(CONFIRM_PATH)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .send({ csrf: MOCK_CSRF_TOKEN });

      expect(mockCsrfService.validateToken).toHaveBeenCalledWith(
        MOCK_CSRF_TOKEN,
        MOCK_CSRF_TOKEN,
        MOCK_SESSION_ID,
      );
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

  describe('POST confirm-account — who the account goes to', () => {
    beforeEach(() => {
      // Earlier cases swap these implementations (an expired intent, a CSRF
      // fault) and clearAllMocks only clears calls — put the happy path back.
      mockAuthService.verifySignupIntentToken.mockReturnValue({
        email: 'new@example.com',
        name: 'Test User',
        issuer: 'https://hub.test',
        subject: 'portal-sub-1',
      });
      mockCsrfService.validateToken.mockImplementation(() => undefined);
      mockAuthService.resolveCsrfScope.mockReturnValue(null);
    });

    const validPost = () =>
      request(app.getHttpServer())
        .post(CONFIRM_PATH)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .send({ csrf: MOCK_CSRF_TOKEN });

    it('creates the account and binds it to the Portal identity the intent was minted for', async () => {
      mockUserService.findByEmail.mockResolvedValue(null);

      const res = await validPost();

      expect(mockUserService.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'new@example.com', name: 'Test User' }),
      );
      // Nothing was waived for being first, so the appliance having an owner by
      // now is no reason to refuse.
      expect(mockUserService.createFirstAccount).not.toHaveBeenCalled();
      // Bound at creation, so the bearer path resolves this account by
      // (iss, sub) from its first API call — no email matching later. Written
      // after the account rather than in a claim transaction (`undefined`):
      // an ordinary account has no first-account decision to commit with.
      expect(mockFederatedIdentityService.bind).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', issuer: 'https://hub.test', subject: 'portal-sub-1' }),
        undefined,
      );
      expect(mockAuthService.issueSessionToken).toHaveBeenCalledWith('user-1', expect.anything());
      expect(res.headers.location).not.toMatch(/^\/login\?error=/);
    });

    it('marks the address proven only when the intent says the Portal verified it', async () => {
      mockUserService.findByEmail.mockResolvedValue(null);

      await validPost();

      // The intent above carries no `emailVerified`: an address nobody verified proves nothing.
      expect(mockUserService.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'new@example.com', emailProven: false }),
      );

      mockUserService.create.mockClear();
      mockAuthService.verifySignupIntentToken.mockReturnValue({
        email: 'new@example.com',
        name: 'Test User',
        issuer: 'https://hub.test',
        subject: 'portal-sub-1',
        emailVerified: true,
      });

      await validPost();

      expect(mockUserService.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'new@example.com', emailProven: true }),
      );
    });

    it("SECURITY: refuses when an account for the address already exists and is not this identity's", async () => {
      // The callback already refused this sign-in (password account, or one
      // bound to a different Portal identity). This step used to do
      // `findByEmail(email) ?? create(...)` and sign the caller in as whatever
      // it found — undoing that refusal for anyone holding a Portal login that
      // merely claims the same address.
      mockUserService.findByEmail.mockResolvedValue({ id: 'user-victim', email: 'new@example.com' });
      mockFederatedIdentityService.findUserId.mockResolvedValue(null);

      const res = await validPost().expect(303);

      expect(res.headers.location).toBe('/login?error=account_exists');
      expect(mockUserService.create).not.toHaveBeenCalled();
      expect(mockAuthService.issueSessionToken).not.toHaveBeenCalled();
      // The intent is spent either way.
      const cleared = parseCookies(res);
      expect(cleared[SIGNUP_INTENT_COOKIE]?.value ?? '').toBe('');
    });

    it('signs in the account a concurrent tab already created for this same identity', async () => {
      // Two tabs confirm; the first created and bound the account. The second
      // must land in that account, not fail, and must not create a duplicate.
      mockUserService.findByEmail.mockResolvedValue({ id: 'user-1', email: 'new@example.com' });
      mockFederatedIdentityService.findUserId.mockResolvedValue('user-1');

      const res = await validPost();

      expect(mockUserService.create).not.toHaveBeenCalled();
      expect(mockAuthService.issueSessionToken).toHaveBeenCalledWith('user-1', expect.anything());
      expect(res.headers.location).not.toMatch(/^\/login\?error=/);
    });
  });

  /**
   * The callback waived the signup code only because the appliance had no accounts — and wrote that
   * into the intent, because the confirm step runs up to the intent's lifetime later. By then
   * someone else may own the appliance. Creating the account on the callback's word is how a
   * stranger became a member without an invitation.
   */
  describe('POST confirm-account — an intent that was admitted only as the first account', () => {
    const intent = {
      email: 'new@example.com',
      name: 'Test User',
      issuer: 'https://hub.test',
      subject: 'portal-sub-1',
      firstAccountOnly: true,
    };

    beforeEach(() => {
      mockAuthService.verifySignupIntentToken.mockReturnValue(intent);
      mockCsrfService.validateToken.mockImplementation(() => undefined);
      mockAuthService.resolveCsrfScope.mockReturnValue(null);
      mockUserService.findByEmail.mockResolvedValue(null);
      mockUserService.findById.mockResolvedValue(null);
      mockUserService.createFirstAccount.mockResolvedValue(null);
      mockFederatedIdentityService.findUserId.mockResolvedValue(null);
    });

    const validPost = () =>
      request(app.getHttpServer())
        .post(CONFIRM_PATH)
        .set('Cookie', [`${SIGNUP_INTENT_COOKIE}=intent`, `${CSRF_COOKIE_NAME}=${MOCK_CSRF_TOKEN}`])
        .send({ csrf: MOCK_CSRF_TOKEN });

    it('creates it only as the first account, bound to the identity in the same transaction', async () => {
      mockUserService.createFirstAccount.mockImplementation(
        async (
          _context: unknown,
          _data: unknown,
          alongside?: (m: unknown, u: unknown) => Promise<unknown>,
        ) => {
          await alongside?.(CLAIM_TRANSACTION, { ...mockUser, role: 'admin' });

          return mockUser;
        },
      );

      const res = await validPost();

      expect(mockUserService.createFirstAccount).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'new@example.com', passwordChosenByUser: false }),
        expect.any(Function),
      );
      expect(mockUserService.create).not.toHaveBeenCalled();
      expect(mockFederatedIdentityService.bind).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', issuer: 'https://hub.test', subject: 'portal-sub-1' }),
        CLAIM_TRANSACTION,
      );
      expect(mockAuthService.issueSessionToken).toHaveBeenCalledWith('user-1', expect.anything());
      expect(res.headers.location).not.toMatch(/^\/login\?error=/);
    });

    it('SECURITY: refuses once somebody else has claimed the appliance, as the code gate would', async () => {
      const res = await validPost().expect(303);

      expect(res.headers.location).toBe('/login?error=signup_code_required');
      expect(mockUserService.create).not.toHaveBeenCalled();
      expect(mockAuthService.issueSessionToken).not.toHaveBeenCalled();
      // The intent is spent: it cannot be replayed once the appliance is someone else's.
      const cleared = parseCookies(res);
      expect(cleared[SIGNUP_INTENT_COOKIE]?.value ?? '').toBe('');
    });

    it('signs in the account this same identity claimed the appliance with from another tab', async () => {
      // Both tabs got past the "already exists?" check; one won. Its binding committed with the
      // account, so the other finds it by (issuer, subject) — the same person, not a stranger.
      mockFederatedIdentityService.findUserId.mockResolvedValue('user-1');
      mockUserService.findById.mockResolvedValue(mockUser);

      const res = await validPost();

      expect(mockFederatedIdentityService.findUserId).toHaveBeenCalledWith(
        'https://hub.test',
        'portal-sub-1',
      );
      expect(mockAuthService.issueSessionToken).toHaveBeenCalledWith('user-1', expect.anything());
      expect(res.headers.location).not.toMatch(/^\/login\?error=/);
    });
  });
});

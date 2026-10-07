import { type INestApplication, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { BodyParserMiddleware } from '@ci/common/middleware';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { SignupController } from '../controllers/SignupController';
import { AuthService } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';
import { SignupCodeService } from '../services/SignupCodeService';

import { parseCookies } from './utils/parseCookies';

const COOKIE_NAME = config.auth.cookies.sessionTokenName;

const MOCK_SESSION_ID = 'session-id-1';

const mockUser = { id: 'user-1', name: 'New User', email: 'new@example.com' };

/** The transaction `UserService.create` runs its `alongside` work in. */
const accountTransaction = { name: 'the transaction creating the account' };

const mockAuthService = {
  issueSessionToken: jest
    .fn()
    .mockResolvedValue({ sessionToken: 'session-token-value', sessionId: MOCK_SESSION_ID }),
  issueAccessToken: jest.fn().mockReturnValue('access-token-value'),
  getSessionMetadata: jest.fn().mockReturnValue({ ip: '127.0.0.1', userAgent: 'test' }),
  resolveCsrfScope: jest.fn().mockReturnValue(null),
};

/**
 * `create`'s contract: `alongside` runs inside the transaction that inserts the account, and if it
 * throws, the account is rolled back and the error reaches the caller as thrown.
 */
const createAccount = async (
  _context: unknown,
  _data: unknown,
  alongside?: (manager: unknown, user: unknown) => Promise<unknown>,
) => {
  await alongside?.(accountTransaction, mockUser);

  return mockUser;
};

const mockUserService = {
  checkEmailAvailability: jest.fn().mockResolvedValue(false),
  create: jest.fn(createAccount),
  // Default to an appliance that already has an account, so the signup-code
  // tests below exercise the gate rather than the first-account exemption:
  // createFirstAccount declines, and the requirements endpoint says "claimed".
  createFirstAccount: jest.fn().mockResolvedValue(null),
  hasNoUsers: jest.fn().mockResolvedValue(false),
};

const mockSignupCodeService = {
  findOne: jest.fn().mockResolvedValue({ signup_code: 'valid-code', used: false }),
  consume: jest.fn().mockResolvedValue(true),
};

const mockFeatureService = {
  isFeatureEnabled: jest.fn().mockResolvedValue(false),
};

const mockCsrfService = {
  generateToken: jest.fn().mockReturnValue('csrf-token'),
  validateToken: jest.fn(),
  verifyToken: jest.fn().mockReturnValue(true),
};

const mockLogger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};

@Module({
  controllers: [SignupController],
  providers: [
    { provide: AuthService, useValue: mockAuthService },
    { provide: UserService, useValue: mockUserService },
    { provide: SignupCodeService, useValue: mockSignupCodeService },
    { provide: FeatureService, useValue: mockFeatureService },
    { provide: CsrfService, useValue: mockCsrfService },
    // CsrfGuard (on /signup) injects the logger for its rejection warnings.
    { provide: LoggerService, useValue: mockLogger },
  ],
})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(BodyParserMiddleware).forRoutes('*');
  }
}

describe('SignupController', () => {
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
    mockUserService.checkEmailAvailability.mockResolvedValue(false);
    mockUserService.create.mockImplementation(createAccount);
    mockAuthService.issueSessionToken.mockResolvedValue({
      sessionToken: 'session-token-value',
      sessionId: MOCK_SESSION_ID,
    });
    mockAuthService.issueAccessToken.mockReturnValue('access-token-value');
    mockFeatureService.isFeatureEnabled.mockResolvedValue(false);
    mockSignupCodeService.findOne.mockResolvedValue({ signup_code: 'valid-code', used: false });
    mockSignupCodeService.consume.mockResolvedValue(true);
    mockUserService.createFirstAccount.mockResolvedValue(null);
    mockUserService.hasNoUsers.mockResolvedValue(false);
  });

  const validPayload = {
    name: 'New User',
    email: 'new@example.com',
    password: 'password123',
  };

  describe('POST /signup', () => {
    it('should set session token as httpOnly cookie on successful signup', async () => {
      const response = await request(app.getHttpServer()).post('/signup').send(validPayload).expect(201);

      const cookies = parseCookies(response);

      expect(cookies[COOKIE_NAME]).toBeDefined();
      expect(cookies[COOKIE_NAME].value).toBe('session-token-value');
      expect(cookies[COOKIE_NAME].httpOnly).toBe(true);
      expect(cookies[COOKIE_NAME].path).toBe('/');
    });

    it('should return access token in the response body', async () => {
      const response = await request(app.getHttpServer()).post('/signup').send(validPayload).expect(201);

      expect(response.body).toEqual({ accessToken: 'access-token-value' });
    });

    it('should not return session token in the response body', async () => {
      const response = await request(app.getHttpServer()).post('/signup').send(validPayload).expect(201);

      expect(response.body.sessionToken).toBeUndefined();
    });

    it('should set cookie with maxAge', async () => {
      const response = await request(app.getHttpServer()).post('/signup').send(validPayload).expect(201);

      const cookies = parseCookies(response);

      expect(cookies[COOKIE_NAME].maxAge).toBeDefined();
    });

    it('should mint the CSRF token bound to the newly issued session (identity boundary)', async () => {
      await request(app.getHttpServer()).post('/signup').send(validPayload).expect(201);

      expect(mockCsrfService.generateToken).toHaveBeenCalledWith(MOCK_SESSION_ID);
    });

    it('should return 400 when email is already in use', async () => {
      mockUserService.checkEmailAvailability.mockResolvedValue(true);

      await request(app.getHttpServer()).post('/signup').send(validPayload).expect(400);
    });

    it('should return 400 when required fields are missing', async () => {
      await request(app.getHttpServer()).post('/signup').send({ email: 'test@example.com' }).expect(400);
    });

    it('spends no code where none is required, even one that is offered', async () => {
      await request(app.getHttpServer())
        .post('/signup')
        .send({ ...validPayload, signup_code: 'valid-code' })
        .expect(201);

      expect(mockUserService.create).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined);
      expect(mockSignupCodeService.consume).not.toHaveBeenCalled();
    });

    it('should return 400 when password is too short', async () => {
      await request(app.getHttpServer())
        .post('/signup')
        .send({ name: 'User', email: 'test@example.com', password: 'short' })
        .expect(400);
    });

    it('asks for at least eight characters: seven are refused, and say why', async () => {
      const response = await request(app.getHttpServer())
        .post('/signup')
        .send({ name: 'User', email: 'test@example.com', password: 'seven77' })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('Password must be at least 8 characters');
      expect(mockUserService.create).not.toHaveBeenCalled();
    });

    it('does not ask whether this is the first account when signup codes are off', async () => {
      // There is no exemption to decide, so an ordinary create — which admits the second person
      // as readily as the first — is the whole of it.
      await request(app.getHttpServer()).post('/signup').send(validPayload).expect(201);

      expect(mockUserService.createFirstAccount).not.toHaveBeenCalled();
      expect(mockUserService.create).toHaveBeenCalledTimes(1);
    });

    describe('with signup codes required', () => {
      beforeEach(() => {
        mockFeatureService.isFeatureEnabled.mockResolvedValue(true);
      });

      it('should succeed with a valid signup code, redeeming it in the transaction creating the account', async () => {
        const response = await request(app.getHttpServer())
          .post('/signup')
          .send({ ...validPayload, signup_code: 'valid-code' })
          .expect(201);

        const cookies = parseCookies(response);

        expect(cookies[COOKIE_NAME]).toBeDefined();
        // Inside the account's transaction, so a signup that fails spends nothing.
        expect(mockSignupCodeService.consume).toHaveBeenCalledWith('valid-code', accountTransaction);
      });

      // The look-up only refuses early: two signups presenting one code both pass it. The one that
      // redeems it second must be refused — and its account, already written in that transaction,
      // rolled back — or one invitation admits two people.
      it('refuses a code another signup redeemed first, rolling back the account it was creating', async () => {
        mockSignupCodeService.consume.mockResolvedValue(false);

        const response = await request(app.getHttpServer())
          .post('/signup')
          .send({ ...validPayload, signup_code: 'valid-code' })
          .expect(400);

        expect(response.body.message).toBe('Must provide a valid signup code');
        await expect(mockUserService.create.mock.results[0].value).rejects.toThrow(
          'Must provide a valid signup code',
        );
        expect(mockAuthService.issueSessionToken).not.toHaveBeenCalled();
      });

      it('should return 400 when signup code is missing', async () => {
        await request(app.getHttpServer()).post('/signup').send(validPayload).expect(400);
      });

      it('should return 400 when signup code is invalid', async () => {
        mockSignupCodeService.findOne.mockResolvedValue(null);

        await request(app.getHttpServer())
          .post('/signup')
          .send({ ...validPayload, signup_code: 'bad-code' })
          .expect(400);

        // Refused before anything else is looked at — whether the address is taken included.
        expect(mockUserService.checkEmailAvailability).not.toHaveBeenCalled();
        expect(mockUserService.create).not.toHaveBeenCalled();
        expect(mockSignupCodeService.consume).not.toHaveBeenCalled();
      });

      // A self-hosted appliance starts with an empty user table AND an empty
      // signup-code table, and nothing in the product mints a code — so with the
      // gate applied unconditionally, the person who just installed the box could
      // never create the first account on it. The exemption is exactly one
      // account wide.
      it('allows the first account on an unclaimed appliance, with no code', async () => {
        mockUserService.createFirstAccount.mockResolvedValue(mockUser);

        await request(app.getHttpServer()).post('/signup').send(validPayload).expect(201);

        expect(mockUserService.createFirstAccount).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ email: validPayload.email, password: validPayload.password }),
        );
        expect(mockUserService.create).not.toHaveBeenCalled();
        expect(mockSignupCodeService.findOne).not.toHaveBeenCalled();
        expect(mockSignupCodeService.consume).not.toHaveBeenCalled();
      });

      it('requires a code again once the appliance has an account', async () => {
        mockUserService.createFirstAccount.mockResolvedValue(null);

        await request(app.getHttpServer()).post('/signup').send(validPayload).expect(400);

        expect(mockUserService.create).not.toHaveBeenCalled();
      });

      // Two people signing up to a fresh appliance at once both used to be
      // exempt: each asked "is it empty?" and then created an account. The
      // exemption is now decided as the account is created, and a signup that
      // loses it is held to the code like anyone arriving a moment later.
      it('never grants the exemption on an earlier look at the appliance', async () => {
        mockUserService.hasNoUsers.mockResolvedValue(true);
        mockUserService.createFirstAccount.mockResolvedValue(null);

        const response = await request(app.getHttpServer()).post('/signup').send(validPayload).expect(400);

        expect(response.body.message).toBe('Must provide a valid signup code');
        expect(mockUserService.hasNoUsers).not.toHaveBeenCalled();
        expect(mockUserService.create).not.toHaveBeenCalled();
      });

      it('admits a signup that lost the first-account race when it holds a code, and redeems it', async () => {
        mockUserService.createFirstAccount.mockResolvedValue(null);

        await request(app.getHttpServer())
          .post('/signup')
          .send({ ...validPayload, signup_code: 'valid-code' })
          .expect(201);

        expect(mockUserService.create).toHaveBeenCalledTimes(1);
        expect(mockSignupCodeService.consume).toHaveBeenCalledWith('valid-code', accountTransaction);
      });
    });

    describe('GET /signup/requirements', () => {
      it('reports a code as required when the flag is on and the appliance is claimed', async () => {
        mockFeatureService.isFeatureEnabled.mockResolvedValue(true);
        mockUserService.hasNoUsers.mockResolvedValue(false);

        const response = await request(app.getHttpServer()).get('/signup/requirements').expect(200);

        expect(response.body).toEqual({ codeRequired: true });
      });

      it('reports no code required on an unclaimed appliance, so the form hides the field', async () => {
        mockFeatureService.isFeatureEnabled.mockResolvedValue(true);
        mockUserService.hasNoUsers.mockResolvedValue(true);

        const response = await request(app.getHttpServer()).get('/signup/requirements').expect(200);

        expect(response.body).toEqual({ codeRequired: false });
      });
    });
  });
});

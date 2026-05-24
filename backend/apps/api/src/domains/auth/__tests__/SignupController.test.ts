import { type INestApplication, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { FeatureService } from '@ci/common/feature';
import { BodyParserMiddleware } from '@ci/common/middleware';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { SignupController } from '../controllers/SignupController';
import { AuthService } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';
import { SignupCodeService } from '../services/SignupCodeService';

import { parseCookies } from './utils/parseCookies';

const COOKIE_NAME = config.auth.cookies.sessionTokenName;

const mockUser = { id: 'user-1', name: 'New User', email: 'new@example.com' };

const mockAuthService = {
  issueSessionToken: jest.fn().mockResolvedValue('session-token-value'),
  issueAccessToken: jest.fn().mockReturnValue('access-token-value'),
  getSessionMetadata: jest.fn().mockReturnValue({ ip: '127.0.0.1', userAgent: 'test' }),
};

const mockUserService = {
  checkEmailAvailability: jest.fn().mockResolvedValue(false),
  create: jest.fn().mockResolvedValue(mockUser),
};

const mockSignupCodeService = {
  findOne: jest.fn().mockResolvedValue({ signup_code: 'valid-code', used: false }),
  update: jest.fn().mockResolvedValue(undefined),
};

const mockFeatureService = {
  isFeatureEnabled: jest.fn().mockResolvedValue(false),
};

const mockCsrfService = {
  generateToken: jest.fn().mockReturnValue('csrf-token'),
  validateToken: jest.fn(),
  verifyToken: jest.fn().mockReturnValue(true),
};

@Module({
  controllers: [SignupController],
  providers: [
    { provide: AuthService, useValue: mockAuthService },
    { provide: UserService, useValue: mockUserService },
    { provide: SignupCodeService, useValue: mockSignupCodeService },
    { provide: FeatureService, useValue: mockFeatureService },
    { provide: CsrfService, useValue: mockCsrfService },
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
    mockUserService.create.mockResolvedValue(mockUser);
    mockAuthService.issueSessionToken.mockResolvedValue('session-token-value');
    mockAuthService.issueAccessToken.mockReturnValue('access-token-value');
    mockFeatureService.isFeatureEnabled.mockResolvedValue(false);
    mockSignupCodeService.findOne.mockResolvedValue({ signup_code: 'valid-code', used: false });
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

    it('should return 400 when email is already in use', async () => {
      mockUserService.checkEmailAvailability.mockResolvedValue(true);

      await request(app.getHttpServer()).post('/signup').send(validPayload).expect(400);
    });

    it('should return 400 when required fields are missing', async () => {
      await request(app.getHttpServer()).post('/signup').send({ email: 'test@example.com' }).expect(400);
    });

    it('should return 400 when password is too short', async () => {
      await request(app.getHttpServer())
        .post('/signup')
        .send({ name: 'User', email: 'test@example.com', password: 'short' })
        .expect(400);
    });

    describe('with signup codes required', () => {
      beforeEach(() => {
        mockFeatureService.isFeatureEnabled.mockResolvedValue(true);
      });

      it('should succeed with a valid signup code', async () => {
        const response = await request(app.getHttpServer())
          .post('/signup')
          .send({ ...validPayload, signup_code: 'valid-code' })
          .expect(201);

        const cookies = parseCookies(response);

        expect(cookies[COOKIE_NAME]).toBeDefined();
        expect(mockSignupCodeService.update).toHaveBeenCalledWith('valid-code', { used: true });
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
      });
    });
  });
});

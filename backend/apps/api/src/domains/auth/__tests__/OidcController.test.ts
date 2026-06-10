import { type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { OidcController } from '../controllers/OidcController';
import { AuthService } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';

import { parseCookies } from './utils/parseCookies';

jest.mock('undici', () => ({
  Agent: jest.fn(),
  fetch: jest.fn(),
}));

// eslint-disable-next-line import/order
import { fetch as undiciFetch } from 'undici';

const mockFetch = undiciFetch as jest.Mock;

const SESSION_COOKIE = config.auth.cookies.sessionTokenName;
const ISSUER_URL = 'https://portal.example.com';

const mockUser = { id: 'user-1', name: 'Existing User', email: 'user@example.com' };

const mockUserService = {
  findByEmail: jest.fn().mockResolvedValue(mockUser),
  create: jest.fn().mockResolvedValue(mockUser),
};

const mockAuthService = {
  issueSessionToken: jest.fn().mockResolvedValue('session-token-value'),
  getSessionMetadata: jest.fn().mockReturnValue({ ip: '127.0.0.1', userAgent: 'test' }),
};

const mockCsrfService = {
  generateToken: jest.fn().mockReturnValue('csrf-token'),
};

const mockFeatureService = {
  isFeatureEnabled: jest.fn().mockResolvedValue(false),
};

const mockLogger = {
  setContext: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
};

@Module({
  controllers: [OidcController],
  providers: [
    { provide: UserService, useValue: mockUserService },
    { provide: AuthService, useValue: mockAuthService },
    { provide: CsrfService, useValue: mockCsrfService },
    { provide: FeatureService, useValue: mockFeatureService },
    { provide: LoggerService, useValue: mockLogger },
  ],
})
class TestModule {}

function tokenResponse(body: Record<string, unknown>, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('OidcController', () => {
  let app: INestApplication;
  let originalIssuerUrl: string;

  beforeAll(async () => {
    originalIssuerUrl = config.auth.oidc.issuerUrl;
    config.auth.oidc.issuerUrl = ISSUER_URL;

    const module = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();

    app = module.createNestApplication({ logger: false });
    app.use(cookieParser());

    await app.init();
  });

  afterAll(async () => {
    config.auth.oidc.issuerUrl = originalIssuerUrl;
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    config.auth.oidc.issuerUrl = ISSUER_URL;
    mockUserService.findByEmail.mockResolvedValue(mockUser);
    mockUserService.create.mockResolvedValue(mockUser);
    mockAuthService.issueSessionToken.mockResolvedValue('session-token-value');
    mockAuthService.getSessionMetadata.mockReturnValue({ ip: '127.0.0.1', userAgent: 'test' });
    mockCsrfService.generateToken.mockReturnValue('csrf-token');
    mockFeatureService.isFeatureEnabled.mockResolvedValue(false);
  });

  describe('GET /authenticate/oidc (initiate)', () => {
    it('redirects to the Portal authorize endpoint with PKCE parameters', async () => {
      const response = await request(app.getHttpServer()).get('/authenticate/oidc').expect(302);

      const location = new URL(response.headers.location);

      expect(location.origin).toBe(ISSUER_URL);
      expect(location.pathname).toBe('/api/auth/oauth2/authorize');
      expect(location.searchParams.get('client_id')).toBe('ci-server');
      expect(location.searchParams.get('response_type')).toBe('code');
      expect(location.searchParams.get('scope')).toBe('openid email profile');
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');
      expect(location.searchParams.get('code_challenge')).toBeTruthy();
      expect(location.searchParams.get('state')).toBeTruthy();
      expect(location.searchParams.get('redirect_uri')).toContain('/api/authenticate/oidc/callback');
    });

    it('sets httpOnly state and PKCE cookies', async () => {
      const response = await request(app.getHttpServer()).get('/authenticate/oidc').expect(302);

      const cookies = parseCookies(response);

      expect(cookies.oidc_state).toBeDefined();
      expect(cookies.oidc_state.httpOnly).toBe(true);
      expect(cookies.oidc_pkce).toBeDefined();
      expect(cookies.oidc_pkce.httpOnly).toBe(true);

      const location = new URL(response.headers.location);
      expect(location.searchParams.get('state')).toBe(cookies.oidc_state.value);
    });

    it('redirects to login with an error when OIDC is not configured', async () => {
      config.auth.oidc.issuerUrl = '';

      const response = await request(app.getHttpServer()).get('/authenticate/oidc').expect(302);

      expect(response.headers.location).toBe('/login?error=oidc_not_configured');
    });
  });

  describe('GET /authenticate/oidc/callback', () => {
    const STATE = 'test-state';
    const VERIFIER = 'test-verifier';
    const COOKIES = [`oidc_state=${STATE}`, `oidc_pkce=${VERIFIER}`].join('; ');

    function mockPortalSuccess(
      userInfo: Record<string, unknown> = {
        sub: 'portal-1',
        email: 'user@example.com',
        name: 'Existing User',
      },
    ) {
      mockFetch
        .mockResolvedValueOnce(tokenResponse({ access_token: 'portal-access-token', token_type: 'Bearer' }))
        .mockResolvedValueOnce(tokenResponse(userInfo));
    }

    it('redirects to login when code or state is missing', async () => {
      const response = await request(app.getHttpServer()).get('/authenticate/oidc/callback').expect(302);

      expect(response.headers.location).toBe('/login?error=missing_params');
    });

    it('redirects to login when state does not match the cookie', async () => {
      const response = await request(app.getHttpServer())
        .get('/authenticate/oidc/callback')
        .query({ code: 'auth-code', state: 'wrong-state' })
        .set('Cookie', COOKIES)
        .expect(302);

      expect(response.headers.location).toBe('/login?error=invalid_state');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('redirects to login when the PKCE cookie is missing', async () => {
      const response = await request(app.getHttpServer())
        .get('/authenticate/oidc/callback')
        .query({ code: 'auth-code', state: STATE })
        .set('Cookie', `oidc_state=${STATE}`)
        .expect(302);

      expect(response.headers.location).toBe('/login?error=missing_pkce');
    });

    it('passes the Portal error through to the login page', async () => {
      const response = await request(app.getHttpServer())
        .get('/authenticate/oidc/callback')
        .query({ error: 'access_denied' })
        .expect(302);

      expect(response.headers.location).toBe('/login?error=access_denied');
    });

    it('issues a session for an existing user and clears the flow cookies', async () => {
      mockPortalSuccess();

      const response = await request(app.getHttpServer())
        .get('/authenticate/oidc/callback')
        .query({ code: 'auth-code', state: STATE })
        .set('Cookie', COOKIES)
        .expect(302);

      expect(response.headers.location).toBe('/');

      const cookies = parseCookies(response);
      expect(cookies[SESSION_COOKIE].value).toBe('session-token-value');
      expect(cookies[SESSION_COOKIE].httpOnly).toBe(true);
      expect(cookies.oidc_state.value).toBe('');
      expect(cookies.oidc_pkce.value).toBe('');

      expect(mockUserService.findByEmail).toHaveBeenCalledWith('user@example.com');
      expect(mockUserService.create).not.toHaveBeenCalled();
    });

    it('exchanges the code with PKCE verifier and ci-server client id', async () => {
      mockPortalSuccess();

      await request(app.getHttpServer())
        .get('/authenticate/oidc/callback')
        .query({ code: 'auth-code', state: STATE })
        .set('Cookie', COOKIES)
        .expect(302);

      const [tokenUrl, tokenInit] = mockFetch.mock.calls[0];
      expect(String(tokenUrl)).toBe(`${ISSUER_URL}/api/auth/oauth2/token`);

      const body = new URLSearchParams(String(tokenInit.body));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth-code');
      expect(body.get('client_id')).toBe('ci-server');
      expect(body.get('code_verifier')).toBe(VERIFIER);

      const [userinfoUrl, userinfoInit] = mockFetch.mock.calls[1];
      expect(String(userinfoUrl)).toBe(`${ISSUER_URL}/api/auth/oauth2/userinfo`);
      expect(userinfoInit.headers.Authorization).toBe('Bearer portal-access-token');
    });

    it('auto-provisions an unknown user when signup codes are not required', async () => {
      mockPortalSuccess({ sub: 'portal-2', email: 'new@example.com', name: 'New User' });
      mockUserService.findByEmail.mockResolvedValue(null);
      mockFeatureService.isFeatureEnabled.mockResolvedValue(false);

      const response = await request(app.getHttpServer())
        .get('/authenticate/oidc/callback')
        .query({ code: 'auth-code', state: STATE })
        .set('Cookie', COOKIES)
        .expect(302);

      expect(response.headers.location).toBe('/');
      expect(mockUserService.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'new@example.com', name: 'New User' }),
      );
    });

    it('rejects an unknown user when signup codes are required', async () => {
      mockPortalSuccess({ sub: 'portal-2', email: 'new@example.com', name: 'New User' });
      mockUserService.findByEmail.mockResolvedValue(null);
      mockFeatureService.isFeatureEnabled.mockResolvedValue(true);

      const response = await request(app.getHttpServer())
        .get('/authenticate/oidc/callback')
        .query({ code: 'auth-code', state: STATE })
        .set('Cookie', COOKIES)
        .expect(302);

      expect(response.headers.location).toBe('/login?error=signup_code_required');
      expect(mockFeatureService.isFeatureEnabled).toHaveBeenCalledWith('require.signup.codes');
      expect(mockUserService.create).not.toHaveBeenCalled();
      expect(mockAuthService.issueSessionToken).not.toHaveBeenCalled();

      const cookies = parseCookies(response);
      expect(cookies[SESSION_COOKIE]).toBeUndefined();
    });

    it('redirects to login when the token exchange fails', async () => {
      mockFetch.mockResolvedValueOnce(tokenResponse({ error: 'invalid_grant' }, false, 400));

      const response = await request(app.getHttpServer())
        .get('/authenticate/oidc/callback')
        .query({ code: 'auth-code', state: STATE })
        .set('Cookie', COOKIES)
        .expect(302);

      expect(response.headers.location).toBe('/login?error=token_exchange_failed');
      expect(mockAuthService.issueSessionToken).not.toHaveBeenCalled();
    });

    it('redirects to login when userinfo has no email', async () => {
      mockPortalSuccess({ sub: 'portal-3', name: 'No Email' });

      const response = await request(app.getHttpServer())
        .get('/authenticate/oidc/callback')
        .query({ code: 'auth-code', state: STATE })
        .set('Cookie', COOKIES)
        .expect(302);

      expect(response.headers.location).toBe('/login?error=no_email');
      expect(mockAuthService.issueSessionToken).not.toHaveBeenCalled();
    });
  });
});

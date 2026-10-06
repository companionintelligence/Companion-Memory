import { type INestApplication, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { RequestContextMiddleware } from '@ci/common/context';
import { PORTAL_TOKEN_VERIFIER } from '@ci/common/guards/PortalTokenVerifier';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { ApiKeyService } from '../../services/ApiKeyService';
import { ApiKeyStrategy } from '../../services/ApiKeyStrategy';
import { AuthService } from '../../services/AuthService';
import { capabilityForApp, scopesForApp } from '../../services/ConnectService';
import { FederatedIdentityService } from '../../services/FederatedIdentityService';
import { HubForwardAuthBridgeService } from '../../services/HubForwardAuthBridgeService';
import { JwtStrategy } from '../../services/JwtStrategy';
import { CONNECT_PROVENANCE, type ValidatedApiKey } from '../../types';
import { AccountController } from '../AccountController';

const USER = { id: 'user-1', email: 'jsmith@example.com', passwordSetAt: new Date() };

const CHAT_AGENT_URN = 'ci-openclaw:ci-marketplace';

/**
 * Every key shape the deletion route has to tell apart, as `ApiKeyService.validateKey`
 * reports it. The raw values are 64 hex characters, like a minted key.
 */
const KEYS: Record<string, { raw: string; validated: ValidatedApiKey }> = {
  // What `mintAndStoreApiKey` (web `useAuth.ts`) mints for the phone: `full`, no
  // scopes, the user's own. The one key this route exists to admit.
  native: {
    raw: 'a'.repeat(64),
    validated: {
      keyId: 'k-native',
      userId: USER.id,
      scopes: [],
      capability: 'full',
      managedBy: null,
      name: 'Companion mobile · 2026-09-30',
    },
  },
  // The level every new key is minted at, and what a phone that signed in before
  // #2661 still holds.
  write: {
    raw: 'b'.repeat(64),
    validated: {
      keyId: 'k-write',
      userId: USER.id,
      scopes: [],
      capability: 'write',
      managedBy: null,
      name: 'agent',
    },
  },
  read: {
    raw: 'c'.repeat(64),
    validated: {
      keyId: 'k-read',
      userId: USER.id,
      scopes: [],
      capability: 'read',
      managedBy: null,
      name: 'dashboard',
    },
  },
  // A chat agent's real connect grant: `full`, confined to its scopes.
  chatAgent: {
    raw: 'd'.repeat(64),
    validated: {
      keyId: 'k-chat-agent',
      userId: USER.id,
      scopes: scopesForApp(CHAT_AGENT_URN),
      capability: capabilityForApp(CHAT_AGENT_URN),
      managedBy: CONNECT_PROVENANCE,
      name: `app:${CHAT_AGENT_URN}`,
    },
  },
  // No app holds this today. It is what an app would get if it were added to
  // `FULL_SURFACE_CONNECT_APPS` at `full`, and nothing about that edit points at this route.
  fullSurfaceApp: {
    raw: 'e'.repeat(64),
    validated: {
      keyId: 'k-app',
      userId: USER.id,
      scopes: [],
      capability: 'full',
      managedBy: CONNECT_PROVENANCE,
      name: 'app:some-app:ci-marketplace',
    },
  },
};

const mockUserService = {
  findById: jest.fn(),
  requestDeletion: jest.fn(),
  changeEmail: jest.fn(),
  changePassword: jest.fn(),
  checkEmailAvailability: jest.fn(),
  validatePassword: jest.fn(),
};

const mockAuthService = {
  invalidateOtherSessions: jest.fn(),
  sessionEstablishedAt: jest.fn(),
};

const mockFederatedIdentityService = {
  listForUser: jest.fn(),
};

const mockHubBridge = {
  namesAccount: jest.fn(),
};

const mockApiKeyService = {
  validateKey: jest.fn(),
  revokeSignInKeys: jest.fn(),
  revokeAllExceptConnect: jest.fn(),
};

// Enabled, as `auth.portal.enabled` is by default, and verifying nothing: a request
// carrying a session JWT is offered to it first and has to fall through.
const mockPortalTokenVerifier = {
  enabled: true,
  verifyAndProvision: jest.fn(),
  verifyClaims: jest.fn(),
};

@Module({
  controllers: [AccountController],
  imports: [PassportModule],
  providers: [
    { provide: UserService, useValue: mockUserService },
    { provide: AuthService, useValue: mockAuthService },
    { provide: FederatedIdentityService, useValue: mockFederatedIdentityService },
    { provide: HubForwardAuthBridgeService, useValue: mockHubBridge },
    { provide: ApiKeyService, useValue: mockApiKeyService },
    { provide: PORTAL_TOKEN_VERIFIER, useValue: mockPortalTokenVerifier },
    // Instantiating these registers the real 'jwt' and 'api-key' passport strategies
    // the guards delegate to, so what is under test is the production authentication
    // path, not a stand-in for it.
    JwtStrategy,
    ApiKeyStrategy,
  ],
})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // `@Context()` reads ContextService's AsyncLocalStorage, which exists only inside a
    // request wrapped by this middleware — as in application.ts.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

/**
 * Who may reach `AccountController`, proven at the guard rather than by calling the
 * handler (`AccountController.test.ts` does that, and cannot see a guard at all).
 *
 * The native app never holds a JWT: it trades one for a durable API key at sign-in
 * and sends `x-api-key` from then on. #2743 moved every route here, deletion
 * included, onto the session-only `JwtAuthGuard`, and in-app deletion — the path
 * Apple 5.1.1(v) and Google Play require — answered every phone with 401. These
 * tests pin both halves of the fix: the device key deletes, and the same key still
 * cannot touch the credentials #2743 made session-only.
 */
describe('AccountController (real guards + real JwtStrategy and ApiKeyStrategy)', () => {
  let app: INestApplication;
  const jwtService = new JwtService({});

  function sessionAccessToken(): string {
    return jwtService.sign({ sub: USER.id }, { secret: config.auth.jwt.authTokenSecret, expiresIn: '15m' });
  }

  function deleteAccount() {
    return request(app.getHttpServer()).delete('/account').send({ confirmEmail: USER.email });
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [TestModule] }).compile();

    app = module.createNestApplication({ bodyParser: true, logger: false });
    // Listen once, so supertest does not listen and close on a fresh ephemeral port for
    // every request. Under a parallel run that churn intermittently resets a connection
    // (`socket hang up`), whatever the request.
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserService.findById.mockResolvedValue(USER);
    mockUserService.requestDeletion.mockResolvedValue(true);
    mockFederatedIdentityService.listForUser.mockResolvedValue([]);
    mockHubBridge.namesAccount.mockReturnValue(false);
    mockPortalTokenVerifier.verifyAndProvision.mockResolvedValue(null);
    mockApiKeyService.validateKey.mockImplementation(
      async (raw: string) => Object.values(KEYS).find((key) => key.raw === raw)?.validated ?? null,
    );
  });

  describe('DELETE /account', () => {
    it('deletes the account for the native app, with the device key it holds (x-api-key)', async () => {
      await deleteAccount().set('x-api-key', KEYS.native.raw).expect(204);

      expect(mockUserService.requestDeletion).toHaveBeenCalledWith({ userId: USER.id }, USER.id, {
        successorEmail: undefined,
      });
    });

    it('deletes the account for a web session (JWT)', async () => {
      await deleteAccount().set('Authorization', `Bearer ${sessionAccessToken()}`).expect(204);

      expect(mockUserService.requestDeletion).toHaveBeenCalledWith({ userId: USER.id }, USER.id, {
        successorEmail: undefined,
      });
    });

    it('401s with no credential', async () => {
      await deleteAccount().expect(401);

      expect(mockUserService.requestDeletion).not.toHaveBeenCalled();
    });

    it.each([
      ['a `write` key: the level every new key is minted at, and a phone signed in before #2661', 'write'],
      ['a `read` key', 'read'],
      ["a chat agent's connect key, `full` but confined to its scopes", 'chatAgent'],
      ["an installed app's key holding the whole surface at `full`", 'fullSurfaceApp'],
    ])('403s %s, and deletes nothing', async (_label, name) => {
      await deleteAccount().set('x-api-key', KEYS[name].raw).expect(403);

      expect(mockUserService.requestDeletion).not.toHaveBeenCalled();
    });
  });

  describe('the credential routes stay session-only (#2743)', () => {
    const routes: Array<{ method: 'get' | 'patch' | 'post'; path: string; body?: object }> = [
      { method: 'get', path: '/account' },
      // A key must not be able to revoke every other credential, its owner's sessions included.
      { method: 'post', path: '/account/sign-out-everywhere' },
      {
        method: 'patch',
        path: '/account/email',
        body: { newEmail: 'new@example.com', currentPassword: 'x' },
      },
      {
        method: 'patch',
        path: '/account/password',
        body: { newPassword: 'new-password-1', currentPassword: 'x' },
      },
    ];

    it.each(routes)(
      '401s $method $path for the same `full` device key that may delete the account',
      async ({ method, path, body }) => {
        const call = request(app.getHttpServer())[method](path).set('x-api-key', KEYS.native.raw);

        await (body ? call.send(body) : call).expect(401);

        expect(mockUserService.changeEmail).not.toHaveBeenCalled();
        expect(mockUserService.changePassword).not.toHaveBeenCalled();
        expect(mockApiKeyService.revokeAllExceptConnect).not.toHaveBeenCalled();
      },
    );

    it('serves a session, so the 401s above are about the key and not the route', async () => {
      await request(app.getHttpServer())
        .get('/account')
        .set('Authorization', `Bearer ${sessionAccessToken()}`)
        .expect(200, {
          email: USER.email,
          hasFederatedIdentity: false,
          hasOwnPassword: true,
          emailManagedByHub: false,
        });
    });
  });
});

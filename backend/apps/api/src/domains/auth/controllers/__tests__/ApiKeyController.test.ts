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
import { JwtStrategy } from '../../services/JwtStrategy';
import { SIGN_IN_PROVENANCE, type ValidatedApiKey } from '../../types';
import { ApiKeyController } from '../ApiKeyController';

const mockApiKeyService = {
  create: jest.fn(),
  findAllByUser: jest.fn(),
  findOneByUser: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  validateKey: jest.fn(),
};

/** The key the phone app signs in with, as `ApiKeyService.validateKey` reports it. */
const DEVICE_KEY = {
  raw: 'a'.repeat(64),
  validated: {
    keyId: 'k-device',
    userId: 'user-1',
    scopes: [],
    capability: 'full',
    managedBy: SIGN_IN_PROVENANCE,
    name: 'Companion mobile · 2026-10-06',
  } satisfies ValidatedApiKey,
};

/** A read-only key: giving itself up is still within its reach. */
const READ_KEY = {
  raw: 'b'.repeat(64),
  validated: { ...DEVICE_KEY.validated, keyId: 'k-read', capability: 'read', managedBy: null, name: 'dash' },
};

/** An installed app's key: scope-limited, and the Hub's to revoke. */
const APP_KEY = {
  raw: 'c'.repeat(64),
  validated: {
    ...DEVICE_KEY.validated,
    keyId: 'k-app',
    scopes: ['memory'],
    managedBy: 'connect',
    name: 'app:ci-hermes:ci-marketplace',
  } satisfies ValidatedApiKey,
};

/**
 * A broad-access app's key (the bulk importer's): no scopes, so the scope rule lets it through,
 * but it is still the Hub's to revoke.
 */
const BROAD_APP_KEY = {
  raw: 'd'.repeat(64),
  validated: {
    ...APP_KEY.validated,
    keyId: 'k-importer',
    scopes: [],
    name: 'app:ci-import-tools:ci-marketplace',
  },
};

const AUTH_USER = { id: 'user-1', name: 'Test User' };

const mockUserService = {
  findById: jest.fn(),
};

// A disabled verifier so the guard falls straight through to its `super.canActivate`
// (the passport 'jwt' strategy) branch — this suite is specifically about that
// fallback, not the portal-token path (covered by PortalTokenService.test.ts).
const mockPortalTokenVerifier = {
  enabled: false,
  verifyAndProvision: jest.fn(),
};

@Module({
  controllers: [ApiKeyController],
  imports: [PassportModule],
  providers: [
    { provide: ApiKeyService, useValue: mockApiKeyService },
    { provide: UserService, useValue: mockUserService },
    { provide: PORTAL_TOKEN_VERIFIER, useValue: mockPortalTokenVerifier },
    // Instantiating this registers the real 'jwt' passport strategy that
    // JwtOrPortalAuthGuard's `AuthGuard('jwt')` base delegates to — the actual
    // production authentication path, not a stand-in.
    JwtStrategy,
    // ...and the real 'api-key' strategy, which only `DELETE /keys/current` accepts.
    ApiKeyStrategy,
  ],
})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Context() reads from ContextService's AsyncLocalStorage, which only
    // exists inside a request wrapped by this middleware — exactly as in the
    // real app (application.ts).
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

/**
 * `ApiKeyController`'s five routes (`create`/`findAll`/`findOne`/`update`/`remove`)
 * had NO test coverage at all before this file: no test constructed the
 * controller or exercised its handlers, and the only related test
 * (apiKeyScopeValidation.test.ts) only imports the zod schemas.
 *
 * Two things specifically matter here and are otherwise unverified:
 *
 *  1. These routes are actually reachable ONLY via a session JWT or portal
 *     bearer — never a bare api key — per the controller's own security
 *     rationale ("a leaked key must not be able to mint/read successor
 *     keys"). This is proven with the REAL `JwtOrPortalAuthGuard` and REAL
 *     `JwtStrategy` wired up (not overridden with an always-true stub), so a
 *     guard misconfiguration would actually fail these tests.
 *  2. The `@Context()` → `toServiceContext()` → service wiring, and the
 *     404-on-null translation for findOne/update/remove.
 */
describe('ApiKeyController (real guard + real JwtStrategy)', () => {
  let app: INestApplication;
  const jwtService = new JwtService({});

  function sessionAccessToken(sub: string): string {
    return jwtService.sign({ sub }, { secret: config.auth.jwt.authTokenSecret, expiresIn: '15m' });
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [TestModule] }).compile();

    app = module.createNestApplication({ bodyParser: true, logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUserService.findById.mockResolvedValue(AUTH_USER);
    mockPortalTokenVerifier.enabled = false;
  });

  describe('guard enforcement', () => {
    const routes: Array<{ method: 'get' | 'post' | 'patch' | 'delete'; path: string }> = [
      { method: 'post', path: '/keys' },
      { method: 'get', path: '/keys' },
      { method: 'get', path: '/keys/key-1' },
      { method: 'patch', path: '/keys/key-1' },
      { method: 'delete', path: '/keys/key-1' },
    ];

    it.each(routes)('rejects $method $path with no credential at all (401)', async ({ method, path }) => {
      await request(app.getHttpServer())[method](path).expect(401);

      expect(mockApiKeyService.create).not.toHaveBeenCalled();
      expect(mockApiKeyService.findAllByUser).not.toHaveBeenCalled();
      expect(mockApiKeyService.findOneByUser).not.toHaveBeenCalled();
      expect(mockApiKeyService.update).not.toHaveBeenCalled();
      expect(mockApiKeyService.remove).not.toHaveBeenCalled();
    });

    it.each(routes)(
      'rejects $method $path presenting a bare api key (x-api-key header) — never reachable this way',
      async ({ method, path }) => {
        // The controller doc explicitly rules this out: a leaked api key must
        // not be able to list/read/mint/revoke keys, or it could mint itself
        // a replacement that outlives its own revocation. JwtOrPortalAuthGuard
        // has no ApiKeyStrategy in its chain at all, so this must 401 exactly
        // like having no credential.
        await request(app.getHttpServer())[method](path).set('x-api-key', 'a'.repeat(64)).expect(401);
      },
    );

    it.each(routes)(
      'rejects $method $path when an api key is sent as a Bearer token',
      async ({ method, path }) => {
        // Also rules out the "just move it to Authorization: Bearer" bypass: a raw
        // hex api key is not a valid signed JWT, so passport-jwt's signature
        // verification fails it the same as any other garbage bearer value.
        await request(app.getHttpServer())
          [method](path)
          .set('Authorization', `Bearer ${'a'.repeat(64)}`)
          .expect(401);
      },
    );

    it('accepts a valid session access token (real JwtStrategy verifies it)', async () => {
      mockApiKeyService.findAllByUser.mockResolvedValue([]);

      await request(app.getHttpServer())
        .get('/keys')
        .set('Authorization', `Bearer ${sessionAccessToken(AUTH_USER.id)}`)
        .expect(200);

      expect(mockApiKeyService.findAllByUser).toHaveBeenCalledWith({ userId: AUTH_USER.id });
    });

    it('rejects a validly-signed token for a user that no longer exists', async () => {
      mockUserService.findById.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get('/keys')
        .set('Authorization', `Bearer ${sessionAccessToken('deleted-user')}`)
        .expect(401);

      expect(mockApiKeyService.findAllByUser).not.toHaveBeenCalled();
    });
  });

  describe('handler wiring (authenticated)', () => {
    function authed() {
      return request(app.getHttpServer())
        .get('/keys')
        .set('Authorization', `Bearer ${sessionAccessToken(AUTH_USER.id)}`);
    }

    function authedMethod(method: 'get' | 'post' | 'patch' | 'delete', path: string) {
      return request(app.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${sessionAccessToken(AUTH_USER.id)}`);
    }

    it('POST /keys creates a key scoped to the authenticated user', async () => {
      mockApiKeyService.create.mockResolvedValue({ id: 'k1', name: 'My key', key: 'raw' });

      const response = await authedMethod('post', '/keys').send({ name: 'My key' }).expect(201);

      expect(mockApiKeyService.create).toHaveBeenCalledWith(
        { userId: AUTH_USER.id },
        { name: 'My key' },
        null,
      );
      expect(response.body).toEqual({ id: 'k1', name: 'My key', key: 'raw' });
    });

    it("GET /keys lists the authenticated user's keys", async () => {
      mockApiKeyService.findAllByUser.mockResolvedValue([{ id: 'k1' }]);

      await authed().expect(200);

      expect(mockApiKeyService.findAllByUser).toHaveBeenCalledWith({ userId: AUTH_USER.id });
    });

    it('GET /keys/:id returns the key when found', async () => {
      mockApiKeyService.findOneByUser.mockResolvedValue({ id: 'key-1', name: 'k' });

      const response = await authedMethod('get', '/keys/key-1').expect(200);

      expect(mockApiKeyService.findOneByUser).toHaveBeenCalledWith({ userId: AUTH_USER.id }, 'key-1');
      expect(response.body).toEqual({ id: 'key-1', name: 'k' });
    });

    it('GET /keys/:id 404s when the service returns null (not found or not owned)', async () => {
      mockApiKeyService.findOneByUser.mockResolvedValue(null);

      await authedMethod('get', '/keys/missing').expect(404);
    });

    it('PATCH /keys/:id 404s when the service returns null', async () => {
      mockApiKeyService.update.mockResolvedValue(null);

      await authedMethod('patch', '/keys/missing').send({ name: 'x' }).expect(404);
      expect(mockApiKeyService.update).toHaveBeenCalledWith({ userId: AUTH_USER.id }, 'missing', {
        name: 'x',
      });
    });

    it('DELETE /keys/:id 404s when the service reports nothing removed', async () => {
      mockApiKeyService.remove.mockResolvedValue(false);

      await authedMethod('delete', '/keys/missing').expect(404);
    });

    it('DELETE /keys/:id 204s when the service reports a removal', async () => {
      mockApiKeyService.remove.mockResolvedValue(true);

      await authedMethod('delete', '/keys/key-1').expect(204);
      expect(mockApiKeyService.remove).toHaveBeenCalledWith({ userId: AUTH_USER.id }, 'key-1');
    });
  });

  describe('a sign-in key and the self-revoke route', () => {
    beforeEach(() => {
      mockApiKeyService.validateKey.mockImplementation(
        async (raw: string) =>
          [DEVICE_KEY, READ_KEY, APP_KEY, BROAD_APP_KEY].find((key) => key.raw === raw)?.validated ?? null,
      );
      mockApiKeyService.remove.mockResolvedValue(true);
    });

    it('tags a key the app mints at sign-in, so a password change can revoke it', async () => {
      mockApiKeyService.create.mockResolvedValue({ id: 'k2', name: 'Companion mobile', key: 'raw' });

      await request(app.getHttpServer())
        .post('/keys')
        .set('Authorization', `Bearer ${sessionAccessToken(AUTH_USER.id)}`)
        .send({ name: 'Companion mobile · 2026-10-06', capability: 'full', sign_in: true })
        .expect(201);

      expect(mockApiKeyService.create).toHaveBeenCalledWith(
        { userId: AUTH_USER.id },
        expect.objectContaining({ name: 'Companion mobile · 2026-10-06' }),
        SIGN_IN_PROVENANCE,
      );
    });

    it('tags a key an app build from before `sign_in` mints, by the name every build gives it', async () => {
      mockApiKeyService.create.mockResolvedValue({ id: 'k3', name: 'Companion mobile', key: 'raw' });

      await request(app.getHttpServer())
        .post('/keys')
        .set('Authorization', `Bearer ${sessionAccessToken(AUTH_USER.id)}`)
        .send({ name: 'Companion mobile · 2026-09-30', capability: 'full' })
        .expect(201);

      expect(mockApiKeyService.create).toHaveBeenCalledWith(
        { userId: AUTH_USER.id },
        expect.objectContaining({ name: 'Companion mobile · 2026-09-30' }),
        SIGN_IN_PROVENANCE,
      );
    });

    it('leaves a key someone names in Settings untagged', async () => {
      mockApiKeyService.create.mockResolvedValue({ id: 'k4', name: 'Companion mobile backup', key: 'raw' });

      await request(app.getHttpServer())
        .post('/keys')
        .set('Authorization', `Bearer ${sessionAccessToken(AUTH_USER.id)}`)
        .send({ name: 'Companion mobile backup', capability: 'write' })
        .expect(201);

      expect(mockApiKeyService.create).toHaveBeenCalledWith(
        { userId: AUTH_USER.id },
        expect.objectContaining({ name: 'Companion mobile backup' }),
        null,
      );
    });

    it('lets a key revoke itself, and only itself', async () => {
      await request(app.getHttpServer()).delete('/keys/current').set('x-api-key', DEVICE_KEY.raw).expect(204);

      expect(mockApiKeyService.remove).toHaveBeenCalledTimes(1);
      expect(mockApiKeyService.remove).toHaveBeenCalledWith({ userId: 'user-1' }, 'k-device');
    });

    it('lets a read-only key give itself up too', async () => {
      await request(app.getHttpServer()).delete('/keys/current').set('x-api-key', READ_KEY.raw).expect(204);

      expect(mockApiKeyService.remove).toHaveBeenCalledWith({ userId: 'user-1' }, 'k-read');
    });

    it("refuses an installed app's scope-limited key: the Hub revokes those", async () => {
      await request(app.getHttpServer()).delete('/keys/current').set('x-api-key', APP_KEY.raw).expect(403);

      expect(mockApiKeyService.remove).not.toHaveBeenCalled();
    });

    it("refuses an installed app's key with no scopes too: provenance, not scope, makes it the Hub's", async () => {
      await request(app.getHttpServer())
        .delete('/keys/current')
        .set('x-api-key', BROAD_APP_KEY.raw)
        .expect(403);

      expect(mockApiKeyService.remove).not.toHaveBeenCalled();
    });

    it('takes no session: there is no "current key" behind a JWT', async () => {
      await request(app.getHttpServer())
        .delete('/keys/current')
        .set('Authorization', `Bearer ${sessionAccessToken(AUTH_USER.id)}`)
        .expect(401);

      expect(mockApiKeyService.remove).not.toHaveBeenCalled();
    });
  });
});

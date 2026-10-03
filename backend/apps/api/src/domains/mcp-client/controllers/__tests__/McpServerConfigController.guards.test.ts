import { type INestApplication, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ExtractJwt, Strategy } from 'passport-jwt';
import request from 'supertest';

import { ContextService, RequestContextMiddleware } from '@ci/common/context';
import { PORTAL_TOKEN_VERIFIER } from '@ci/common/guards/PortalTokenVerifier';
import config from '@ci/configuration';

import { McpServerConfigService } from '../../services/McpServerConfigService';
import { McpServerConfigController } from '../McpServerConfigController';

const mockConfigService = {
  listForUser: jest.fn(),
  create: jest.fn(),
  setEnabled: jest.fn(),
};

/** What the session strategy below resolves a valid access token to. */
const session = { role: 'admin' };

// A disabled verifier so the guard falls straight through to its `super.canActivate` (the passport
// 'jwt' strategy) branch — this suite is about that fallback, not the portal-token path.
const mockPortalTokenVerifier = {
  enabled: false,
  verifyAndProvision: jest.fn(),
};

/**
 * The session-JWT strategy the guard delegates to. `JwtOrPortalAuthGuard` extends `AuthGuard('jwt')`,
 * and passport-jwt's `Strategy` is registered under that name, so this is the same slot the
 * production `JwtStrategy` fills (that one is internal to the auth domain, so a sibling domain's test
 * does not reach for it). What is under test is the GUARD: which credentials it consults at all.
 */
class SessionJwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.auth.jwt.authTokenSecret,
    });
  }

  validate(payload: { sub: string }) {
    ContextService.set({ userId: payload.sub });

    return { id: payload.sub, role: session.role };
  }
}

@Module({
  controllers: [McpServerConfigController],
  imports: [PassportModule],
  providers: [
    { provide: McpServerConfigService, useValue: mockConfigService },
    { provide: PORTAL_TOKEN_VERIFIER, useValue: mockPortalTokenVerifier },
    SessionJwtStrategy,
  ],
})
class TestModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}

/**
 * ═══ THE MCP SERVER ROUTES ARE CLOSED TO API KEYS, ON PURPOSE ═══
 *
 * A stdio MCP server is arbitrary command execution on the appliance — a materially bigger
 * capability than an api key should ever reach (see the controller's own doc comment). So every
 * route takes a session JWT or a Portal bearer and nothing else.
 *
 * The native apps hold only a device API key, so on them these routes can only 401. The web
 * Settings → MCP Servers screen says so up front (`WebSignInRequired`) instead of firing requests
 * that cannot succeed and reporting "Failed to load MCP servers". That is a UI decision resting on
 * THIS fact: if one of these routes were ever opened to keys, the notice would be wrong — and if
 * someone "fixed" the phone screen by widening the guard, this suite is what says no.
 *
 * Proven with the REAL `JwtOrPortalAuthGuard`, not an always-true stub.
 */
describe('McpServerConfigController guards (real JwtOrPortalAuthGuard)', () => {
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
    session.role = 'admin';
    mockPortalTokenVerifier.enabled = false;
  });

  const routes: Array<{ method: 'get' | 'post'; path: string }> = [
    { method: 'get', path: '/mcp/servers' },
    { method: 'get', path: '/mcp/catalog' },
    { method: 'post', path: '/mcp/servers' },
    { method: 'post', path: '/mcp/servers/s-1/enable' },
  ];

  it.each(routes)('rejects $method $path with no credential at all (401)', async ({ method, path }) => {
    await request(app.getHttpServer())[method](path).expect(401);

    expect(mockConfigService.listForUser).not.toHaveBeenCalled();
    expect(mockConfigService.create).not.toHaveBeenCalled();
    expect(mockConfigService.setEnabled).not.toHaveBeenCalled();
  });

  it.each(routes)(
    'rejects $method $path presenting a bare api key (x-api-key header)',
    async ({ method, path }) => {
      await request(app.getHttpServer())[method](path).set('x-api-key', 'a'.repeat(64)).expect(401);

      expect(mockConfigService.listForUser).not.toHaveBeenCalled();
      expect(mockConfigService.create).not.toHaveBeenCalled();
    },
  );

  it.each(routes)(
    'rejects $method $path when an api key is sent as a Bearer token',
    async ({ method, path }) => {
      await request(app.getHttpServer())
        [method](path)
        .set('Authorization', `Bearer ${'a'.repeat(64)}`)
        .expect(401);
    },
  );

  it('lists the caller own servers for a valid session access token', async () => {
    mockConfigService.listForUser.mockResolvedValue([]);

    await request(app.getHttpServer())
      .get('/mcp/servers')
      .set('Authorization', `Bearer ${sessionAccessToken('user-1')}`)
      .expect(200);

    expect(mockConfigService.listForUser).toHaveBeenCalledWith('user-1');
  });

  it('serves the suggested catalogue to a valid session access token', async () => {
    await request(app.getHttpServer())
      .get('/mcp/catalog')
      .set('Authorization', `Bearer ${sessionAccessToken('user-1')}`)
      .expect(200);
  });

  it('still refuses a signed-in non-administrator the routes that change a config (403, not 401)', async () => {
    session.role = 'user';

    await request(app.getHttpServer())
      .post('/mcp/servers/s-1/enable')
      .set('Authorization', `Bearer ${sessionAccessToken('user-1')}`)
      .expect(403);

    expect(mockConfigService.setEnabled).not.toHaveBeenCalled();
  });
});

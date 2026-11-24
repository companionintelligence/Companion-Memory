import { type INestApplication, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ExtractJwt, Strategy } from 'passport-jwt';
import request from 'supertest';

import { ContextService, RequestContextMiddleware } from '@ci/common/context';
import { PORTAL_TOKEN_VERIFIER } from '@ci/common/guards/PortalTokenVerifier';
import config from '@ci/configuration';

import { ToolInvocationLedgerService } from '../../services/ToolInvocationLedgerService';
import { ToolInvocationsController } from '../ToolInvocationsController';

const mockLedger = {
  listForUser: jest.fn(),
  listSystem: jest.fn(),
};

/** What the session strategy below resolves a valid access token to. */
const session = { role: 'user' };

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
  controllers: [ToolInvocationsController],
  imports: [PassportModule],
  providers: [
    { provide: ToolInvocationLedgerService, useValue: mockLedger },
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
 * ═══ THE TOOL LEDGER IS CLOSED TO API KEYS, ON PURPOSE ═══
 *
 * The ledger's whole subject is which key called what, so letting a key page through its own
 * record is the one authority it should not have (see the controller's own doc comment). Both
 * routes take a session JWT or a Portal bearer and nothing else.
 *
 * The native apps hold only a device API key, so on them these routes can only 401. The web
 * Approvals → Activity screen says so up front (`WebSignInRequired`) and stops polling, instead of
 * asking every few seconds and reporting "Could not load the ledger: Unauthorized". That is a UI
 * decision resting on THIS fact: if the route were ever opened to keys, the notice would be wrong —
 * and if someone "fixed" the phone screen by widening the guard, this suite is what says no.
 *
 * Proven with the REAL `JwtOrPortalAuthGuard`, not an always-true stub.
 */
describe('ToolInvocationsController guards (real JwtOrPortalAuthGuard)', () => {
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
    session.role = 'user';
    mockLedger.listForUser.mockResolvedValue({ items: [], nextCursor: null });
    mockLedger.listSystem.mockResolvedValue({ items: [], nextCursor: null });
    mockPortalTokenVerifier.enabled = false;
  });

  const routes = ['/tools/invocations', '/tools/invocations/system'];

  it.each(routes)('rejects GET %s with no credential at all (401)', async (path) => {
    await request(app.getHttpServer()).get(path).expect(401);

    expect(mockLedger.listForUser).not.toHaveBeenCalled();
    expect(mockLedger.listSystem).not.toHaveBeenCalled();
  });

  it.each(routes)('rejects GET %s presenting a bare api key (x-api-key header)', async (path) => {
    await request(app.getHttpServer()).get(path).set('x-api-key', 'a'.repeat(64)).expect(401);

    expect(mockLedger.listForUser).not.toHaveBeenCalled();
    expect(mockLedger.listSystem).not.toHaveBeenCalled();
  });

  it.each(routes)('rejects GET %s when an api key is sent as a Bearer token', async (path) => {
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${'a'.repeat(64)}`)
      .expect(401);
  });

  it('reads the caller own invocations for a valid session access token', async () => {
    await request(app.getHttpServer())
      .get('/tools/invocations')
      .set('Authorization', `Bearer ${sessionAccessToken('user-1')}`)
      .expect(200);

    expect(mockLedger.listForUser).toHaveBeenCalledWith('user-1', expect.anything());
  });

  it('keeps the system view for an administrator, so a plain session is refused it (403, not 401)', async () => {
    await request(app.getHttpServer())
      .get('/tools/invocations/system')
      .set('Authorization', `Bearer ${sessionAccessToken('user-1')}`)
      .expect(403);

    expect(mockLedger.listSystem).not.toHaveBeenCalled();
  });
});

import config from '@ci/configuration';

// `undici`'s fetch is the ONLY thing OidcController.callback uses to talk to the
// OIDC provider (token exchange + userinfo). Nothing in the suite mocked it before
// this file (confirmed by grep), so every branch of callback() that runs AFTER
// PKCE/state validation — a failed token exchange, a failed userinfo call, a
// userinfo payload missing an email, an existing user signing in (web + native),
// and first-time web sign-in stashing the signup-intent cookie — was completely
// unexercised. OidcController.callbackNative.test.ts explicitly says the
// post-exchange branches are "covered separately"; this is that coverage.
const mockFetch = jest.fn();

jest.mock('undici', () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
  // fetchDispatcher is built at module load with `new Agent(...)` (issuerUrl is
  // localhost in the test env) — only needs to be constructable, never inspected.
  Agent: jest.fn().mockImplementation(() => ({})),
}));

// Import AFTER the mock so the controller module picks up the mocked `undici`.

import { signCompanionLink } from '../../utils/companionLink';
import { OidcController } from '../OidcController';

const SESSION_COOKIE_NAME = config.auth.cookies.sessionTokenName;

// `config` defaults `auth.oidc.issuerUrl` to '' (config/default.json) unless
// OIDC_ISSUER_URL is set — every callback() call would otherwise short-circuit
// at its own `if (!issuerUrl) return failRedirect('oidc_not_configured')` gate
// before ever reaching the fetch calls this file exists to exercise. `config`
// is a plain mutable object (configuration.ts's `export default parsed`), and
// jest gives this test file its own isolated module registry, so mutating it
// here cannot leak into any other suite.
config.auth.oidc.issuerUrl = 'http://localhost:8506';

function jsonResponse(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const TOKEN_OK = jsonResponse(true, 200, { access_token: 'portal-access-token', token_type: 'bearer' });

function makeController() {
  const userService = {
    findAccountByEmail: jest.fn(),
    // The accounts these cases link into carry a proven address unless a case says otherwise.
    isEmailProven: jest.fn().mockReturnValue(true),
    findById: jest.fn(),
    create: jest.fn(),
    // Default to an appliance that already has an account: these cases are
    // about the gates, not the one-account-wide exemption that lets someone
    // claim a box with an empty user table.
    hasNoUsers: jest.fn().mockResolvedValue(false),
    createFirstAccount: jest.fn().mockResolvedValue(null),
  };
  const authService = {
    sessionEstablishedAt: jest.fn().mockResolvedValue(new Date()),
    issueSessionToken: jest
      .fn()
      .mockResolvedValue({ sessionToken: 'new-session-token', sessionId: 'sess-1' }),
    getSessionMetadata: jest.fn().mockReturnValue({ ip: '127.0.0.1', userAgent: 'jest' }),
    issueSignupIntentToken: jest.fn().mockReturnValue('signup-intent-jwt'),
    resolveCsrfScope: jest.fn().mockReturnValue(null),
  };
  const csrfService = { generateToken: jest.fn().mockReturnValue('new-csrf-token') };
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(false) };
  const oidcNativeCodeService = { issue: jest.fn().mockReturnValue('one-time-code'), redeem: jest.fn() };
  const signupCodeService = {
    findOne: jest.fn().mockResolvedValue(null),
    consume: jest.fn().mockResolvedValue(true),
  };
  const federatedIdentityService = {
    findUserId: jest.fn().mockResolvedValue(null),
    listForUser: jest.fn().mockResolvedValue([]),
    bind: jest.fn().mockResolvedValue(undefined),
  };
  const hubBridge = { verifyUsername: jest.fn().mockReturnValue(null) };
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() };

  const controller = new OidcController(
    userService as never,
    authService as never,
    csrfService as never,
    featureService as never,
    oidcNativeCodeService as never,
    signupCodeService as never,
    federatedIdentityService as never,
    hubBridge as never,
    logger as never,
  );

  return {
    controller,
    userService,
    authService,
    csrfService,
    featureService,
    oidcNativeCodeService,
    signupCodeService,
    federatedIdentityService,
    hubBridge,
    logger,
  };
}

function makeRes() {
  return { clearCookie: jest.fn(), cookie: jest.fn(), redirect: jest.fn() };
}

const USERINFO = jsonResponse(true, 200, {
  sub: 'portal-sub-1',
  iss: 'http://localhost:8506',
  email: 'owner@example.com',
  email_verified: true,
});

/** A web callback from the browser signed in with `session`, carrying `link` as its connect cookie. */
function linkReq(link: string | undefined, session = 'session-a') {
  return {
    cookies: {
      oidc_state: 'match',
      oidc_pkce: 'verifier',
      [SESSION_COOKIE_NAME]: session,
      ...(link === undefined ? {} : { ci_companion_link: link }),
    },
    secure: false,
    headers: {},
  } as never;
}

const link = (userId = 'u-owner', session = 'session-a') =>
  signCompanionLink(config.auth.jwt.authTokenSecret, userId, session);

/**
 * The end of "Connect a Companion account": the signed-in person proved the account with their
 * password (`AccountController`), the Portal proves the identity, and the callback links the two
 * by (issuer, subject) without signing anyone in again.
 */
describe('OidcController — connecting a Companion account on the callback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValueOnce(TOKEN_OK).mockResolvedValueOnce(USERINFO);
  });

  function controllerFor(owner: { id: string; email: string; emailProvenAt: Date | null }) {
    const made = makeController();
    made.userService.findById.mockResolvedValue(owner);
    made.userService.isEmailProven.mockReturnValue(owner.emailProvenAt != null);
    (made.userService as Record<string, unknown>).markEmailProven = jest.fn();

    return made;
  }

  it('links the identity to the signed-in account as session_link, proves a matching address, and returns to Settings', async () => {
    const { controller, federatedIdentityService, userService, authService } = controllerFor({
      id: 'u-owner',
      email: 'owner@example.com',
      emailProvenAt: null,
    });
    const res = makeRes();

    await controller.callback('code-x', 'match', undefined, linkReq(link()), res as never);

    expect(federatedIdentityService.bind).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-owner', subject: 'portal-sub-1', bindMethod: 'session_link' }),
    );
    expect((userService as Record<string, jest.Mock>).markEmailProven).toHaveBeenCalledWith('u-owner');
    expect(res.redirect).toHaveBeenCalledWith('/self?companion=connected');
    // Already signed in: no new session, and not the sign-in path at all.
    expect(authService.issueSessionToken).not.toHaveBeenCalled();
    expect(userService.findAccountByEmail).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalledWith('ci_companion_link', { path: '/' });
  });

  it('links whatever address the Portal account has, and proves nothing when it differs', async () => {
    const { controller, federatedIdentityService, userService } = controllerFor({
      id: 'u-owner',
      email: 'typed-at-setup@example.com',
      emailProvenAt: null,
    });
    const res = makeRes();

    await controller.callback('code-x', 'match', undefined, linkReq(link()), res as never);

    expect(federatedIdentityService.bind).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-owner' }),
    );
    expect((userService as Record<string, jest.Mock>).markEmailProven).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/self?companion=connected');
  });

  it('refuses, linking nothing, when the Portal identity already belongs to another account', async () => {
    const { controller, federatedIdentityService } = controllerFor({
      id: 'u-owner',
      email: 'owner@example.com',
      emailProvenAt: null,
    });
    federatedIdentityService.findUserId.mockResolvedValue('someone-else');
    const res = makeRes();

    await controller.callback('code-x', 'match', undefined, linkReq(link()), res as never);

    expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/self?companion=linked_elsewhere');
  });

  it.each([
    ['from another browser session', link('u-owner', 'session-a'), 'session-b'],
    ['when the cookie is not one this Memory signed', 'forged.cookie', 'session-a'],
  ])('refuses %s, linking nothing', async (_label, cookie, session) => {
    const { controller, federatedIdentityService } = controllerFor({
      id: 'u-owner',
      email: 'owner@example.com',
      emailProvenAt: null,
    });
    const res = makeRes();

    await controller.callback('code-x', 'match', undefined, linkReq(cookie, session), res as never);

    expect(federatedIdentityService.bind).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/self?companion=expired');
  });

  it('refuses once that session has been signed out', async () => {
    const made = controllerFor({ id: 'u-owner', email: 'owner@example.com', emailProvenAt: null });
    made.authService.sessionEstablishedAt.mockResolvedValue(null);
    const res = makeRes();

    await made.controller.callback('code-x', 'match', undefined, linkReq(link()), res as never);

    expect(made.federatedIdentityService.bind).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/self?companion=expired');
  });
});

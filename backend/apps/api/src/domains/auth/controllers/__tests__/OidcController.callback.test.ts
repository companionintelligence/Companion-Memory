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

import { OidcController } from '../OidcController';

const SESSION_COOKIE_NAME = config.auth.cookies.sessionTokenName;
const CSRF_COOKIE_NAME = config.auth.cookies.csrfTokenName;
const NATIVE_SCHEME = config.auth.oidc.nativeRedirectScheme;

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

/** The transaction `UserService.create` runs its `alongside` work in. */
const accountTransaction = { name: 'the transaction creating the account' };

/**
 * `UserService.create` creating `user`, honouring its contract: `alongside` runs inside the
 * transaction that inserts the account, and if it throws, the account is rolled back and the error
 * reaches the caller as thrown.
 */
const createsAccount =
  (user: { id: string }) =>
  async (
    _context: unknown,
    _data: unknown,
    alongside?: (manager: unknown, created: unknown) => Promise<unknown>,
  ) => {
    await alongside?.(accountTransaction, user);

    return user;
  };

function makeController() {
  const userService = {
    findByEmail: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    // Default to an appliance that already has an account: these cases are
    // about the gates, not the one-account-wide exemption that lets someone
    // claim a box with an empty user table.
    hasNoUsers: jest.fn().mockResolvedValue(false),
    createFirstAccount: jest.fn().mockResolvedValue(null),
  };
  const authService = {
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

/** Stands in for the transaction `UserService.createFirstAccount` runs its `alongside` work in. */
const CLAIM_TRANSACTION = { transaction: 'first-account' };

/**
 * The appliance is empty and this sign-in claims it: `createFirstAccount` creates the account, runs
 * the controller's `alongside` work (the binding) in its transaction, and returns the account.
 */
function claimsTheAppliance(userService: { createFirstAccount: jest.Mock }, user: { id: string }) {
  userService.createFirstAccount.mockImplementation(
    async (
      _context: unknown,
      _data: unknown,
      alongside?: (manager: unknown, created: unknown) => Promise<unknown>,
    ) => {
      await alongside?.(CLAIM_TRANSACTION, { ...user, role: 'admin' });

      return user;
    },
  );
}

function makeRes() {
  return {
    clearCookie: jest.fn(),
    cookie: jest.fn(),
    redirect: jest.fn(),
  };
}

function webReq(cookies: Record<string, string> = {}) {
  return {
    cookies: { oidc_state: 'match', oidc_pkce: 'verifier', ...cookies },
    secure: false,
    headers: {},
  } as never;
}

function nativeReq(cookies: Record<string, string> = {}) {
  return webReq({ oidc_client: 'native', ...cookies });
}

describe('OidcController — OIDC callback (post-token-exchange path)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('redirects to /login?error=token_exchange_failed when the token endpoint 4xxs, without ever calling userinfo', async () => {
    const { controller, logger } = makeController();
    const res = makeRes();
    mockFetch.mockResolvedValueOnce(jsonResponse(false, 400, { error: 'invalid_grant' }));

    await controller.callback('code-x', 'match', undefined, webReq(), res as never);

    expect(res.redirect).toHaveBeenCalledWith('/login?error=token_exchange_failed');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('redirects to /login?error=userinfo_failed when userinfo 4xxs after a successful token exchange', async () => {
    const { controller, userService } = makeController();
    const res = makeRes();
    mockFetch
      .mockResolvedValueOnce(TOKEN_OK)
      .mockResolvedValueOnce(jsonResponse(false, 401, { error: 'invalid_token' }));

    await controller.callback('code-x', 'match', undefined, webReq(), res as never);

    expect(res.redirect).toHaveBeenCalledWith('/login?error=userinfo_failed');
    expect(userService.findByEmail).not.toHaveBeenCalled();
  });

  it('redirects to /login?error=no_email when userinfo has no email, without looking up any user', async () => {
    const { controller, userService } = makeController();
    const res = makeRes();
    mockFetch
      .mockResolvedValueOnce(TOKEN_OK)
      .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-1', name: 'No Email' }));

    await controller.callback('code-x', 'match', undefined, webReq(), res as never);

    expect(res.redirect).toHaveBeenCalledWith('/login?error=no_email');
    expect(userService.findByEmail).not.toHaveBeenCalled();
  });

  describe('existing user (web)', () => {
    it('signs the user in: issues session+CSRF cookies and returns to the stored redirect', async () => {
      const { controller, userService, authService, csrfService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(
          jsonResponse(true, 200, { sub: 'portal-sub-1', email: 'user@example.com', email_verified: true }),
        );
      userService.findByEmail.mockResolvedValue({ id: 'user-1' });

      await controller.callback(
        'code-x',
        'match',
        undefined,
        webReq({ oidc_redirect: '/shared/abc123' }),
        res as never,
      );

      expect(userService.findByEmail).toHaveBeenCalledWith('user@example.com');
      expect(authService.issueSessionToken).toHaveBeenCalledWith('user-1', expect.any(Object));
      expect(res.cookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, 'new-session-token', expect.any(Object));
      // Identity boundary: a fresh CSRF token bound to the NEW session, not the pre-auth one.
      expect(csrfService.generateToken).toHaveBeenCalledWith('sess-1');
      expect(res.cookie).toHaveBeenCalledWith(CSRF_COOKIE_NAME, 'new-csrf-token', expect.any(Object));
      // Redirect-destination re-validation: the stored deep link is honoured.
      expect(res.redirect).toHaveBeenCalledWith('/shared/abc123');
    });

    it('falls back to "/" when no redirect was stored', async () => {
      const { controller, userService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(
          jsonResponse(true, 200, { sub: 'portal-sub-1', email: 'user@example.com', email_verified: true }),
        );
      userService.findByEmail.mockResolvedValue({ id: 'user-1' });

      await controller.callback('code-x', 'match', undefined, webReq(), res as never);

      expect(res.redirect).toHaveBeenCalledWith('/');
    });

    it('never trusts an unsafe stored redirect (open-redirect guard still applies here)', async () => {
      const { controller, userService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(
          jsonResponse(true, 200, { sub: 'portal-sub-1', email: 'user@example.com', email_verified: true }),
        );
      userService.findByEmail.mockResolvedValue({ id: 'user-1' });

      await controller.callback(
        'code-x',
        'match',
        undefined,
        webReq({ oidc_redirect: 'https://evil.example.com' }),
        res as never,
      );

      expect(res.redirect).toHaveBeenCalledWith('/');
    });
  });

  describe('existing user (native)', () => {
    it('issues a single-use deep-link code instead of a browser session cookie', async () => {
      const { controller, userService, authService, oidcNativeCodeService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(
          jsonResponse(true, 200, { sub: 'portal-sub-1', email: 'user@example.com', email_verified: true }),
        );
      userService.findByEmail.mockResolvedValue({ id: 'user-1' });

      await controller.callback('code-x', 'match', undefined, nativeReq(), res as never);

      expect(oidcNativeCodeService.issue).toHaveBeenCalledWith('user-1');
      expect(res.redirect).toHaveBeenCalledWith(`${NATIVE_SCHEME}://oidc/callback?code=one-time-code`);
      // No browser session was minted — the cross-origin native webview cannot
      // read it anyway, and the deep-link code is the credential handoff.
      expect(authService.issueSessionToken).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalledWith(SESSION_COOKIE_NAME, expect.anything(), expect.anything());
    });
  });

  describe('first-time sign-in (no existing account)', () => {
    it('web: stashes the signup-intent cookie and sends the user to confirm-account, without creating an account', async () => {
      const { controller, userService, authService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(
          jsonResponse(true, 200, { sub: 'portal-sub-1', email: 'new@example.com', name: 'New Person' }),
        );
      userService.findByEmail.mockResolvedValue(null);

      await controller.callback('code-x', 'match', undefined, webReq(), res as never);

      expect(userService.create).not.toHaveBeenCalled();
      // The intent carries the (issuer, subject) so confirm-account can bind the
      // account it creates to this identity — and recognise a concurrent tab.
      // Signup codes are off, so nothing was waived for being first.
      expect(authService.issueSignupIntentToken).toHaveBeenCalledWith(
        'new@example.com',
        'New Person',
        { issuer: expect.any(String), subject: 'portal-sub-1' },
        { firstAccountOnly: false },
      );
      expect(res.cookie).toHaveBeenCalledWith('oidc_signup_intent', 'signup-intent-jwt', expect.any(Object));
      expect(res.redirect).toHaveBeenCalledWith('/api/authenticate/oidc/confirm-account');
    });

    it('native: cannot run the web confirmation, so it deep-links signup_required instead', async () => {
      const { controller, userService, authService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-1', email: 'new@example.com' }));
      userService.findByEmail.mockResolvedValue(null);

      await controller.callback('code-x', 'match', undefined, nativeReq(), res as never);

      expect(res.redirect).toHaveBeenCalledWith(`${NATIVE_SCHEME}://oidc/callback?error=signup_required`);
      expect(authService.issueSignupIntentToken).not.toHaveBeenCalled();
    });

    // The desktop app signs in as a native client, so signup_required was the
    // last door out of a freshly installed appliance: no account, no way to mint
    // a signup code, and no web confirmation reachable from the deep-link flow.
    it('native: claims an unclaimed appliance instead of dead-ending on signup_required', async () => {
      const { controller, userService, federatedIdentityService, oidcNativeCodeService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(
          jsonResponse(true, 200, { sub: 'portal-sub-1', email: 'owner@example.com', name: 'Owner' }),
        );
      userService.findByEmail.mockResolvedValue(null);
      userService.hasNoUsers.mockResolvedValue(true);
      claimsTheAppliance(userService, { id: 'user-first' });
      oidcNativeCodeService.issue.mockReturnValue('one-time-code');

      await controller.callback('code-x', 'match', undefined, nativeReq(), res as never);

      // Created only as the first account — never through the create() that admits anyone — and
      // bound in the same transaction.
      expect(userService.createFirstAccount).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'owner@example.com', name: 'Owner' }),
        expect.any(Function),
      );
      expect(userService.create).not.toHaveBeenCalled();
      expect(federatedIdentityService.bind).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-first', subject: 'portal-sub-1', bindMethod: 'sub' }),
        CLAIM_TRANSACTION,
      );
      expect(res.redirect).toHaveBeenCalledWith(`${NATIVE_SCHEME}://oidc/callback?code=one-time-code`);
    });

    // Two first sign-ins on an empty appliance used to both get accounts: each
    // read `hasNoUsers()` as true and then created one. That answer is now only
    // a way of sorting the request; the account is created only if it is still
    // the first, and a sign-in that loses is answered as a later arrival would be.
    it.each([
      [false, 'signup_required'],
      [true, 'signup_code_required'],
    ])(
      'native: a sign-in that loses the race for an empty appliance is refused like any uninvited one (codes required: %s)',
      async (codesRequired, refusal) => {
        const { controller, userService, featureService, oidcNativeCodeService } = makeController();
        const res = makeRes();
        mockFetch
          .mockResolvedValueOnce(TOKEN_OK)
          .mockResolvedValueOnce(
            jsonResponse(true, 200, { sub: 'portal-sub-2', email: 'second@example.com' }),
          );
        userService.findByEmail.mockResolvedValue(null);
        userService.hasNoUsers.mockResolvedValue(true);
        featureService.isFeatureEnabled.mockResolvedValue(codesRequired);
        userService.createFirstAccount.mockResolvedValue(null);

        await controller.callback('code-x', 'match', undefined, nativeReq(), res as never);

        expect(res.redirect).toHaveBeenCalledWith(`${NATIVE_SCHEME}://oidc/callback?error=${refusal}`);
        expect(userService.create).not.toHaveBeenCalled();
        expect(oidcNativeCodeService.issue).not.toHaveBeenCalled();
      },
    );

    it('native: a race lost to the SAME identity signs it in to the account it claimed', async () => {
      const { controller, userService, federatedIdentityService, oidcNativeCodeService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-1', email: 'owner@example.com' }));
      userService.findByEmail.mockResolvedValue(null);
      userService.hasNoUsers.mockResolvedValue(true);
      userService.createFirstAccount.mockResolvedValue(null);
      federatedIdentityService.findUserId
        .mockResolvedValueOnce(null) // before the race
        .mockResolvedValueOnce('user-first'); // committed, with its account, by the winner
      userService.findById.mockResolvedValue({ id: 'user-first' });
      oidcNativeCodeService.issue.mockReturnValue('one-time-code');

      await controller.callback('code-x', 'match', undefined, nativeReq(), res as never);

      expect(oidcNativeCodeService.issue).toHaveBeenCalledWith('user-first');
      expect(res.redirect).toHaveBeenCalledWith(`${NATIVE_SCHEME}://oidc/callback?code=one-time-code`);
    });

    it('native: still refuses an unknown user once the appliance has an account', async () => {
      const { controller, userService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-1', email: 'new@example.com' }));
      userService.findByEmail.mockResolvedValue(null);
      userService.hasNoUsers.mockResolvedValue(false);

      await controller.callback('code-x', 'match', undefined, nativeReq(), res as never);

      expect(userService.create).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith(`${NATIVE_SCHEME}://oidc/callback?error=signup_required`);
    });

    // The desktop is a native client, and an invited person is the ONLY kind
    // of second person it can admit. This path burned the invitation and then
    // deep-linked signup_required — the web-only confirmation — so every
    // attempt cost the owner a code and let nobody in.
    it('native: an invitation is the consent, so the account is created and the code comes back — not signup_required', async () => {
      const { controller, userService, signupCodeService, featureService, oidcNativeCodeService } =
        makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(
          jsonResponse(true, 200, { sub: 'portal-sub-9', email: 'guest@example.com', name: 'Guest' }),
        );
      userService.findByEmail.mockResolvedValue(null);
      userService.hasNoUsers.mockResolvedValue(false);
      featureService.isFeatureEnabled.mockResolvedValue(true);
      signupCodeService.findOne.mockResolvedValue({ signup_code: 'invite-1' });
      userService.create.mockImplementation(createsAccount({ id: 'user-guest' }));
      oidcNativeCodeService.issue.mockReturnValue('one-time-code');

      await controller.callback(
        'code-x',
        'match',
        undefined,
        nativeReq({ oidc_signup_code: 'invite-1' }),
        res as never,
      );

      expect(userService.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'guest@example.com', name: 'Guest' }),
        expect.any(Function),
      );
      // The invitation admits them whether or not they are first.
      expect(userService.createFirstAccount).not.toHaveBeenCalled();
      // Redeemed in the transaction creating the account, so a sign-in whose account cannot be
      // created leaves the invitation unspent.
      expect(signupCodeService.consume).toHaveBeenCalledWith('invite-1', accountTransaction);
      expect(res.redirect).toHaveBeenCalledWith(`${NATIVE_SCHEME}://oidc/callback?code=one-time-code`);
      expect(res.redirect).not.toHaveBeenCalledWith(`${NATIVE_SCHEME}://oidc/callback?error=signup_required`);
    });

    it('lets an invited identity in when the code the owner issued rides along, and redeems it before the confirmation', async () => {
      const { controller, userService, signupCodeService, featureService, authService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-9', email: 'guest@example.com' }));
      userService.findByEmail.mockResolvedValue(null);
      userService.hasNoUsers.mockResolvedValue(false);
      featureService.isFeatureEnabled.mockResolvedValue(true);
      signupCodeService.findOne.mockResolvedValue({ signup_code: 'invite-1' });

      await controller.callback(
        'code-x',
        'match',
        undefined,
        webReq({ oidc_signup_code: 'invite-1' }),
        res as never,
      );

      // Not refused, and the invitation cannot be replayed by whoever arrives next: it is redeemed
      // here, before the confirmation page, not by the step that creates the account.
      expect(res.redirect).toHaveBeenCalledWith('/api/authenticate/oidc/confirm-account');
      expect(signupCodeService.consume).toHaveBeenCalledWith('invite-1');
      expect(userService.create).not.toHaveBeenCalled();
      // Admitted by the invitation, so confirm-account need not be the first account.
      expect(authService.issueSignupIntentToken).toHaveBeenCalledWith(
        'guest@example.com',
        undefined,
        expect.any(Object),
        { firstAccountOnly: false },
      );
    });

    // The look-up only refuses early: every sign-in presenting one code finds it unused until one of
    // them redeems it. The rest are refused as a used code is — before anyone is admitted on it.
    it('web: refuses, before the confirmation, an invitation another sign-in redeemed first', async () => {
      const { controller, userService, signupCodeService, featureService, authService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-9', email: 'guest@example.com' }));
      userService.findByEmail.mockResolvedValue(null);
      featureService.isFeatureEnabled.mockResolvedValue(true);
      signupCodeService.findOne.mockResolvedValue({ signup_code: 'invite-1' });
      signupCodeService.consume.mockResolvedValue(false);

      await controller.callback(
        'code-x',
        'match',
        undefined,
        webReq({ oidc_signup_code: 'invite-1' }),
        res as never,
      );

      expect(res.redirect).toHaveBeenCalledWith('/login?error=signup_code_required');
      expect(authService.issueSignupIntentToken).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalledWith('oidc_signup_intent', expect.anything(), expect.anything());
    });

    it.each([
      ['on', 'signup_code_required'],
      ['off', 'signup_required'],
    ])(
      'native, codes %s: refuses an invitation another sign-in redeemed first, rolling its account back (%s)',
      async (codes, refusal) => {
        const {
          controller,
          userService,
          signupCodeService,
          featureService,
          oidcNativeCodeService,
          federatedIdentityService,
        } = makeController();
        const res = makeRes();
        mockFetch
          .mockResolvedValueOnce(TOKEN_OK)
          .mockResolvedValueOnce(
            jsonResponse(true, 200, { sub: 'portal-sub-9', email: 'guest@example.com' }),
          );
        userService.findByEmail.mockResolvedValue(null);
        featureService.isFeatureEnabled.mockResolvedValue(codes === 'on');
        signupCodeService.findOne.mockResolvedValue({ signup_code: 'invite-1' });
        signupCodeService.consume.mockResolvedValue(false);
        userService.create.mockImplementation(createsAccount({ id: 'user-guest' }));

        await controller.callback(
          'code-x',
          'match',
          undefined,
          nativeReq({ oidc_signup_code: 'invite-1' }),
          res as never,
        );

        // Refused as it would be with a code that was already used when it was checked.
        expect(res.redirect).toHaveBeenCalledWith(`${NATIVE_SCHEME}://oidc/callback?error=${refusal}`);
        // The losing redemption threw inside the account's transaction, rolling the account back.
        await expect(userService.create.mock.results[0].value).rejects.toThrow('redeemed by another sign-in');
        expect(federatedIdentityService.bind).not.toHaveBeenCalled();
        expect(oidcNativeCodeService.issue).not.toHaveBeenCalled();
      },
    );

    it('web, codes off: spends no code, since nothing rests on it', async () => {
      const { controller, userService, signupCodeService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-9', email: 'guest@example.com' }));
      userService.findByEmail.mockResolvedValue(null);
      signupCodeService.findOne.mockResolvedValue({ signup_code: 'invite-1' });

      await controller.callback(
        'code-x',
        'match',
        undefined,
        webReq({ oidc_signup_code: 'invite-1' }),
        res as never,
      );

      expect(res.redirect).toHaveBeenCalledWith('/api/authenticate/oidc/confirm-account');
      expect(signupCodeService.consume).not.toHaveBeenCalled();
    });

    // The web flow creates the account a page later, from confirm-account. When
    // the only thing that let this person past the code gate was an empty
    // appliance, the intent says so, and confirm-account re-decides it as it
    // creates — the callback's answer is up to the intent's lifetime old.
    it('web: an intent that skipped the code gate only for being first says so', async () => {
      const { controller, userService, featureService, authService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-1', email: 'owner@example.com' }));
      userService.findByEmail.mockResolvedValue(null);
      userService.hasNoUsers.mockResolvedValue(true);
      featureService.isFeatureEnabled.mockResolvedValue(true);

      await controller.callback('code-x', 'match', undefined, webReq(), res as never);

      expect(userService.create).not.toHaveBeenCalled();
      expect(userService.createFirstAccount).not.toHaveBeenCalled();
      expect(authService.issueSignupIntentToken).toHaveBeenCalledWith(
        'owner@example.com',
        undefined,
        { issuer: expect.any(String), subject: 'portal-sub-1' },
        { firstAccountOnly: true },
      );
      expect(res.redirect).toHaveBeenCalledWith('/api/authenticate/oidc/confirm-account');
    });

    it('refuses a code that is not a real invitation, and burns nothing', async () => {
      const { controller, userService, signupCodeService, featureService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-9', email: 'guest@example.com' }));
      userService.findByEmail.mockResolvedValue(null);
      userService.hasNoUsers.mockResolvedValue(false);
      featureService.isFeatureEnabled.mockResolvedValue(true);
      signupCodeService.findOne.mockResolvedValue(null);

      await controller.callback(
        'code-x',
        'match',
        undefined,
        webReq({ oidc_signup_code: 'made-up' }),
        res as never,
      );

      expect(res.redirect).toHaveBeenCalledWith('/login?error=signup_code_required');
      expect(signupCodeService.consume).not.toHaveBeenCalled();
      expect(userService.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown user outright when signup codes are required, before minting any intent cookie', async () => {
      const { controller, userService, authService, featureService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-1', email: 'new@example.com' }));
      userService.findByEmail.mockResolvedValue(null);
      featureService.isFeatureEnabled.mockResolvedValue(true);

      await controller.callback('code-x', 'match', undefined, webReq(), res as never);

      expect(res.redirect).toHaveBeenCalledWith('/login?error=signup_code_required');
      expect(authService.issueSignupIntentToken).not.toHaveBeenCalled();
    });
  });

  it('routes an unexpected exception (e.g. network failure) through failRedirect(oidc_failed), not a raw 500', async () => {
    const { controller, logger } = makeController();
    const res = makeRes();
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await controller.callback('code-x', 'match', undefined, webReq(), res as never);

    expect(res.redirect).toHaveBeenCalledWith('/login?error=oidc_failed');
    expect(logger.error).toHaveBeenCalled();
  });

  describe('federated identity and Hub invitation', () => {
    it('signs in the user bound to (iss, sub) even when emails differ', async () => {
      const { controller, userService, federatedIdentityService, authService } = makeController();
      const res = makeRes();
      mockFetch.mockResolvedValueOnce(TOKEN_OK).mockResolvedValueOnce(
        jsonResponse(true, 200, {
          sub: 'portal-sub-hello',
          iss: 'https://hub.ci.computer',
          email: 'hello@lifescope.io',
        }),
      );
      federatedIdentityService.findUserId.mockResolvedValue('user-hello');
      userService.findById.mockResolvedValue({ id: 'user-hello', email: 'hello@lifescope.io' });

      await controller.callback('code-x', 'match', undefined, webReq(), res as never);

      expect(federatedIdentityService.findUserId).toHaveBeenCalledWith(
        'https://hub.ci.computer',
        'portal-sub-hello',
      );
      expect(userService.findByEmail).not.toHaveBeenCalled();
      expect(authService.issueSessionToken).toHaveBeenCalledWith('user-hello', expect.any(Object));
    });

    it('does not sign in an existing email that is already bound to another subject', async () => {
      const { controller, userService, federatedIdentityService, authService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-2', email: 'shared@example.com' }));
      userService.findByEmail.mockResolvedValue({ id: 'user-1' });
      federatedIdentityService.listForUser.mockResolvedValue([{ id: 'fed-other' }]);

      await controller.callback('code-x', 'match', undefined, webReq(), res as never);

      expect(authService.issueSessionToken).not.toHaveBeenCalled();
      // Terminal: it must NOT continue into the first-time flow, whose confirm
      // step used to find the same address and sign the caller in as it.
      expect(authService.issueSignupIntentToken).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('/login?error=account_linked_elsewhere');
    });

    it('does not sign in an existing account when the Portal has not verified the address', async () => {
      const { controller, userService, authService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-9', email: 'user@example.com' }));
      userService.findByEmail.mockResolvedValue({ id: 'user-1' });

      await controller.callback('code-x', 'match', undefined, webReq(), res as never);

      expect(authService.issueSessionToken).not.toHaveBeenCalled();
      expect(authService.issueSignupIntentToken).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledWith('/login?error=email_unverified');
    });

    it('Hub-invited first login creates a Memory user without a signup code or confirm page', async () => {
      const { controller, userService, hubBridge, featureService, authService, signupCodeService } =
        makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(
          jsonResponse(true, 200, { sub: 'portal-sub-hello', email: 'hello@lifescope.io', name: 'Hello' }),
        );
      userService.findByEmail.mockResolvedValue(null);
      featureService.isFeatureEnabled.mockResolvedValue(true);
      hubBridge.verifyUsername.mockReturnValue('hello@lifescope.io');
      userService.create.mockResolvedValue({ id: 'user-hello', email: 'hello@lifescope.io' });

      await controller.callback('code-x', 'match', undefined, webReq(), res as never);

      expect(userService.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'hello@lifescope.io' }),
        // No invitation to redeem alongside it: the Hub is what admits this person.
        undefined,
      );
      expect(authService.issueSessionToken).toHaveBeenCalledWith('user-hello', expect.any(Object));
      expect(res.redirect).not.toHaveBeenCalledWith('/login?error=signup_code_required');
      // It presented no code, so there is none to spend. This used to "burn" `undefined`, which
      // TypeORM drops from a `where` — spending whichever outstanding invitation came back first.
      expect(signupCodeService.consume).not.toHaveBeenCalled();
    });

    it('Hub-invited first login leaves a code it presents unspent: the Hub is what admits it', async () => {
      const { controller, userService, hubBridge, featureService, signupCodeService } = makeController();
      const res = makeRes();
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(
          jsonResponse(true, 200, { sub: 'portal-sub-hello', email: 'hello@lifescope.io', name: 'Hello' }),
        );
      userService.findByEmail.mockResolvedValue(null);
      featureService.isFeatureEnabled.mockResolvedValue(true);
      hubBridge.verifyUsername.mockReturnValue('hello@lifescope.io');
      signupCodeService.findOne.mockResolvedValue({ signup_code: 'invite-1' });
      userService.create.mockImplementation(createsAccount({ id: 'user-hello' }));

      await controller.callback(
        'code-x',
        'match',
        undefined,
        webReq({ oidc_signup_code: 'invite-1' }),
        res as never,
      );

      expect(userService.create).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined);
      expect(signupCodeService.consume).not.toHaveBeenCalled();
    });
  });

  // `users.password_set_at` decides what `AccountController.requireReauth` asks
  // for: where it is set, an email or password change must present the current
  // password. Every account this callback creates holds a random password nobody
  // has seen, so it must be created as not chosen — stamped as chosen, the
  // account is asked for a password it cannot know and can never change either.
  // One row per door that creates an account, the provisioning path #2743 missed.
  // Claiming an empty appliance goes through createFirstAccount; an invitation
  // goes through create. Both build the account with oidcAccount.
  describe('an account the callback creates has no password of its own', () => {
    const userinfo = () =>
      mockFetch
        .mockResolvedValueOnce(TOKEN_OK)
        .mockResolvedValueOnce(jsonResponse(true, 200, { sub: 'portal-sub-1', email: 'new@example.com' }));

    it('native, claiming an empty appliance', async () => {
      const mocks = makeController();
      userinfo();
      mocks.userService.findByEmail.mockResolvedValue(null);
      mocks.userService.hasNoUsers.mockResolvedValue(true);
      claimsTheAppliance(mocks.userService, { id: 'user-new' });

      await mocks.controller.callback('code-x', 'match', undefined, nativeReq(), makeRes() as never);

      expect(mocks.userService.create).not.toHaveBeenCalled();
      expect(mocks.userService.createFirstAccount).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'new@example.com', passwordChosenByUser: false }),
        expect.any(Function),
      );
    });

    // The third argument is what is redeemed alongside the account: the invitation, where one admits
    // this person; nothing, where the Hub does.
    it.each<
      [
        door: string,
        req: unknown,
        admit: (mocks: ReturnType<typeof makeController>) => void,
        alongside: unknown,
      ]
    >([
      [
        'native, invited with a signup code',
        nativeReq({ oidc_signup_code: 'invite-1' }),
        ({ signupCodeService }) => signupCodeService.findOne.mockResolvedValue({ signup_code: 'invite-1' }),
        expect.any(Function),
      ],
      [
        'web, invited by the Hub',
        webReq(),
        ({ hubBridge }) => hubBridge.verifyUsername.mockReturnValue('new@example.com'),
        undefined,
      ],
    ])('%s', async (_door, req, admit, alongside) => {
      const mocks = makeController();
      userinfo();
      mocks.userService.findByEmail.mockResolvedValue(null);
      mocks.userService.create.mockResolvedValue({ id: 'user-new', email: 'new@example.com' });
      admit(mocks);

      await mocks.controller.callback('code-x', 'match', undefined, req as never, makeRes() as never);

      expect(mocks.userService.create).toHaveBeenCalledTimes(1);
      expect(mocks.userService.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ email: 'new@example.com', passwordChosenByUser: false }),
        alongside,
      );
    });
  });
});

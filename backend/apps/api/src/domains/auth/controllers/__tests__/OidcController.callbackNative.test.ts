import { OidcController } from '../OidcController';

/**
 * `GET /authenticate/oidc/callback` is the IdP return leg. When the native app launched
 * the flow (the `oidc_client=native` cookie set on `initiate`), EVERY exit — including
 * every failure — must return via the custom-scheme deep link (`companion://oidc/callback
 * ?error=...`) rather than a browser redirect to `/login`, so the system browser can hand
 * control back to the app instead of stranding the user on a web page it can't see.
 *
 * These tests pin the native-vs-web routing on the failure branches that resolve BEFORE
 * the IdP token exchange (so they need no OIDC provider / `undici` mock): provider error,
 * missing params, bad state, and missing PKCE. They also pin that the client-marker
 * cookie is always cleared. The post-exchange success branches (existing user → one-time
 * code deep link; unknown user → `signup_required`) require mocking the Portal token +
 * userinfo round-trip and are covered separately.
 */
function makeController() {
  const oidcNativeCodeService = { issue: jest.fn(), redeem: jest.fn() };
  const signupCodeService = { findOne: jest.fn().mockResolvedValue(null), consume: jest.fn() };
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() };

  const controller = new OidcController(
    {} as never, // userService — not reached on the pre-exchange failure branches
    {} as never, // authService
    {} as never, // csrfService
    {} as never, // featureService
    oidcNativeCodeService as never,
    signupCodeService as never,
    { findUserId: jest.fn(), listForUser: jest.fn(), bind: jest.fn() } as never,
    { verifyUsername: jest.fn().mockReturnValue(null) } as never,
    logger as never,
  );

  return { controller, oidcNativeCodeService, logger };
}

function makeRes() {
  // Plain spies (no `return res` chaining) — the callback never chains these, and a
  // self-referential initializer would give `res` an inferred circular `any` type (TS7022).
  return {
    clearCookie: jest.fn(),
    cookie: jest.fn(),
    redirect: jest.fn(),
  };
}

/** The app's half of the sign-in, parked by initiate: an S256 challenge and its own state. */
const APP_CHALLENGE = 'c'.repeat(43);
const APP_STATE = 's'.repeat(32);

// A request carrying the native client marker and the app's binding, plus whatever
// state/pkce cookies the case needs.
function nativeReq(cookies: Record<string, string> = {}) {
  return {
    cookies: {
      oidc_client: 'native',
      oidc_native_challenge: APP_CHALLENGE,
      oidc_native_state: APP_STATE,
      ...cookies,
    },
    secure: false,
    headers: {},
  } as never;
}

describe('OidcController — OIDC callback (native deep-link routing)', () => {
  it('routes a provider error back to the app via the deep link, not /login', async () => {
    const { controller } = makeController();
    const res = makeRes();

    await controller.callback('code-x', 'state-x', 'access_denied', nativeReq(), res as never);

    expect(res.redirect).toHaveBeenCalledWith(
      `companion://oidc/callback?error=access_denied&state=${APP_STATE}`,
    );
    // The client marker is always cleared on the return leg.
    expect(res.clearCookie).toHaveBeenCalledWith('oidc_client', expect.any(Object));
  });

  it('routes the SAME provider error to /login when the web (non-native) flow launched it', async () => {
    const { controller } = makeController();
    const res = makeRes();
    const webReq = { cookies: {}, secure: false, headers: {} } as never; // no oidc_client cookie

    await controller.callback('code-x', 'state-x', 'access_denied', webReq, res as never);

    expect(res.redirect).toHaveBeenCalledWith('/login?error=access_denied');
  });

  it('deep-links missing_params when the code is absent', async () => {
    const { controller } = makeController();
    const res = makeRes();

    await controller.callback('', 'state-x', undefined, nativeReq(), res as never);

    expect(res.redirect).toHaveBeenCalledWith(
      `companion://oidc/callback?error=missing_params&state=${APP_STATE}`,
    );
  });

  it('deep-links invalid_state when the returned state does not match the cookie', async () => {
    const { controller } = makeController();
    const res = makeRes();

    await controller.callback(
      'code-x',
      'returned-state',
      undefined,
      nativeReq({ oidc_state: 'stored-state' }),
      res as never,
    );

    expect(res.redirect).toHaveBeenCalledWith(
      `companion://oidc/callback?error=invalid_state&state=${APP_STATE}`,
    );
  });

  it('deep-links missing_pkce when state matches but the PKCE verifier cookie is gone', async () => {
    const { controller } = makeController();
    const res = makeRes();

    // State matches (so it clears the state cookie and advances) but no oidc_pkce cookie.
    await controller.callback('code-x', 'match', undefined, nativeReq({ oidc_state: 'match' }), res as never);

    expect(res.redirect).toHaveBeenCalledWith(
      `companion://oidc/callback?error=missing_pkce&state=${APP_STATE}`,
    );
  });

  it("returns the app's state on every exit, so the app can tell its own result from a stray link", async () => {
    const { controller } = makeController();
    const res = makeRes();

    await controller.callback('code-x', 'state-x', 'access_denied', nativeReq(), res as never);

    const [target] = res.redirect.mock.calls[0] as [string];

    expect(new URL(target).searchParams.get('state')).toBe(APP_STATE);
  });

  it('refuses a native return whose binding cookies are gone, and clears them', async () => {
    // Without the challenge there is nothing to bind a one-time code to, so no code is
    // issued, and without the state the app could not recognise the result anyway.
    const { controller, oidcNativeCodeService } = makeController();
    const res = makeRes();
    const req = {
      cookies: { oidc_client: 'native', oidc_state: 'good', oidc_pkce: 'verifier' },
      secure: false,
      headers: {},
    } as never;

    await controller.callback('code-x', 'good', undefined, req, res as never);

    expect(res.redirect).toHaveBeenCalledWith('companion://oidc/callback?error=missing_pkce');
    expect(oidcNativeCodeService.issue).not.toHaveBeenCalled();
    expect(res.clearCookie).toHaveBeenCalledWith('oidc_native_challenge', { path: '/' });
    expect(res.clearCookie).toHaveBeenCalledWith('oidc_native_state', { path: '/' });
  });
});

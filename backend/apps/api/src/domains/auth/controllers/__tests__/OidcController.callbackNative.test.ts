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
  const signupCodeService = { findOne: jest.fn().mockResolvedValue(null), update: jest.fn() };
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() };

  const controller = new OidcController(
    {} as never, // userService — not reached on the pre-exchange failure branches
    {} as never, // authService
    {} as never, // csrfService
    {} as never, // featureService
    oidcNativeCodeService as never,
    signupCodeService as never,
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

// A request carrying the native client marker plus whatever state/pkce cookies the case needs.
function nativeReq(cookies: Record<string, string> = {}) {
  return { cookies: { oidc_client: 'native', ...cookies }, secure: false, headers: {} } as never;
}

describe('OidcController — OIDC callback (native deep-link routing)', () => {
  it('routes a provider error back to the app via the deep link, not /login', async () => {
    const { controller } = makeController();
    const res = makeRes();

    await controller.callback('code-x', 'state-x', 'access_denied', nativeReq(), res as never);

    expect(res.redirect).toHaveBeenCalledWith('companion://oidc/callback?error=access_denied');
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

    expect(res.redirect).toHaveBeenCalledWith('companion://oidc/callback?error=missing_params');
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

    expect(res.redirect).toHaveBeenCalledWith('companion://oidc/callback?error=invalid_state');
  });

  it('deep-links missing_pkce when state matches but the PKCE verifier cookie is gone', async () => {
    const { controller } = makeController();
    const res = makeRes();

    // State matches (so it clears the state cookie and advances) but no oidc_pkce cookie.
    await controller.callback('code-x', 'match', undefined, nativeReq({ oidc_state: 'match' }), res as never);

    expect(res.redirect).toHaveBeenCalledWith('companion://oidc/callback?error=missing_pkce');
  });
});

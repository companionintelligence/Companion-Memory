import config from '@ci/configuration';

import { OidcController } from '../OidcController';

// `config` defaults `auth.oidc.issuerUrl` to '' (config/default.json) unless
// OIDC_ISSUER_URL is set. `config` is a plain mutable object (configuration.ts's
// `export default parsed`), and jest gives this test file its own isolated
// module registry, so mutating it here cannot leak into any other suite.
config.auth.oidc.issuerUrl = 'http://localhost:8506';
config.auth.oidc.publicBaseUrl = '';

/**
 * `GET /authenticate/oidc` (initiate) had no test constructing the controller and
 * calling it directly or over HTTP — only the pure-function pieces it calls
 * (safeRelativePath, resolveOidcCallbackUrl/resolveOidcOriginBounce as isolated
 * units) were covered, never this handler's own wiring: whether the redirect
 * query param is actually run through safeRelativePath BEFORE being stored in a
 * cookie, whether issuerUrl-not-configured redirects to /login instead of
 * throwing, and the state/PKCE/native-client cookies it mints.
 */
/** The app's half of a native sign-in: an S256 challenge and a state value of its own. */
const CHALLENGE = 'c'.repeat(43);
const APP_STATE = 's'.repeat(32);

function makeController() {
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  const controller = new OidcController(
    {} as never, // userService — unused by initiate()
    {} as never, // authService
    {} as never, // csrfService
    {} as never, // featureService
    {} as never, // oidcNativeCodeService
    {} as never, // signupCodeService
    {} as never, // federatedIdentityService
    {} as never, // hubBridge
    logger as never,
  );

  return { controller, logger };
}

function makeRes() {
  return {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
  };
}

function makeReq(query: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return { headers, secure: false, query } as never;
}

function cookieCall(res: ReturnType<typeof makeRes>, name: string) {
  return res.cookie.mock.calls.find((call) => call[0] === name);
}

describe('OidcController.initiate (GET /authenticate/oidc)', () => {
  it('redirects to /login?error=oidc_not_configured and mints no cookies when OIDC_ISSUER_URL is unset', () => {
    const { controller, logger } = makeController();
    const res = makeRes();
    const savedIssuerUrl = config.auth.oidc.issuerUrl;
    config.auth.oidc.issuerUrl = '';

    try {
      controller.initiate(undefined, undefined, undefined, undefined, undefined, makeReq(), res as never);
    } finally {
      config.auth.oidc.issuerUrl = savedIssuerUrl;
    }

    expect(res.redirect).toHaveBeenCalledWith('/login?error=oidc_not_configured');
    expect(res.cookie).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('mints state + PKCE cookies and redirects to the Portal authorize endpoint with the matching params', () => {
    const { controller } = makeController();
    const res = makeRes();

    controller.initiate(undefined, undefined, undefined, undefined, undefined, makeReq(), res as never);

    const stateCall = cookieCall(res, 'oidc_state');
    const pkceCall = cookieCall(res, 'oidc_pkce');

    expect(stateCall).toBeDefined();
    expect(pkceCall).toBeDefined();
    // Both are httpOnly, lax, path-scoped — never readable by page JS.
    expect(stateCall![2]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(pkceCall![2]).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });

    expect(res.redirect).toHaveBeenCalledTimes(1);
    const [redirectUrl] = res.redirect.mock.calls[0] as [string];
    const url = new URL(redirectUrl);

    expect(url.origin + url.pathname).toBe('http://localhost:8506/api/auth/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('ci-server');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    // The state cookie value and the state query param must be the SAME value —
    // that's the whole point of the state check on callback.
    expect(url.searchParams.get('state')).toBe(stateCall![1]);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    // PKCE: the challenge sent to the IdP is the SHA-256/base64url of the verifier
    // cookie, never the verifier itself.
    expect(url.searchParams.get('code_challenge')).not.toBe(pkceCall![1]);
  });

  it('does NOT set the native-client cookie for an ordinary (web) sign-in', () => {
    const { controller } = makeController();
    const res = makeRes();

    controller.initiate(undefined, undefined, undefined, undefined, undefined, makeReq(), res as never);

    expect(cookieCall(res, 'oidc_client')).toBeUndefined();
  });

  it('sets the native-client cookie when client=native, so the callback returns via deep link', () => {
    const { controller } = makeController();
    const res = makeRes();

    controller.initiate('native', undefined, undefined, CHALLENGE, APP_STATE, makeReq(), res as never);

    const clientCall = cookieCall(res, 'oidc_client');

    expect(clientCall?.[1]).toBe('native');
  });

  it("parks the app's challenge and state for the callback, httpOnly like the rest", () => {
    const { controller } = makeController();
    const res = makeRes();

    controller.initiate('native', undefined, undefined, CHALLENGE, APP_STATE, makeReq(), res as never);

    expect(cookieCall(res, 'oidc_native_challenge')?.[1]).toBe(CHALLENGE);
    expect(cookieCall(res, 'oidc_native_state')?.[1]).toBe(APP_STATE);
    expect(cookieCall(res, 'oidc_native_challenge')?.[2]).toMatchObject({ httpOnly: true, sameSite: 'lax' });
  });

  it.each([
    ['no challenge or state', undefined, undefined],
    ['no state', CHALLENGE, undefined],
    ['no challenge', undefined, APP_STATE],
    ['a challenge that is not S256 base64url', 'too-short', APP_STATE],
    ['a state that is too short', CHALLENGE, 'abc'],
    ['an array instead of a string', [CHALLENGE, CHALLENGE], APP_STATE],
  ])(
    'refuses a native sign-in with %s, before anything reaches the identity provider',
    (_label, challenge, state) => {
      // An app build from before the binding: it is told to update rather than handed a code
      // that any app could redeem.
      const { controller } = makeController();
      const res = makeRes();

      controller.initiate('native', undefined, undefined, challenge, state, makeReq(), res as never);

      expect(res.redirect).toHaveBeenCalledWith('companion://oidc/callback?error=app_update_required');
      expect(res.cookie).not.toHaveBeenCalled();
    },
  );

  it('clears an abandoned native attempt when a web sign-in starts', () => {
    const { controller } = makeController();
    const res = makeRes();

    controller.initiate(undefined, undefined, undefined, undefined, undefined, makeReq(), res as never);

    expect(cookieCall(res, 'oidc_native_challenge')).toBeUndefined();
    expect(res.clearCookie).toHaveBeenCalledWith('oidc_native_challenge', { path: '/' });
    expect(res.clearCookie).toHaveBeenCalledWith('oidc_native_state', { path: '/' });
    // Left set, the callback would send this browser's sign-in to the app's deep link.
    expect(res.clearCookie).toHaveBeenCalledWith('oidc_client', { path: '/' });
  });

  it('stores a safe relative redirect target in the redirect cookie', () => {
    const { controller } = makeController();
    const res = makeRes();

    controller.initiate(
      undefined,
      '/shared/abc123',
      undefined,
      undefined,
      undefined,
      makeReq(),
      res as never,
    );

    const redirectCall = cookieCall(res, 'oidc_redirect');

    expect(redirectCall?.[1]).toBe('/shared/abc123');
    expect(res.clearCookie).not.toHaveBeenCalledWith('oidc_redirect', expect.anything());
  });

  it('runs the redirect param through safeRelativePath BEFORE storing it — an unsafe target is never persisted', () => {
    const { controller } = makeController();
    const res = makeRes();

    // Absolute cross-origin URL: exactly what safeRelativePath exists to reject.
    controller.initiate(
      undefined,
      'https://evil.example.com/steal',
      undefined,
      undefined,
      undefined,
      makeReq(),
      res as never,
    );

    expect(cookieCall(res, 'oidc_redirect')).toBeUndefined();
    // A plain sign-in with no (valid) destination must not inherit a stale one —
    // the cookie is actively cleared, not merely left unset.
    expect(res.clearCookie).toHaveBeenCalledWith('oidc_redirect', { path: '/' });
  });

  it('clears any stale redirect cookie when no redirect param is given at all', () => {
    const { controller } = makeController();
    const res = makeRes();

    controller.initiate(undefined, undefined, undefined, undefined, undefined, makeReq(), res as never);

    expect(res.clearCookie).toHaveBeenCalledWith('oidc_redirect', { path: '/' });
  });

  it('preserves client=native when bouncing onto the public origin', () => {
    const { controller } = makeController();
    const res = makeRes();
    const savedPublicBaseUrl = config.auth.oidc.publicBaseUrl;
    config.auth.oidc.publicBaseUrl = 'https://ci-memory.example.com';

    try {
      controller.initiate(
        'native',
        undefined,
        undefined,
        CHALLENGE,
        APP_STATE,
        makeReq({}, { host: '192.168.1.50:8642' }),
        res as never,
      );
    } finally {
      config.auth.oidc.publicBaseUrl = savedPublicBaseUrl;
    }

    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledTimes(1);
    const [bounceUrl] = res.redirect.mock.calls[0] as [string];
    const url = new URL(bounceUrl);

    expect(url.origin).toBe('https://ci-memory.example.com');
    expect(url.searchParams.get('client')).toBe('native');
    expect(url.searchParams.get('origin_bounced')).toBe('1');
    // The bounced initiate refuses a native sign-in without the app's binding.
    expect(url.searchParams.get('code_challenge')).toBe(CHALLENGE);
    expect(url.searchParams.get('app_state')).toBe(APP_STATE);
  });

  it('carries the invitation across the bounce, instead of clearing the cookie on the far side', () => {
    // The bounced request re-enters initiate. Without the code in its query it
    // takes the "no code offered" branch and CLEARS the invitation cookie — so
    // a second person signing in from a LAN address was refused for lacking
    // the invitation they had just presented.
    const { controller } = makeController();
    const res = makeRes();
    const savedPublicBaseUrl = config.auth.oidc.publicBaseUrl;
    config.auth.oidc.publicBaseUrl = 'https://ci-memory.example.com';

    try {
      controller.initiate(
        'native',
        undefined,
        'ABCD-1234',
        CHALLENGE,
        APP_STATE,
        makeReq({}, { host: '192.168.1.50:8642' }),
        res as never,
      );
    } finally {
      config.auth.oidc.publicBaseUrl = savedPublicBaseUrl;
    }

    expect(res.redirect).toHaveBeenCalledTimes(1);
    const [bounceUrl] = res.redirect.mock.calls[0] as [string];
    const url = new URL(bounceUrl);

    expect(url.searchParams.get('signup_code')).toBe('ABCD-1234');
    expect(url.searchParams.get('client')).toBe('native');
    expect(url.searchParams.get('origin_bounced')).toBe('1');
  });

  it('does not add client=native when a web sign-in bounces', () => {
    const { controller } = makeController();
    const res = makeRes();
    const savedPublicBaseUrl = config.auth.oidc.publicBaseUrl;
    config.auth.oidc.publicBaseUrl = 'https://ci-memory.example.com';

    try {
      controller.initiate(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        makeReq({}, { host: '192.168.1.50:8642' }),
        res as never,
      );
    } finally {
      config.auth.oidc.publicBaseUrl = savedPublicBaseUrl;
    }

    const [bounceUrl] = res.redirect.mock.calls[0] as [string];
    const url = new URL(bounceUrl);

    expect(url.searchParams.get('client')).toBeNull();
    expect(url.searchParams.get('origin_bounced')).toBe('1');
  });
});

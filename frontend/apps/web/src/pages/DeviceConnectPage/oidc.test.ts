import { AuthSessionCancelledError } from '@ci/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bearerAddressedTo,
  dropPendingPick,
  emailFromIdToken,
  exchangePortalSignIn,
  forgetPortalSignIn,
  hasPendingPortalOidc,
  OIDC_CLIENT_ID,
  OIDC_REDIRECT_URI,
  OidcCancelledError,
  type PairingTarget,
  PortalInvalidTargetError,
  type PortalSignIn,
  resumePendingOidcLogin,
  selectMemoryPortalBearers,
  signInWithPortalOidc,
} from './oidc';
import { DEFAULT_PORTAL_URL, PortalSignInExpiredError } from './portal-client';

const openAuthSession = vi.fn<(url: string) => Promise<void>>(async () => {});
const closeBrowser = vi.fn(async () => {});
const getLaunchUrl = vi.fn(async (): Promise<string | null> => null);
let urlHandler: ((url: string) => void) | undefined;
const unlisten = vi.fn();

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  openAuthSession: (url: string) => openAuthSession(url),
  closeBrowser: () => closeBrowser(),
  getLaunchUrl: () => getLaunchUrl(),
  addAppUrlOpenListener: vi.fn(async (handler: (url: string) => void) => {
    urlHandler = handler;

    return unlisten;
  }),
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

function openedAuthorizeUrl(): URL {
  const href = openAuthSession.mock.calls[0]?.[0];

  if (typeof href !== 'string') {
    throw new Error('authorize URL was not opened');
  }

  return new URL(href);
}

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The Memory the person picked, as `/api/users/me/apps` listed it. */
const HOME: PairingTarget = {
  id: 'home',
  name: 'Home',
  status: 'active',
  memoryUrl: 'https://memory.example.com/app',
  resource: 'urn:ci:device:home-device',
};

function exchangeBody(call = 0): URLSearchParams {
  const init = vi.mocked(fetch).mock.calls[call]?.[1] as RequestInit | undefined;

  return new URLSearchParams(String(init?.body));
}

const INVALID_TARGET = {
  error: 'invalid_target',
  error_description: 'Not an appliance this sign-in can be addressed to',
};

const INVALID_GRANT = { error: 'invalid_grant', error_description: 'invalid code' };

const TOKENS = { accessToken: 'AT', idToken: 'IT', tokenType: 'Bearer', expiresIn: 3600 };

beforeEach(() => {
  openAuthSession.mockReset();
  openAuthSession.mockResolvedValue(undefined);
  closeBrowser.mockClear();
  unlisten.mockClear();
  getLaunchUrl.mockReset();
  getLaunchUrl.mockResolvedValue(null);
  urlHandler = undefined;
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      tokenResponse({ access_token: 'AT', id_token: 'IT', token_type: 'Bearer', expires_in: 3600 }),
    ),
  );
});

/** Sign in up to the code: the sheet opens and the callback comes back with `code`. */
async function signedIn(code = 'auth-code-1'): Promise<PortalSignIn> {
  const promise = signInWithPortalOidc();
  await fireCallback(code);

  return promise;
}

async function fireCallback(code: string, stateOverride?: string) {
  await vi.waitFor(() => {
    expect(openAuthSession).toHaveBeenCalled();
    expect(urlHandler).toBeTruthy();
  });
  const authorizeUrl = openedAuthorizeUrl();
  const state = stateOverride ?? authorizeUrl.searchParams.get('state') ?? '';
  urlHandler?.(`${OIDC_REDIRECT_URI}?code=${code}&state=${state}`);

  return authorizeUrl;
}

describe('signInWithPortalOidc', () => {
  it('runs the PKCE authorize and callback, and hands back the code unspent', async () => {
    const promise = signInWithPortalOidc();
    const authorizeUrl = await fireCallback('auth-code-1');
    const signIn = await promise;

    expect(signIn).toEqual({ portal: DEFAULT_PORTAL_URL, code: 'auth-code-1', verifier: expect.any(String) });
    expect(signIn.verifier).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // Nothing is exchanged until a Memory is picked.
    expect(fetch).not.toHaveBeenCalled();
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      `${DEFAULT_PORTAL_URL}/api/auth/oauth2/authorize`,
    );
    expect(authorizeUrl.searchParams.get('client_id')).toBe(OIDC_CLIENT_ID);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(OIDC_REDIRECT_URI);
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(authorizeUrl.searchParams.has('resource')).toBe(false);
    expect(unlisten).toHaveBeenCalled();
    expect(closeBrowser).toHaveBeenCalled();
    // Kept until the code is spent: a relaunch resumes from it.
    expect(hasPendingPortalOidc()).toBe(true);
  });

  it('ignores a callback whose state does not match', async () => {
    const promise = signInWithPortalOidc();
    await fireCallback('code', 'tampered-state');
    const state = openedAuthorizeUrl().searchParams.get('state') ?? '';
    urlHandler?.(`${OIDC_REDIRECT_URI}?code=real&state=${state}`);

    await expect(promise).resolves.toMatchObject({ code: 'real' });
  });

  it('sends a code_challenge that is the SHA-256 of the code_verifier', async () => {
    const promise = signInWithPortalOidc();
    const authorizeUrl = await fireCallback('code');
    const { verifier } = await promise;

    const challenge = authorizeUrl.searchParams.get('code_challenge') ?? '';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(challenge).toBe(expected);
    expect(authorizeUrl.toString()).not.toContain(verifier);
  });

  it('cancels quietly when the caller aborts', async () => {
    const controller = new AbortController();
    const promise = signInWithPortalOidc(undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(urlHandler).toBeTruthy());
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'OidcCancelledError' });
    expect(unlisten).toHaveBeenCalled();
    expect(hasPendingPortalOidc()).toBe(false);
  });

  it('treats a dismissed iOS sheet as a quiet cancel', async () => {
    openAuthSession.mockRejectedValue(new AuthSessionCancelledError());
    await expect(signInWithPortalOidc()).rejects.toBeInstanceOf(OidcCancelledError);
    expect(hasPendingPortalOidc()).toBe(false);
  });

  it('rejects immediately when handed an already-aborted signal', async () => {
    const promise = signInWithPortalOidc(undefined, { signal: AbortSignal.abort() });
    await expect(promise).rejects.toMatchObject({ name: 'OidcCancelledError' });
  });

  it('surfaces a Portal error from the callback', async () => {
    const promise = signInWithPortalOidc();
    await vi.waitFor(() => expect(urlHandler).toBeTruthy());
    urlHandler?.(`${OIDC_REDIRECT_URI}?error=access_denied&error_description=User%20denied%20access`);
    await expect(promise).rejects.toThrow('User denied access');
  });

  it('ignores companion://oidc/callback (that is Memory login, not cloud connect)', async () => {
    const promise = signInWithPortalOidc();
    await vi.waitFor(() => expect(urlHandler).toBeTruthy());
    urlHandler?.('companion://oidc/callback?code=appliance');
    const url = openedAuthorizeUrl();
    urlHandler?.(`${OIDC_REDIRECT_URI}?code=real&state=${url.searchParams.get('state')}`);
    await expect(promise).resolves.toMatchObject({ code: 'real' });
  });
});

describe('exchangePortalSignIn', () => {
  it("exchanges an older Portal's code at once, with no resource, and drops the sign-in", async () => {
    const signIn = await signedIn('auth-code-1');

    await expect(exchangePortalSignIn(signIn)).resolves.toEqual(TOKENS);

    const [tokenUrl, init] = (vi.mocked(fetch).mock.calls[0] ?? []) as [string, RequestInit];
    expect(tokenUrl).toBe(`${DEFAULT_PORTAL_URL}/api/auth/oauth2/token`);
    expect(init.headers).toMatchObject({ Origin: DEFAULT_PORTAL_URL });
    const body = exchangeBody();
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe(OIDC_CLIENT_ID);
    expect(body.get('redirect_uri')).toBe(OIDC_REDIRECT_URI);
    expect(body.get('code')).toBe('auth-code-1');
    expect(body.get('code_verifier')).toBe(signIn.verifier);
    expect(body.has('resource')).toBe(false);
    expect(hasPendingPortalOidc()).toBe(false);
  });

  it('spends the code on the picked Memory, naming its resource, and drops the sign-in', async () => {
    const signIn = await signedIn('pick-code');

    await expect(exchangePortalSignIn(signIn, HOME)).resolves.toEqual(TOKENS);

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = exchangeBody();
    expect(body.get('resource')).toBe('urn:ci:device:home-device');
    expect(body.get('code')).toBe('pick-code');
    expect(body.get('code_verifier')).toBe(signIn.verifier);
    expect(openedAuthorizeUrl().toString()).not.toContain('home-device');
    expect(hasPendingPortalOidc()).toBe(false);
  });

  it('records the pick before the exchange answers, so a relaunch can finish it', async () => {
    const signIn = await signedIn('pick-code');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    getLaunchUrl.mockResolvedValue(
      `${OIDC_REDIRECT_URI}?code=pick-code&state=${openedAuthorizeUrl().searchParams.get('state')}`,
    );

    void exchangePortalSignIn(signIn, HOME);

    await expect(resumePendingOidcLogin()).resolves.toEqual({ signIn, pick: HOME });
    // Reading it changes nothing: a resume abandoned before it acts leaves the pick for the next one.
    await expect(resumePendingOidcLogin()).resolves.toEqual({ signIn, pick: HOME });

    // Taken out when the page starts that pairing again; the sign-in itself stays.
    dropPendingPick();
    await expect(resumePendingOidcLogin()).resolves.toEqual({ signIn, pick: null });
  });

  it('turns invalid_target into a plain message, keeps the code for another pick, and forgets the pick', async () => {
    const signIn = await signedIn('pick-code');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse(INVALID_TARGET, 400)),
    );

    const attempt = exchangePortalSignIn(signIn, HOME);

    await expect(attempt).rejects.toBeInstanceOf(PortalInvalidTargetError);
    await expect(attempt).rejects.toThrow(
      "This Memory Server isn't one your Companion account can connect to.",
    );
    expect(hasPendingPortalOidc()).toBe(true);
    await expect(resumePendingOidcLogin()).resolves.toMatchObject({ pick: null });
  });

  it('says the sign-in expired on invalid_grant, and drops it', async () => {
    const signIn = await signedIn('pick-code');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse(INVALID_GRANT, 400)),
    );

    const attempt = exchangePortalSignIn(signIn, HOME);

    await expect(attempt).rejects.toBeInstanceOf(PortalSignInExpiredError);
    await expect(attempt).rejects.toThrow('Your Companion sign-in expired. Sign in again.');
    expect(hasPendingPortalOidc()).toBe(false);
  });

  it('forgets the pick but keeps the sign-in when the exchange fails some other way', async () => {
    const signIn = await signedIn('pick-code');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse({ error: 'server_error' }, 500)),
    );

    await expect(exchangePortalSignIn(signIn, HOME)).rejects.toThrow('server_error');

    expect(hasPendingPortalOidc()).toBe(true);
    await expect(resumePendingOidcLogin()).resolves.toMatchObject({ pick: null });
  });
});

describe('resumePendingOidcLogin', () => {
  it('returns null when nothing is pending', async () => {
    await expect(resumePendingOidcLogin()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('picks up a cold-start callback with the persisted verifier, without exchanging it', async () => {
    const controller = new AbortController();
    const first = signInWithPortalOidc(undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(openAuthSession).toHaveBeenCalled());
    const state = openedAuthorizeUrl().searchParams.get('state') ?? '';

    // iOS relaunched the app from the callback: the sign-in above is gone, only storage is left.
    getLaunchUrl.mockResolvedValue(`${OIDC_REDIRECT_URI}?code=cold-code&state=${state}`);
    const resumed = await resumePendingOidcLogin();

    expect(resumed).toEqual({
      signIn: {
        portal: DEFAULT_PORTAL_URL,
        code: 'cold-code',
        verifier: expect.stringMatching(/^[A-Za-z0-9_-]{20,}$/),
      },
      pick: null,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(hasPendingPortalOidc()).toBe(true);

    controller.abort();
    await expect(first).rejects.toBeInstanceOf(OidcCancelledError);
  });

  it('refuses a stored pick that cannot be read back', async () => {
    localStorage.setItem(
      'ci-memory.oidc.pending',
      JSON.stringify({
        verifier: 'v'.repeat(43),
        state: 'stored-state',
        portal: DEFAULT_PORTAL_URL,
        startedAt: Date.now(),
        pick: { id: 'home', name: 'Home', status: 'active', memoryUrl: 'https://memory.example.com' },
      }),
    );
    getLaunchUrl.mockResolvedValue(`${OIDC_REDIRECT_URI}?code=cold-code&state=stored-state`);

    // Without its resource the pick could only be exchanged for a token no Memory pairs with.
    await expect(resumePendingOidcLogin()).resolves.toBeNull();
  });

  it('drops the sign-in and reports a Portal error the callback carried', async () => {
    localStorage.setItem(
      'ci-memory.oidc.pending',
      JSON.stringify({
        verifier: 'v'.repeat(43),
        state: 's1',
        portal: DEFAULT_PORTAL_URL,
        startedAt: Date.now(),
      }),
    );
    getLaunchUrl.mockResolvedValue(
      `${OIDC_REDIRECT_URI}?error=access_denied&error_description=Denied&state=s1`,
    );

    await expect(resumePendingOidcLogin()).rejects.toThrow('Denied');
    expect(hasPendingPortalOidc()).toBe(false);
  });
});

describe('forgetPortalSignIn', () => {
  it('drops the sign-in, so nothing is left to resume', async () => {
    await signedIn('auth-code-1');

    await forgetPortalSignIn();

    expect(hasPendingPortalOidc()).toBe(false);
    await expect(resumePendingOidcLogin()).resolves.toBeNull();
  });
});

describe('bearerAddressedTo', () => {
  function tokenWithPayload(payload: unknown): string {
    const json = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    return `hdr.${json}.sig`;
  }

  const live = Math.floor(Date.now() / 1000) + 600;

  it('returns the id_token the Portal addressed to the picked Memory', () => {
    const addressed = tokenWithPayload({ aud: ['ci-server', HOME.resource], azp: 'ci-server', exp: live });

    expect(bearerAddressedTo(addressed, HOME.resource)).toBe(addressed);
  });

  it('refuses an id_token addressed to nobody or to another Memory', () => {
    expect(bearerAddressedTo(tokenWithPayload({ aud: 'ci-server', exp: live }), HOME.resource)).toBeNull();
    expect(
      bearerAddressedTo(
        tokenWithPayload({ aud: ['ci-server', 'urn:ci:device:other-device'], exp: live }),
        HOME.resource,
      ),
    ).toBeNull();
  });

  it('refuses an expired one, one for a client Memory does not accept, and none at all', () => {
    expect(
      bearerAddressedTo(
        tokenWithPayload({ aud: ['ci-server', HOME.resource], exp: Math.floor(Date.now() / 1000) - 120 }),
        HOME.resource,
      ),
    ).toBeNull();
    expect(
      bearerAddressedTo(tokenWithPayload({ aud: ['ci-hub-web', HOME.resource], exp: live }), HOME.resource),
    ).toBeNull();
    expect(bearerAddressedTo(null, HOME.resource)).toBeNull();
  });
});

describe('emailFromIdToken', () => {
  function tokenWithPayload(payload: unknown): string {
    const json = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    return `hdr.${json}.sig`;
  }

  it('reads the Portal email from an id_token payload', () => {
    expect(emailFromIdToken(tokenWithPayload({ email: 'chamberlain.bennett@gmail.com' }))).toBe(
      'chamberlain.bennett@gmail.com',
    );
  });

  it('returns null for missing, empty, or unreadable tokens', () => {
    expect(emailFromIdToken(null)).toBeNull();
    expect(emailFromIdToken('not-a-jwt')).toBeNull();
    expect(emailFromIdToken(tokenWithPayload({ sub: 'user-1' }))).toBeNull();
  });
});

describe('selectMemoryPortalBearers', () => {
  function tokenWithPayload(payload: unknown): string {
    const json = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    return `hdr.${json}.sig`;
  }

  it('prefers an unexpired id_token whose aud Memory accepts', () => {
    const idToken = tokenWithPayload({
      aud: 'ci-server',
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const accessToken = tokenWithPayload({
      aud: 'https://hub.ci.computer',
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    expect(selectMemoryPortalBearers([idToken, accessToken])).toEqual([idToken]);
  });

  it('drops expired JWTs and never sends an opaque token instead', () => {
    // The opaque one is the Portal access token: a credential for the Portal, not for a Memory.
    const expired = tokenWithPayload({ aud: 'ci-server', exp: Math.floor(Date.now() / 1000) - 120 });

    expect(selectMemoryPortalBearers([expired, 'opaque-at'])).toEqual([]);
  });

  it('never falls back to a live JWT whose aud Memory does not accept', () => {
    const portalSession = tokenWithPayload({
      aud: 'https://hub.ci.computer',
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    expect(selectMemoryPortalBearers([portalSession])).toEqual([]);
  });

  it('accepts an id_token whose aud lists a Memory client among others', () => {
    const addressed = tokenWithPayload({
      aud: ['ci-server', 'urn:ci:device:abc'],
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    expect(selectMemoryPortalBearers([addressed])).toEqual([addressed]);
  });
});

import { AuthSessionCancelledError } from '@ci/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bearerAddressedTo,
  emailFromIdToken,
  hasPendingPortalOidc,
  loginWithPortalOidc,
  OIDC_CLIENT_ID,
  OIDC_REDIRECT_URI,
  OidcCancelledError,
  type PairingTarget,
  PortalInvalidTargetError,
  resumePendingOidcLogin,
  selectMemoryPortalBearers,
} from './oidc';
import { DEFAULT_PORTAL_URL } from './portal-client';

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
  error_description: 'The resource is not a device this account can reach',
};

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

describe('loginWithPortalOidc', () => {
  it('runs the PKCE authorize → callback → token exchange and returns tokens', async () => {
    const promise = loginWithPortalOidc();
    const authorizeUrl = await fireCallback('auth-code-1');
    const tokens = await promise;

    expect(tokens).toEqual({ accessToken: 'AT', idToken: 'IT', tokenType: 'Bearer', expiresIn: 3600 });
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      `${DEFAULT_PORTAL_URL}/api/auth/oauth2/authorize`,
    );
    expect(authorizeUrl.searchParams.get('client_id')).toBe(OIDC_CLIENT_ID);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(OIDC_REDIRECT_URI);
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const [tokenUrl, init] = (vi.mocked(fetch).mock.calls[0] ?? []) as [string, RequestInit];
    expect(tokenUrl).toBe(`${DEFAULT_PORTAL_URL}/api/auth/oauth2/token`);
    expect(init.headers).toMatchObject({ Origin: DEFAULT_PORTAL_URL });
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-1');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // The first sign-in picks no Memory, so it asks for no resource.
    expect(body.has('resource')).toBe(false);
    expect(authorizeUrl.searchParams.has('resource')).toBe(false);
    expect(unlisten).toHaveBeenCalled();
    expect(closeBrowser).toHaveBeenCalled();
  });

  it("sends the picked Memory's resource at the code exchange of a pairing sign-in, and nowhere else", async () => {
    const promise = loginWithPortalOidc(undefined, { pairWith: HOME });
    const authorizeUrl = await fireCallback('pairing-code');

    await expect(promise).resolves.toMatchObject({ idToken: 'IT' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = exchangeBody();
    expect(body.get('resource')).toBe('urn:ci:device:home-device');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe(OIDC_CLIENT_ID);
    expect(body.get('redirect_uri')).toBe(OIDC_REDIRECT_URI);
    expect(body.get('code')).toBe('pairing-code');
    // The Portal ignores `resource` at /authorize, so it is never put there.
    expect(authorizeUrl.searchParams.has('resource')).toBe(false);
    expect(authorizeUrl.toString()).not.toContain('home-device');
    expect(hasPendingPortalOidc()).toBe(false);
  });

  it('turns invalid_target into a plain message and drops the pairing sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse(INVALID_TARGET, 400)),
    );

    const promise = loginWithPortalOidc(undefined, { pairWith: HOME });
    await fireCallback('pairing-code');

    await expect(promise).rejects.toBeInstanceOf(PortalInvalidTargetError);
    await expect(promise).rejects.toThrow(
      "This Memory Server isn't one your Companion account can connect to.",
    );
    // Nothing is left for a later resume to retry behind the error the person already saw.
    expect(hasPendingPortalOidc()).toBe(false);
  });

  it('keeps a failed first sign-in pending, as before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse({ error: 'server_error' }, 500)),
    );

    const promise = loginWithPortalOidc();
    await fireCallback('code');

    await expect(promise).rejects.toThrow('server_error');
    expect(hasPendingPortalOidc()).toBe(true);
  });

  it('drops a pairing sign-in whose sheet could not open', async () => {
    openAuthSession.mockRejectedValue(new Error('Could not open the sign-in sheet.'));

    await expect(loginWithPortalOidc(undefined, { pairWith: HOME })).rejects.toThrow(
      'Could not open the sign-in sheet.',
    );
    expect(hasPendingPortalOidc()).toBe(false);
  });

  it('drops a cancelled pairing sign-in', async () => {
    openAuthSession.mockRejectedValue(new AuthSessionCancelledError());

    await expect(loginWithPortalOidc(undefined, { pairWith: HOME })).rejects.toBeInstanceOf(
      OidcCancelledError,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(hasPendingPortalOidc()).toBe(false);
  });

  it('ignores a callback whose state does not match', async () => {
    const promise = loginWithPortalOidc();
    await fireCallback('code', 'tampered-state');
    expect(fetch).not.toHaveBeenCalled();
    const authorizeUrl = openedAuthorizeUrl();
    const state = authorizeUrl.searchParams.get('state') ?? '';
    urlHandler?.(`${OIDC_REDIRECT_URI}?code=real&state=${state}`);
    await expect(promise).resolves.toMatchObject({ accessToken: 'AT' });
  });

  it('sends a code_challenge that is the SHA-256 of the code_verifier', async () => {
    const promise = loginWithPortalOidc();
    const authorizeUrl = await fireCallback('code');
    await promise;

    const challenge = authorizeUrl.searchParams.get('code_challenge') ?? '';
    const tokenInit = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit | undefined;
    const verifier = new URLSearchParams(String(tokenInit?.body)).get('code_verifier') ?? '';
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
    const promise = loginWithPortalOidc(undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(urlHandler).toBeTruthy());
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'OidcCancelledError' });
    expect(unlisten).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats a dismissed iOS sheet as a quiet cancel', async () => {
    openAuthSession.mockRejectedValue(new AuthSessionCancelledError());
    await expect(loginWithPortalOidc()).rejects.toBeInstanceOf(OidcCancelledError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects immediately when handed an already-aborted signal', async () => {
    const promise = loginWithPortalOidc(undefined, { signal: AbortSignal.abort() });
    await expect(promise).rejects.toMatchObject({ name: 'OidcCancelledError' });
  });

  it('surfaces a Portal error instead of exchanging', async () => {
    const promise = loginWithPortalOidc();
    await vi.waitFor(() => expect(urlHandler).toBeTruthy());
    urlHandler?.(`${OIDC_REDIRECT_URI}?error=access_denied&error_description=User%20denied%20access`);
    await expect(promise).rejects.toThrow('User denied access');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores companion://oidc/callback (that is Memory login, not cloud connect)', async () => {
    const promise = loginWithPortalOidc();
    await vi.waitFor(() => expect(urlHandler).toBeTruthy());
    urlHandler?.('companion://oidc/callback?code=appliance');
    expect(fetch).not.toHaveBeenCalled();
    const url = openedAuthorizeUrl();
    urlHandler?.(`${OIDC_REDIRECT_URI}?code=real&state=${url.searchParams.get('state')}`);
    await expect(promise).resolves.toMatchObject({ accessToken: 'AT' });
  });
});

describe('resumePendingOidcLogin', () => {
  it('returns null when nothing is pending', async () => {
    await expect(resumePendingOidcLogin()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exchanges a cold-start callback using the persisted PKCE verifier', async () => {
    const controller = new AbortController();
    const first = loginWithPortalOidc(undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(openAuthSession).toHaveBeenCalled());
    const authorizeUrl = openedAuthorizeUrl();
    const state = authorizeUrl.searchParams.get('state') ?? '';

    getLaunchUrl.mockResolvedValue(`${OIDC_REDIRECT_URI}?code=cold-code&state=${state}`);
    await expect(resumePendingOidcLogin()).resolves.toEqual({
      tokens: { accessToken: 'AT', idToken: 'IT', tokenType: 'Bearer', expiresIn: 3600 },
      pairWith: null,
    });

    const body = exchangeBody();
    expect(body.get('code')).toBe('cold-code');
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.has('resource')).toBe(false);

    controller.abort();
    await expect(first).rejects.toBeInstanceOf(OidcCancelledError);
  });

  it('finishes a pairing sign-in with its resource and hands back the Memory that was picked', async () => {
    const controller = new AbortController();
    const live = loginWithPortalOidc(undefined, { signal: controller.signal, pairWith: HOME });
    await vi.waitFor(() => expect(openAuthSession).toHaveBeenCalled());
    const state = openedAuthorizeUrl().searchParams.get('state') ?? '';

    // iOS relaunched the app from the callback: the live sign-in above is gone, only storage is left.
    getLaunchUrl.mockResolvedValue(`${OIDC_REDIRECT_URI}?code=cold-code&state=${state}`);
    await expect(resumePendingOidcLogin()).resolves.toEqual({
      tokens: { accessToken: 'AT', idToken: 'IT', tokenType: 'Bearer', expiresIn: 3600 },
      pairWith: HOME,
    });

    const body = exchangeBody();
    expect(body.get('code')).toBe('cold-code');
    expect(body.get('resource')).toBe('urn:ci:device:home-device');
    expect(hasPendingPortalOidc()).toBe(false);

    controller.abort();
    await expect(live).rejects.toBeInstanceOf(OidcCancelledError);
  });

  it('drops a resumed pairing sign-in the Portal answers with invalid_target', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse(INVALID_TARGET, 400)),
    );
    const controller = new AbortController();
    const live = loginWithPortalOidc(undefined, { signal: controller.signal, pairWith: HOME });
    await vi.waitFor(() => expect(openAuthSession).toHaveBeenCalled());
    const state = openedAuthorizeUrl().searchParams.get('state') ?? '';

    getLaunchUrl.mockResolvedValue(`${OIDC_REDIRECT_URI}?code=cold-code&state=${state}`);
    await expect(resumePendingOidcLogin()).rejects.toBeInstanceOf(PortalInvalidTargetError);
    expect(hasPendingPortalOidc()).toBe(false);

    controller.abort();
    await expect(live).rejects.toBeInstanceOf(OidcCancelledError);
  });

  it('refuses a stored pairing sign-in whose Memory cannot be read back', async () => {
    localStorage.setItem(
      'ci-memory.oidc.pending',
      JSON.stringify({
        verifier: 'v'.repeat(43),
        state: 'stored-state',
        portal: DEFAULT_PORTAL_URL,
        startedAt: Date.now(),
        pairWith: { id: 'home', name: 'Home', status: 'active', memoryUrl: 'https://memory.example.com' },
      }),
    );
    getLaunchUrl.mockResolvedValue(`${OIDC_REDIRECT_URI}?code=cold-code&state=stored-state`);

    // Exchanged without its resource it would come back unaddressed, so it is not exchanged at all.
    await expect(resumePendingOidcLogin()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
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

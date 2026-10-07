import {
  OIDC_NATIVE_CALLBACK_URL,
  OIDC_NATIVE_CLIENT_FLAG,
  OIDC_NATIVE_SCHEME,
  beginNativeOidcSignIn,
  claimNativeOidcCode,
  hasPendingNativeOidcSignIn,
  parseOidcCallbackUrl,
  takePendingNativeOidcSignIn,
} from '@ci/common/src/utils/oidcNative';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  sessionStorage.clear();
  localStorage.removeItem('ci.oidc.pendingNativeSignIn');
});

describe('oidcNative — constants', () => {
  it('exposes the expected scheme/callback/flag', () => {
    expect(OIDC_NATIVE_SCHEME).toBe('companion');
    expect(OIDC_NATIVE_CALLBACK_URL).toBe('companion://oidc/callback');
    expect(OIDC_NATIVE_CLIENT_FLAG).toBe('native');
  });
});

describe('parseOidcCallbackUrl', () => {
  it('extracts the one-time code from a success deep link', () => {
    expect(parseOidcCallbackUrl('companion://oidc/callback?code=abc123')).toEqual({
      code: 'abc123',
      error: undefined,
    });
  });

  it('extracts the error from a failure deep link', () => {
    expect(parseOidcCallbackUrl('companion://oidc/callback?error=invalid_state')).toEqual({
      code: undefined,
      error: 'invalid_state',
    });
  });

  it('tolerates a trailing slash on the path', () => {
    expect(parseOidcCallbackUrl('companion://oidc/callback/?code=xyz')).toEqual({
      code: 'xyz',
      error: undefined,
    });
  });

  it('returns null for a different scheme', () => {
    expect(parseOidcCallbackUrl('https://oidc/callback?code=abc')).toBeNull();
    expect(parseOidcCallbackUrl('otherapp://oidc/callback?code=abc')).toBeNull();
  });

  it('returns null for our scheme but a different path', () => {
    expect(parseOidcCallbackUrl('companion://oidc/other?code=abc')).toBeNull();
    expect(parseOidcCallbackUrl('companion://settings')).toBeNull();
  });

  it('returns null for a non-URL string', () => {
    expect(parseOidcCallbackUrl('not a url')).toBeNull();
    expect(parseOidcCallbackUrl('')).toBeNull();
  });

  it('extracts the state the appliance echoes back', () => {
    expect(parseOidcCallbackUrl('companion://oidc/callback?code=abc&state=s1')).toEqual({
      code: 'abc',
      error: undefined,
      state: 's1',
    });
  });

  it('returns empty params (no code/error) for a bare callback', () => {
    expect(parseOidcCallbackUrl('companion://oidc/callback')).toEqual({
      code: undefined,
      error: undefined,
    });
  });
});

describe('claimNativeOidcCode', () => {
  it('claims a code once so getLaunchUrl remounts cannot replay it', () => {
    expect(claimNativeOidcCode('otc-1')).toBe(true);
    expect(claimNativeOidcCode('otc-1')).toBe(false);
    expect(claimNativeOidcCode('otc-2')).toBe(true);
  });
});

describe('a native sign-in bound to this app', () => {
  it('hands back the verifier for the state it started with, once', async () => {
    const { appState, codeChallenge } = await beginNativeOidcSignIn();

    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const pending = takePendingNativeOidcSignIn(appState);

    expect(pending?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(takePendingNativeOidcSignIn(appState)).toBeNull();
  });

  it('sends the S256 challenge of the verifier, never the verifier', async () => {
    const { appState, codeChallenge } = await beginNativeOidcSignIn();
    const { verifier } = takePendingNativeOidcSignIn(appState)!;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const expected = btoa(String.fromCharCode(...digest))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(codeChallenge).toBe(expected);
    expect(codeChallenge).not.toBe(verifier);
  });

  it('refuses a callback with no state, or another state, and keeps the real sign-in pending', async () => {
    const { appState } = await beginNativeOidcSignIn();

    expect(takePendingNativeOidcSignIn(undefined)).toBeNull();
    expect(takePendingNativeOidcSignIn('someone-elses-state')).toBeNull();
    expect(takePendingNativeOidcSignIn(appState)).not.toBeNull();
  });

  it('refuses everything when this app started nothing', () => {
    expect(takePendingNativeOidcSignIn('any-state')).toBeNull();
    expect(hasPendingNativeOidcSignIn()).toBe(false);
  });

  it('reports a sign-in in flight until it expires or completes', async () => {
    const { appState } = await beginNativeOidcSignIn();

    expect(hasPendingNativeOidcSignIn()).toBe(true);
    expect(hasPendingNativeOidcSignIn(Date.now() + 11 * 60 * 1000)).toBe(false);

    takePendingNativeOidcSignIn(appState);

    expect(hasPendingNativeOidcSignIn()).toBe(false);
  });

  it('refuses a callback that arrives after the attempt expired', async () => {
    const { appState } = await beginNativeOidcSignIn();

    expect(takePendingNativeOidcSignIn(appState, Date.now() + 11 * 60 * 1000)).toBeNull();
    expect(takePendingNativeOidcSignIn(appState)).toBeNull();
  });

  it('survives a cold start: the pending sign-in is in localStorage too', async () => {
    const { appState } = await beginNativeOidcSignIn();

    sessionStorage.clear();

    expect(takePendingNativeOidcSignIn(appState)).not.toBeNull();
  });
});

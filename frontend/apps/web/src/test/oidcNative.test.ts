import {
  OIDC_NATIVE_CALLBACK_URL,
  OIDC_NATIVE_CLIENT_FLAG,
  OIDC_NATIVE_SCHEME,
  claimNativeOidcCode,
  parseOidcCallbackUrl,
} from '@ci/common/src/utils/oidcNative';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  sessionStorage.clear();
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

import {
  AuthSessionCancelledError,
  isIosPlatform,
  isNativePlatform,
  isTauriPlatform,
  openAuthSession,
  openExternalUrl,
} from '@ci/common';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OidcButton } from './OidcButton';

// Keep the real helpers (buildApiUrl resolves to same-origin paths on web) but control
// the platform checks and stub the native "open the system browser" bridge.
vi.mock('@ci/common', async (orig) => ({
  ...(await orig<typeof import('@ci/common')>()),
  isIosPlatform: vi.fn(() => false),
  isNativePlatform: vi.fn(() => false),
  isTauriPlatform: vi.fn(() => false),
  openAuthSession: vi.fn(),
  openExternalUrl: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(isIosPlatform).mockReturnValue(false);
  vi.mocked(isNativePlatform).mockReturnValue(false);
  vi.mocked(isTauriPlatform).mockReturnValue(false);
  vi.mocked(openAuthSession).mockResolvedValue(undefined);
  // vitest.config.ts sets `restoreMocks: true`, which wipes every mock's
  // implementation (not just its call history) before each test — including
  // one set once in the vi.mock factory above, the same reason
  // isNativePlatform/isTauriPlatform are re-armed here rather than only in
  // the factory. handleClick now chains `.catch()` off this call, so it must
  // resolve to a real Promise on every test, not just the first.
  vi.mocked(openExternalUrl).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.removeItem('ci.oidc.pendingNativeSignIn');
});

/** The URL a native click opened, once the async PKCE step has run. */
async function openedUrl(opener: typeof openExternalUrl | typeof openAuthSession): Promise<URL> {
  await waitFor(() => expect(opener).toHaveBeenCalledTimes(1));

  return new URL(vi.mocked(opener).mock.calls[0][0], window.location.origin);
}

/** What `beginNativeOidcSignIn` kept for the deep-link handler. */
function pendingSignIn(): { state: string; verifier: string } {
  return JSON.parse(localStorage.getItem('ci.oidc.pendingNativeSignIn')!) as {
    state: string;
    verifier: string;
  };
}

/** base64url(SHA-256(verifier)), the S256 challenge the appliance checks the verifier against. */
async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('OidcButton', () => {
  it('web: renders an anchor to the OIDC route and does not open a system browser', () => {
    render(<OidcButton label="Sign in with CI Portal" />);

    const link = screen.getByRole('link', { name: 'Sign in with CI Portal' });
    expect(link.getAttribute('href')).toBe('/api/authenticate/oidc');

    fireEvent.click(link);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('native: opens the OIDC route in the system browser with ?client=native, bound to this app', async () => {
    vi.mocked(isNativePlatform).mockReturnValue(true);

    render(<OidcButton label="Sign in with Companion account" />);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in with Companion account' }));

    const url = await openedUrl(openExternalUrl);
    expect(url.pathname).toBe('/api/authenticate/oidc');
    expect(url.searchParams.get('client')).toBe('native');
    expect(openAuthSession).not.toHaveBeenCalled();

    // The challenge of a verifier the app keeps, and a state the deep link must echo.
    const pending = pendingSignIn();
    expect(url.searchParams.get('app_state')).toBe(pending.state);
    expect(url.searchParams.get('code_challenge')).toBe(await s256(pending.verifier));
    expect(url.searchParams.get('code_challenge')).not.toBe(pending.verifier);
  });

  it('native: a second click starts a fresh sign-in, with a new state and verifier', async () => {
    vi.mocked(isNativePlatform).mockReturnValue(true);

    render(<OidcButton label="Sign in with Companion account" />);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in with Companion account' }));
    const first = (await openedUrl(openExternalUrl)).searchParams.get('app_state');

    fireEvent.click(screen.getByRole('link', { name: 'Sign in with Companion account' }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledTimes(2));
    const second = new URL(
      vi.mocked(openExternalUrl).mock.calls[1][0],
      window.location.origin,
    ).searchParams.get('app_state');

    expect(second).not.toBe(first);
    expect(pendingSignIn().state).toBe(second);
  });

  it('iOS: opens the OIDC route in the in-app sheet, not Safari', async () => {
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(isIosPlatform).mockReturnValue(true);

    render(<OidcButton label="Sign in with Companion account" />);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in with Companion account' }));

    const url = await openedUrl(openAuthSession);
    expect(url.pathname).toBe('/api/authenticate/oidc');
    expect(url.searchParams.get('client')).toBe('native');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('iOS: dismissing the sheet stays quiet', async () => {
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(isIosPlatform).mockReturnValue(true);
    vi.mocked(openAuthSession).mockRejectedValue(new AuthSessionCancelledError());

    render(<OidcButton label="Sign in with Companion account" />);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in with Companion account' }));

    await waitFor(() => expect(openAuthSession).toHaveBeenCalled());
    expect(screen.queryByText(/Could not open your browser to sign in/)).not.toBeInTheDocument();
  });

  it('desktop (Tauri): opens the OIDC route in the system browser as an ABSOLUTE url', async () => {
    // isNativePlatform stays false here — Tauri is a distinct native shell (see
    // isTauriPlatform's doc comment), so this exercises the OR condition
    // specifically rather than just re-testing the Capacitor branch under a
    // different mock.
    //
    // Unlike Capacitor, nothing calls setApiBaseUrl() on Tauri boot, so
    // buildApiUrl() would stay relative — which open_external_url_command
    // rejects outright. The Tauri branch resolves against window.location.origin
    // instead, so this must assert an absolute URL, not the bare relative path.
    vi.mocked(isTauriPlatform).mockReturnValue(true);

    render(<OidcButton label="Sign in with Companion account" />);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in with Companion account' }));

    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledTimes(1));
    const opened = vi.mocked(openExternalUrl).mock.calls[0][0];
    expect(opened.startsWith(`${window.location.origin}/api/authenticate/oidc?client=native&`)).toBe(true);
    expect(new URL(opened).searchParams.get('app_state')).toBe(pendingSignIn().state);
  });

  it('carries a post-login redirect through both paths', async () => {
    // Web href includes the (encoded) redirect.
    render(<OidcButton label="Sign in" redirect="/shared/abc" />);
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      '/api/authenticate/oidc?redirect=%2Fshared%2Fabc',
    );

    // Android still carries both the redirect and the client flag through the system browser.
    vi.mocked(isNativePlatform).mockReturnValue(true);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in' }));

    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledTimes(1));
    const opened = vi.mocked(openExternalUrl).mock.calls[0][0];
    expect(opened).toContain('redirect=%2Fshared%2Fabc');
    expect(opened).toContain('client=native');
  });

  it('tells the user when the browser could not be opened, instead of looking like a dead button', async () => {
    // The exact shape of the bug this covers: on desktop the opener call was
    // denied by the ACL, the rejection was only console.error'd, and the button
    // appeared to do nothing at all.
    vi.mocked(isTauriPlatform).mockReturnValue(true);
    vi.mocked(openExternalUrl).mockRejectedValue(new Error('opener.open_url not allowed'));

    render(<OidcButton label="Sign in with Companion account" />);
    fireEvent.click(screen.getByText('Sign in with Companion account'));

    await waitFor(() => {
      expect(screen.getByText(/Could not open your browser to sign in/)).toBeInTheDocument();
    });
  });
});

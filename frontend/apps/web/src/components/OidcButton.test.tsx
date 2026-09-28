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
});

describe('OidcButton', () => {
  it('web: renders an anchor to the OIDC route and does not open a system browser', () => {
    render(<OidcButton label="Sign in with CI Portal" />);

    const link = screen.getByRole('link', { name: 'Sign in with CI Portal' });
    expect(link.getAttribute('href')).toBe('/api/authenticate/oidc');

    fireEvent.click(link);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('native: opens the OIDC route in the system browser with ?client=native', () => {
    vi.mocked(isNativePlatform).mockReturnValue(true);

    render(<OidcButton label="Sign in with Companion account" />);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in with Companion account' }));

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith('/api/authenticate/oidc?client=native');
    expect(openAuthSession).not.toHaveBeenCalled();
  });

  it('iOS: opens the OIDC route in the in-app sheet, not Safari', () => {
    vi.mocked(isNativePlatform).mockReturnValue(true);
    vi.mocked(isIosPlatform).mockReturnValue(true);

    render(<OidcButton label="Sign in with Companion account" />);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in with Companion account' }));

    expect(openAuthSession).toHaveBeenCalledTimes(1);
    expect(openAuthSession).toHaveBeenCalledWith('/api/authenticate/oidc?client=native');
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

  it('desktop (Tauri): opens the OIDC route in the system browser as an ABSOLUTE url', () => {
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

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith(
      `${window.location.origin}/api/authenticate/oidc?client=native`,
    );
  });

  it('carries a post-login redirect through both paths', () => {
    // Web href includes the (encoded) redirect.
    render(<OidcButton label="Sign in" redirect="/shared/abc" />);
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      '/api/authenticate/oidc?redirect=%2Fshared%2Fabc',
    );

    // Android still carries both the redirect and the client flag through the system browser.
    vi.mocked(isNativePlatform).mockReturnValue(true);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in' }));

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

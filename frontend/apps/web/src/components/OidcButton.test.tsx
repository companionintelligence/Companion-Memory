import { isNativePlatform, isTauriPlatform, openExternalUrl } from '@ci/common';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OidcButton } from './OidcButton';

// Keep the real helpers (buildApiUrl resolves to same-origin paths on web) but control
// the platform checks and stub the native "open the system browser" bridge.
vi.mock('@ci/common', async (orig) => ({
  ...(await orig<typeof import('@ci/common')>()),
  isNativePlatform: vi.fn(() => false),
  isTauriPlatform: vi.fn(() => false),
  openExternalUrl: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(isNativePlatform).mockReturnValue(false);
  vi.mocked(isTauriPlatform).mockReturnValue(false);
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

    // Native carries both the redirect and the client flag.
    vi.mocked(isNativePlatform).mockReturnValue(true);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in' }));

    const opened = vi.mocked(openExternalUrl).mock.calls[0][0];
    expect(opened).toContain('redirect=%2Fshared%2Fabc');
    expect(opened).toContain('client=native');
  });
});

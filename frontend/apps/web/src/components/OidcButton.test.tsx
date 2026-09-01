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

  it('desktop (Tauri): also opens the OIDC route in the system browser with ?client=native, same as Capacitor native', () => {
    // isNativePlatform stays false here — Tauri is a distinct native shell (see
    // isTauriPlatform's doc comment), so this exercises the OR condition
    // specifically rather than just re-testing the Capacitor branch under a
    // different mock.
    vi.mocked(isTauriPlatform).mockReturnValue(true);

    render(<OidcButton label="Sign in with Companion account" />);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in with Companion account' }));

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith('/api/authenticate/oidc?client=native');
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

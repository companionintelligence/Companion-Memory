import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceConnectPage } from './DeviceConnectPage';

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

const h = vi.hoisted(() => ({
  ios: false,
  persistApiBaseUrl: vi.fn(),
  getApiBaseUrl: vi.fn(() => ''),
  signInToPortal: vi.fn(),
  listMemoryServers: vi.fn(),
  probePortalOrigin: vi.fn(async (): Promise<void> => {}),
  loginWithPortalOidc: vi.fn(),
  resumePendingOidcLogin: vi.fn(
    async (): Promise<{
      accessToken: string;
      idToken: string | null;
      tokenType: string;
      expiresIn: number;
    } | null> => null,
  ),
  completePortalMemoryConnect: vi.fn(async () => false),
  completeMemoryPasswordConnect: vi.fn(async () => false),
  authenticated: false,
  profileUser: undefined as { id: string; onboarded: boolean } | null | undefined,
  profileError: null as Error | null,
}));

// Spread the real module rather than allow-listing exports: this page also reaches
// `@ci/common` *transitively* — the real `probeMemoryOrigin` in ./portal-client calls
// `apiFetch` — so an allow-list mock silently blanks whatever the next import adds.
// Only `persistApiBaseUrl` is stubbed, because the tests assert on it and it must not
// write the origin to localStorage.
vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  persistApiBaseUrl: h.persistApiBaseUrl,
  getApiBaseUrl: () => h.getApiBaseUrl(),
  isIosPlatform: () => h.ios,
}));

vi.mock('@/components/ThemePicker', () => ({
  ThemeToggle: () => null,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [
    { authenticated: h.authenticated, initializing: false },
    {
      completePortalMemoryConnect: h.completePortalMemoryConnect,
      completeMemoryPasswordConnect: h.completeMemoryPasswordConnect,
    },
  ],
  useCurrentUser: () => ({
    user:
      h.profileUser !== undefined ? h.profileUser : h.authenticated ? { id: 'u1', onboarded: true } : null,
    loading: false,
    error: h.profileError,
    refetch: vi.fn(async () => ({})),
  }),
}));

vi.mock('./portal-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./portal-client')>();

  return {
    ...actual,
    signInToPortal: h.signInToPortal,
    listMemoryServers: h.listMemoryServers,
    // Answers by default, so the sign-in tests never reach for the network; the
    // unreachable-host tests below make it reject.
    probePortalOrigin: h.probePortalOrigin,
  };
});

vi.mock('./oidc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./oidc')>();

  return {
    ...actual,
    loginWithPortalOidc: h.loginWithPortalOidc,
    resumePendingOidcLogin: h.resumePendingOidcLogin,
  };
});

beforeEach(() => {
  // The splash mark lazily imports a 1.9 MB Lottie animation unless reduced
  // motion is on, and `lottie-web` throws when it evaluates under jsdom (no
  // canvas context). That surfaced as an unhandled error landing on whichever
  // test happened to be running; the static SVG is the deterministic path — the
  // same stub DesktopSignInPage.test.tsx uses for the same reason.
  window.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;

  h.ios = false;
  navigate.mockReset();
  h.persistApiBaseUrl.mockReset();
  h.getApiBaseUrl.mockReset();
  h.getApiBaseUrl.mockReturnValue('');
  h.signInToPortal.mockReset();
  h.listMemoryServers.mockReset();
  h.probePortalOrigin.mockReset();
  h.probePortalOrigin.mockResolvedValue(undefined);
  h.loginWithPortalOidc.mockReset();
  h.resumePendingOidcLogin.mockReset();
  h.resumePendingOidcLogin.mockResolvedValue(null);
  h.completePortalMemoryConnect.mockReset();
  h.completePortalMemoryConnect.mockResolvedValue(false);
  h.completeMemoryPasswordConnect.mockReset();
  h.completeMemoryPasswordConnect.mockResolvedValue(false);
  h.authenticated = false;
  h.profileUser = undefined;
  h.profileError = null;
  sessionStorage.clear();
  localStorage.removeItem('ci.deviceConnect.portalUrl');
});

describe('DeviceConnectPage', () => {
  it('opens on the splash with Log in and an Advanced link', () => {
    render(<DeviceConnectPage />);

    expect(screen.getByText('Companion Memory')).toBeInTheDocument();
    expect(screen.getByTestId('oidc-login-btn')).toHaveTextContent(/log in/i);
    expect(screen.getByTestId('advanced-link')).toBeInTheDocument();
    expect(screen.queryByText(/or use email/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('you@example.com')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /enter a memory server url instead/i }),
    ).not.toBeInTheDocument();
  });

  it('names Safari on iOS and stays browser-neutral everywhere else while OIDC is pending', async () => {
    // Never resolves: the page keeps the abort controller, so the pending hint stays up.
    h.loginWithPortalOidc.mockReturnValue(new Promise(() => {}));

    const { unmount } = render(<DeviceConnectPage />);

    fireEvent.click(screen.getByTestId('oidc-login-btn'));

    expect(
      await screen.findByText(/Finish signing in in your browser, then return to this app\./),
    ).toBeInTheDocument();
    unmount();

    h.ios = true;
    render(<DeviceConnectPage />);

    fireEvent.click(screen.getByTestId('oidc-login-btn'));

    expect(
      await screen.findByText(/Finish signing in in Safari, then return to this app\./),
    ).toBeInTheDocument();
  });

  it('opens Advanced from the splash', () => {
    render(<DeviceConnectPage />);
    fireEvent.click(screen.getByTestId('advanced-link'));

    expect(navigate).toHaveBeenCalledWith('/device-connect/advanced');
  });

  /**
   * QA AUTH-12: with a wrong Companion URL the sign-in sheet opened on the
   * browser's own error page, and closing it was a silent cancel, so Log in
   * came back with nothing in the app saying what was wrong.
   */
  describe('a Companion URL that does not answer', () => {
    it('says so in the app, names the URL and where to fix it, and never opens the sign-in sheet', async () => {
      localStorage.setItem('ci.deviceConnect.portalUrl', 'http://192.168.0.4:9');
      h.probePortalOrigin.mockRejectedValue(new Error('Load failed'));

      render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));

      const alert = await screen.findByTestId('connect-signin-error');

      expect(alert).toHaveTextContent('http://192.168.0.4:9');
      expect(alert).toHaveTextContent(/Advanced/);
      expect(h.probePortalOrigin).toHaveBeenCalledWith('http://192.168.0.4:9');
      expect(h.loginWithPortalOidc).not.toHaveBeenCalled();
      // Back to a usable Log in, with no "finish signing in in Safari" hint for
      // a sheet that never opened.
      expect(screen.getByTestId('oidc-login-btn')).toBeEnabled();
      expect(screen.queryByText(/Finish signing in/)).not.toBeInTheDocument();
    });

    it('blames the connection, not Advanced, when the default Companion server is the one that is silent', async () => {
      h.probePortalOrigin.mockRejectedValue(new Error('Load failed'));

      render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));

      const alert = await screen.findByTestId('connect-signin-error');

      expect(alert).toHaveTextContent(/check your connection/i);
      expect(alert).not.toHaveTextContent(/Advanced/);
      expect(h.loginWithPortalOidc).not.toHaveBeenCalled();
    });

    it('clears the message and opens the sheet once the next attempt gets an answer', async () => {
      h.probePortalOrigin.mockRejectedValueOnce(new Error('Load failed'));
      h.loginWithPortalOidc.mockReturnValue(new Promise(() => {}));

      render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));
      expect(await screen.findByTestId('connect-signin-error')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('oidc-login-btn'));

      expect(await screen.findByText(/Finish signing in/)).toBeInTheDocument();
      expect(screen.queryByTestId('connect-signin-error')).not.toBeInTheDocument();
      expect(h.loginWithPortalOidc).toHaveBeenCalledTimes(1);
    });
  });

  it('lists Memory Servers after Portal OIDC', async () => {
    h.loginWithPortalOidc.mockResolvedValue({
      accessToken: 'oidc-at',
      idToken: null,
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
    h.listMemoryServers.mockResolvedValue([
      { id: 'home', name: 'Home', status: 'active', memoryUrl: 'https://memory.example.com/app' },
    ]);

    render(<DeviceConnectPage />);
    fireEvent.click(screen.getByTestId('oidc-login-btn'));

    expect(await screen.findByText('Home')).toBeInTheDocument();
    expect(screen.queryByTestId('portal-account')).not.toBeInTheDocument();
    expect(h.listMemoryServers).toHaveBeenCalledWith(
      { token: 'oidc-at', idToken: null, cookie: null, kind: 'oauth' },
      expect.any(String),
    );
  });

  it('shows the Companion account on the Memory picker', async () => {
    const payload = btoa(JSON.stringify({ email: 'demo-1@lifescope.io' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    h.loginWithPortalOidc.mockResolvedValue({
      accessToken: 'oidc-at',
      idToken: `e30.${payload}.sig`,
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
    h.listMemoryServers.mockResolvedValue([]);

    render(<DeviceConnectPage />);
    fireEvent.click(screen.getByTestId('oidc-login-btn'));

    expect(await screen.findByTestId('portal-account')).toHaveTextContent('Signed in as demo-1@lifescope.io');
  });

  it('Back forgets the Portal token so the next Log in is not that account', async () => {
    h.loginWithPortalOidc.mockResolvedValue({
      accessToken: 'oidc-at',
      idToken: null,
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
    h.listMemoryServers.mockResolvedValue([]);

    render(<DeviceConnectPage />);
    fireEvent.click(screen.getByTestId('oidc-login-btn'));
    expect(await screen.findByText('Pick a Memory Server')).toBeInTheDocument();
    expect(sessionStorage.getItem('ci.deviceConnect.portalAuth')).toContain('oidc-at');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(sessionStorage.getItem('ci.deviceConnect.portalAuth')).toBeNull();
    expect(localStorage.getItem('ci.deviceConnect.portalAuth')).toBeNull();
    expect(screen.getByTestId('oidc-login-btn')).toBeInTheDocument();
  });

  it('after Portal OIDC, picking a server mints a Memory key and skips /login', async () => {
    h.loginWithPortalOidc.mockResolvedValue({
      accessToken: 'oidc-at',
      idToken: 'oidc-id',
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
    h.listMemoryServers.mockResolvedValue([
      { id: 'home', name: 'Home', status: 'active', memoryUrl: 'https://memory.example.com/app' },
    ]);
    h.completePortalMemoryConnect.mockImplementation(async () => {
      h.authenticated = true;

      return true;
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    const { rerender } = render(<DeviceConnectPage />);
    fireEvent.click(screen.getByTestId('oidc-login-btn'));
    expect(await screen.findByText('Home')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('memory-row-home'));

    await waitFor(() => {
      expect(h.completePortalMemoryConnect).toHaveBeenCalledWith('oidc-id', 'https://memory.example.com');
    });
    expect(h.persistApiBaseUrl).toHaveBeenCalledWith('https://memory.example.com');
    rerender(<DeviceConnectPage />);
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/', { replace: true });
    });
    expect(navigate).not.toHaveBeenCalledWith('/login', { replace: true });
  });

  it('does not surface a leftover GraphQL error while a mint is still in flight', async () => {
    h.authenticated = true;
    h.profileUser = null;
    h.profileError = new Error(
      'Native HTTP needs an absolute http(s) URL (got "/api/graphql"). Pick a Memory Server again.',
    );
    h.resumePendingOidcLogin.mockResolvedValue({
      accessToken: 'oidc-at',
      idToken: 'oidc-id',
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
    h.listMemoryServers.mockResolvedValue([
      { id: 'home', name: 'Home', status: 'active', memoryUrl: 'https://memory.example.com/app' },
    ]);
    h.completePortalMemoryConnect.mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    render(<DeviceConnectPage />);
    expect(await screen.findByText('Home')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('memory-row-home'));

    expect(await screen.findByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByText(/Native HTTP needs an absolute/i)).not.toBeInTheDocument();
  });

  it('stays on the picker and shows the mint error instead of dumping to /login', async () => {
    h.loginWithPortalOidc.mockResolvedValue({
      accessToken: 'oidc-at',
      idToken: 'oidc-id',
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
    h.listMemoryServers.mockResolvedValue([
      { id: 'home', name: 'Home', status: 'active', memoryUrl: 'https://memory.example.com/app' },
    ]);
    h.completePortalMemoryConnect.mockRejectedValue(new Error('Unauthorized'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    render(<DeviceConnectPage />);
    fireEvent.click(screen.getByTestId('oidc-login-btn'));
    expect(await screen.findByText('Home')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('memory-row-home'));

    expect(await screen.findByText(/did not accept your Companion account/i)).toBeInTheDocument();
    expect(screen.queryByTestId('memory-password-submit')).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalledWith('/login', { replace: true });
    expect(navigate).not.toHaveBeenCalledWith('/', { replace: true });
  });
});

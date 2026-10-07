import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceConnectPage } from './DeviceConnectPage';
import { OidcCancelledError, type OidcTokens, type PairingTarget, PortalInvalidTargetError } from './oidc';

const navigate = vi.fn();

function jwt(payload: Record<string, unknown>): string {
  const json = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `hdr.${json}.sig`;
}

/** A Portal id_token for client `ci-server` that is still live: the one bearer Memory accepts. */
const ID_TOKEN = jwt({ aud: 'ci-server' });

/** The Memory a Portal that addresses tokens lists, with its resource. */
const HOME: PairingTarget = {
  id: 'home',
  name: 'Home',
  status: 'active',
  memoryUrl: 'https://memory.example.com/app',
  resource: 'urn:ci:device:home-device',
};

/** The id_token from the pairing sign-in for HOME: addressed to it and no other Memory. */
const ADDRESSED_ID_TOKEN = jwt({
  aud: ['ci-server', HOME.resource],
  azp: 'ci-server',
  ci_appliance_binding: 1,
});

const FIRST_SIGN_IN: OidcTokens = {
  accessToken: 'oidc-at',
  idToken: ID_TOKEN,
  tokenType: 'Bearer',
  expiresIn: 3600,
};
const PAIRING_SIGN_IN: OidcTokens = {
  accessToken: 'oidc-at-2',
  idToken: ADDRESSED_ID_TOKEN,
  tokenType: 'Bearer',
  expiresIn: 3600,
};

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
  resumePendingOidcLogin: vi.fn(async (): Promise<import('./oidc').ResumedOidcLogin | null> => null),
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
  localStorage.removeItem('ci.deviceConnect.portalAuth');
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
      idToken: ID_TOKEN,
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
      expect(h.completePortalMemoryConnect).toHaveBeenCalledWith(ID_TOKEN, 'https://memory.example.com');
    });
    // An older Portal lists no resource: the first sign-in's id_token is sent, with no second sign-in.
    expect(h.loginWithPortalOidc).toHaveBeenCalledTimes(1);
    expect(h.persistApiBaseUrl).toHaveBeenCalledWith('https://memory.example.com');
    rerender(<DeviceConnectPage />);
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/', { replace: true });
    });
    expect(navigate).not.toHaveBeenCalledWith('/login', { replace: true });
  });

  describe('a Memory the Portal can address a sign-in to', () => {
    /** Log in, then wait for the picker to list HOME. */
    async function signInAndList() {
      h.loginWithPortalOidc.mockResolvedValueOnce(FIRST_SIGN_IN);
      h.listMemoryServers.mockResolvedValue([HOME]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

      const view = render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));
      expect(await screen.findByText('Home')).toBeInTheDocument();

      return view;
    }

    it('signs in again for that Memory and sends only the id_token addressed to it', async () => {
      h.completePortalMemoryConnect.mockResolvedValue(true);
      await signInAndList();
      h.loginWithPortalOidc.mockResolvedValueOnce(PAIRING_SIGN_IN);

      fireEvent.click(screen.getByTestId('memory-row-home'));

      await waitFor(() => {
        expect(h.completePortalMemoryConnect).toHaveBeenCalledWith(
          ADDRESSED_ID_TOKEN,
          'https://memory.example.com',
        );
      });
      expect(h.loginWithPortalOidc).toHaveBeenCalledTimes(2);
      // The first sign-in asks for nothing; the second names the Memory that was picked.
      expect(h.loginWithPortalOidc.mock.calls[0]?.[1]).not.toHaveProperty('pairWith');
      expect(h.loginWithPortalOidc).toHaveBeenLastCalledWith(expect.any(String), {
        signal: expect.any(AbortSignal),
        pairWith: HOME,
      });
      // The addressed token is the only thing the picked server receives.
      expect(h.completePortalMemoryConnect).toHaveBeenCalledTimes(1);
      expect(h.persistApiBaseUrl).toHaveBeenCalledWith('https://memory.example.com');
    });

    it('sends nothing when the Portal did not address the id_token to that Memory', async () => {
      await signInAndList();
      // A Portal that ignored `resource` hands back the unaddressed kind.
      h.loginWithPortalOidc.mockResolvedValueOnce(FIRST_SIGN_IN);

      fireEvent.click(screen.getByTestId('memory-row-home'));

      expect(
        await screen.findByText('The Companion server did not return a sign-in for this Memory Server.'),
      ).toBeInTheDocument();
      expect(h.completePortalMemoryConnect).not.toHaveBeenCalled();
    });

    it('says so plainly when the Portal answers invalid_target', async () => {
      await signInAndList();
      h.loginWithPortalOidc.mockRejectedValueOnce(new PortalInvalidTargetError());

      fireEvent.click(screen.getByTestId('memory-row-home'));

      expect((await screen.findByTestId('connect-signin-error')).textContent).toBe(
        "This Memory Server isn't one your Companion account can connect to.",
      );
      expect(h.completePortalMemoryConnect).not.toHaveBeenCalled();
      expect(screen.getByTestId('memory-row-home')).toBeEnabled();
    });

    it('stays on the list without an error when the sign-in sheet is closed', async () => {
      await signInAndList();
      h.loginWithPortalOidc.mockRejectedValueOnce(new OidcCancelledError());

      fireEvent.click(screen.getByTestId('memory-row-home'));

      await waitFor(() => expect(screen.getByTestId('memory-row-home')).toBeEnabled());
      expect(screen.queryByTestId('connect-signin-error')).not.toBeInTheDocument();
      expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
      expect(h.completePortalMemoryConnect).not.toHaveBeenCalled();
    });

    it('offers Cancel while the second sign-in is open, and Cancel goes back to the list', async () => {
      await signInAndList();
      h.loginWithPortalOidc.mockImplementationOnce(
        (_portal: string, options: { signal: AbortSignal }) =>
          new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => reject(new OidcCancelledError()));
          }),
      );

      fireEvent.click(screen.getByTestId('memory-row-home'));
      expect(await screen.findByText(/Finish signing in in your browser/)).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('cancel-oidc-btn'));

      await waitFor(() => expect(screen.getByTestId('memory-row-home')).toBeEnabled());
      expect(screen.queryByText(/Finish signing in/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('connect-signin-error')).not.toBeInTheDocument();
      expect(h.completePortalMemoryConnect).not.toHaveBeenCalled();
    });

    it('finishes pairing with the picked Memory when iOS relaunches the app from the second sign-in', async () => {
      localStorage.setItem(
        'ci.deviceConnect.portalAuth',
        JSON.stringify({ token: 'oidc-at', idToken: ID_TOKEN, cookie: null, kind: 'oauth' }),
      );
      h.resumePendingOidcLogin.mockResolvedValueOnce({ tokens: PAIRING_SIGN_IN, pairWith: HOME });
      h.completePortalMemoryConnect.mockImplementation(() => new Promise(() => {}));
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

      render(<DeviceConnectPage />);

      await waitFor(() => {
        expect(h.completePortalMemoryConnect).toHaveBeenCalledWith(
          ADDRESSED_ID_TOKEN,
          'https://memory.example.com',
        );
      });
      // Straight to that Memory: no list to pick from again, and no third sign-in.
      expect(screen.getByText('Connecting…')).toBeInTheDocument();
      expect(h.listMemoryServers).not.toHaveBeenCalled();
      expect(h.loginWithPortalOidc).not.toHaveBeenCalled();
      expect(h.completePortalMemoryConnect).toHaveBeenCalledTimes(1);
    });

    it('pairs once when a warm return resumes the same sign-in that is still running', async () => {
      h.completePortalMemoryConnect.mockResolvedValue(true);
      await signInAndList();
      let finishSignIn: (tokens: OidcTokens) => void = () => {};

      h.loginWithPortalOidc.mockImplementationOnce(
        () =>
          new Promise<OidcTokens>((resolve) => {
            finishSignIn = resolve;
          }),
      );

      fireEvent.click(screen.getByTestId('memory-row-home'));
      await waitFor(() => expect(h.loginWithPortalOidc).toHaveBeenCalledTimes(2));

      // The app comes back to the foreground and the resume exchanges the same callback.
      h.resumePendingOidcLogin.mockResolvedValueOnce({ tokens: PAIRING_SIGN_IN, pairWith: HOME });
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(h.resumePendingOidcLogin).toHaveBeenCalledTimes(2));
      finishSignIn(PAIRING_SIGN_IN);

      await waitFor(() => expect(h.completePortalMemoryConnect).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.completePortalMemoryConnect).toHaveBeenCalledTimes(1);
    });
  });

  it('never sends the Portal access token to a Memory, even with no id_token to send', async () => {
    h.loginWithPortalOidc.mockResolvedValue({
      accessToken: 'oidc-at',
      idToken: null,
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
    h.listMemoryServers.mockResolvedValue([
      { id: 'home', name: 'Home', status: 'active', memoryUrl: 'https://memory.example.com/app' },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));

    render(<DeviceConnectPage />);
    fireEvent.click(screen.getByTestId('oidc-login-btn'));
    expect(await screen.findByText('Home')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('memory-row-home'));

    expect(await screen.findByText(/Sign in with your Companion account first/)).toBeInTheDocument();
    expect(h.completePortalMemoryConnect).not.toHaveBeenCalled();
  });

  it('does not surface a leftover GraphQL error while a mint is still in flight', async () => {
    h.authenticated = true;
    h.profileUser = null;
    h.profileError = new Error(
      'Native HTTP needs an absolute http(s) URL (got "/api/graphql"). Pick a Memory Server again.',
    );
    h.resumePendingOidcLogin.mockResolvedValue({ tokens: FIRST_SIGN_IN, pairWith: null });
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
      idToken: ID_TOKEN,
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

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceConnectPage } from './DeviceConnectPage';
import {
  OidcCancelledError,
  type OidcTokens,
  type PairingTarget,
  PortalInvalidTargetError,
  type PortalSignIn,
} from './oidc';
import { type MemoryServerDevice, PortalSignInExpiredError } from './portal-client';

const navigate = vi.fn();

function jwt(payload: Record<string, unknown>): string {
  const json = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `hdr.${json}.sig`;
}

/** A Portal id_token for client `ci-server` that is still live: what an older Portal's sign-in gives. */
const ID_TOKEN = jwt({ aud: 'ci-server' });

/** The Memory a Portal that addresses tokens lists, with its resource. */
const HOME: PairingTarget = {
  id: 'home',
  name: 'Home',
  status: 'active',
  memoryUrl: 'https://memory.example.com/app',
  resource: 'urn:ci:device:home-device',
};

/** The same Memory as an older Portal lists it: no resource. */
const HOME_UNADDRESSABLE: MemoryServerDevice = {
  id: 'home',
  name: 'Home',
  status: 'active',
  memoryUrl: 'https://memory.example.com/app',
};

/** The id_token the pick's exchange returns for HOME: addressed to it and no other Memory. */
const ADDRESSED_ID_TOKEN = jwt({
  aud: ['ci-server', HOME.resource],
  azp: 'ci-server',
  ci_appliance_binding: 1,
});

/** The one sign-in, its code not spent yet. */
const HELD: PortalSignIn = {
  portal: 'https://hub.ci.computer',
  code: 'auth-code-1',
  verifier: 'v'.repeat(43),
};

/** What an older Portal's sign-in is exchanged for straight away. */
const OLDER_PORTAL_TOKENS: OidcTokens = {
  accessToken: 'oidc-at',
  idToken: ID_TOKEN,
  tokenType: 'Bearer',
  expiresIn: 3600,
};
/** What spending the code on HOME returns. */
const PICK_TOKENS: OidcTokens = {
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
  listMemoryServersByCode: vi.fn(),
  probePortalOrigin: vi.fn(async (): Promise<void> => {}),
  signInWithPortalOidc: vi.fn(),
  exchangePortalSignIn: vi.fn(),
  forgetPortalSignIn: vi.fn(async (): Promise<void> => {}),
  dropPendingPick: vi.fn(),
  resumePendingOidcLogin: vi.fn(async (): Promise<import('./oidc').ResumedOidcLogin | null> => null),
  completePortalMemoryConnect: vi.fn(async () => false),
  completeMemoryPasswordConnect: vi.fn(async () => false),
  authenticated: false,
  profileUser: undefined as { id: string; onboarded: boolean } | null | undefined,
  profileError: null as Error | null,
  profileLoading: false,
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
    loading: h.profileLoading,
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
    listMemoryServersByCode: h.listMemoryServersByCode,
    // Answers by default, so the sign-in tests never reach for the network; the
    // unreachable-host tests below make it reject.
    probePortalOrigin: h.probePortalOrigin,
  };
});

vi.mock('./oidc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./oidc')>();

  return {
    ...actual,
    signInWithPortalOidc: h.signInWithPortalOidc,
    exchangePortalSignIn: h.exchangePortalSignIn,
    forgetPortalSignIn: h.forgetPortalSignIn,
    dropPendingPick: h.dropPendingPick,
    resumePendingOidcLogin: h.resumePendingOidcLogin,
  };
});

beforeEach(() => {
  // jsdom has no `matchMedia`, and `Reveal` reads it to decide whether to
  // stagger the copy. Reduced motion is the deterministic path: no entrance
  // animation classes, nothing timing-dependent — the same stub
  // DesktopSignInPage.test.tsx uses for the same reason.
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
  h.listMemoryServersByCode.mockReset();
  h.probePortalOrigin.mockReset();
  h.probePortalOrigin.mockResolvedValue(undefined);
  h.signInWithPortalOidc.mockReset();
  h.exchangePortalSignIn.mockReset();
  h.forgetPortalSignIn.mockReset();
  h.forgetPortalSignIn.mockResolvedValue(undefined);
  h.dropPendingPick.mockReset();
  h.resumePendingOidcLogin.mockReset();
  h.resumePendingOidcLogin.mockResolvedValue(null);
  h.completePortalMemoryConnect.mockReset();
  h.completePortalMemoryConnect.mockResolvedValue(false);
  h.completeMemoryPasswordConnect.mockReset();
  h.completeMemoryPasswordConnect.mockResolvedValue(false);
  h.authenticated = false;
  h.profileUser = undefined;
  h.profileError = null;
  h.profileLoading = false;
  sessionStorage.clear();
  localStorage.removeItem('ci.deviceConnect.portalUrl');
  localStorage.removeItem('ci.deviceConnect.portalAuth');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
});

/** An older Portal: no by-code route, so the code is exchanged at once and listed with the access token. */
function olderPortal(tokens: OidcTokens, servers: MemoryServerDevice[]) {
  h.signInWithPortalOidc.mockResolvedValue(HELD);
  h.listMemoryServersByCode.mockResolvedValue(null);
  h.exchangePortalSignIn.mockResolvedValue(tokens);
  h.listMemoryServers.mockResolvedValue(servers);
}

/** Tap the Home row once it takes taps: rows are disabled while a list is in flight. */
async function tapHome() {
  await waitFor(() => expect(screen.getByTestId('memory-row-home')).toBeEnabled());
  fireEvent.click(screen.getByTestId('memory-row-home'));
}

/** A Portal that lists by code: the code stays unspent until the pick. */
function portalListingByCode(servers: MemoryServerDevice[] = [HOME]) {
  h.signInWithPortalOidc.mockResolvedValue(HELD);
  h.listMemoryServersByCode.mockResolvedValue(servers);
}

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
    h.signInWithPortalOidc.mockReturnValue(new Promise(() => {}));

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
      expect(h.signInWithPortalOidc).not.toHaveBeenCalled();
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
      expect(h.signInWithPortalOidc).not.toHaveBeenCalled();
    });

    it('clears the message and opens the sheet once the next attempt gets an answer', async () => {
      h.probePortalOrigin.mockRejectedValueOnce(new Error('Load failed'));
      h.signInWithPortalOidc.mockReturnValue(new Promise(() => {}));

      render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));
      expect(await screen.findByTestId('connect-signin-error')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('oidc-login-btn'));

      expect(await screen.findByText(/Finish signing in/)).toBeInTheDocument();
      expect(screen.queryByTestId('connect-signin-error')).not.toBeInTheDocument();
      expect(h.signInWithPortalOidc).toHaveBeenCalledTimes(1);
    });
  });

  describe('an older Portal, which cannot list by code', () => {
    it('exchanges the code at once and lists with the access token, as before', async () => {
      olderPortal({ ...OLDER_PORTAL_TOKENS, idToken: null }, [HOME_UNADDRESSABLE]);

      render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));

      expect(await screen.findByText('Home')).toBeInTheDocument();
      expect(screen.queryByTestId('portal-account')).not.toBeInTheDocument();
      expect(h.listMemoryServersByCode).toHaveBeenCalledWith(HELD, expect.any(String));
      // No resource on an older Portal: the exchange names no Memory.
      expect(h.exchangePortalSignIn).toHaveBeenCalledWith(HELD);
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
      olderPortal({ ...OLDER_PORTAL_TOKENS, idToken: `e30.${payload}.sig` }, []);

      render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));

      expect(await screen.findByTestId('portal-account')).toHaveTextContent(
        'Signed in as demo-1@lifescope.io',
      );
    });

    it('Back forgets the Portal token so the next Log in is not that account', async () => {
      olderPortal({ ...OLDER_PORTAL_TOKENS, idToken: null }, []);

      render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));
      expect(await screen.findByText('Pick a Memory Server')).toBeInTheDocument();
      expect(sessionStorage.getItem('ci.deviceConnect.portalAuth')).toContain('oidc-at');

      fireEvent.click(screen.getByRole('button', { name: 'Back' }));

      expect(sessionStorage.getItem('ci.deviceConnect.portalAuth')).toBeNull();
      expect(localStorage.getItem('ci.deviceConnect.portalAuth')).toBeNull();
      expect(screen.getByTestId('oidc-login-btn')).toBeInTheDocument();
    });

    it('picking a server sends the id_token, mints a Memory key and skips /login', async () => {
      olderPortal(OLDER_PORTAL_TOKENS, [HOME_UNADDRESSABLE]);
      h.completePortalMemoryConnect.mockImplementation(async () => {
        h.authenticated = true;

        return true;
      });

      const { rerender } = render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));
      expect(await screen.findByText('Home')).toBeInTheDocument();
      await tapHome();

      await waitFor(() => {
        expect(h.completePortalMemoryConnect).toHaveBeenCalledWith(ID_TOKEN, 'https://memory.example.com');
      });
      // One sign-in, exchanged once, at sign-in.
      expect(h.signInWithPortalOidc).toHaveBeenCalledTimes(1);
      expect(h.exchangePortalSignIn).toHaveBeenCalledTimes(1);
      expect(h.persistApiBaseUrl).toHaveBeenCalledWith('https://memory.example.com');
      rerender(<DeviceConnectPage />);
      await waitFor(() => {
        expect(navigate).toHaveBeenCalledWith('/', { replace: true });
      });
      expect(navigate).not.toHaveBeenCalledWith('/login', { replace: true });
    });

    it('never sends the Portal access token to a Memory, even with no id_token to send', async () => {
      olderPortal({ ...OLDER_PORTAL_TOKENS, idToken: null }, [HOME_UNADDRESSABLE]);

      render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));
      expect(await screen.findByText('Home')).toBeInTheDocument();
      await tapHome();

      expect(await screen.findByText(/Sign in with your Companion account first/)).toBeInTheDocument();
      expect(h.completePortalMemoryConnect).not.toHaveBeenCalled();
    });

    it('stays on the picker and shows the mint error instead of dumping to /login', async () => {
      olderPortal(OLDER_PORTAL_TOKENS, [HOME_UNADDRESSABLE]);
      h.completePortalMemoryConnect.mockRejectedValue(new Error('Unauthorized'));

      render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));
      expect(await screen.findByText('Home')).toBeInTheDocument();
      await tapHome();

      expect(await screen.findByText(/did not accept your Companion account/i)).toBeInTheDocument();
      expect(screen.getByTestId('memory-row-home')).toBeInTheDocument();
      expect(screen.queryByTestId('memory-password-submit')).not.toBeInTheDocument();
      expect(navigate).not.toHaveBeenCalledWith('/login', { replace: true });
      expect(navigate).not.toHaveBeenCalledWith('/', { replace: true });
    });

    it('keeps the tokens when the page goes away while the resume is exchanging the code', async () => {
      let finishExchange: (tokens: OidcTokens) => void = () => {};

      h.resumePendingOidcLogin.mockResolvedValueOnce({ signIn: HELD, pick: null });
      h.listMemoryServersByCode.mockResolvedValue(null);
      h.exchangePortalSignIn.mockReturnValueOnce(
        new Promise((resolve) => {
          finishExchange = resolve;
        }),
      );

      const { unmount } = render(<DeviceConnectPage />);
      await waitFor(() => expect(h.exchangePortalSignIn).toHaveBeenCalledWith(HELD));
      unmount();
      finishExchange(OLDER_PORTAL_TOKENS);

      // The code is spent: without the tokens the next mount would need a new sign-in.
      await waitFor(() => expect(localStorage.getItem('ci.deviceConnect.portalAuth')).toContain('oidc-at'));
      expect(h.listMemoryServers).not.toHaveBeenCalled();
    });

    it('resumes an older Portal sign-in after a relaunch by exchanging it, as before', async () => {
      // Listed at the Portal that issued the sign-in, whatever the Companion URL says now.
      localStorage.setItem('ci.deviceConnect.portalUrl', 'https://other.example.com');
      h.resumePendingOidcLogin.mockResolvedValueOnce({ signIn: HELD, pick: null });
      h.listMemoryServersByCode.mockResolvedValue(null);
      h.exchangePortalSignIn.mockResolvedValue(OLDER_PORTAL_TOKENS);
      h.listMemoryServers.mockResolvedValue([HOME_UNADDRESSABLE]);

      render(<DeviceConnectPage />);

      expect(await screen.findByText('Home')).toBeInTheDocument();
      expect(h.exchangePortalSignIn).toHaveBeenCalledWith(HELD);
      expect(h.listMemoryServers).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'oidc-at' }),
        HELD.portal,
      );
      expect(h.signInWithPortalOidc).not.toHaveBeenCalled();
    });
  });

  describe('a Portal that lists by code: one sign-in, spent on the pick', () => {
    async function signInAndList() {
      portalListingByCode();

      const view = render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));
      expect(await screen.findByText('Home')).toBeInTheDocument();

      return view;
    }

    it('a closed sign-in sheet stays quiet and lists nothing', async () => {
      h.signInWithPortalOidc.mockRejectedValueOnce(new OidcCancelledError());

      render(<DeviceConnectPage />);
      fireEvent.click(screen.getByTestId('oidc-login-btn'));

      await waitFor(() => expect(screen.getByTestId('oidc-login-btn')).toBeEnabled());
      expect(screen.queryByTestId('connect-signin-error')).not.toBeInTheDocument();
      expect(h.listMemoryServersByCode).not.toHaveBeenCalled();
    });

    it('lists with the unspent code and keeps no Portal token', async () => {
      await signInAndList();

      expect(h.listMemoryServersByCode).toHaveBeenCalledWith(HELD, expect.any(String));
      expect(h.exchangePortalSignIn).not.toHaveBeenCalled();
      expect(h.listMemoryServers).not.toHaveBeenCalled();
      expect(sessionStorage.getItem('ci.deviceConnect.portalAuth')).toBeNull();
      expect(localStorage.getItem('ci.deviceConnect.portalAuth')).toBeNull();
    });

    it('spends the code on the picked Memory and sends only the id_token addressed to it', async () => {
      h.completePortalMemoryConnect.mockResolvedValue(true);
      await signInAndList();
      h.exchangePortalSignIn.mockResolvedValueOnce(PICK_TOKENS);

      await tapHome();

      await waitFor(() => {
        expect(h.completePortalMemoryConnect).toHaveBeenCalledWith(
          ADDRESSED_ID_TOKEN,
          'https://memory.example.com',
        );
      });
      expect(h.exchangePortalSignIn).toHaveBeenCalledTimes(1);
      expect(h.exchangePortalSignIn).toHaveBeenCalledWith(HELD, HOME);
      // One sign-in in all, and the addressed token is the only thing the picked server receives.
      expect(h.signInWithPortalOidc).toHaveBeenCalledTimes(1);
      expect(h.completePortalMemoryConnect).toHaveBeenCalledTimes(1);
      expect(h.persistApiBaseUrl).toHaveBeenCalledWith('https://memory.example.com');
    });

    it('sends nothing when the id_token is not addressed to the picked Memory, and asks for a new sign-in', async () => {
      await signInAndList();
      // The kind a Portal hands out when it did not address the token.
      h.exchangePortalSignIn.mockResolvedValueOnce(OLDER_PORTAL_TOKENS);

      await tapHome();

      expect((await screen.findByTestId('connect-signin-error')).textContent).toBe(
        'The Companion server did not return a sign-in for this Memory Server.',
      );
      expect(screen.getByTestId('oidc-login-btn')).toBeInTheDocument();
      expect(h.completePortalMemoryConnect).not.toHaveBeenCalled();
    });

    it('says so plainly on invalid_target, and the same sign-in can still pick another Memory', async () => {
      await signInAndList();
      h.exchangePortalSignIn.mockRejectedValueOnce(new PortalInvalidTargetError());

      await tapHome();

      expect((await screen.findByTestId('connect-signin-error')).textContent).toBe(
        "This Memory Server isn't one your Companion account can connect to.",
      );
      expect(screen.getByTestId('memory-row-home')).toBeEnabled();
      expect(h.completePortalMemoryConnect).not.toHaveBeenCalled();

      h.exchangePortalSignIn.mockResolvedValueOnce(PICK_TOKENS);
      await tapHome();

      await waitFor(() => expect(h.exchangePortalSignIn).toHaveBeenCalledTimes(2));
      expect(h.exchangePortalSignIn).toHaveBeenLastCalledWith(HELD, HOME);
    });

    it('goes back to Log in when the sign-in expired before the pick', async () => {
      await signInAndList();
      h.exchangePortalSignIn.mockRejectedValueOnce(new PortalSignInExpiredError());

      await tapHome();

      expect((await screen.findByTestId('connect-signin-error')).textContent).toBe(
        'Your Companion sign-in expired. Sign in again.',
      );
      expect(screen.getByTestId('oidc-login-btn')).toBeEnabled();
      expect(h.forgetPortalSignIn).toHaveBeenCalled();
    });

    it("shows the Companion server's own words when the exchange fails there, not a Memory error", async () => {
      await signInAndList();
      h.exchangePortalSignIn.mockRejectedValueOnce(new Error('unauthorized_client'));

      await tapHome();

      expect((await screen.findByTestId('connect-signin-error')).textContent).toBe('unauthorized_client');
      expect(screen.getByTestId('memory-row-home')).toBeEnabled();
      expect(h.completePortalMemoryConnect).not.toHaveBeenCalled();
    });

    it('blames the connection when the Companion server cannot be reached at the pick', async () => {
      await signInAndList();
      h.exchangePortalSignIn.mockRejectedValueOnce(new TypeError('Load failed'));

      await tapHome();

      expect(await screen.findByTestId('connect-signin-error')).toHaveTextContent(
        'Could not reach the Companion server (https://hub.ci.computer). Check your connection and try again.',
      );
      expect(screen.getByTestId('memory-row-home')).toBeEnabled();
    });

    it('goes back to Log in when the Memory refuses after the code was spent', async () => {
      await signInAndList();
      h.exchangePortalSignIn.mockResolvedValueOnce(PICK_TOKENS);
      h.completePortalMemoryConnect.mockRejectedValue(new Error('Unauthorized'));

      await tapHome();

      expect((await screen.findByTestId('connect-signin-error')).textContent).toBe(
        'This Memory Server is online, but it did not accept your Companion account. Sign in again.',
      );
      // The code is spent: this sign-in can open nothing else, so the list is gone too.
      expect(screen.getByTestId('oidc-login-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('memory-row-home')).not.toBeInTheDocument();
    });

    it('keeps the code for another pick when the Memory does not answer', async () => {
      await signInAndList();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

      await tapHome();

      expect(
        await screen.findByText(/Could not reach this Memory Server from the phone/),
      ).toBeInTheDocument();
      expect(h.exchangePortalSignIn).not.toHaveBeenCalled();
      expect(screen.getByTestId('memory-row-home')).toBeEnabled();
    });

    it('Refresh lists again with the same unspent code', async () => {
      await signInAndList();

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      await waitFor(() => expect(h.listMemoryServersByCode).toHaveBeenCalledTimes(2));
      expect(h.listMemoryServersByCode).toHaveBeenLastCalledWith(HELD, expect.any(String));
      expect(h.exchangePortalSignIn).not.toHaveBeenCalled();
    });

    it('Refresh goes back to Log in once the code has expired', async () => {
      await signInAndList();
      h.listMemoryServersByCode.mockRejectedValueOnce(new PortalSignInExpiredError());

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      expect((await screen.findByTestId('connect-signin-error')).textContent).toBe(
        'Your Companion sign-in expired. Sign in again.',
      );
      expect(screen.getByTestId('oidc-login-btn')).toBeInTheDocument();
    });

    it('keeps the Memories untappable while a list is in flight', async () => {
      await signInAndList();
      h.listMemoryServersByCode.mockReturnValueOnce(new Promise(() => {}));

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      await waitFor(() => expect(screen.getByTestId('memory-row-home')).toBeDisabled());
    });

    it('goes back to Log in when a warm return finds the code expired', async () => {
      await signInAndList();
      h.resumePendingOidcLogin.mockResolvedValueOnce({ signIn: HELD, pick: null });
      h.listMemoryServersByCode.mockRejectedValueOnce(new PortalSignInExpiredError());

      document.dispatchEvent(new Event('visibilitychange'));

      expect((await screen.findByTestId('connect-signin-error')).textContent).toBe(
        'Your Companion sign-in expired. Sign in again.',
      );
      expect(screen.getByTestId('oidc-login-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('memory-row-home')).not.toBeInTheDocument();
    });

    it('goes back to Log in when the profile fails after the code was spent', async () => {
      h.completePortalMemoryConnect.mockResolvedValue(true);
      const view = await signInAndList();
      h.exchangePortalSignIn.mockResolvedValueOnce(PICK_TOKENS);

      await tapHome();
      // The key is minted and the origin kept: the page now waits for `me`.
      await waitFor(() => expect(h.persistApiBaseUrl).toHaveBeenCalled());
      expect(screen.getByText('Connecting…')).toBeInTheDocument();

      h.authenticated = true;
      h.profileUser = null;
      h.profileError = new Error('Could not load your profile.');
      view.rerender(<DeviceConnectPage />);

      expect((await screen.findByTestId('connect-signin-error')).textContent).toBe(
        'Could not load your profile.',
      );
      expect(screen.getByTestId('oidc-login-btn')).toBeInTheDocument();
    });

    it('sends the code only to the Portal that issued it, even after the Companion URL changed', async () => {
      // The code with its verifier is enough to redeem it, so it never goes anywhere else.
      localStorage.setItem('ci.deviceConnect.portalUrl', 'https://other.example.com');
      h.resumePendingOidcLogin.mockResolvedValueOnce({ signIn: HELD, pick: null });
      h.listMemoryServersByCode.mockResolvedValue([HOME]);

      render(<DeviceConnectPage />);

      expect(await screen.findByText('Home')).toBeInTheDocument();
      expect(h.listMemoryServersByCode).toHaveBeenCalledWith(HELD, HELD.portal);

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(h.listMemoryServersByCode).toHaveBeenCalledTimes(2));
      expect(h.listMemoryServersByCode).toHaveBeenLastCalledWith(HELD, HELD.portal);

      // And a Portal that can't be reached at the pick is named as the one that issued the code.
      h.exchangePortalSignIn.mockRejectedValueOnce(new TypeError('Load failed'));
      await tapHome();

      const alert = await screen.findByTestId('connect-signin-error');
      expect(alert).toHaveTextContent(HELD.portal);
      expect(alert).not.toHaveTextContent('other.example.com');
    });

    it('Back drops the held sign-in', async () => {
      await signInAndList();

      fireEvent.click(screen.getByRole('button', { name: 'Back' }));

      expect(h.forgetPortalSignIn).toHaveBeenCalled();
      expect(screen.getByTestId('oidc-login-btn')).toBeInTheDocument();
    });

    it('disables Back and Advanced while the pick is pairing', async () => {
      await signInAndList();
      h.exchangePortalSignIn.mockReturnValueOnce(new Promise(() => {}));

      await tapHome();

      expect(await screen.findByText('Connecting…')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
      expect(screen.getByTestId('picker-advanced-btn')).toBeDisabled();
    });

    it('lists by code after an iOS relaunch from the callback, without exchanging', async () => {
      h.resumePendingOidcLogin.mockResolvedValueOnce({ signIn: HELD, pick: null });
      h.listMemoryServersByCode.mockResolvedValue([HOME]);

      render(<DeviceConnectPage />);

      expect(await screen.findByText('Home')).toBeInTheDocument();
      expect(h.listMemoryServersByCode).toHaveBeenCalledWith(HELD, expect.any(String));
      expect(h.exchangePortalSignIn).not.toHaveBeenCalled();
      expect(h.signInWithPortalOidc).not.toHaveBeenCalled();
    });

    it('finishes the pick iOS killed the app in the middle of', async () => {
      h.resumePendingOidcLogin.mockResolvedValueOnce({ signIn: HELD, pick: HOME });
      h.exchangePortalSignIn.mockResolvedValueOnce(PICK_TOKENS);
      h.completePortalMemoryConnect.mockImplementation(() => new Promise(() => {}));

      render(<DeviceConnectPage />);

      await waitFor(() => {
        expect(h.completePortalMemoryConnect).toHaveBeenCalledWith(
          ADDRESSED_ID_TOKEN,
          'https://memory.example.com',
        );
      });
      expect(h.exchangePortalSignIn).toHaveBeenCalledWith(HELD, HOME);
      // Taken out of storage as the pairing starts again: the exchange records it once more.
      expect(h.dropPendingPick).toHaveBeenCalledTimes(1);
      // Straight to that Memory: no list to pick from again, and no new sign-in.
      expect(screen.getByText('Connecting…')).toBeInTheDocument();
      expect(h.listMemoryServersByCode).not.toHaveBeenCalled();
      expect(h.signInWithPortalOidc).not.toHaveBeenCalled();
    });

    it('leaves the pick in storage when the page goes away before acting on it', async () => {
      let finishResume: (resumed: { signIn: PortalSignIn; pick: PairingTarget }) => void = () => {};

      h.resumePendingOidcLogin.mockReturnValueOnce(
        new Promise((resolve) => {
          finishResume = resolve;
        }),
      );

      const { unmount } = render(<DeviceConnectPage />);
      await waitFor(() => expect(h.resumePendingOidcLogin).toHaveBeenCalledTimes(1));
      unmount();
      finishResume({ signIn: HELD, pick: HOME });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The next mount still finds it and finishes the pairing.
      expect(h.dropPendingPick).not.toHaveBeenCalled();
      expect(h.exchangePortalSignIn).not.toHaveBeenCalled();
    });

    it('says the sign-in expired when a relaunch finds a code the Portal no longer takes', async () => {
      h.resumePendingOidcLogin.mockResolvedValueOnce({ signIn: HELD, pick: null });
      h.listMemoryServersByCode.mockRejectedValueOnce(new PortalSignInExpiredError());

      render(<DeviceConnectPage />);

      expect((await screen.findByTestId('connect-signin-error')).textContent).toBe(
        'Your Companion sign-in expired. Sign in again.',
      );
      expect(h.forgetPortalSignIn).toHaveBeenCalled();
    });

    it('pairs once when a warm return resumes the pick that is still being spent', async () => {
      h.completePortalMemoryConnect.mockResolvedValue(true);
      await signInAndList();
      let finishExchange: (tokens: OidcTokens) => void = () => {};

      const exchange = new Promise<OidcTokens>((resolve) => {
        finishExchange = resolve;
      });

      // The same code, so the same answer, however many times it is asked.
      h.exchangePortalSignIn.mockReturnValue(exchange);

      await tapHome();
      await waitFor(() => expect(h.exchangePortalSignIn).toHaveBeenCalledTimes(1));

      // The app comes back to the foreground. A resume would find the sign-in and its pick, and
      // hand the pick over, so it is not run while the pick is being spent.
      h.resumePendingOidcLogin.mockResolvedValueOnce({ signIn: HELD, pick: HOME });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.resumePendingOidcLogin).toHaveBeenCalledTimes(1);
      finishExchange(PICK_TOKENS);

      await waitFor(() => expect(h.completePortalMemoryConnect).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.completePortalMemoryConnect).toHaveBeenCalledTimes(1);
      expect(h.exchangePortalSignIn).toHaveBeenCalledTimes(1);
    });

    it('pairs once when a resume already running finds the pick that has just started', async () => {
      h.completePortalMemoryConnect.mockResolvedValue(true);
      await signInAndList();
      let finishResume: (resumed: { signIn: PortalSignIn; pick: PairingTarget }) => void = () => {};

      h.resumePendingOidcLogin.mockReturnValueOnce(
        new Promise((resolve) => {
          finishResume = resolve;
        }),
      );
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(h.resumePendingOidcLogin).toHaveBeenCalledTimes(2));

      // The pick starts while that resume is still reading storage, and the resume then finds it.
      h.exchangePortalSignIn.mockResolvedValue(PICK_TOKENS);
      await tapHome();
      await waitFor(() => expect(h.exchangePortalSignIn).toHaveBeenCalledTimes(1));
      finishResume({ signIn: HELD, pick: HOME });

      await waitFor(() => expect(h.completePortalMemoryConnect).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.completePortalMemoryConnect).toHaveBeenCalledTimes(1);
      expect(h.exchangePortalSignIn).toHaveBeenCalledTimes(1);
    });

    it('does not surface a leftover GraphQL error while a mint is still in flight', async () => {
      h.authenticated = true;
      h.profileUser = null;
      h.profileError = new Error(
        'Native HTTP needs an absolute http(s) URL (got "/api/graphql"). Pick a Memory Server again.',
      );
      h.resumePendingOidcLogin.mockResolvedValue({ signIn: HELD, pick: null });
      h.listMemoryServersByCode.mockResolvedValue([HOME]);
      h.exchangePortalSignIn.mockResolvedValue(PICK_TOKENS);
      h.completePortalMemoryConnect.mockImplementation(() => new Promise(() => {}));

      render(<DeviceConnectPage />);
      expect(await screen.findByText('Home')).toBeInTheDocument();
      await tapHome();

      expect(await screen.findByText('Connecting…')).toBeInTheDocument();
      expect(screen.queryByText(/Native HTTP needs an absolute/i)).not.toBeInTheDocument();
    });
  });

  // Storing the new key remounts every route (PowerSyncBoundary in App.tsx), so a finished
  // pairing lands on a fresh instance of this page while `me` is still loading.
  describe('mounting with a new key while the profile loads', () => {
    it('shows Finishing sign-in instead of Log in, then goes home once the profile lands', () => {
      h.authenticated = true;
      h.profileUser = null;
      h.profileLoading = true;
      const view = render(<DeviceConnectPage />);

      expect(screen.getByText('Finishing sign-in…')).toBeInTheDocument();
      expect(screen.queryByTestId('oidc-login-btn')).not.toBeInTheDocument();
      expect(navigate).not.toHaveBeenCalled();

      h.profileUser = { id: 'u1', onboarded: true };
      h.profileLoading = false;
      view.rerender(<DeviceConnectPage />);

      expect(navigate).toHaveBeenCalledWith('/', { replace: true });
    });

    it('says why and offers Log in when the profile then fails', async () => {
      h.authenticated = true;
      h.profileUser = null;
      h.profileLoading = true;
      const view = render(<DeviceConnectPage />);

      h.profileLoading = false;
      h.profileError = new Error('Could not load your profile.');
      view.rerender(<DeviceConnectPage />);

      expect((await screen.findByTestId('connect-signin-error')).textContent).toBe(
        'Could not load your profile.',
      );
      expect(screen.getByTestId('oidc-login-btn')).toBeInTheDocument();
      expect(navigate).not.toHaveBeenCalled();
    });

    it('does not report a profile error that was already there before it mounted', () => {
      h.authenticated = true;
      h.profileUser = null;
      h.profileLoading = true;
      h.profileError = new Error('Unauthorized');
      const view = render(<DeviceConnectPage />);

      h.profileLoading = false;
      view.rerender(<DeviceConnectPage />);

      expect(screen.getByTestId('oidc-login-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('connect-signin-error')).not.toBeInTheDocument();
    });
  });
});

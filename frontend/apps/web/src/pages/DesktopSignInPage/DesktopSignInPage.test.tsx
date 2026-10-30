import type { ReactNode } from 'react';

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { DesktopSignInPage } from './DesktopSignInPage';

// What the last browser round-trip came back with. useAuth's deep-link
// listener sets this from `companion://oidc/callback?error=...`; the page only
// reads it, so the hook is the natural seam.
let authError: unknown = null;

vi.mock('@/hooks/useAuth', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => [
    {
      expired: false,
      authToken: null,
      authenticated: false,
      loading: false,
      initializing: false,
      error: authError,
    },
    { login: vi.fn(), logout: vi.fn(), signup: vi.fn() },
  ],
}));

/**
 * Tauri is detected purely from `window.__TAURI_INTERNALS__`, so the desktop
 * shell can be faked by installing that bridge — the same technique
 * `src/test/nativeBridgeTauri.test.ts` uses. Nothing here is mocked out of
 * `@ci/common`: the real `isTauriPlatform` / `openExternalUrl` run, which is the
 * point, because the platform branch inside them is what has never shipped.
 */
type TauriInternals = { invoke: (cmd: string, args?: unknown) => Promise<unknown> };

function installTauriShell(invoke: TauriInternals['invoke']) {
  (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ = { invoke };
}

function renderPage() {
  // `withTheme` because SplashShell renders the ThemeToggle, and `useTheme`
  // throws outside a ThemeProvider.
  return renderWithProviders(<DesktopSignInPage />, { withTheme: true });
}

beforeEach(() => {
  // jsdom has no `matchMedia`, and `Reveal` reads it to decide whether to
  // stagger the copy. Reduced motion is the deterministic path: no entrance
  // animation classes, nothing timing-dependent.
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
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  authError = null;
});

describe('DesktopSignInPage — the first screen of the desktop app', () => {
  it('offers sign-in, not the marketing hero, with an email fallback', () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Sign in to your memory' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in with Companion account' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /email and password/i })).toHaveAttribute('href', '/login');
  });

  it('hides the pairing code until asked, then shows THIS appliance address', () => {
    renderPage();

    expect(screen.queryByText(window.location.origin)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Set up your phone' }));

    // The QR is pairing, not sign-in: it must carry the appliance origin the
    // phone has to reach, never a portal/identity URL. The readable fallback is
    // asserted rather than the SVG, since that is what a user can actually act
    // on when the camera will not focus.
    expect(screen.getByText(window.location.origin)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide phone setup' }));

    expect(screen.queryByText(window.location.origin)).not.toBeInTheDocument();
  });
});

describe('DesktopSignInPage — sign-in leaves the webview', () => {
  it('opens the system browser with an absolute URL and client=native', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);

    installTauriShell(invoke);
    renderPage();

    // `fireEvent.click` returns false when the handler called preventDefault —
    // i.e. the anchor did NOT navigate this webview. That is the whole contract:
    // the desktop shell cannot run an OS-level OAuth redirect inside itself, and
    // the `companion://` deep link only comes back if the system browser owns
    // the round trip.
    const navigated = fireEvent.click(screen.getByRole('link', { name: 'Sign in with Companion account' }));

    expect(navigated).toBe(false);
    // The PKCE pair and state are made before the browser opens, so the open is a beat later.
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));

    const [command, { url }] = invoke.mock.calls[0] as [string, { url: string }];
    expect(command).toBe('open_external_url_command');
    // Absolute on purpose: desktop never calls setApiBaseUrl, so a bare
    // relative path here is rejected outright by open_external_url_command,
    // which only accepts http(s). `?client=native` is what makes the backend
    // answer over the custom scheme instead of setting a browser cookie, and the
    // challenge and state bind the answer to this app.
    expect(url.startsWith(`${window.location.origin}/api/authenticate/oidc?client=native&`)).toBe(true);
    expect(new URL(url).searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(url).searchParams.get('app_state')).toBeTruthy();
  });

  it('says so when the browser could not be opened, instead of looking like a dead button', async () => {
    // A rejected open (no default browser, an ACL denial) used to be
    // console.error only — invisible on the desktop app, leaving the user
    // clicking a button that does nothing.
    installTauriShell(vi.fn().mockRejectedValue(new Error('no default browser')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage();

    fireEvent.click(screen.getByRole('link', { name: 'Sign in with Companion account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open your browser to sign in.');
  });

  it('stays a plain same-origin anchor on the web build (no Tauri bridge present)', () => {
    renderPage();

    const link = screen.getByRole('link', { name: 'Sign in with Companion account' });

    // Same page component, gateway copy of the SPA: the browser navigates to the
    // API itself and gets a session cookie. No `client=native`, and nothing must
    // try to reach a Tauri command that does not exist here. The click must NOT
    // be cancelled — the exact inverse of the desktop case above, and the pair
    // is what pins the platform branch in place. (jsdom logs an unimplemented
    // navigation for the anchor; that log is the proof the anchor ran.)
    expect(link).toHaveAttribute('href', '/api/authenticate/oidc');
    expect(fireEvent.click(link)).toBe(true);
  });
  it('says so when the browser came back with a rejection, instead of looking like nothing happened', () => {
    // The deep link's error= landed in useAuth and was never read here: the
    // browser opened, the person came back, and the screen was unchanged.
    authError = new Error('oidc_failed');
    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('Sign in failed. Please try again.');
    expect(screen.queryByLabelText('Invitation')).not.toBeInTheDocument();
  });

  it('asks for an invitation when this Memory already has an owner, and sends it with the next attempt', () => {
    // A SECOND person can only get in through Portal sign-in if the invitation
    // rides inside the OIDC round-trip; there is no other request in which the
    // callback could learn they were invited.
    authError = new Error('signup_code_required');
    renderPage();

    expect(screen.getByRole('alert')).toHaveTextContent('already belongs to someone');

    fireEvent.change(screen.getByLabelText('Invitation'), { target: { value: '  ABCD-1234 ' } });

    const href =
      screen.getByRole('link', { name: 'Sign in with Companion account' }).getAttribute('href') ?? '';
    expect(new URL(href, window.location.origin).searchParams.get('signup_code')).toBe('ABCD-1234');
  });

  it('lets someone who already holds an invitation offer it before being refused', () => {
    renderPage();

    expect(screen.queryByLabelText('Invitation')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I have an invitation' }));
    fireEvent.change(screen.getByLabelText('Invitation'), { target: { value: 'WXYZ-9876' } });

    const href =
      screen.getByRole('link', { name: 'Sign in with Companion account' }).getAttribute('href') ?? '';
    expect(new URL(href, window.location.origin).searchParams.get('signup_code')).toBe('WXYZ-9876');
  });

  it('sends no invitation parameter at all when none was entered', () => {
    renderPage();

    const href =
      screen.getByRole('link', { name: 'Sign in with Companion account' }).getAttribute('href') ?? '';
    expect(new URL(href, window.location.origin).searchParams.has('signup_code')).toBe(false);
  });
});

import { setApiBaseUrl } from '@ci/common';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ONBOARDING_OAUTH_RESUME_KEY } from '@/pages/OnboardingPage/constants';
import { renderWithProviders } from '@/test/renderWithProviders';

import { OAuthCallbackPage } from './OAuthCallbackPage';

// Sonner's toast only renders behind a mounted <Toaster>, which this page does
// not own — mocking the hook directly is the established pattern here (see
// ProviderPage.test.tsx) for asserting a toast fired without fighting
// portal/animation timing. On this page the toast IS the failure UI: every
// error branch ends in a bare <LoadingPage /> plus a redirect, so if the toast
// stops firing the user is bounced back with no explanation at all.
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));

vi.mock('@ci/shadcn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/shadcn')>()),
  useToast: () => ({ toast }),
}));

// `useAuth` reads AuthProvider context, which `renderWithProviders` does not
// supply (it fetches on mount) — the established pattern for pages that need it
// is to mock the hook directly. Spread the real module: `renderWithProviders`
// itself pulls `CaptureModalProvider` from '@/hooks', so an allow-list mock
// would blank the wrapper.
const auth = vi.hoisted(() => ({ authToken: 'test-token' as string | null, loading: false }));

vi.mock('@/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks')>()),
  useAuth: () => [{ authToken: auth.authToken, loading: auth.loading, authenticated: !!auth.authToken }],
}));

const fetchMock = vi.hoisted(() => vi.fn());

/** The destination routes, so navigation is asserted by where the user lands. */
function LandedOn({ label }: { label: string }) {
  const location = useLocation();

  return <div data-testid={`landed-${label}`}>{JSON.stringify((location.state as unknown) ?? null)}</div>;
}

function renderCallback(entry: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
      <Route path="/sources/connect" element={<LandedOn label="sources" />} />
      <Route path="/onboarding" element={<LandedOn label="onboarding" />} />
      <Route path="/login" element={<LandedOn label="login" />} />
    </Routes>,
    { route: entry },
  );
}

/**
 * Put a fragment on the jsdom URL. The router entry above is a MemoryRouter
 * entry and never touches `window.location`, but this page reads the CI Cloud
 * tokens out of `window.location.hash` directly — so the fragment has to be set
 * on the real document location or the proxy flow is untested.
 */
function setDocumentUrl(url: string) {
  window.history.replaceState(null, '', url);
}

function lastRequest() {
  const calls = fetchMock.mock.calls;

  expect(calls.length).toBeGreaterThan(0);

  const [url, init] = calls[calls.length - 1] as [string, RequestInit];

  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  };
}

function okResponse(status = 200) {
  return { ok: status >= 200 && status < 300, status } as Response;
}

beforeEach(() => {
  auth.authToken = 'test-token';
  auth.loading = false;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  setDocumentUrl('/oauth/callback');
});

afterEach(() => {
  vi.unstubAllGlobals();
  // The api base is a module singleton in @ci/common; leaving a native origin
  // behind would silently rewrite every later test's URLs.
  setApiBaseUrl('');
  setDocumentUrl('/');
});

describe('OAuthCallbackPage — direct provider callback', () => {
  it('posts code + state and lands the user back on the connect page', async () => {
    renderCallback('/oauth/callback?code=auth-code-1&state=state-1');

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();

    const request = lastRequest();

    expect(request.url).toBe('/api/connections/complete');
    expect(request.body).toEqual({ flow: 'direct', state: 'state-1', code: 'auth-code-1' });
    expect(request.headers.Authorization).toBe('Bearer test-token');
    expect(toast.success).toHaveBeenCalledWith('Created connection');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('refuses a callback that is missing state, without calling the API', async () => {
    renderCallback('/oauth/callback?code=auth-code-1');

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Missing OAuth credentials');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OAuthCallbackPage — CI Cloud proxy callback', () => {
  it('reads the tokens out of the URL fragment and scrubs them from the address bar', async () => {
    // CI Cloud puts the tokens in the fragment precisely so they never reach the
    // appliance's access log. If this page ever goes back to reading them from
    // the query string only, the proxy flow breaks outright — and if the
    // `replaceState` cleanup is dropped, a live access token is left sitting in
    // the address bar and in browser history.
    setDocumentUrl(
      '/oauth/callback#access_token=at-1&refresh_token=rt-1&user_provider_id=up-1&expires_in=3600',
    );

    renderCallback('/oauth/callback?connectionId=conn-1');

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();
    expect(lastRequest().body).toEqual({
      flow: 'proxy',
      state: 'conn-1',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      // parsed to a number, not the raw '3600' string the URL carries
      expiresIn: 3600,
      userProviderId: 'up-1',
    });
    expect(window.location.hash).toBe('');
  });

  it('still accepts proxy params in the query string (older CI Cloud builds)', async () => {
    renderCallback('/oauth/callback?connectionId=conn-2&access_token=at-2&user_provider_id=up-2');

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();
    expect(lastRequest().body).toEqual({
      flow: 'proxy',
      state: 'conn-2',
      accessToken: 'at-2',
      // absent rather than null: the backend treats undefined as "no refresh token"
      refreshToken: undefined,
      expiresIn: undefined,
      userProviderId: 'up-2',
    });
  });

  it('refuses a proxy callback with a token but no connectionId', async () => {
    setDocumentUrl('/oauth/callback#access_token=at-3&user_provider_id=up-3');

    renderCallback('/oauth/callback');

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Missing OAuth credentials from provider');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OAuthCallbackPage — failure paths never strand the user', () => {
  it('surfaces the provider error description and returns to the connect page', async () => {
    renderCallback('/oauth/callback?error=access_denied&error_description=You+said+no');

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('You said no');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the duplicate-connection case rather than a generic failure', async () => {
    fetchMock.mockResolvedValue(okResponse(409));

    renderCallback('/oauth/callback?code=c&state=s');

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('A connection to that account already exists');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('names the rejected-credentials case (403) rather than a generic failure', async () => {
    fetchMock.mockResolvedValue(okResponse(403));

    renderCallback('/oauth/callback?code=c&state=s');

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Could not use new credentials to access API');
  });

  it('still redirects when the completion request throws outright', async () => {
    // The `finally` block is what stops a network failure leaving the user on a
    // permanent spinner — the blank-screen case this page exists to avoid.
    fetchMock.mockRejectedValue(new Error('offline'));

    renderCallback('/oauth/callback?code=c&state=s');

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Error: offline');
  });

  it('returns to the wizard when the OAuth hop was started from onboarding', async () => {
    localStorage.setItem(ONBOARDING_OAUTH_RESUME_KEY, 'connect-source');

    renderCallback('/oauth/callback?code=c&state=s');

    expect(await screen.findByTestId('landed-onboarding')).toBeInTheDocument();
    expect(screen.queryByTestId('landed-sources')).not.toBeInTheDocument();
  });
});

describe('OAuthCallbackPage — platform differences between the shipping SPA copies', () => {
  it('posts to the stored server origin on a native shell, not same-origin', async () => {
    // The gateway copy runs same-origin (base ''), the Capacitor/Tauri copies
    // run against a stored absolute origin. A relative URL there is the failure
    // mode that already bit native OIDC ("Native HTTP needs an absolute
    // http(s) URL"), so pin that this call goes through buildApiUrl.
    setApiBaseUrl('https://memory.example.com');

    renderCallback('/oauth/callback?code=c&state=s');

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();
    expect(lastRequest().url).toBe('https://memory.example.com/api/connections/complete');
  });

  it('waits for the auth check instead of bouncing a still-loading session to /login', () => {
    // The guard is `!authLoading && !authToken`, and the `!authLoading` half is
    // load-bearing on the native shells, where the token is restored
    // asynchronously (Preferences / Keychain) after the first render. Drop it
    // and every OAuth return redirects to /login before the session has had a
    // chance to resolve, so the connection can never complete — and the user is
    // handed a login form they do not need. The bounce that SHOULD happen once
    // loading has finished is the test below; the pair pins the guard from both
    // sides.
    auth.authToken = null;
    auth.loading = true;

    renderCallback('/oauth/callback?code=c&state=s');

    // `<Navigate>` redirects from a mount effect and `render` flushes effects
    // inside `act`, so if the bounce were going to happen it has already
    // happened by this line — the negative is deterministic, not a race.
    expect(screen.queryByTestId('landed-login')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounces to /login carrying the whole callback URL when the session was lost', async () => {
    // A native shell can lose its session across the browser round-trip. The
    // fragment has to travel with the return path or the tokens are gone by the
    // time the user is signed back in, and the connection can never complete.
    auth.authToken = null;
    setDocumentUrl('/oauth/callback#access_token=at-9&user_provider_id=up-9');

    renderCallback('/oauth/callback?connectionId=conn-9');

    const landed = await screen.findByTestId('landed-login');

    await waitFor(() => {
      expect(JSON.parse(landed.textContent ?? 'null')).toEqual({
        from: '/oauth/callback?connectionId=conn-9#access_token=at-9&user_provider_id=up-9',
      });
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { Component, type ReactNode } from 'react';

import { setApiBaseUrl } from '@ci/common';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { OpenIDCallbackPage } from './OpenIDCallbackPage';

// See OAuthCallbackPage.test.tsx: the toast hook is mocked rather than mounting
// a <Toaster>, because on this page the toast is the only feedback the user gets
// before being redirected away.
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));

vi.mock('@ci/shadcn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/shadcn')>()),
  useToast: () => ({ toast }),
}));

const auth = vi.hoisted(() => ({ authToken: 'test-token' as string | null }));

vi.mock('@/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks')>()),
  useAuth: () => [{ authToken: auth.authToken, authenticated: !!auth.authToken }],
}));

const fetchMock = vi.hoisted(() => vi.fn());

/**
 * Stands in for the app's real error boundary.
 *
 * Every failure branch on this page is a bare `throw` during render — there is
 * no in-page error UI at all — so the only way to assert on those branches is
 * to catch them the way production does. The message matters: it is the entire
 * explanation the user gets for a sign-in that did not happen.
 */
class CatchRenderError extends Component<{ children: ReactNode }, { message: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { message: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { message: error.message };
  }

  render() {
    if (this.state.message != null) {
      return <div data-testid="render-error">{this.state.message}</div>;
    }

    return this.props.children;
  }
}

function renderCallback(entry: string) {
  return renderWithProviders(
    <CatchRenderError>
      <Routes>
        <Route path="/openid/callback" element={<OpenIDCallbackPage />} />
        <Route path="/sources/connect" element={<div data-testid="landed-sources" />} />
      </Routes>
    </CatchRenderError>,
    { route: entry },
  );
}

/** A complete, valid Steam OpenID 2.0 return, as the provider actually sends it. */
const STEAM_RETURN = new URLSearchParams({
  'openid.mode': 'id_res',
  'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561197960287930',
  'openid.identity': 'https://steamcommunity.com/openid/id/76561197960287930',
  'openid.sig': 'sig-value',
  'openid.signed': 'signed,op_endpoint,claimed_id,identity',
  connection_id: 'conn-1',
});

function steamReturn(overrides: Record<string, string | null> = {}) {
  const params = new URLSearchParams(STEAM_RETURN);

  for (const [key, value] of Object.entries(overrides)) {
    if (value == null) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }

  return `/openid/callback?${params.toString()}`;
}

function lastRequest() {
  const calls = fetchMock.mock.calls;

  expect(calls.length).toBeGreaterThan(0);

  const [url, init] = calls[calls.length - 1] as [string, RequestInit];

  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)) as { params: Record<string, string> },
  };
}

function okResponse(status = 200) {
  return { ok: status >= 200 && status < 300, status } as Response;
}

beforeEach(() => {
  auth.authToken = 'test-token';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setApiBaseUrl('');
});

describe('OpenIDCallbackPage — success path', () => {
  it('forwards every OpenID param verbatim so the backend can check_authentication', async () => {
    // Steam signs a named set of fields (`openid.signed`) and the backend
    // replays them to Steam unchanged. Dropping or renaming any one of them
    // invalidates the signature, so this asserts the whole query string is
    // passed through rather than a hand-picked subset.
    renderCallback(steamReturn());

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();

    const request = lastRequest();

    expect(request.url).toBe('/api/connections/openid/complete');
    expect(request.headers.Authorization).toBe('Bearer test-token');
    expect(request.body.params).toEqual(Object.fromEntries(STEAM_RETURN.entries()));
    expect(toast.success).toHaveBeenCalledWith('Created connection');
  });

  it('names the duplicate-connection case and still redirects', async () => {
    fetchMock.mockResolvedValue(okResponse(409));

    renderCallback(steamReturn());

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('A connection to that account already exists');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('still redirects when the completion request throws outright', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    renderCallback(steamReturn());

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Error: offline');
  });
});

describe('OpenIDCallbackPage — failure paths reach the error boundary', () => {
  beforeEach(() => {
    // React logs every boundary-caught error; the throws below ARE the
    // behaviour under test, not noise worth printing six times. Scoped to this
    // block rather than the whole file on purpose: a blanket silence would also
    // swallow act()/hook warnings in the success tests above, where such a log
    // is a real signal that something is wrong. `restoreMocks: true` in
    // vitest.config.ts puts console.error back after each test.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('rejects a return with no identity, without calling the API', async () => {
    renderCallback(steamReturn({ 'openid.identity': null }));

    expect(await screen.findByTestId('render-error')).toHaveTextContent('Missing OpenID credentials');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a return with no claimed_id', async () => {
    renderCallback(steamReturn({ 'openid.claimed_id': null }));

    expect(await screen.findByTestId('render-error')).toHaveTextContent('Missing OpenID credentials');
  });

  it('rejects a return with no connection_id — nothing to attach the account to', async () => {
    renderCallback(steamReturn({ connection_id: null }));

    expect(await screen.findByTestId('render-error')).toHaveTextContent('Missing Connection ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a provider error instead of posting it as a successful return', async () => {
    renderCallback(steamReturn({ error: 'user_cancelled' }));

    expect(await screen.findByTestId('render-error')).toHaveTextContent('user_cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a provider error_description on its own', async () => {
    renderCallback(steamReturn({ error_description: 'Steam is down' }));

    expect(await screen.findByTestId('render-error')).toHaveTextContent('Steam is down');
  });

  it('refuses to complete a connection with no session', async () => {
    // A native shell can come back from the system browser without a session.
    // The page must not POST an unauthenticated completion.
    auth.authToken = null;

    renderCallback(steamReturn());

    expect(await screen.findByTestId('render-error')).toHaveTextContent('Unauthenticated');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OpenIDCallbackPage — platform differences between the shipping SPA copies', () => {
  it('posts to the stored server origin on a native shell, not same-origin', async () => {
    setApiBaseUrl('https://memory.example.com');

    renderCallback(steamReturn());

    expect(await screen.findByTestId('landed-sources')).toBeInTheDocument();
    expect(lastRequest().url).toBe('https://memory.example.com/api/connections/openid/complete');
  });
});

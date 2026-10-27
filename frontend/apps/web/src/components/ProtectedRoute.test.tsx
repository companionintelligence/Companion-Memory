import { lazy } from 'react';

import { FetchJsonError } from '@ci/common';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtectedRoute } from './ProtectedRoute';

// ProtectedRoute reads useAuth + useCurrentUser from the @/hooks barrel.
interface AuthState {
  authToken: string | null;
  expired: boolean;
  loading: boolean;
  error: null;
  unreachable?: boolean;
}

interface UserState {
  user: { id: string } | null;
  loading: boolean;
  unreachable?: boolean;
  refetch?: () => Promise<unknown>;
}

const h = vi.hoisted(() => ({
  auth: { authToken: null, expired: true, loading: false, error: null } as AuthState,
  actions: {} as { refresh?: () => Promise<void> },
  user: { user: null, loading: false } as UserState,
  isNative: false,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [h.auth, h.actions],
  useCurrentUser: () => h.user,
}));

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ci/common')>();

  return {
    ...actual,
    isNativePlatform: () => h.isNative,
  };
});

function routeTree() {
  return (
    <MemoryRouter initialEntries={['/secret']}>
      <Routes>
        <Route
          path="/secret"
          element={
            <ProtectedRoute>
              <div>secret content</div>
            </ProtectedRoute>
          }
        />
        <Route path="/login" element={<div>login page</div>} />
        <Route path="/device-connect" element={<div>device connect</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function renderProtected() {
  return render(routeTree());
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    h.isNative = false;
    h.actions = {};
  });

  it('shows a loading state while auth/user resolve', () => {
    h.auth = { authToken: null, expired: true, loading: true, error: null };
    h.user = { user: null, loading: false };

    renderProtected();

    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
  });

  it('redirects to login when authenticated but the profile never resolved', () => {
    h.auth = { authToken: 'tok', expired: false, loading: false, error: null };
    h.user = { user: null, loading: false };

    renderProtected();

    expect(screen.getByText('login page')).toBeInTheDocument();
  });

  it('says Memory cannot be reached, instead of Log In, when the profile query goes unanswered', () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    h.auth = { authToken: 'tok', expired: false, loading: false, error: null, unreachable: false };
    h.user = { user: null, loading: false, unreachable: true, refetch };

    renderProtected();

    expect(screen.getByText("Can't reach Memory")).toBeInTheDocument();
    expect(screen.queryByText('login page')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('says Memory cannot be reached when the session check itself goes unanswered', () => {
    h.auth = { authToken: null, expired: true, loading: false, error: null, unreachable: true };
    h.user = { user: null, loading: false, unreachable: false, refetch: undefined };

    renderProtected();

    expect(screen.getByText("Can't reach Memory")).toBeInTheDocument();
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
  });

  it('says Memory cannot be reached, not Log In, when the kept token runs out during the outage', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);

    h.auth = { authToken: 'stale', expired: true, loading: false, error: null, unreachable: true };
    h.actions = { refresh };
    h.user = { user: { id: 'u1' }, loading: false, unreachable: false };

    renderProtected();

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Can't reach Memory")).toBeInTheDocument());
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
  });

  it('keeps a shown page mounted when a later profile refetch goes unanswered', () => {
    h.auth = { authToken: 'tok', expired: false, loading: false, error: null, unreachable: false };
    h.user = { user: { id: 'u1' }, loading: false, unreachable: false };

    const view = renderProtected();

    expect(screen.getByText('secret content')).toBeInTheDocument();

    h.user = { user: null, loading: false, unreachable: true, refetch: vi.fn() };
    view.rerender(routeTree());

    expect(screen.getByText('secret content')).toBeInTheDocument();
    expect(screen.queryByText("Can't reach Memory")).not.toBeInTheDocument();
  });

  it('redirects to /login when expired or unauthenticated on web', () => {
    h.auth = { authToken: null, expired: true, loading: false, error: null };
    h.user = { user: null, loading: false };

    renderProtected();

    expect(screen.getByText('login page')).toBeInTheDocument();
  });

  it('redirects to /device-connect when expired or unauthenticated on native', () => {
    h.isNative = true;
    h.auth = { authToken: null, expired: true, loading: false, error: null };
    h.user = { user: null, loading: false };

    renderProtected();

    expect(screen.getByText('device connect')).toBeInTheDocument();
  });

  it('renders children when authenticated with a user', () => {
    h.auth = { authToken: 'tok', expired: false, loading: false, error: null };
    h.user = { user: { id: 'u1' }, loading: false };

    renderProtected();

    expect(screen.getByText('secret content')).toBeInTheDocument();
  });

  // Routes are lazy and the router runs without transitions, so this shows on
  // every first visit. The Memory hub passes its skeleton (MemoryHubRoute).
  it("shows the given fallback while the page's code downloads", () => {
    h.auth = { authToken: 'token', expired: false, loading: false, error: null };
    h.user = { user: { id: 'u1' }, loading: false };
    const NeverLoads = lazy(() => new Promise<never>(() => {}));

    render(
      <MemoryRouter initialEntries={['/secret']}>
        <Routes>
          <Route
            path="/secret"
            element={
              <ProtectedRoute fallback={<div>section placeholder</div>}>
                <NeverLoads />
              </ProtectedRoute>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('section placeholder')).toBeInTheDocument();
  });

  it('tries a silent refresh before sending an expired session to login', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);

    h.auth = { authToken: 'stale', expired: true, loading: false, error: null };
    h.actions = { refresh };
    h.user = { user: { id: 'u1' }, loading: false };

    renderProtected();

    expect(screen.queryByText('login page')).not.toBeInTheDocument();
    expect(screen.queryByText('secret content')).not.toBeInTheDocument();

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument());
  });

  it('does not attempt a silent refresh (or surface an error) for a visitor who never had a session', async () => {
    const refresh = vi.fn().mockRejectedValue(new FetchJsonError(401, 'Unauthorized'));

    h.auth = { authToken: null, expired: true, loading: false, error: null };
    h.actions = { refresh };
    h.user = { user: null, loading: false };

    renderProtected();

    await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps a signed-in page mounted when the profile blips empty', () => {
    h.isNative = true;
    h.auth = { authToken: null, expired: false, loading: false, error: null };
    h.user = { user: { id: 'u1' }, loading: false };

    const view = renderProtected();

    expect(screen.getByText('secret content')).toBeInTheDocument();

    h.user = { user: null, loading: true };
    view.rerender(routeTree());

    expect(screen.getByText('secret content')).toBeInTheDocument();
    expect(screen.queryByText('device connect')).not.toBeInTheDocument();
  });
});

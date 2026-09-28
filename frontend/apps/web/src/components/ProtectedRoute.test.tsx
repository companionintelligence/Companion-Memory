import { FetchJsonError } from '@ci/common';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProtectedRoute } from './ProtectedRoute';

// ProtectedRoute reads useAuth + useCurrentUser from the @/hooks barrel.
const h = vi.hoisted(() => ({
  auth: { authToken: null as string | null, expired: true, loading: false, error: null },
  actions: {} as { refresh?: () => Promise<void> },
  user: { user: null as { id: string } | null, loading: false },
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

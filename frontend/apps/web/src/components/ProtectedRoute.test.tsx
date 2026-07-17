import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ProtectedRoute } from './ProtectedRoute';

// ProtectedRoute reads useAuth + useCurrentUser from the @/hooks barrel.
const h = vi.hoisted(() => ({
  auth: { authToken: null as string | null, expired: true, loading: false, error: null },
  user: { user: null as { id: string } | null, loading: false },
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [h.auth, {}],
  useCurrentUser: () => h.user,
}));

function renderProtected() {
  return render(
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
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  it('shows a loading state while auth/user resolve', () => {
    h.auth = { authToken: null, expired: true, loading: true, error: null };
    h.user = { user: null, loading: false };

    renderProtected();

    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
  });

  it('waits (loading) when authenticated but the user has not loaded yet', () => {
    h.auth = { authToken: 'tok', expired: false, loading: false, error: null };
    h.user = { user: null, loading: false };

    renderProtected();

    expect(screen.queryByText('secret content')).not.toBeInTheDocument();
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
  });

  it('redirects to /login when expired or unauthenticated', () => {
    h.auth = { authToken: null, expired: true, loading: false, error: null };
    h.user = { user: null, loading: false };

    renderProtected();

    expect(screen.getByText('login page')).toBeInTheDocument();
  });

  it('renders children when authenticated with a user', () => {
    h.auth = { authToken: 'tok', expired: false, loading: false, error: null };
    h.user = { user: { id: 'u1' }, loading: false };

    renderProtected();

    expect(screen.getByText('secret content')).toBeInTheDocument();
  });
});

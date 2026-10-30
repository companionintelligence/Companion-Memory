import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RedirectKnownUser } from './RedirectKnownUser';

// RedirectKnownUser reads useAuth + useCurrentUser from the @/hooks barrel.
const h = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  user: {} as Record<string, unknown>,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [h.auth, {}],
  useCurrentUser: () => h.user,
}));

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({ loading: false }),
}));

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ci/common')>();

  return {
    ...actual,
    isNativePlatform: () => false,
    // No Hub in front: the identity answer names nobody.
    fetchJson: vi.fn().mockResolvedValue({ username: null, accountId: null }),
  };
});

function ShowState() {
  const location = useLocation();

  return <div data-testid="state">{JSON.stringify(location.state)}</div>;
}

function ShowSearch() {
  return <div data-testid="search">{useLocation().search}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/"
          element={
            <RedirectKnownUser>
              <div>splash page</div>
            </RedirectKnownUser>
          }
        />
        <Route
          path="/login"
          element={
            <RedirectKnownUser>
              <div>login form</div>
              <ShowState />
            </RedirectKnownUser>
          }
        />
        <Route
          path="/signup"
          element={
            <RedirectKnownUser>
              <div>signup form</div>
              <ShowSearch />
            </RedirectKnownUser>
          }
        />
        <Route path="/memory" element={<div>memory home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const signedOut = { expired: true, authToken: null, authenticated: false, initializing: false };

describe('RedirectKnownUser while Memory does not answer', () => {
  const reload = vi.fn();
  const realLocation = window.location;

  beforeEach(() => {
    reload.mockReset();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  it('says Memory cannot be reached on Log In when the session check goes unanswered', async () => {
    h.auth = { ...signedOut, unreachable: true };
    h.user = { user: null, loading: false, unreachable: false };

    renderAt('/login');

    expect(await screen.findByText("Can't reach Memory")).toBeInTheDocument();
    expect(
      screen.getByText('Memory is not answering. This page opens as soon as it answers again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('login form')).not.toBeInTheDocument();

    // A reload asks again at once; refresh() would put a 401 on the form as an error.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('says so on the splash too and that the person is still signed in when there is a token', async () => {
    const refetch = vi.fn().mockResolvedValue(undefined);

    h.auth = {
      expired: false,
      authToken: 'tok',
      authenticated: true,
      initializing: false,
      unreachable: false,
    };
    h.user = { user: null, loading: false, unreachable: true, refetch };

    renderAt('/');

    expect(await screen.findByText("Can't reach Memory")).toBeInTheDocument();
    expect(screen.getByText(/You're still signed in/)).toBeInTheDocument();
    expect(screen.queryByText('splash page')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('opens the Log In form from the card while Memory still does not answer', async () => {
    h.auth = { ...signedOut, unreachable: true };
    h.user = { user: null, loading: false, unreachable: false };

    renderAt('/');

    fireEvent.click(await screen.findByRole('link', { name: 'Log In' }));

    expect(await screen.findByText('login form')).toBeInTheDocument();
    expect(screen.queryByText("Can't reach Memory")).not.toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('state').textContent ?? 'null')).toEqual({ pastOutage: true });
  });

  it("opens Sign up's own form from the card, keeping the invite code", async () => {
    h.auth = { ...signedOut, unreachable: true };
    h.user = { user: null, loading: false, unreachable: false };

    renderAt('/signup?code=XYZ');

    fireEvent.click(await screen.findByRole('link', { name: 'Sign up' }));

    expect(await screen.findByText('signup form')).toBeInTheDocument();
    expect(screen.getByTestId('search').textContent).toBe('?code=XYZ');
  });

  it('still sends a known user on to their memory when only the session check goes unanswered', async () => {
    h.auth = {
      expired: false,
      authToken: 'tok',
      authenticated: true,
      initializing: false,
      unreachable: true,
    };
    h.user = {
      user: { id: 'u1', email: 'a@example.com', onboarded: true },
      loading: false,
      unreachable: false,
    };

    renderAt('/login');
    expect(await screen.findByText('memory home')).toBeInTheDocument();
  });

  it('keeps the form and the splash as they were once Memory answers', async () => {
    h.auth = { ...signedOut, unreachable: false };
    h.user = { user: null, loading: false, unreachable: false };

    renderAt('/login');
    expect(await screen.findByText('login form')).toBeInTheDocument();
    expect(screen.queryByText("Can't reach Memory")).not.toBeInTheDocument();
  });

  it('still sends a known user on to their memory', async () => {
    h.auth = {
      expired: false,
      authToken: 'tok',
      authenticated: true,
      initializing: false,
      unreachable: false,
    };
    h.user = {
      user: { id: 'u1', email: 'a@example.com', onboarded: true },
      loading: false,
      unreachable: false,
    };

    renderAt('/login');
    expect(await screen.findByText('memory home')).toBeInTheDocument();
  });
});

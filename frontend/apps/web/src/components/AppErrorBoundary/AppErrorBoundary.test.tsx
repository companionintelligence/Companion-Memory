import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorBoundary } from './AppErrorBoundary';

/** Throws on `/` only, so the boundary has something that recovers on navigation. */
function CrashesOnHome() {
  const { pathname } = useLocation();

  if (pathname === '/') {
    throw new Error('render exploded');
  }

  return <div>the other page</div>;
}

function NavigateAway() {
  const navigate = useNavigate();

  return (
    <button type="button" onClick={() => navigate('/elsewhere')}>
      go elsewhere
    </button>
  );
}

describe('AppErrorBoundary', () => {
  beforeEach(() => {
    // React logs every caught error, and the boundary logs it again for
    // self-hosters running without a DSN. Both are expected in these cases.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders children when nothing throws', () => {
    render(
      <MemoryRouter>
        <AppErrorBoundary>
          <div>the page</div>
        </AppErrorBoundary>
      </MemoryRouter>,
    );

    expect(screen.getByText('the page')).toBeInTheDocument();
  });

  it('shows the fallback and leaves the surrounding shell mounted', () => {
    render(
      <MemoryRouter>
        <nav>the navigation</nav>
        <AppErrorBoundary>
          <CrashesOnHome />
        </AppErrorBoundary>
      </MemoryRouter>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('This page stopped working')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    // The whole point: the chrome outside the boundary survives the crash.
    expect(screen.getByText('the navigation')).toBeInTheDocument();
  });

  it('clears the error when the user navigates to another route', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <NavigateAway />
        <AppErrorBoundary>
          <CrashesOnHome />
        </AppErrorBoundary>
      </MemoryRouter>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'go elsewhere' }));

    expect(screen.getByText('the other page')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

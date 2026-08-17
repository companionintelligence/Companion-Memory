/**
 * Where destinations live in the chrome.
 *
 * The left rail is the whole menu now: major pages, minor tools (including
 * Jobs, which used to hide in the account dropdown), and the account cluster
 * itself. These assertions pin that — present in the rail, not in the
 * account menu — and that expanding the rail reveals labels and submenus.
 */
import { Tooltip } from '@ci/shadcn';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PowerRailProvider } from '../PowerRailContext';
import { PowerRailToggle } from '../PowerRailToggle';
import { NavUser } from '../PrimaryNavigation/NavUser';

import { SecondaryNavigation } from './SecondaryNavigation';

const STORAGE_KEY = 'ci-power-rail-expanded';

vi.mock('@/common/feature', async () => {
  const actual = await vi.importActual<typeof import('@/common/feature')>('@/common/feature');

  return { ...actual, useFeatures: () => ({ isFeatureEnabled: () => true }) };
});

vi.mock('./useFeedBadgeCount', () => ({ useFeedBadgeCount: () => 0 }));

vi.mock('@/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/hooks')>('@/hooks');

  return {
    ...actual,
    useAuth: () => [{ isAuthenticated: true, authToken: 'token' }, { logout: vi.fn() }],
    useCurrentUser: () => ({ user: { name: 'Test User', email: 'test@example.com', onboarded: true } }),
  };
});

vi.mock('@/components/ThemePicker', () => ({
  useTheme: () => ({ themeState: { mode: 'light' }, setTheme: vi.fn() }),
  ColorPicker: () => null,
}));

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
});

function renderRail(route = '/feed', { expanded = false }: { expanded?: boolean } = {}) {
  if (expanded) {
    localStorage.setItem(STORAGE_KEY, 'true');
  }

  return render(
    <MemoryRouter initialEntries={[route]}>
      <PowerRailProvider>
        <Tooltip.Provider>
          <SecondaryNavigation />
        </Tooltip.Provider>
      </PowerRailProvider>
    </MemoryRouter>,
  );
}

function renderToggleAndRail(route = '/feed') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <PowerRailProvider>
        <Tooltip.Provider>
          <PowerRailToggle />
          <SecondaryNavigation />
        </Tooltip.Provider>
      </PowerRailProvider>
    </MemoryRouter>,
  );
}

describe('SecondaryNavigation', () => {
  it('carries Sources in the primary rail', () => {
    renderRail();

    expect(screen.getByRole('link', { name: 'Sources' })).toHaveAttribute('href', '/sources');
  });

  it('carries Jobs in the primary rail', () => {
    renderRail();

    expect(screen.getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', '/jobs');
  });

  // The account's destinations are rail rows now, not a dropdown behind an
  // avatar: one list of everywhere you can go, opening in one direction.
  it('carries the account destinations as rail rows, not a menu', () => {
    renderRail();

    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log out/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Colours' })).toBeInTheDocument();

    // Nothing is reachable only by opening a second surface.
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('offers the theme as a visible choice once expanded', () => {
    renderRail();

    // Collapsed it is one cycling icon; the segmented control needs the width.
    expect(screen.getByRole('button', { name: /Theme:/ })).toBeInTheDocument();
  });

  // `end={false}`: both halves are Sources, and the rail should say so on
  // either one.
  it.each(['/sources', '/sources/connect', '/sources/import'])('marks itself active on %s', (route) => {
    renderRail(route);

    expect(screen.getByRole('link', { name: 'Sources' })).toHaveClass('border-l-primary');
  });

  it('stays icon-only until the rail is opened', () => {
    renderRail();

    expect(screen.getByRole('navigation')).toHaveAttribute('data-state', 'collapsed');
    expect(screen.queryByText('Main')).not.toBeInTheDocument();
    expect(screen.queryByText('More')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('shows labels, groups, and the Sources submenu when expanded', () => {
    renderRail('/feed', { expanded: true });

    expect(screen.getByRole('navigation')).toHaveAttribute('data-state', 'expanded');
    expect(screen.getByText('Feed')).toBeInTheDocument();
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.getByText('More')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect' })).toHaveAttribute('href', '/sources/connect');
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute('href', '/sources/import');
  });
});

describe('PowerRailToggle', () => {
  it('opens and closes the rail instead of navigating home', () => {
    renderToggleAndRail();

    const toggle = screen.getByRole('button', { name: 'Open menu' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'power-rail');
    expect(screen.queryByRole('link', { name: /Companion Intelligence/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Main')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));

    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Main')).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
  });
});

describe('NavUser', () => {
  it('no longer hides Connections in the account menu', async () => {
    render(
      <MemoryRouter>
        <PowerRailProvider>
          <Tooltip.Provider>
            <NavUser />
          </Tooltip.Provider>
        </PowerRailProvider>
      </MemoryRouter>,
    );

    // The menu is closed, but the assertion that matters is that no link to
    // the old route survives anywhere in this component.
    expect(screen.queryByRole('link', { name: /Connections/i })).not.toBeInTheDocument();
  });

  it('no longer hides Jobs in the account menu', () => {
    render(
      <MemoryRouter>
        <PowerRailProvider>
          <Tooltip.Provider>
            <NavUser />
          </Tooltip.Provider>
        </PowerRailProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('link', { name: 'Jobs' })).not.toBeInTheDocument();
  });
});

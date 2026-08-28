import { DeviceLayoutProvider } from '@ci/common';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { ProfilePage } from './ProfilePage';

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const logout = vi.fn();

vi.mock('@/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/hooks')>('@/hooks');

  return {
    ...actual,
    useAuth: () => [{ isAuthenticated: true, authToken: 'token' }, { logout }],
    useCurrentUser: () => ({ user: { name: 'Test User', email: 'test@example.com', onboarded: true } }),
  };
});

vi.mock('@/components/ThemePicker', () => ({
  useTheme: () => ({ themeState: { mode: 'light' }, setTheme: vi.fn() }),
  useBackground: () => ({ glowEnabled: true, setGlowEnabled: vi.fn() }),
  ColorPicker: () => <div>color picker</div>,
  TexturePicker: () => <div>texture picker</div>,
}));

describe('ProfilePage', () => {
  beforeEach(() => {
    logout.mockReset();
    setViewport(true);
  });

  afterEach(() => {
    setViewport(false);
  });

  it('lists settings, help, and log out on the phone hub', async () => {
    renderWithProviders(<ProfilePage />, { route: '/self/settings', path: '/self/settings/*' });

    expect(await screen.findByRole('heading', { name: 'Test User' })).toBeInTheDocument();
    expect(screen.getByText('test@example.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Appearance' })).toHaveAttribute('href', '/self/settings/appearance');
    expect(screen.getByRole('link', { name: 'Your data' })).toHaveAttribute('href', '/self/settings/data');
    // About you and Account moved to the Self tab — reached from the rail, not this hub.
    expect(screen.queryByRole('link', { name: 'About you' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Account' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Support' })).toHaveAttribute(
      'href',
      'https://ci.computer/support',
    );
    expect(screen.getByRole('link', { name: 'Docs' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(logout).toHaveBeenCalled();
  });

  it('opens a settings section as a page with a back link', async () => {
    renderWithProviders(<ProfilePage />, { route: '/self/settings/appearance', path: '/self/settings/*' });

    expect(await screen.findByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/self/settings');
    expect(await screen.findByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
  });

  it('sends desktop visitors to the settings dialog', async () => {
    setViewport(false);
    renderWithProviders(<ProfilePage />, { route: '/self/settings', path: '/self/settings/*' });

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Test User' })).not.toBeInTheDocument();
    });
  });

  /**
   * I5: this redirect used to carry no `state`, so SettingsPage's own
   * `location.state.backgroundLocation` was undefined too — it portalled
   * over a blank `<main>` (nothing else matched the URL to render behind it)
   * and Escape/Close fell back to `appHomePath()` instead of back to Self,
   * where `/self/settings` conceptually lives. A direct visit (a bookmark)
   * has no real prior page to fall back to, so this synthesizes one.
   */
  it('carries a synthesized backgroundLocation to Self, not a blank one', async () => {
    setViewport(false);

    function LocationProbe() {
      const location = useLocation();

      return <div data-testid="state">{JSON.stringify(location.state)}</div>;
    }

    render(
      <MemoryRouter initialEntries={['/self/settings']}>
        <DeviceLayoutProvider args={[]}>
          <Routes>
            <Route path="/self/settings/*" element={<ProfilePage />} />
            <Route path="/settings/appearance" element={<LocationProbe />} />
          </Routes>
        </DeviceLayoutProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('state')).toHaveTextContent(
      JSON.stringify({ backgroundLocation: { pathname: '/self', search: '', hash: '' } }),
    );
  });
});

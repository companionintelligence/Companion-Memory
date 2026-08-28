import { Tooltip } from '@ci/shadcn';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { PowerRailProvider } from '../PowerRailContext';

import { SettingsRailButton } from './SettingsRailButton';

const h = vi.hoisted(() => ({ isMobile: false as boolean | undefined }));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  useDeviceLayout: () => ({ isMobile: h.isMobile }),
}));

function renderButton(route = '/plan') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <PowerRailProvider>
        <Tooltip.Provider>
          <SettingsRailButton />
        </Tooltip.Provider>
      </PowerRailProvider>
    </MemoryRouter>,
  );
}

describe('SettingsRailButton', () => {
  it('renders nothing until the device layout is known, to avoid a flash of the wrong destination', () => {
    h.isMobile = undefined;
    renderButton();

    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('opens the overlay dialog on desktop, carrying the current page as its backgroundLocation', () => {
    h.isMobile = false;
    renderButton('/plan');

    const link = screen.getByRole('link', { name: 'Settings' });

    expect(link).toHaveAttribute('href', '/settings/appearance');
  });

  it('walks to the real settings page on mobile, not the desktop overlay route', () => {
    h.isMobile = true;
    renderButton('/plan');

    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/self/settings');
  });
});

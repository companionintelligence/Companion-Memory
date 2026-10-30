import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocationAlwaysBanner } from './LocationAlwaysBanner';

const h = vi.hoisted(() => ({
  mode: 'off' as 'off' | 'when_in_use' | 'always',
  isNativePlatform: vi.fn(() => false),
  isMobile: true as boolean | null,
}));

vi.mock('@/hooks', () => ({
  useLocationTracking: () => ({ mode: h.mode }),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  isNativePlatform: () => h.isNativePlatform(),
  useDeviceLayout: () => ({ isMobile: h.isMobile }),
}));

beforeEach(() => {
  h.mode = 'off';
  h.isNativePlatform.mockReset();
  h.isNativePlatform.mockReturnValue(false);
  h.isMobile = true;
});

describe('LocationAlwaysBanner', () => {
  it('is hidden on web', () => {
    render(
      <MemoryRouter>
        <LocationAlwaysBanner />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Turn on Location Sync/)).not.toBeInTheDocument();
  });

  it('links to phone Location settings when Always is not on', () => {
    h.isNativePlatform.mockReturnValue(true);
    render(
      <MemoryRouter>
        <LocationAlwaysBanner />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Turn on Location Sync' })).toHaveAttribute(
      'href',
      '/self/settings/location',
    );
  });

  it('hides once Always is selected', () => {
    h.isNativePlatform.mockReturnValue(true);
    h.mode = 'always';
    render(
      <MemoryRouter>
        <LocationAlwaysBanner />
      </MemoryRouter>,
    );

    expect(screen.queryByText(/Turn on Location Sync/)).not.toBeInTheDocument();
  });
});

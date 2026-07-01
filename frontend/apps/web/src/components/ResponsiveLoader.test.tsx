import { type ReactNode } from 'react';

import { DeviceLayoutProvider, useDeviceLayout } from '@ci/common';
import { renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { ResponsiveLoader } from './ResponsiveLoader';

const Desktop = () => <div>desktop view</div>;
const Mobile = () => <div>mobile view</div>;

// useDeviceLayout reads window.matchMedia; drive it to simulate viewport size.
function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : query.includes('landscape') ? !mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => setViewport(false));

describe('ResponsiveLoader', () => {
  it('renders the desktop component on a wide viewport', async () => {
    setViewport(false);
    renderWithProviders(<ResponsiveLoader desktop={Desktop} mobile={Mobile} />);

    await waitFor(() => expect(screen.getByText('desktop view')).toBeInTheDocument());
    expect(screen.queryByText('mobile view')).not.toBeInTheDocument();
  });

  it('renders the mobile component on a narrow viewport', async () => {
    setViewport(true);
    renderWithProviders(<ResponsiveLoader desktop={Desktop} mobile={Mobile} />);

    await waitFor(() => expect(screen.getByText('mobile view')).toBeInTheDocument());
    expect(screen.queryByText('desktop view')).not.toBeInTheDocument();
  });
});

describe('useDeviceLayout (@ci/common)', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DeviceLayoutProvider args={[]}>{children}</DeviceLayoutProvider>
  );

  it('reports mobile + portrait when the narrow media query matches', async () => {
    setViewport(true);
    const { result } = renderHook(() => useDeviceLayout(), { wrapper });

    await waitFor(() => expect(result.current.isMobile).toBe(true));
    expect(result.current.isPortrait).toBe(true);
    expect(result.current.isLandscape).toBe(false);
  });

  it('reports desktop + landscape on a wide viewport', async () => {
    setViewport(false);
    const { result } = renderHook(() => useDeviceLayout(), { wrapper });

    await waitFor(() => expect(result.current.isMobile).toBe(false));
    expect(result.current.isLandscape).toBe(true);
  });
});

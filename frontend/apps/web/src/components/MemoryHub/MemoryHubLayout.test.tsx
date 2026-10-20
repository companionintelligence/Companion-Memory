import { lazy } from 'react';

import { act, fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { MemoryHubLayout } from './MemoryHubLayout';
import { MemoryHubShell } from './MemoryHubShell';

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({ isFeatureEnabled: () => true, loading: false, refresh: vi.fn() }),
}));

const originalMatchMedia = window.matchMedia;

function stubViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function Section({ name }: { name: string }) {
  return <MemoryHubShell>{`${name} page`}</MemoryHubShell>;
}

/** A section whose code never finishes downloading. */
const NeverLoads = lazy(() => new Promise<never>(() => {}));

function Crashes(): never {
  throw new Error('section crashed');
}

function renderHub(route: string) {
  return renderWithProviders(
    <Routes>
      <Route element={<MemoryHubLayout />}>
        <Route path="/memory/people" element={<Section name="People" />} />
        <Route path="/memory/places" element={<Section name="Places" />} />
        <Route path="/memory/things" element={<NeverLoads />} />
        <Route path="/memory/receipts" element={<Crashes />} />
      </Route>
    </Routes>,
    { route },
  );
}

describe('MemoryHubLayout', () => {
  // Every section page used to render the strip itself, so a switch threw the
  // strip away and built a new one.
  it('keeps the same section strip on screen while the section under it changes', async () => {
    stubViewport(true);
    renderHub('/memory/people');

    const strip = await screen.findByRole('navigation', { name: 'Memory sections' });
    const scroller = screen.getByTestId('memory-section-scroller');

    expect(screen.getByText('People page')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Places' }));

    expect(await screen.findByText('Places page')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Memory sections' })).toBe(strip);
    expect(screen.getByTestId('memory-section-scroller')).toBe(scroller);
    expect(screen.getByRole('link', { name: 'Places' })).toHaveAttribute('aria-current', 'page');
  });

  it("keeps the strip while a section's code is still loading, over that section's placeholder", async () => {
    stubViewport(true);
    renderHub('/memory/things');

    expect(await screen.findByRole('navigation', { name: 'Memory sections' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Things' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('status')).toHaveTextContent('Loading things');
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  it('keeps the strip, and a way out, when a section crashes', async () => {
    stubViewport(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    renderHub('/memory/receipts');

    expect(await screen.findByText('This page stopped working')).toBeInTheDocument();

    const strip = screen.getByRole('navigation', { name: 'Memory sections' });

    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'People' }));
    });

    expect(await screen.findByText('People page')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Memory sections' })).toBe(strip);

    vi.mocked(console.error).mockRestore();
  });
});

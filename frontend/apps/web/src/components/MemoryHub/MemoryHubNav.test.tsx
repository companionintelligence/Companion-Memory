import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { MemoryHubNav } from './MemoryHubNav';

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

describe('MemoryHubNav', () => {
  it('lists Memory sections on desktop', async () => {
    stubViewport(false);

    renderWithProviders(<MemoryHubNav />, { route: '/memory/things' });

    expect(await screen.findByRole('navigation', { name: 'Memory sections' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Things' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();
  });

  // D8: the section strip used to disappear entirely on a phone, though its
  // own markup is a scrolling row built for exactly that width — the only
  // way to reach People/Places/Things/etc. that isn't three taps into the
  // drawer. Only page actions ("New thing" — Create lives in the top-bar Add
  // menu on a phone) still hide, to avoid a duplicate control.
  it('keeps the section menu but hides page actions on mobile', async () => {
    stubViewport(true);

    renderWithProviders(<MemoryHubNav actions={<button type="button">New thing</button>} />, {
      route: '/memory/things',
    });

    expect(await screen.findByRole('navigation', { name: 'Memory sections' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Things' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New thing' })).not.toBeInTheDocument();
  });
});

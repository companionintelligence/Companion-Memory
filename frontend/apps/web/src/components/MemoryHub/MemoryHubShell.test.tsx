import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { MemoryHubShell } from './MemoryHubShell';

vi.mock('./MemoryHubNav', () => ({
  MemoryHubNav: () => <div data-testid="hub-nav">destinations</div>,
}));
vi.mock('./MemoryEntityTypeNav', () => ({
  MemoryEntityTypeNav: () => <div data-testid="what-bar">what filter</div>,
}));

/**
 * D5: the explorer (`/memory`, `/memory/events`) used to render only the What
 * filter bar, in place of the hub tabs every other Memory page shows — landing
 * exactly where the rail points at with no sign People/Places/Things exist.
 * Both rows now render there, stacked: which destination, then which filter.
 */
describe('MemoryHubShell', () => {
  it('shows both the hub tabs and the What bar on the explorer', () => {
    renderWithProviders(<MemoryHubShell>content</MemoryHubShell>, { route: '/memory/events' });

    expect(screen.getByTestId('hub-nav')).toBeInTheDocument();
    expect(screen.getByTestId('what-bar')).toBeInTheDocument();
  });

  it('shows only the hub tabs on every other Memory page', () => {
    renderWithProviders(<MemoryHubShell>content</MemoryHubShell>, { route: '/memory/people' });

    expect(screen.getByTestId('hub-nav')).toBeInTheDocument();
    expect(screen.queryByTestId('what-bar')).not.toBeInTheDocument();
  });
});

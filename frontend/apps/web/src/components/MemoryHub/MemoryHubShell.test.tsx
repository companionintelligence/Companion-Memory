import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { MEMORY_HUB_ACTIONS_SLOT } from './MemoryHubNav';
import { MemoryHubShell } from './MemoryHubShell';

vi.mock('./MemoryEntityTypeNav', () => ({
  MemoryEntityTypeNav: () => <div data-testid="what-bar">what filter</div>,
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

/** The strip's end, where MemoryHubNav (in MemoryHubLayout) puts the actions slot. */
function renderWithSlot(ui: React.ReactElement, route: string) {
  return renderWithProviders(
    <>
      <div id={MEMORY_HUB_ACTIONS_SLOT} data-testid="actions-slot" />
      {ui}
    </>,
    { route },
  );
}

/**
 * D5: the explorer (`/memory`, `/memory/events`) used to render only the What
 * filter bar, in place of the hub tabs every other Memory page shows — landing
 * exactly where the rail points at with no sign People/Places/Things exist.
 * The tabs come from MemoryHubLayout now; the explorer adds the What bar under
 * them.
 */
describe('MemoryHubShell', () => {
  it('adds the What bar on the explorer', () => {
    renderWithProviders(<MemoryHubShell>content</MemoryHubShell>, { route: '/memory/events' });

    expect(screen.getByTestId('what-bar')).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('adds no What bar on any other Memory page', () => {
    renderWithProviders(<MemoryHubShell>content</MemoryHubShell>, { route: '/memory/people' });

    expect(screen.queryByTestId('what-bar')).not.toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  // The strip outlives the page, so the page's actions travel up to it.
  it("puts the page's actions at the end of the strip on desktop", async () => {
    stubViewport(false);
    renderWithSlot(
      <MemoryHubShell actions={<button type="button">New place</button>}>content</MemoryHubShell>,
      '/memory/places',
    );

    const slot = screen.getByTestId('actions-slot');

    expect(await screen.findByRole('button', { name: 'New place' })).toBeInTheDocument();
    expect(slot).toContainElement(screen.getByRole('button', { name: 'New place' }));
  });

  it('leaves page actions off on a phone, where Add in the top bar has them', () => {
    stubViewport(true);
    renderWithSlot(
      <MemoryHubShell actions={<button type="button">New place</button>}>content</MemoryHubShell>,
      '/memory/places',
    );

    expect(screen.queryByRole('button', { name: 'New place' })).not.toBeInTheDocument();
  });
});

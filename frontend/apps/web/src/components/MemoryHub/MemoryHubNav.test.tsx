import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { MEMORY_HUB_ACTIONS_SLOT, MemoryHubNav, nearestHorizontalScroll } from './MemoryHubNav';

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

function domRect(left: number, right: number): DOMRect {
  return {
    x: left,
    y: 0,
    left,
    right,
    top: 0,
    bottom: 32,
    width: right - left,
    height: 32,
    toJSON: () => ({}),
  };
}

/**
 * jsdom has no layout. Give the section strip stable content coordinates so
 * its layout effect can be tested like a 220px-wide phone viewport.
 */
function stubHorizontalLayout() {
  const positions = new Map([
    ['Events', 0],
    ['People', 90],
    ['Places', 180],
    ['Things', 270],
    ['Receipts', 360],
    ['Content', 450],
    ['Tags', 540],
    ['Notes', 630],
    ['Chat', 720],
  ]);
  const originalRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect');
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');

  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset.testid === 'memory-section-scroller' ? 220 : 72;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).dataset.testid === 'memory-section-scroller' ? 800 : 72;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      if (this.dataset.testid === 'memory-section-scroller') {
        return domRect(0, 220);
      }

      if (this instanceof HTMLAnchorElement && positions.has(this.textContent ?? '')) {
        const scroller = document.querySelector<HTMLElement>('[data-testid="memory-section-scroller"]');
        const left = positions.get(this.textContent ?? '')! - (scroller?.scrollLeft ?? 0);

        return domRect(left, left + 72);
      }

      return domRect(0, 0);
    },
  });

  return () => {
    for (const [property, descriptor] of [
      ['getBoundingClientRect', originalRect],
      ['clientWidth', originalClientWidth],
      ['scrollWidth', originalScrollWidth],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, property, descriptor);
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
      }
    }
  };
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
    expect(screen.getByRole('link', { name: 'Things' })).toHaveAttribute('aria-current', 'page');
  });

  // D8: the section strip used to disappear entirely on a phone, though its
  // own markup is a scrolling row built for exactly that width — the only
  // way to reach People/Places/Things/etc. that isn't three taps into the
  // drawer. Only page actions ("New thing" — Create lives in the top-bar Add
  // menu on a phone) still hide, to avoid a duplicate control.
  it('carries the search query to the next section, and nothing else', async () => {
    stubViewport(false);

    renderWithProviders(<MemoryHubNav />, {
      route: '/memory/events?search=shell&sortBy=time&sortOrder=desc&includedEntityTypes=Event',
    });

    const content = await screen.findByRole('link', { name: 'Content' });

    // Filters and sort stay behind: the next page has its own and may not
    // understand these.
    expect(content).toHaveAttribute('href', '/memory/content?search=shell');
    expect(screen.getByRole('link', { name: 'People' })).toHaveAttribute(
      'href',
      '/memory/people?search=shell',
    );
  });

  it('links plainly when nothing has been searched', async () => {
    stubViewport(false);

    renderWithProviders(<MemoryHubNav />, { route: '/memory/things?types=image' });

    expect(await screen.findByRole('link', { name: 'Content' })).toHaveAttribute('href', '/memory/content');
  });

  it('keeps the section menu but has no slot for page actions on mobile', async () => {
    stubViewport(true);

    renderWithProviders(<MemoryHubNav />, { route: '/memory/things' });

    expect(await screen.findByRole('navigation', { name: 'Memory sections' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Things' })).toBeInTheDocument();
    expect(document.getElementById(MEMORY_HUB_ACTIONS_SLOT)).toBeNull();
  });

  it('ends the strip with a slot for page actions on desktop', async () => {
    stubViewport(false);

    renderWithProviders(<MemoryHubNav />, { route: '/memory/things' });

    const nav = await screen.findByRole('navigation', { name: 'Memory sections' });
    const slot = document.getElementById(MEMORY_HUB_ACTIONS_SLOT);

    expect(slot).not.toBeNull();
    expect(nav.lastElementChild).toBe(slot);
    // Empty, it takes no room: a page without actions leaves no gap.
    expect(slot).toHaveClass('empty:hidden');
  });

  it('bounds the nearest horizontal position without moving an already-visible tab', () => {
    expect(
      nearestHorizontalScroll({
        scrollLeft: 0,
        clientWidth: 220,
        scrollWidth: 800,
        itemLeft: 540,
        itemRight: 612,
      }),
    ).toBe(400);
    expect(
      nearestHorizontalScroll({
        scrollLeft: 430,
        clientWidth: 220,
        scrollWidth: 800,
        itemLeft: 540,
        itemRight: 612,
      }),
    ).toBe(430);
    expect(
      nearestHorizontalScroll({
        scrollLeft: 590,
        clientWidth: 220,
        scrollWidth: 800,
        itemLeft: 780,
        itemRight: 852,
      }),
    ).toBe(580);
  });

  it('reveals a late active tab and preserves manual scroll when the next active tab is already visible', async () => {
    stubViewport(true);
    const restoreLayout = stubHorizontalLayout();

    try {
      renderWithProviders(<MemoryHubNav />, { route: '/memory/content' });

      const scroller = await screen.findByTestId('memory-section-scroller');
      expect(scroller.scrollLeft).toBe(310);

      // Simulate the user scrolling slightly farther right. Tags is already
      // fully visible in this viewport, so route activation must not snap back.
      scroller.scrollLeft = 430;
      fireEvent.click(screen.getByRole('link', { name: 'Tags' }));

      expect(screen.getByRole('link', { name: 'Tags' })).toHaveAttribute('aria-current', 'page');
      expect(scroller.scrollLeft).toBe(430);
    } finally {
      restoreLayout();
    }
  });
});

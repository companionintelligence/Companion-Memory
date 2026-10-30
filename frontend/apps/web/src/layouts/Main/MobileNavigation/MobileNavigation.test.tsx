import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { PowerRailProvider } from '../PowerRailContext';

import { MobileNavigation } from './MobileNavigation';
import { MobileTopBar } from './MobileTopBar';

vi.mock('@/common/feature', async () => {
  const actual = await vi.importActual<typeof import('@/common/feature')>('@/common/feature');

  return {
    ...actual,
    useFeatures: () => ({ isFeatureEnabled: () => true, loading: false, refresh: vi.fn() }),
  };
});

vi.mock('../SecondaryNavigation/useFeedBadgeCount', () => ({ useFeedBadgeCount: () => 0 }));
vi.mock('../SecondaryNavigation/usePlanBadgeCount', () => ({ usePlanBadgeCount: () => 0 }));

const recentThreads = vi.hoisted(() => ({ current: [] as { id: string; name: string | null }[] }));

vi.mock('@/pages/ChatPage/useRecentThreads', async () => {
  const actual = await vi.importActual<typeof import('@/pages/ChatPage/useRecentThreads')>(
    '@/pages/ChatPage/useRecentThreads',
  );

  return {
    ...actual,
    useRecentThreads: ({ enabled }: { enabled: boolean }) => ({
      threads: enabled ? recentThreads.current : [],
      loading: false,
      error: null,
    }),
  };
});

vi.mock('@/components/modals/CaptureModal', () => ({
  CaptureModal: () => <div data-testid="capture-modal" />,
}));
vi.mock('@/components/modals/UploadModal', () => ({ UploadModal: () => null }));
vi.mock('@/components/modals/AddItemModal', () => ({
  AddEventModal: () => null,
  AddPersonModal: () => null,
  AddPlaceModal: () => null,
}));
vi.mock('@/components/modals/AddItemModal/AddConceptModal.tsx', () => ({ AddConceptModal: () => null }));
vi.mock('@/components/modals/ThingModal', () => ({ ThingModal: () => null }));

vi.mock('@/api', async () => {
  const actual = await vi.importActual<typeof import('@/api')>('@/api');

  return {
    ...actual,
    useUploadFile: () => [null, { upload: vi.fn(), reset: vi.fn() }],
    useTriggerHbpe: () => [null, { trigger: vi.fn() }],
  };
});

vi.mock('@/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/hooks')>('@/hooks');

  return {
    ...actual,
    useAuth: () => [{ isAuthenticated: true, authToken: 'token' }, { logout: vi.fn() }],
    useCurrentUser: () => ({ user: { name: 'Test User', email: 'test@example.com', onboarded: true } }),
    useCaptureModal: () => [{ isOpen: false }, { open: vi.fn(), close: vi.fn() }],
  };
});

vi.mock('@/components/ThemePicker', () => ({
  useTheme: () => ({ themeState: { mode: 'light' }, setTheme: vi.fn() }),
  ColorPicker: () => null,
}));

vi.mock('@/components/SearchBox', () => ({
  GlobalSearchBox: () => <input aria-label="Search memory" />,
}));

vi.mock('@/components/ConnectionModeIndicator', () => ({
  ConnectionModeIndicator: () => null,
  OutboxQueueIndicator: () => null,
}));

function renderMobileNav(route = '/calendar') {
  return renderWithProviders(
    <PowerRailProvider variant="overlay">
      <MobileTopBar />
      <MobileNavigation />
    </PowerRailProvider>,
    { route },
  );
}

/** The drawer while it is shut: hidden from the a11y tree, so not reachable by role. */
function drawerNav() {
  const nav = document.getElementById('power-rail');

  if (!nav) {
    throw new Error('No #power-rail in the document');
  }

  return nav;
}

/** jsdom does no layout: give the drawer the 300px it has on a phone. */
function mockDrawerWidth(nav: HTMLElement) {
  vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue({ width: 300, right: 300 } as DOMRect);
}

function touchAt(clientX: number, clientY = 240) {
  return { touches: [{ identifier: 0, clientX, clientY }] };
}

/**
 * One finger down at the first x, through the rest, then up. The clock stands
 * still, so the release has no speed and where it lets go decides. Synthetic
 * events land within a millisecond of each other, which would read as a flick.
 */
function drag(target: Element, xs: number[]) {
  const [first, ...rest] = xs;
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

  fireEvent.touchStart(target, touchAt(first));

  for (const x of rest) {
    fireEvent.touchMove(target, touchAt(x));
  }

  fireEvent.touchEnd(target, { touches: [] });
  now.mockRestore();
}

/** A sideways scroller (the Memory section strip, say), scrolled `scrollLeft` px from its start. */
function sidewaysStrip(scrollLeft: number) {
  const strip = document.createElement('div');

  strip.dataset.testid = 'page-strip';
  strip.style.overflowX = 'auto';
  Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 800 });
  Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 400 });
  Object.defineProperty(strip, 'scrollLeft', { configurable: true, value: scrollLeft });
  document.body.appendChild(strip);

  return strip;
}

describe('MobileNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recentThreads.current = [];
  });

  it('starts closed, with chevron, search, and Add in the top row', () => {
    renderMobileNav();

    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search memory' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Planning' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
    // The wordmark belongs to the drawer, which is off-canvas until opened —
    // the top bar itself stays chevron, search, chips, Add.
    expect(screen.getByRole('banner').querySelector('img[src*="logo"]')).toBeNull();
  });

  // QA MEM-05: an entity's full page had only the menu chevron on its left, so
  // on a phone — no browser Back, no swipe back — there was no way out that
  // kept the explorer's filters.
  it('puts a visible Back under the top row on an entity full page, and not on the explorer', () => {
    const { unmount } = renderMobileNav('/memory');

    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    unmount();

    renderMobileNav('/events/e-1');

    const back = screen.getByRole('button', { name: 'Back' });

    expect(back).toBeVisible();
    // Below the header row, not inside it: the search box keeps its room.
    expect(screen.getByRole('banner')).not.toContainElement(back);
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
  });

  it('opens the drawer with the same destinations as the desktop list', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(await screen.findByRole('link', { name: 'Planning' })).toHaveAttribute('href', '/plan');
    expect(screen.getByRole('link', { name: 'Memory' })).toHaveAttribute('href', '/memory');
    expect(screen.queryByRole('link', { name: 'System' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Close menu' }).length).toBeGreaterThanOrEqual(1);
  });

  // The drawer never said which app it belonged to. Desktop only reveals the
  // name when the rail is pinned, and the phone has no pinning at all.
  it('names the app in the open drawer, logo and wordmark together', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    const nav = await screen.findByRole('navigation');
    const wordmark = within(nav).getByTestId('power-rail-wordmark');

    // Short form — the drawer shares its width with the close chevron, so the
    // full "Companion Memory" used to ellipsize. Desktop keeps the long name.
    expect(within(wordmark).getByText('Memory')).toHaveAttribute('aria-hidden', 'false');
    expect(within(wordmark).queryByText('Companion Memory')).toBeNull();
    // The Companion Memory mark, not the old raster logo.png: the drawer, the
    // splash hero and the app icons are one drawing now — the static solid-teal
    // SVG, which `CompanionMark` always renders (`animated` only adds a CSS
    // entrance, which the drawer never asks for).
    expect(wordmark.querySelector('img[src*="companion-memory-brain"]')).not.toBeNull();
    // Same inset as Capture / Planning — without it the 32px disc sat on the
    // pane edge while every row below had px-2 + a 2px active border.
    expect(wordmark.parentElement).toHaveClass('border-l-2', 'px-2', 'py-2');
  });

  // The drawer is glass: the page stays in view behind it, frosted by the
  // blur. 300px, less a strip of page on the narrowest phones.
  it('draws a glass drawer, 300px wide', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    const nav = await screen.findByRole('navigation');

    expect(nav).toHaveClass(
      'backdrop-blur-xl',
      'bg-white/35',
      'dark:bg-white/10',
      'w-[min(300px,calc(100vw-56px))]',
    );
    expect(nav).not.toHaveClass('bg-background');
  });

  it('pins Help and the account under a divider while the rest of the drawer scrolls', async () => {
    renderMobileNav('/memory/chat');

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    const nav = await screen.findByRole('navigation');
    const list = within(nav).getByTestId('rail-scroll');
    const footer = within(nav).getByTestId('rail-footer');

    expect(list).toHaveClass('overflow-y-auto', 'flex-1', 'min-h-0');
    expect(within(list).getByRole('link', { name: 'Chat' })).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: 'Help' })).toBeInTheDocument();
    expect(within(footer).getByRole('link', { name: 'Test User' })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Help' })).not.toBeInTheDocument();
    expect(footer).toHaveClass('border-t', 'shrink-0');
  });

  // The swipe that closes the drawer may start anywhere on it, and the drawer
  // travels with the finger on the way.
  it('closes on a left drag that starts anywhere on the drawer', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    const nav = await screen.findByRole('navigation');
    const row = within(nav).getByRole('link', { name: 'Planning' });

    mockDrawerWidth(nav);
    drag(row, [280, 230, 120]);

    // Let go short of halfway shut: on its way out.
    expect(nav.style.translate).toBe('-100% 0');

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Planning' })).not.toBeInTheDocument();
    });
  });

  it('closes on a left drag that starts on the scrim beside the drawer', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    mockDrawerWidth(await screen.findByRole('navigation'));

    drag(screen.getByRole('button', { name: 'Dismiss menu' }), [360, 300, 180]);

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Planning' })).not.toBeInTheDocument();
    });
  });

  it('stays open when the drag left is let go before halfway', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    const nav = await screen.findByRole('navigation');

    mockDrawerWidth(nav);
    drag(within(nav).getByRole('link', { name: 'Planning' }), [280, 250, 200]);

    await waitFor(() => expect(nav.style.translate).toBe(''));
    expect(screen.getByRole('link', { name: 'Planning' })).toBeInTheDocument();
  });

  // The wordmark is a statement, not a second close button: the chevron beside
  // it already owns that, and two controls with one accessible name is one too
  // many for a thumb.
  it('leaves the drawer with a single close control', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    const nav = await screen.findByRole('navigation');

    expect(within(nav).getAllByRole('button', { name: 'Close menu' })).toHaveLength(1);
  });

  // ChatSidebar is portaled to `tertiary-navigation`, which the phone layout
  // never renders — without this submenu there is no way to change thread.
  // Chat lives under Memory now, whose group auto-opens on a memory-hub
  // route, same as it did for the old dedicated Chat group.
  it('switches among recent threads from the drawer', async () => {
    recentThreads.current = [
      { id: 't1', name: 'Dinner plans' },
      { id: 't2', name: null },
    ];

    renderMobileNav('/memory/chat');

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(await screen.findByRole('link', { name: 'Dinner plans' })).toHaveAttribute(
      'href',
      '/memory/chat/t1',
    );
    expect(screen.getByRole('link', { name: 'Thread t2' })).toHaveAttribute('href', '/memory/chat/t2');
  });

  // Chat itself is a Memory hub section now, not a peer row — see the
  // equivalent assertion in SecondaryNavigation.test.tsx.
  it('lists Chat inside the Memory group, not as its own row', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(screen.queryByRole('link', { name: 'Chat' })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Memory sections' }));

    expect(screen.getByRole('link', { name: 'Chat' })).toHaveAttribute('href', '/memory/chat');
  });

  it('carries Asks inside the drawer Saved Searches group, not as its own row', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    await screen.findByRole('link', { name: 'Saved Searches' });
    expect(screen.queryByRole('link', { name: 'Asks' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Saved Searches sections' }));

    expect(screen.getByRole('link', { name: 'Asks' })).toHaveAttribute('href', '/asks');
  });

  it('puts Capture first in the drawer and Help and the user tile at the foot', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    const nav = await screen.findByRole('navigation');
    const close = nav.querySelector('[aria-label="Close menu"]');
    const capture = screen.getByRole('button', { name: 'Capture' });
    const plan = screen.getByRole('link', { name: 'Planning' });
    const help = await screen.findByRole('button', { name: 'Help' });
    const account = screen.getByRole('link', { name: 'Test User' });

    expect(account).toHaveAttribute('href', '/self');
    expect(close).toBeTruthy();
    expect((close as Node).compareDocumentPosition(capture) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(capture.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(plan.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(help.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('puts Settings in the Self submenu, not as its own drawer row', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Self sections' }));

    const self = screen.getByTestId('self-submenu');

    expect(within(self).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(within(self).getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/self');
    expect(within(self).getByRole('link', { name: 'Stats' })).toHaveAttribute('href', '/self/stats');
    expect(within(self).getByRole('link', { name: 'Reflections' })).toHaveAttribute(
      'href',
      '/self/reflections',
    );
  });

  // D13: the phone drawer used to have no route to support or docs at all.
  it('opens Support and Docs from the drawer footer', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Help' }));

    expect(screen.getByRole('link', { name: 'Support' })).toHaveAttribute(
      'href',
      'https://ci.computer/support',
    );
    expect(screen.getByRole('link', { name: 'Docs' })).toBeInTheDocument();
  });

  describe('pulling the drawer out from the left edge', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      document.body.querySelectorAll('[data-testid="page-strip"]').forEach((el) => el.remove());
    });

    it('moves the drawer with the finger, and opens it once let go past halfway', async () => {
      // `/plan/calendar` so the Planning submenu auto-opens on the route,
      // surfacing the Calendar child link without an explicit expand click.
      renderMobileNav('/plan/calendar');

      const nav = drawerNav();
      const page = screen.getByRole('banner');

      mockDrawerWidth(nav);

      vi.spyOn(Date, 'now').mockReturnValue(1_000);
      fireEvent.touchStart(page, touchAt(8));
      fireEvent.touchMove(page, touchAt(68));
      // 60px of a 300px drawer: a fifth of the way out, under the finger.
      expect(nav.style.translate).toBe('-240px 0');
      // Open from the moment the drag claims the touch, so what slides out is
      // the labelled drawer, not the icon-only rows it keeps while shut.
      expect(nav).toHaveAttribute('data-state', 'expanded');
      // The scrim mounts at the drag's shade, not at full for a frame.
      expect(screen.getByRole('button', { name: 'Dismiss menu' }).style.opacity).toBe('0.2');

      fireEvent.touchMove(page, touchAt(158));
      expect(nav.style.translate).toBe('-150px 0');
      // The scrim darkens with it: half out, half dark.
      expect(screen.getByRole('button', { name: 'Dismiss menu' }).style.opacity).toBe('0.5');

      fireEvent.touchMove(page, touchAt(208));
      fireEvent.touchEnd(page, { touches: [] });

      expect(await screen.findByRole('link', { name: 'Calendar' })).toBeInTheDocument();
      // Settled: the inline position comes off, and the class holds it open.
      await waitFor(() => expect(nav.style.translate).toBe(''));
      expect(nav).toHaveClass('translate-x-0');
    });

    it('goes back when let go short of halfway, scrim and all', async () => {
      renderMobileNav();

      const nav = drawerNav();

      mockDrawerWidth(nav);
      drag(screen.getByRole('banner'), [8, 60, 110]);

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Dismiss menu' })).not.toBeInTheDocument(),
      );
      expect(nav).toHaveAttribute('data-state', 'collapsed');
      expect(nav.style.translate).toBe('');
    });

    it('opens on a quick flick, however short', async () => {
      renderMobileNav('/plan/calendar');

      const page = screen.getByRole('banner');
      const now = vi.spyOn(Date, 'now');

      mockDrawerWidth(drawerNav());

      now.mockReturnValue(1_000);
      fireEvent.touchStart(page, touchAt(8));
      now.mockReturnValue(1_016);
      fireEvent.touchMove(page, touchAt(30));
      now.mockReturnValue(1_032);
      // 60px in 16ms, and only a fifth of the way out.
      fireEvent.touchMove(page, touchAt(90));
      fireEvent.touchEnd(page, { touches: [] });

      expect(await screen.findByRole('link', { name: 'Calendar' })).toBeInTheDocument();
    });

    it('leaves a drag that starts further in than the edge strip to the page', () => {
      renderMobileNav();

      const nav = drawerNav();

      mockDrawerWidth(nav);
      drag(screen.getByRole('banner'), [60, 160, 260]);

      expect(nav.style.translate).toBe('');
      expect(screen.queryByRole('button', { name: 'Dismiss menu' })).not.toBeInTheDocument();
    });

    it('leaves a mostly vertical drag to the page, so it scrolls', () => {
      renderMobileNav();

      const nav = drawerNav();
      const page = screen.getByRole('banner');

      mockDrawerWidth(nav);

      fireEvent.touchStart(page, touchAt(8, 240));
      const move = createEvent.touchMove(page, touchAt(30, 340));
      fireEvent(page, move);
      fireEvent.touchEnd(page, { touches: [] });

      expect(move.defaultPrevented).toBe(false);
      expect(nav.style.translate).toBe('');
      expect(nav).toHaveAttribute('data-state', 'collapsed');
    });

    it("keeps the page from scrolling once the drag is the drawer's", () => {
      renderMobileNav();

      const page = screen.getByRole('banner');

      mockDrawerWidth(drawerNav());

      fireEvent.touchStart(page, touchAt(8));
      const move = createEvent.touchMove(page, touchAt(80));
      fireEvent(page, move);

      expect(move.defaultPrevented).toBe(true);
    });

    it('lets a sideways strip that can still scroll back have the swipe', () => {
      renderMobileNav();

      const nav = drawerNav();
      const strip = sidewaysStrip(40);

      mockDrawerWidth(nav);
      drag(strip, [8, 80, 200]);

      expect(nav.style.translate).toBe('');
      expect(nav).toHaveAttribute('data-state', 'collapsed');
    });

    it('takes the swipe from a sideways strip that is already back at its start', async () => {
      renderMobileNav('/plan/calendar');

      mockDrawerWidth(drawerNav());
      drag(sidewaysStrip(0), [8, 80, 200]);

      expect(await screen.findByRole('link', { name: 'Calendar' })).toBeInTheDocument();
    });

    // Leaflet and d3-zoom set `touch-action: none` and pan on their own.
    it('leaves a surface that handles its own touches alone', () => {
      renderMobileNav();

      const nav = drawerNav();
      const map = sidewaysStrip(0);
      const realGetComputedStyle = window.getComputedStyle.bind(window);

      vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
        const style = realGetComputedStyle(element, pseudo);

        return element === map
          ? ({ ...style, touchAction: 'none', overflowX: 'hidden' } as CSSStyleDeclaration)
          : style;
      });

      mockDrawerWidth(nav);
      drag(map, [8, 80, 200]);

      expect(nav.style.translate).toBe('');
    });

    it('stays put under an open dialog', () => {
      renderMobileNav();

      const nav = drawerNav();

      mockDrawerWidth(nav);
      // What Radix does to the page while a modal sheet or dialog is open.
      document.body.style.pointerEvents = 'none';

      try {
        drag(screen.getByRole('banner'), [8, 80, 200]);
      } finally {
        document.body.style.pointerEvents = '';
      }

      expect(nav.style.translate).toBe('');
    });
  });

  // The drawer names itself distinctly from the desktop rail's nav (see the
  // "Main navigation" assertion in SecondaryNavigation.test.tsx), so a
  // screen-reader user can tell which one they are in.
  it('labels the drawer nav distinctly from the desktop rail nav', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    const nav = await screen.findByRole('navigation');

    expect(nav).toHaveAttribute('aria-label', 'Main navigation drawer');
  });

  // H4: Escape is a standard way to dismiss any dialog-like overlay, and the
  // drawer covers the whole screen on a phone.
  it('closes the drawer when Escape is pressed', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(await screen.findByRole('link', { name: 'Planning' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('link', { name: 'Planning' })).not.toBeInTheDocument();
  });

  // H4: without this, closing the drawer (by any means) strands keyboard
  // focus on a node that just left the accessibility tree.
  it('returns focus to the button that opened it once the drawer closes', async () => {
    renderMobileNav();

    const trigger = screen.getByRole('button', { name: 'Open menu' });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    await screen.findByRole('navigation');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(document.activeElement).toBe(trigger);
  });

  // H4: `aria-hidden` on the drawer already keeps the scrim-covered page out
  // of the accessibility tree, but its links stayed tabbable. `inert` is what
  // actually pulls them out of tab order (and pointer hit-testing) too.
  it('makes the page behind the scrim inert, not just visually covered, while the drawer is open', async () => {
    renderMobileNav();

    const banner = screen.getByRole('banner');

    expect(banner).not.toHaveAttribute('inert');

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    await screen.findByRole('navigation');

    expect(banner).toHaveAttribute('inert');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(banner).not.toHaveAttribute('inert');
  });

  // The shut drawer is translated off-canvas but stays `visibility: visible`,
  // so `aria-hidden` alone left its ten controls in the Tab order. `inert`
  // takes them out while shut, and comes off the moment it opens so the
  // focus trap above still lands on its first control.
  it('keeps the shut drawer out of the tab order, and the open one in it', async () => {
    renderMobileNav();

    const nav = drawerNav();

    expect(nav).toHaveAttribute('aria-hidden', 'true');
    expect(nav).toHaveAttribute('inert');

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    await screen.findByRole('navigation');

    expect(nav).not.toHaveAttribute('inert');
    expect(nav).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(nav).toHaveAttribute('inert');
  });
});

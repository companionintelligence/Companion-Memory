import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    // splash hero and the app icons are one drawing now. Under jsdom this is
    // the static SVG — `CompanionMark` only reaches for the Lottie player when
    // something asks it to animate, which the drawer never does.
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

  // The swipe that closes the drawer may start anywhere on it — the drawer's
  // own measured edge, not the 224px it used to be.
  it('closes on a left swipe that starts anywhere on the drawer', async () => {
    renderMobileNav();

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    const nav = await screen.findByRole('navigation');

    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue({ right: 300 } as DOMRect);

    fireEvent.touchStart(document, { touches: [{ clientX: 280, clientY: 240 }] });
    fireEvent.touchEnd(document, { changedTouches: [{ clientX: 180, clientY: 240 }] });

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Planning' })).not.toBeInTheDocument();
    });
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

  it('opens on a right swipe from the left edge', async () => {
    // `/plan/calendar` so the Planning submenu auto-opens on the route,
    // surfacing the Calendar child link without an explicit expand click.
    renderMobileNav('/plan/calendar');

    fireEvent.touchStart(document, { touches: [{ clientX: 8, clientY: 240 }] });
    fireEvent.touchEnd(document, { changedTouches: [{ clientX: 80, clientY: 240 }] });

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Calendar' })).toBeInTheDocument();
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
});

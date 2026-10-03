/**
 * Where destinations live in the chrome.
 *
 * The left rail is the whole menu now: major pages, minor tools, and the
 * account cluster itself. These assertions pin that — present in the rail,
 * not in the account menu — and that expanding the rail reveals labels.
 */
import { DeviceLayoutProvider } from '@ci/common';
import { Tooltip } from '@ci/shadcn';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PowerRailProvider } from '../PowerRailContext';
import { PowerRailToggle } from '../PowerRailToggle';

import { SecondaryNavigation } from './SecondaryNavigation';

const STORAGE_KEY = 'ci-power-rail-expanded';

vi.mock('@/common/feature', async () => {
  const actual = await vi.importActual<typeof import('@/common/feature')>('@/common/feature');

  return { ...actual, useFeatures: () => ({ isFeatureEnabled: () => true }) };
});

vi.mock('./useFeedBadgeCount', () => ({ useFeedBadgeCount: () => 0 }));
vi.mock('./usePlanBadgeCount', () => ({ usePlanBadgeCount: () => 0 }));

const recentThreads = vi.hoisted(() => ({
  current: [] as { id: string; name: string | null; createdAt?: string }[],
}));
// One stable function, so a test can say whether the account row actually signed anyone out.
const logout = vi.hoisted(() => vi.fn());

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

vi.mock('@/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/hooks')>('@/hooks');

  return {
    ...actual,
    useAuth: () => [{ isAuthenticated: true, authToken: 'token' }, { logout }],
    useCurrentUser: () => ({ user: { name: 'Test User', email: 'test@example.com', onboarded: true } }),
    useCaptureModal: () => [{ isOpen: false }, { open: vi.fn(), close: vi.fn() }],
  };
});

vi.mock('@/components/modals/CaptureModal', () => ({
  CaptureModal: () => <div data-testid="capture-modal" />,
}));

vi.mock('@/components/ThemePicker', () => ({
  useTheme: () => ({ themeState: { mode: 'light' }, setTheme: vi.fn() }),
  ColorPicker: () => null,
}));

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  recentThreads.current = [];
  logout.mockClear();
});

function renderRail(route = '/plan', { expanded = false }: { expanded?: boolean } = {}) {
  if (expanded) {
    localStorage.setItem(STORAGE_KEY, 'true');
  }

  return render(
    <MemoryRouter initialEntries={[route]}>
      <DeviceLayoutProvider args={[]}>
        <PowerRailProvider>
          <Tooltip.Provider>
            <SecondaryNavigation />
          </Tooltip.Provider>
        </PowerRailProvider>
      </DeviceLayoutProvider>
    </MemoryRouter>,
  );
}

function renderToggleAndRail(route = '/plan') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <DeviceLayoutProvider args={[]}>
        <PowerRailProvider>
          <Tooltip.Provider>
            <PowerRailToggle />
            <SecondaryNavigation />
          </Tooltip.Provider>
        </PowerRailProvider>
      </DeviceLayoutProvider>
    </MemoryRouter>,
  );
}

describe('SecondaryNavigation', () => {
  it('carries Sources in the primary rail', () => {
    renderRail();

    expect(screen.getByRole('link', { name: 'Sources' })).toHaveAttribute('href', '/sources');
  });

  it('carries Jobs in the rail', () => {
    renderRail();

    expect(screen.getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', '/jobs');
  });

  it('does not carry Notes in the rail', () => {
    renderRail();

    expect(screen.queryByRole('link', { name: 'Notes' })).not.toBeInTheDocument();
  });

  it('carries Planning in the primary rail', () => {
    renderRail();

    expect(screen.getByRole('link', { name: 'Planning' })).toHaveAttribute('href', '/plan');
  });

  it('carries Forecast in the primary rail', () => {
    renderRail();

    expect(screen.getByRole('link', { name: 'Forecast' })).toHaveAttribute('href', '/forecast');
  });

  it('offers Tasks and Calendar as Planning sub-views when expanded', () => {
    renderRail('/plan', { expanded: true });

    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/plan/tasks');
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/plan/calendar');
  });

  it('opens Planning sections when the Planning link is clicked', () => {
    renderRail('/feed', { expanded: true });

    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Planning' }));
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('opens Planning sections from the collapsed rail without widening it', () => {
    const { container } = renderRail('/feed', { expanded: false });

    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();
    expect(container.querySelector('div.relative')).toHaveClass('w-14');

    fireEvent.click(screen.getByRole('link', { name: 'Planning' }));

    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/plan/tasks');
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/plan/calendar');
    expect(screen.queryByText('Tasks')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="popover-content"]')).not.toBeInTheDocument();
    expect(container.querySelector('div.relative')).toHaveClass('w-14');
    expect(screen.getByRole('navigation')).toHaveAttribute('data-state', 'collapsed');
  });

  it('opens Memory sections from the collapsed rail', () => {
    renderRail('/feed', { expanded: false });

    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Memory' }));

    expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Chat' })).toHaveAttribute('href', '/memory/chat');
  });

  it('closes a route-open submenu when a peer group is opened by click', () => {
    renderRail('/plan', { expanded: true });

    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Jobs sections' }));
    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'History' })).toBeInTheDocument();
  });

  it('closes Jobs sections again when its chevron is clicked to collapse', () => {
    renderRail('/plan', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Jobs sections' }));
    expect(screen.getByRole('link', { name: 'History' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Jobs sections' }));
    expect(screen.queryByRole('link', { name: 'History' })).not.toBeInTheDocument();
  });

  it('keeps Planning sections open after a sticky chevron open even off /plan routes', () => {
    renderRail('/feed', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Planning sections' }));
    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();
  });

  it('keeps Planning sections open on a /plan/tasks or /plan/calendar route', () => {
    renderRail('/plan/calendar', { expanded: true });

    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Tasks' })).not.toHaveAttribute('aria-current');
  });

  // Schedule and Brief were folded into Calendar, so the rail must not offer a
  // second way to reach either — that was the point of combining them.
  it('no longer offers Schedule or Brief as their own destinations', () => {
    renderRail();

    expect(screen.queryByRole('link', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Brief' })).not.toBeInTheDocument();
  });

  // One row that opens for theme and log out — not five flat ones sitting
  // level with the places you actually work. Settings lives in that same
  // submenu as Profile / Stats / Reflections, not as its own rail row.
  it('keeps the account to one user tile that opens for theme and log out', () => {
    renderRail('/feed', { expanded: true });

    const account = screen.getByRole('link', { name: 'Test User' });

    expect(account).toHaveAttribute('href', '/self');
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Self sections' }));

    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings/appearance');
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
  });

  /**
   * QA: on the phone the footer is pinned to the bottom edge and grows upward, so
   * once the account row opens, "Log out" sits exactly where the chevron that
   * opened it was. A second tap on the same spot signed two testers out, and
   * getting back in is a trip through the Companion sign-in. The row now asks.
   */
  it('asks before logging out, and signs out only when that is confirmed', () => {
    renderRail('/feed', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Self sections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));

    // The row alone signs nobody out: it opens a question.
    const dialog = screen.getByRole('alertdialog');

    expect(within(dialog).getByText('Log out?')).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();

    // Backing out leaves the session alone, and the question goes away.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();

    // Asked again, a yes does it — once.
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Log out' }));

    expect(logout).toHaveBeenCalledTimes(1);
  });

  // Appearance is a setting, not a peer of the places you work.
  it('nests theme and colours inside the account, not in the drawer', () => {
    renderRail('/feed', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Self sections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));

    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Colours' })).toBeInTheDocument();
  });

  // Collapsed, the account is the avatar — click still opens its sections
  // as icons in the rail, same as every other group, rather than a dead end
  // to /self only.
  it('collapses the account to a single link to Self', () => {
    renderRail();

    expect(screen.getByRole('link', { name: /Test User/ })).toHaveAttribute('href', '/self');
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
  });

  it('opens Self sections from the collapsed account avatar', () => {
    renderRail('/feed', { expanded: false });

    fireEvent.click(screen.getByRole('link', { name: /Test User/ }));

    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
  });

  // Support and Docs were two permanent rows for one question.
  it('puts Support and Docs under one Help entry', () => {
    renderRail('/feed', { expanded: true });

    const help = screen.getByRole('button', { name: 'Help' });

    expect(screen.queryByRole('link', { name: 'Support' })).not.toBeInTheDocument();

    fireEvent.click(help);

    expect(screen.getByRole('link', { name: 'Support' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Docs' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      'https://ci.computer/privacy-policy',
    );
  });

  // The rail floats over the content when pinned open, so the lane it sits in
  // keeps the collapsed width and the page beside it never reflows.
  it('does not reflow the page when the rail opens', () => {
    const { container } = renderRail();

    const lane = container.querySelector('div.relative');
    const nav = screen.getByRole('navigation');

    expect(lane).toHaveClass('w-14');
    expect(nav).toHaveClass('absolute');
  });

  // The toggle shares the rail's `auto` grid column, so a wordmark appearing
  // there widens the column and shoves the page — the exact reflow the
  // absolute drawer above exists to avoid.
  it('keeps the wordmark collapsed until the rail is pinned', () => {
    renderToggleAndRail();

    expect(screen.getByText('Companion Memory')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(screen.getByText('Companion Memory')).toHaveAttribute('aria-hidden', 'false');
  });

  // `end={false}`: both halves are Sources, and the rail should say so on
  // either one — as a filled cell, not a `border-l` bent into a "(" by the
  // cell's rounded corners.
  it.each(['/sources', '/sources/connect', '/sources/import'])('marks itself active on %s', (route) => {
    renderRail(route);

    const sources = screen.getByRole('link', { name: 'Sources' });

    expect(sources).toHaveClass('bg-primary/10', 'text-primary');
    expect(sources.className).not.toMatch(/border-l/);
  });

  it('leaves the collapsed icons of groups you are not in unfilled', () => {
    renderRail('/sources');

    expect(screen.getByRole('link', { name: 'Memory' })).not.toHaveClass('bg-primary/10');
    expect(screen.getByRole('link', { name: 'Planning' })).not.toHaveClass('bg-primary/10');
  });

  // Distinct from the mobile drawer's "Main navigation drawer" label (see
  // MobileNavigation.test.tsx) so assistive tech can tell the two apart.
  it('labels the desktop rail nav distinctly from the mobile drawer nav', () => {
    renderRail();

    expect(screen.getByRole('navigation')).toHaveAttribute('aria-label', 'Main navigation');
  });

  it('stays icon-only until the rail is opened', () => {
    renderRail();

    expect(screen.getByRole('navigation')).toHaveAttribute('data-state', 'collapsed');
    expect(screen.queryByText('Memory')).not.toBeInTheDocument();
  });

  it('shows labels when expanded, without a Sources submenu', () => {
    renderRail('/plan', { expanded: true });

    expect(screen.getByRole('navigation')).toHaveAttribute('data-state', 'expanded');
    expect(screen.getByText('Planning')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Connect' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import' })).not.toBeInTheDocument();
  });

  it('shows Memory hub sections when expanded, and keeps them open on a hub route', () => {
    renderRail('/memory/people', { expanded: true });

    expect(screen.getByRole('link', { name: 'Memory' })).toHaveAttribute('href', '/memory');
    expect(screen.getByRole('link', { name: 'Events' })).toHaveAttribute('href', '/memory/events');
    expect(screen.getByRole('link', { name: 'People' })).toHaveAttribute('href', '/memory/people');
    expect(screen.getByRole('link', { name: 'Places' })).toHaveAttribute('href', '/memory/places');
    expect(screen.getByRole('link', { name: 'Things' })).toHaveAttribute('href', '/memory/things');
    expect(screen.getByRole('link', { name: 'Content' })).toHaveAttribute('href', '/memory/content');
    expect(screen.getByRole('link', { name: 'Tags' })).toHaveAttribute('href', '/memory/tags');
    expect(screen.getByRole('link', { name: 'People' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Memory' })).not.toHaveAttribute('aria-current');
  });

  it('selects Memory itself on the unfiltered explorer, not the Events submenu', () => {
    renderRail('/memory', { expanded: true });

    expect(screen.getByRole('link', { name: 'Memory' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Events' })).not.toHaveAttribute('aria-current');
  });

  // Reflections moved from Memory into Self — one sub-section list, same
  // collapsible pattern, driven by SELF_SECTIONS instead of MEMORY_HUB_SECTIONS.
  it('shows Self sections when expanded, and keeps them open on a self route', () => {
    renderRail('/self/stats', { expanded: true });

    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/self');
    expect(screen.getByRole('link', { name: 'Stats' })).toHaveAttribute('href', '/self/stats');
    expect(screen.getByRole('link', { name: 'Reflections' })).toHaveAttribute('href', '/self/reflections');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings/appearance');
    expect(screen.getByRole('link', { name: 'Stats' })).toHaveAttribute('aria-current', 'page');
  });

  it('keeps Self sections open on the settings overlay and marks Settings current', () => {
    renderRail('/settings/appearance', { expanded: true });

    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Profile' })).not.toHaveAttribute('aria-current');
  });

  it('opens Self sections when the account tile is clicked', () => {
    renderRail('/plan', { expanded: true });

    expect(screen.queryByRole('link', { name: 'Stats' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Test User' }));
    expect(screen.getByRole('link', { name: 'Stats' })).toBeInTheDocument();
  });

  it('keeps Self sections open after a sticky chevron open even off self routes', () => {
    renderRail('/plan', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Self sections' }));
    expect(screen.getByRole('link', { name: 'Stats' })).toBeInTheDocument();
  });

  it('closes Self sections when the chevron is clicked', () => {
    renderRail('/plan', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Self sections' }));
    expect(screen.getByRole('link', { name: 'Stats' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Self sections' }));
    expect(screen.queryByRole('link', { name: 'Stats' })).not.toBeInTheDocument();
  });

  it('stays closed after a chevron close even on a Self route', () => {
    renderRail('/self/stats', { expanded: true });

    expect(screen.getByRole('link', { name: 'Stats' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Self sections' }));
    expect(screen.queryByRole('link', { name: 'Stats' })).not.toBeInTheDocument();
  });

  it('opens Memory sections when the Memory link is clicked', () => {
    renderRail('/plan', { expanded: true });

    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Memory' }));
    expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();
  });

  it('keeps Memory sections open after a sticky chevron open even off hub routes', () => {
    renderRail('/plan', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Memory sections' }));
    expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();
  });

  it('closes Memory sections when the chevron is clicked', () => {
    renderRail('/plan', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Memory sections' }));
    expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Memory sections' }));
    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
  });

  // Share (a link I mint) and Ask (a request they mint) are both a bounded
  // search run as me. Two peer rows read as two unrelated places, which is
  // what the grouping was meant to fix.
  it('folds Asks into the Saved Searches group instead of a peer row', () => {
    renderRail('/plan', { expanded: true });

    expect(screen.queryByRole('link', { name: 'Asks' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Saved Searches sections' }));

    expect(screen.getByRole('link', { name: 'Saved Searches' })).toHaveAttribute('href', '/saved-searches');
    expect(screen.getByRole('link', { name: 'Asks' })).toHaveAttribute('href', '/asks');
  });

  it('keeps Saved Searches a single icon in the collapsed rail, with no separate Asks row', () => {
    renderRail();

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));

    expect(hrefs).toContain('/saved-searches');
    expect(hrefs).not.toContain('/asks');
  });

  it('opens the Saved Searches group on an Asks route', () => {
    renderRail('/asks', { expanded: true });

    expect(screen.getByRole('link', { name: 'Asks' })).toHaveAttribute('aria-current', 'page');
  });

  // Chat lives inside Memory now (/memory/chat) — a bounded view over your
  // own history, the same as Events/People/Places, not a peer of Memory.
  it('lists Chat as a Memory hub section, not a peer rail row', () => {
    renderRail('/plan', { expanded: true });

    expect(screen.queryByRole('link', { name: 'Chat' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Memory sections' }));

    expect(screen.getByRole('link', { name: 'Chat' })).toHaveAttribute('href', '/memory/chat');
  });

  // The point of the submenu: pick a conversation from the menu, not from a
  // second chat UI nested in it. Threads render under Chat's own row, inside
  // Memory's list — the phone drawer is how you change conversation from
  // outside Chat, since ChatSidebar portals to a slot the mobile layout never
  // renders (inside Chat the phone has PhoneChatBar).
  it('lists recent threads as links under Chat, inside the Memory group', () => {
    recentThreads.current = [
      { id: 't1', name: 'Dinner plans' },
      { id: 't2', name: null },
    ];

    renderRail('/memory/chat', { expanded: true });

    expect(screen.getByRole('link', { name: 'Dinner plans' })).toHaveAttribute('href', '/memory/chat/t1');
    expect(screen.getByRole('link', { name: 'Thread t2' })).toHaveAttribute('href', '/memory/chat/t2');
  });

  // Titles arrive late, and "Thread 01a0fd3b" reads the same for every chat started in the same minute.
  it('names untitled threads by when they started, so the rows can be told apart', () => {
    recentThreads.current = [
      { id: '01a0fd3b-aaaa', name: null, createdAt: '2026-10-02T16:24:00Z' },
      { id: '01a0fd3b-bbbb', name: null, createdAt: '2026-10-02T17:31:00Z' },
    ];

    renderRail('/memory/chat', { expanded: true });

    expect(screen.queryByRole('link', { name: /^Thread / })).not.toBeInTheDocument();

    const labels = screen.getAllByRole('link', { name: /^Chat · / }).map((link) => link.textContent);

    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
  });

  it('opens the Memory group on a thread deep-link and marks the thread current', () => {
    recentThreads.current = [{ id: 't1', name: 'Dinner plans' }];

    renderRail('/memory/chat/t1', { expanded: true });

    const thread = screen.getByRole('link', { name: 'Dinner plans' });

    expect(thread).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Chat' })).not.toHaveAttribute('aria-current');
  });

  // Chat's threads are a third level: capped, so they cannot push the rest of
  // the rail off a phone screen, with the rest one tap away in place — on a
  // phone the Chat page itself has no thread list to send you to.
  describe('recent threads under Chat', () => {
    const threads = ['Dinner plans', 'Trip', 'Gift ideas', 'Groceries', 'Movie night'].map((name, index) => ({
      id: `t${index + 1}`,
      name,
    }));

    it('shows the three newest, then All chats', () => {
      recentThreads.current = threads;

      renderRail('/memory/chat', { expanded: true });

      expect(screen.getByRole('link', { name: 'Dinner plans' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Trip' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Gift ideas' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Groceries' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Movie night' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'All chats' })).toBeInTheDocument();
      // Nested by indentation now, not by a label at Memory's own indent.
      expect(screen.queryByText(/^recent$/i)).not.toBeInTheDocument();
    });

    it('opens the rest in place with All chats, and folds them again', () => {
      recentThreads.current = threads;

      renderRail('/memory/chat', { expanded: true });

      fireEvent.click(screen.getByRole('button', { name: 'All chats' }));

      expect(screen.getByRole('link', { name: 'Groceries' })).toHaveAttribute('href', '/memory/chat/t4');
      expect(screen.getByRole('link', { name: 'Movie night' })).toHaveAttribute('href', '/memory/chat/t5');

      fireEvent.click(screen.getByRole('button', { name: 'Fewer chats' }));

      expect(screen.queryByRole('link', { name: 'Groceries' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'All chats' })).toBeInTheDocument();
    });

    it('offers no All chats when every thread already shows', () => {
      recentThreads.current = threads.slice(0, 3);

      renderRail('/memory/chat', { expanded: true });

      expect(screen.getAllByRole('link', { name: /Dinner plans|Trip|Gift ideas/ })).toHaveLength(3);
      expect(screen.queryByRole('button', { name: 'All chats' })).not.toBeInTheDocument();
    });

    it('keeps the thread you are in showing when it is older than the three', () => {
      recentThreads.current = threads;

      renderRail('/memory/chat/t5', { expanded: true });

      expect(screen.getByRole('link', { name: 'Movie night' })).toHaveAttribute('aria-current', 'page');
      expect(screen.queryByRole('link', { name: 'Groceries' })).not.toBeInTheDocument();
    });

    it('sets threads one level under Chat, smaller and muted', () => {
      recentThreads.current = threads;

      renderRail('/memory/chat', { expanded: true });

      const thread = screen.getByRole('link', { name: 'Trip' });
      const chat = screen.getByRole('link', { name: 'Chat' });

      expect(thread).toHaveClass(
        'ml-7.5',
        'text-xs',
        'text-muted-foreground',
        'min-h-[36px]',
        'device:min-h-[28px]',
      );
      expect(chat).toHaveClass('ml-4.5', 'text-sm', 'min-h-[40px]', 'device:min-h-[32px]');
    });
  });

  it('does not fetch threads while the Memory group is closed', () => {
    recentThreads.current = [{ id: 't1', name: 'Dinner plans' }];

    renderRail('/plan', { expanded: true });

    expect(screen.queryByRole('link', { name: 'Dinner plans' })).not.toBeInTheDocument();
  });

  // A border on a rounded row follows its corners and draws a "(" beside the
  // label. The current page is a filled row with its own straight bar, set on
  // the group's guide line.
  it('marks the current page with a bar on the guide line, not a left border', () => {
    renderRail('/memory/people', { expanded: true });

    const people = screen.getByRole('link', { name: 'People' });
    const memory = screen.getByTestId('memory-submenu');

    expect(people).toHaveAttribute('aria-current', 'page');
    expect(people).toHaveClass('bg-primary/10', 'text-primary');
    expect(people.className).not.toMatch(/border-l/);
    expect(people.parentElement?.querySelector('[data-testid="rail-active-bar"]')).not.toBeNull();
    expect(within(memory).getAllByTestId('rail-active-bar')).toHaveLength(1);
    expect(within(memory).getByTestId('rail-guide')).toBeInTheDocument();
    expect(
      screen
        .getByRole('link', { name: 'Events' })
        .parentElement?.querySelector('[data-testid="rail-active-bar"]'),
    ).toBeNull();
  });

  // Sections, their rows and the rows under those are three heights, so the
  // hierarchy reads at a glance: 44 / 40 / 36px to a thumb, 36 / 32 / 28px on
  // the desktop rail (`device:`).
  it('sizes sections and their rows by level', () => {
    renderRail('/memory/people', { expanded: true });

    const memoryHead = screen.getByRole('link', { name: 'Memory' }).parentElement;

    expect(memoryHead).toHaveClass('min-h-[44px]', 'device:min-h-[36px]');
    expect(screen.getByRole('link', { name: 'People' })).toHaveClass('min-h-[40px]', 'device:min-h-[32px]');
  });

  it('draws the places you work and the machinery behind them as two clusters', () => {
    renderRail('/feed', { expanded: true });

    const [work, system] = screen.getAllByTestId('rail-cluster');

    expect(within(work).getByRole('link', { name: 'Planning' })).toBeInTheDocument();
    expect(within(work).getByRole('link', { name: 'Memory' })).toBeInTheDocument();
    expect(within(work).getByRole('link', { name: 'Saved Searches' })).toBeInTheDocument();
    expect(within(system).getByRole('link', { name: 'Sources' })).toBeInTheDocument();
    expect(within(system).getByRole('link', { name: 'Jobs' })).toBeInTheDocument();
    expect(within(system).getByRole('link', { name: 'Approvals' })).toBeInTheDocument();
    // A hairline and space between them, never a heading.
    expect(system).toHaveClass('border-t');
    expect(work).not.toHaveClass('border-t');
  });

  // Help and the account are what you reach for from anywhere, so they stay
  // put under a divider while the destinations above them scroll.
  it('pins Help and the account under a divider, outside the scrolling list', () => {
    renderRail('/feed', { expanded: true });

    const list = screen.getByTestId('rail-scroll');
    const footer = screen.getByTestId('rail-footer');

    expect(list).toHaveClass('overflow-y-auto');
    expect(within(list).getByRole('link', { name: 'Planning' })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Help' })).not.toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: 'Help' })).toBeInTheDocument();
    expect(within(footer).getByRole('link', { name: 'Test User' })).toBeInTheDocument();
    expect(footer).toHaveClass('border-t', 'shrink-0');
    expect(list.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Capture is mobile-only (the overlay drawer) — desktop already has it in
  // the header Add menu, so a second, always-visible entry point in the
  // pinned/hover rail would be one too many.
  it('does not list Capture on the desktop rail', () => {
    renderRail();

    expect(screen.queryByRole('button', { name: 'Capture' })).not.toBeInTheDocument();
  });

  it('lists the spine with Forecast and Self at the foot', () => {
    renderRail();

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));

    expect(hrefs.indexOf('/plan')).toBeLessThan(hrefs.indexOf('/memory'));
    expect(hrefs.indexOf('/memory')).toBeLessThan(hrefs.indexOf('/saved-searches'));
    expect(hrefs.indexOf('/saved-searches')).toBeLessThan(hrefs.indexOf('/sources'));
    expect(hrefs.indexOf('/sources')).toBeLessThan(hrefs.indexOf('/jobs'));
    // Forecast sits below Jobs, off the primary six, while its flag ships false.
    expect(hrefs.indexOf('/jobs')).toBeLessThan(hrefs.indexOf('/forecast'));
    expect(hrefs.indexOf('/forecast')).toBeLessThan(hrefs.indexOf('/self'));
    // Settings lives inside Self, not as its own last row.
    expect(hrefs).not.toContain('/settings/appearance');
    expect(hrefs).not.toContain('/self/settings');
  });
});

describe('PowerRailToggle', () => {
  it('opens and closes the rail instead of navigating home', () => {
    renderToggleAndRail();

    const toggle = screen.getByRole('button', { name: 'Open menu' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'power-rail');
    expect(screen.queryByRole('link', { name: /Companion Memory/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Memory')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Memory')).toBeInTheDocument();
    expect(screen.getByText('Companion Memory')).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));

    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Companion Memory')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByText('Main')).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
  });

  // The rail widens only on a deliberate click of the pin toggle — brushing
  // past it with the pointer must never expand it, and aria-expanded must
  // only ever track that pin.
  it('does not expand the rail on hover — only a click of the pin toggle does', () => {
    const { container } = renderToggleAndRail();

    const toggle = container.querySelector('button[aria-controls="power-rail"]');
    const lane = container.querySelector('div.relative');

    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.mouseEnter(lane as Element);

    // Hover does nothing to the rail any more...
    expect(screen.getByRole('navigation')).toHaveAttribute('data-state', 'collapsed');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.mouseLeave(lane as Element);

    // ...only a deliberate pin does.
    fireEvent.click(toggle as Element);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('navigation')).toHaveAttribute('data-state', 'expanded');
  });
});

describe('Self user tile', () => {
  it('no longer hides Connections in the account menu', () => {
    renderRail('/plan', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Self sections' }));

    expect(screen.queryByRole('link', { name: /Connections/i })).not.toBeInTheDocument();
  });

  it('keeps Jobs in the rail, not inside the user tile', () => {
    renderRail('/plan', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Self sections' }));

    expect(screen.getByRole('link', { name: 'Jobs' })).toHaveAttribute('href', '/jobs');
    expect(
      within(screen.getByTestId('self-submenu')).queryByRole('link', { name: 'Jobs' }),
    ).not.toBeInTheDocument();
  });
});

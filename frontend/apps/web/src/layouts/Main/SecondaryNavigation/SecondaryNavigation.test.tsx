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

const recentThreads = vi.hoisted(() => ({ current: [] as { id: string; name: string | null }[] }));

vi.mock('@/pages/ChatPage/useRecentThreads', async () => {
  const actual =
    await vi.importActual<typeof import('@/pages/ChatPage/useRecentThreads')>(
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
    useAuth: () => [{ isAuthenticated: true, authToken: 'token' }, { logout: vi.fn() }],
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

  it('carries Plan in the primary rail', () => {
    renderRail();

    expect(screen.getByRole('link', { name: 'Plan' })).toHaveAttribute('href', '/plan');
  });

  it('carries Forecast and Calendar in the primary rail', () => {
    renderRail();

    expect(screen.getByRole('link', { name: 'Forecast' })).toHaveAttribute('href', '/forecast');
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/calendar');
  });

  // Schedule and Brief were folded into Calendar, so the rail must not offer a
  // second way to reach either — that was the point of combining them.
  it('no longer offers Schedule or Brief as their own destinations', () => {
    renderRail();

    expect(screen.queryByRole('link', { name: 'Schedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Brief' })).not.toBeInTheDocument();
  });

  // One row that opens for theme and log out — not five flat ones sitting
  // level with the places you actually work. Settings itself is no longer
  // one of the things behind that chevron: it's its own bottom-anchored rail
  // row (SettingsRailButton), reachable without opening Self at all — the
  // whole point being it used to have no icon in the collapsed rail at all.
  it('keeps the account to one user tile that opens for theme and log out', () => {
    renderRail('/feed', { expanded: true });

    const account = screen.getByRole('link', { name: 'Test User' });

    expect(account).toHaveAttribute('href', '/self');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings/appearance');
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand Self sections' }));

    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
  });

  // Appearance is a setting, not a peer of the places you work.
  it('nests theme and colours inside the account, not in the drawer', () => {
    renderRail('/feed', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Self sections' }));
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));

    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Colours' })).toBeInTheDocument();
  });

  // Collapsed, the account is the avatar and one destination — a 56px rail is
  // no place for a nested accordion.
  it('collapses the account to a single link to Self', () => {
    renderRail();

    expect(screen.getByRole('link', { name: /Test User/ })).toHaveAttribute('href', '/self');
  });

  // Support and Docs were two permanent rows for one question.
  it('puts Support and Docs under one Help entry', () => {
    renderRail('/feed', { expanded: true });

    const help = screen.getByRole('button', { name: 'Help' });

    expect(screen.queryByRole('link', { name: 'Support' })).not.toBeInTheDocument();

    fireEvent.click(help);

    expect(screen.getByRole('link', { name: 'Support' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Docs' })).toBeInTheDocument();
  });

  // The drawer floats over the content on hover, so the lane it sits in keeps
  // the collapsed width and the page beside it never reflows.
  it('does not reflow the page when hover opens it', () => {
    const { container } = renderRail();

    const lane = container.querySelector('div.relative');
    const nav = screen.getByRole('navigation');

    expect(lane).toHaveClass('w-14');
    expect(nav).toHaveClass('absolute');
  });

  // The toggle shares the rail's `auto` grid column, so a wordmark appearing
  // there on hover widens the column and shoves the page — the exact reflow
  // the absolute drawer above exists to avoid.
  it('keeps the wordmark collapsed until the rail is pinned', () => {
    renderToggleAndRail();

    expect(screen.getByText('Companion Memory')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));

    expect(screen.getByText('Companion Memory')).toHaveAttribute('aria-hidden', 'false');
  });

  // `end={false}`: both halves are Sources, and the rail should say so on
  // either one.
  it.each(['/sources', '/sources/connect', '/sources/import'])('marks itself active on %s', (route) => {
    renderRail(route);

    expect(screen.getByRole('link', { name: 'Sources' })).toHaveClass('border-l-primary');
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
    expect(screen.getByText('Plan')).toBeInTheDocument();
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
    expect(screen.getByRole('link', { name: 'Stats' })).toHaveAttribute('aria-current', 'page');
  });

  it('opens Self sections on hover when expanded, and closes after leave when not sticky', () => {
    renderRail('/plan', { expanded: true });

    expect(screen.queryByRole('link', { name: 'Stats' })).not.toBeInTheDocument();

    const submenu = screen.getByTestId('self-submenu');
    fireEvent.mouseEnter(submenu);
    expect(screen.getByRole('link', { name: 'Stats' })).toBeInTheDocument();

    fireEvent.mouseLeave(submenu);
    expect(screen.queryByRole('link', { name: 'Stats' })).not.toBeInTheDocument();
  });

  it('keeps Self sections open after a sticky chevron open even off self routes', () => {
    renderRail('/plan', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Self sections' }));
    expect(screen.getByRole('link', { name: 'Stats' })).toBeInTheDocument();
  });

  it('closes Self sections when the chevron is clicked, even while hovered', () => {
    renderRail('/plan', { expanded: true });

    const submenu = screen.getByTestId('self-submenu');
    fireEvent.mouseEnter(submenu);
    expect(screen.getByRole('link', { name: 'Stats' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Self sections' }));
    expect(screen.queryByRole('link', { name: 'Stats' })).not.toBeInTheDocument();
  });

  it('stays closed after a chevron close even on a Self route', () => {
    renderRail('/self/stats', { expanded: true });

    expect(screen.getByRole('link', { name: 'Stats' })).toBeInTheDocument();

    const submenu = screen.getByTestId('self-submenu');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Self sections' }));
    expect(screen.queryByRole('link', { name: 'Stats' })).not.toBeInTheDocument();

    fireEvent.mouseLeave(submenu);
    expect(screen.queryByRole('link', { name: 'Stats' })).not.toBeInTheDocument();

    fireEvent.mouseEnter(submenu);
    expect(screen.queryByRole('link', { name: 'Stats' })).not.toBeInTheDocument();
  });

  it('opens Memory sections on hover when expanded, and closes after leave when not sticky', () => {
    renderRail('/plan', { expanded: true });

    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();

    const submenu = screen.getByTestId('memory-submenu');
    fireEvent.mouseEnter(submenu);
    expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();

    fireEvent.mouseLeave(submenu);
    expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
  });

  it('keeps Memory sections open after a sticky chevron open even off hub routes', () => {
    renderRail('/plan', { expanded: true });

    fireEvent.click(screen.getByRole('button', { name: 'Expand Memory sections' }));
    expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();
  });

  it('closes Memory sections when the chevron is clicked, even while hovered', () => {
    renderRail('/plan', { expanded: true });

    const submenu = screen.getByTestId('memory-submenu');
    fireEvent.mouseEnter(submenu);
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
  // Memory's list — the phone drawer is the only way to change conversation
  // there, since ChatSidebar portals to a slot the mobile layout never renders.
  it('lists recent threads as links under Chat, inside the Memory group', () => {
    recentThreads.current = [
      { id: 't1', name: 'Dinner plans' },
      { id: 't2', name: null },
    ];

    renderRail('/memory/chat', { expanded: true });

    expect(screen.getByRole('link', { name: 'Dinner plans' })).toHaveAttribute('href', '/memory/chat/t1');
    expect(screen.getByRole('link', { name: 'Thread t2' })).toHaveAttribute('href', '/memory/chat/t2');
  });

  it('opens the Memory group on a thread deep-link and marks the thread current', () => {
    recentThreads.current = [{ id: 't1', name: 'Dinner plans' }];

    renderRail('/memory/chat/t1', { expanded: true });

    const thread = screen.getByRole('link', { name: 'Dinner plans' });

    expect(thread).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Chat' })).not.toHaveAttribute('aria-current');
  });

  it('does not fetch threads while the Memory group is closed', () => {
    recentThreads.current = [{ id: 't1', name: 'Dinner plans' }];

    renderRail('/plan', { expanded: true });

    expect(screen.queryByRole('link', { name: 'Dinner plans' })).not.toBeInTheDocument();
  });

  // Capture is mobile-only (the overlay drawer) — desktop already has it in
  // the header Add menu, so a second, always-visible entry point in the
  // pinned/hover rail would be one too many.
  it('does not list Capture on the desktop rail', () => {
    renderRail();

    expect(screen.queryByRole('button', { name: 'Capture' })).not.toBeInTheDocument();
  });

  it('lists the spine with Forecast, Self, and Settings at the foot', () => {
    renderRail();

    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));

    expect(hrefs.indexOf('/plan')).toBeLessThan(hrefs.indexOf('/calendar'));
    expect(hrefs.indexOf('/calendar')).toBeLessThan(hrefs.indexOf('/memory'));
    expect(hrefs.indexOf('/memory')).toBeLessThan(hrefs.indexOf('/saved-searches'));
    expect(hrefs.indexOf('/saved-searches')).toBeLessThan(hrefs.indexOf('/sources'));
    expect(hrefs.indexOf('/sources')).toBeLessThan(hrefs.indexOf('/jobs'));
    // Forecast sits below Jobs, off the primary six, while its flag ships false.
    expect(hrefs.indexOf('/jobs')).toBeLessThan(hrefs.indexOf('/forecast'));
    expect(hrefs.indexOf('/forecast')).toBeLessThan(hrefs.indexOf('/self'));
    // Settings is the last row of all — below Self, not nested inside it.
    expect(hrefs.indexOf('/self')).toBeLessThan(hrefs.indexOf('/settings/appearance'));
  });
});

describe('PowerRailToggle', () => {
  it('opens and closes the rail instead of navigating home', () => {
    renderToggleAndRail();

    const toggle = screen.getByRole('button', { name: 'Open menu' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'power-rail');
    expect(screen.queryByRole('link', { name: /Companion Intelligence/i })).not.toBeInTheDocument();
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

  // H4: hovering the rail open is a passing intention, not a decision — it
  // must not tell assistive tech the menu was deliberately expanded. Only a
  // pin (persisted, survives the pointer leaving) should.
  it('reports aria-expanded from pinned, not from a hover-only expansion', () => {
    const { container } = renderToggleAndRail();

    const toggle = container.querySelector('button[aria-controls="power-rail"]');
    const lane = container.querySelector('div.relative');

    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.mouseEnter(lane as Element);

    // Hover really did open the rail...
    expect(screen.getByRole('navigation')).toHaveAttribute('data-state', 'expanded');
    // ...but the toggle must not claim it as "expanded".
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.mouseLeave(lane as Element);

    // A deliberate pin is what flips it.
    fireEvent.click(toggle as Element);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
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
    expect(within(screen.getByTestId('self-submenu')).queryByRole('link', { name: 'Jobs' })).not.toBeInTheDocument();
  });
});

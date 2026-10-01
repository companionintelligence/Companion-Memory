import { Tooltip } from '@ci/shadcn';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PowerRailProvider } from '../PowerRailContext';

import { PlanningSubmenu } from './PlanningSubmenu';

const STORAGE_KEY = 'ci-power-rail-expanded';

const h = vi.hoisted(() => ({ planningPageEnabled: true, planBadgeCount: 0 }));

vi.mock('@/common/feature', async () => {
  const actual = await vi.importActual<typeof import('@/common/feature')>('@/common/feature');

  return {
    ...actual,
    useFeatures: () => ({
      isFeatureEnabled: (flag: string) => (flag === 'planning.page' ? h.planningPageEnabled : true),
    }),
  };
});

vi.mock('./useFeedBadgeCount', () => ({ useFeedBadgeCount: () => 0 }));
vi.mock('./usePlanBadgeCount', () => ({ usePlanBadgeCount: () => h.planBadgeCount }));

function renderSubmenu(route = '/plan', { expanded = true }: { expanded?: boolean } = {}) {
  if (expanded) {
    localStorage.setItem(STORAGE_KEY, 'true');
  }

  return render(
    <MemoryRouter initialEntries={[route]}>
      <PowerRailProvider>
        <Tooltip.Provider>
          <PlanningSubmenu />
        </Tooltip.Provider>
      </PowerRailProvider>
    </MemoryRouter>,
  );
}

describe('PlanningSubmenu', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    h.planningPageEnabled = true;
    h.planBadgeCount = 0;
  });

  it('collapses to a single icon link to /plan when the rail is collapsed', () => {
    renderSubmenu('/plan', { expanded: false });

    expect(screen.getByRole('link', { name: 'Planning' })).toHaveAttribute('href', '/plan');
    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();
  });

  it('hangs the collapsed count over the top of the icon, inside the row', () => {
    h.planBadgeCount = 3;
    renderSubmenu('/feed', { expanded: false });

    const count = within(screen.getByRole('link', { name: 'Planning' })).getByText('3');

    // Beside the icon as a flex sibling, the pill's `ml-auto` pushed it to the
    // lane's edge, where the rail's scrollport cut it off.
    expect(count.parentElement).toHaveClass('absolute', 'left-1/2', 'top-0', '-translate-x-1/2');
  });

  it('opens Planning section icons below the head when the collapsed icon is clicked', () => {
    renderSubmenu('/feed', { expanded: false });

    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Planning' }));

    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/plan/tasks');
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/plan/calendar');
    expect(screen.queryByText('Tasks')).not.toBeInTheDocument();
  });

  it('offers Tasks and Calendar once expanded and opened', () => {
    renderSubmenu('/plan/tasks');

    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/plan/tasks');
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/plan/calendar');
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');
  });

  it('hides Tasks, but keeps Calendar, when planning.page is off', () => {
    h.planningPageEnabled = false;
    renderSubmenu('/plan/calendar');

    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/plan/calendar');
  });

  // Tasks and Calendar start on Planning's label column, hung off a guide
  // line under its icon; the current one is filled and carries a straight
  // bar on that line instead of a `border-l` that bends round its corners.
  it('marks the current sub-view with a bar on the guide line', () => {
    renderSubmenu('/plan/tasks');

    const tasks = screen.getByRole('link', { name: 'Tasks' });
    const calendar = screen.getByRole('link', { name: 'Calendar' });

    expect(within(screen.getByTestId('planning-submenu')).getByTestId('rail-guide')).toBeInTheDocument();
    expect(tasks).toHaveClass('bg-primary/10', 'text-primary', 'ml-4.5');
    expect(tasks.className).not.toMatch(/border-l/);
    expect(tasks.parentElement?.querySelector('[data-testid="rail-active-bar"]')).not.toBeNull();
    expect(calendar).not.toHaveClass('bg-primary/10');
    expect(calendar.parentElement?.querySelector('[data-testid="rail-active-bar"]')).toBeNull();
  });

  // Planning itself is a section: on its own page its row fills, with no bar
  // (there is no guide line above a section to put one on).
  it('fills the Planning row itself on /plan', () => {
    renderSubmenu('/plan');

    const head = screen.getByRole('link', { name: 'Planning' });

    expect(head).toHaveAttribute('aria-current', 'page');
    expect(head.parentElement).toHaveClass('bg-primary/10', 'text-primary');
    expect(head.parentElement?.className).not.toMatch(/border-l/);
    expect(screen.queryByTestId('rail-active-bar')).not.toBeInTheDocument();
  });

  it('closes when the chevron is clicked, even off a /plan route the next render', () => {
    renderSubmenu('/plan/tasks');

    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Planning sections' }));

    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();
  });
});

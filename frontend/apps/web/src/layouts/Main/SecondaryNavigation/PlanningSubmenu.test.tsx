import { Tooltip } from '@ci/shadcn';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PowerRailProvider } from '../PowerRailContext';

import { PlanningSubmenu } from './PlanningSubmenu';

const STORAGE_KEY = 'ci-power-rail-expanded';

const h = vi.hoisted(() => ({ planningPageEnabled: true }));

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
vi.mock('./usePlanBadgeCount', () => ({ usePlanBadgeCount: () => 0 }));

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
  });

  it('collapses to a single icon link to /plan when the rail is collapsed', () => {
    renderSubmenu('/plan', { expanded: false });

    expect(screen.getByRole('link', { name: 'Planning' })).toHaveAttribute('href', '/plan');
    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();
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

  it('closes when the chevron is clicked, even off a /plan route the next render', () => {
    renderSubmenu('/plan/tasks');

    expect(screen.getByRole('link', { name: 'Tasks' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Planning sections' }));

    expect(screen.queryByRole('link', { name: 'Tasks' })).not.toBeInTheDocument();
  });
});

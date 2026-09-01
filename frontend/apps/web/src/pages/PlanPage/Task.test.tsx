import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { Task } from './Task';

function node(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'TaskType',
    id: 'dGFzazoxMTE=',
    title: 'Write the migration',
    description: null,
    status: 'open',
    priority: 3,
    parentId: null,
    dueAt: null,
    scheduledFor: null,
    placedOnCalendar: false,
    deferUntil: null,
    estimatedMinutes: null,
    completedAt: null,
    ...overrides,
  };
}

type TaskProps = Omit<React.ComponentProps<typeof Task>, 'task'>;

function renderTask(overrides: Record<string, unknown>, props: Partial<TaskProps> = {}) {
  return renderWithProviders(
    <ul>
      <Task
        task={node(overrides) as never}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
        onSchedule={vi.fn()}
        {...props}
      />
    </ul>,
    { mocks: [] },
  );
}

describe('Task actions', () => {
  it('labels the proposed actions Plan and Schedule so they stay on one row', () => {
    renderTask(
      { status: 'proposed' },
      {
        onAcceptProposed: vi.fn(),
        onDeclineProposed: vi.fn(),
        onAcceptAndSchedule: vi.fn(),
      },
    );

    expect(screen.getByRole('button', { name: /^plan$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^schedule$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^dismiss$/i })).toBeInTheDocument();
    expect(screen.getByTestId('proposed-actions')).toHaveClass('grid-cols-3', 'w-full');
    expect(screen.queryByRole('button', { name: /add to plan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add and schedule/i })).not.toBeInTheDocument();
  });

  it('keeps Plan, Schedule, and Dismiss in fixed columns even without a schedule handler', () => {
    renderTask({ status: 'proposed' }, { onAcceptProposed: vi.fn(), onDeclineProposed: vi.fn() });

    const buttons = screen.getByTestId('proposed-actions').querySelectorAll('button');

    expect([...buttons].map((button) => button.textContent)).toEqual(['Plan', 'Schedule', 'Dismiss']);
    expect(screen.getByRole('button', { name: /^schedule$/i })).toBeDisabled();
  });

  it('keeps the proposed buttons wired to their own handlers', () => {
    const onAcceptProposed = vi.fn();
    const onAcceptAndSchedule = vi.fn();

    renderTask({ status: 'proposed' }, { onAcceptProposed, onDeclineProposed: vi.fn(), onAcceptAndSchedule });

    fireEvent.click(screen.getByRole('button', { name: /^plan$/i }));
    expect(onAcceptProposed).toHaveBeenCalledWith('dGFzazoxMTE=');

    fireEvent.click(screen.getByRole('button', { name: /^schedule$/i }));
    expect(onAcceptAndSchedule).toHaveBeenCalledWith('dGFzazoxMTE=');
  });

  it('offers Plan, Schedule, and Dismiss on a pending calendar suggestion', () => {
    const onAcceptPending = vi.fn();
    const onDeclinePending = vi.fn();
    const onPlanPending = vi.fn();
    const onDismissPendingTask = vi.fn();

    renderTask(
      {},
      {
        pendingChangeId: 'change-1',
        pendingKind: 'schedule',
        onAcceptPending,
        onDeclinePending,
        onPlanPending,
        onDismissPendingTask,
      },
    );

    expect(screen.queryByText(/place on calendar/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^ignore$/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('pending-schedule-actions')).toHaveClass('grid-cols-3', 'w-full');

    fireEvent.click(screen.getByRole('button', { name: /^plan$/i }));
    expect(onPlanPending).toHaveBeenCalledWith('dGFzazoxMTE=', 'change-1');
    expect(onDeclinePending).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^schedule$/i }));
    expect(onAcceptPending).toHaveBeenCalledWith('change-1');

    fireEvent.click(screen.getByRole('button', { name: /^dismiss$/i }));
    expect(onDismissPendingTask).toHaveBeenCalledWith('dGFzazoxMTE=', 'change-1');
  });

  it('still offers Confirm for a pending change that is not a schedule', () => {
    renderTask(
      {},
      {
        pendingChangeId: 'change-2',
        pendingKind: 'split',
        onAcceptPending: vi.fn(),
        onDeclinePending: vi.fn(),
      },
    );

    expect(screen.getByRole('button', { name: /^confirm$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^dismiss$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^ignore$/i })).not.toBeInTheDocument();
    // A non-schedule proposal leaves the ordinary Schedule button alone.
    expect(screen.getByRole('button', { name: /^schedule$/i })).toBeInTheDocument();
  });

  it('offers Schedule on unscheduled open work', () => {
    const onSchedule = vi.fn();

    renderTask({}, { onSchedule });

    fireEvent.click(screen.getByRole('button', { name: /^schedule$/i }));

    expect(onSchedule).toHaveBeenCalledWith('dGFzazoxMTE=');
  });

  it('lets a long unscheduled title wrap to five lines before ellipsis', () => {
    renderTask({
      title:
        'Write the migration notes for the planning board so a long unscheduled title is not cut to a single line',
    });

    const title = screen.getByText(/write the migration notes/i);

    expect(title).toHaveClass('line-clamp-5');
    expect(title).not.toHaveClass('truncate');
  });
});

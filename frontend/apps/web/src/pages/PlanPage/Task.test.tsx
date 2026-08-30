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
    expect(screen.queryByRole('button', { name: /add to plan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add and schedule/i })).not.toBeInTheDocument();
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

  it('accepts a pending schedule with Schedule rather than Place on calendar', () => {
    const onAcceptPending = vi.fn();

    renderTask(
      {},
      {
        pendingChangeId: 'change-1',
        pendingKind: 'schedule',
        onAcceptPending,
        onDeclinePending: vi.fn(),
      },
    );

    expect(screen.queryByText(/place on calendar/i)).not.toBeInTheDocument();

    // One card, one Schedule: the pending row replaces the standalone button.
    const schedule = screen.getByRole('button', { name: /^schedule$/i });
    fireEvent.click(schedule);

    expect(onAcceptPending).toHaveBeenCalledWith('change-1');
    expect(screen.getByRole('button', { name: /^ignore$/i })).toBeInTheDocument();
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
    // A non-schedule proposal leaves the ordinary Schedule button alone.
    expect(screen.getByRole('button', { name: /^schedule$/i })).toBeInTheDocument();
  });

  it('offers Schedule on unscheduled open work', () => {
    const onSchedule = vi.fn();

    renderTask({}, { onSchedule });

    fireEvent.click(screen.getByRole('button', { name: /^schedule$/i }));

    expect(onSchedule).toHaveBeenCalledWith('dGFzazoxMTE=');
  });
});

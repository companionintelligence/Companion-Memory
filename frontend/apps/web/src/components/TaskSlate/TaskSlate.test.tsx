import { act, createEvent, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CANDIDATE_DRAG_TYPE } from '@/lib/scheduleDrag';
import { HOLD_MS, cancelSchedulePointerDrag, getSchedulePointerDrag } from '@/lib/schedulePointerDrag';
import { groupIntoSections } from '@/pages/PlanPage/taskSections';
import type { PlanTask } from '@/pages/PlanPage/usePlanTasks';
import { renderWithProviders } from '@/test/renderWithProviders';

import { TaskSlate, TaskSlateDrawer } from './TaskSlate';

const TODAY = '2026-08-23';

function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: 't1',
    title: 'Book the dentist',
    status: 'open',
    priority: 3,
    ...overrides,
  };
}

function backlog(tasks: PlanTask[]) {
  return groupIntoSections(tasks, TODAY).filter(
    (section) => section.key === 'proposed' || section.key === 'unscheduled',
  );
}

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const NOOP = { loading: false };

describe('TaskSlate — Plan backlog', () => {
  it('shows Proposed and Unscheduled from the same bucketing as Plan', async () => {
    renderWithProviders(
      <TaskSlate
        sections={backlog([
          task({ id: 'p1', title: 'Try this', status: 'proposed' }),
          task({ id: 'u1', title: 'Call Mum', dueAt: '2026-08-25T17:00:00.000Z' }),
        ])}
        {...NOOP}
      />,
    );

    expect(await screen.findByRole('heading', { name: /^proposed/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^unscheduled/i })).toBeInTheDocument();
    expect(screen.getByText('Try this')).toBeInTheDocument();
    expect(screen.getByText('Call Mum')).toBeInTheDocument();
    expect(screen.queryByText(/scheduled on calendar/i)).not.toBeInTheDocument();
  });

  it('does not put scheduled or done work on the rail', () => {
    renderWithProviders(
      <TaskSlate
        sections={backlog([
          task({
            id: 's1',
            title: 'Already placed',
            scheduledFor: '2026-08-24',
            dueAt: '2026-08-24T17:00:00.000Z',
          }),
          task({ id: 'd1', title: 'Finished', status: 'done' }),
        ])}
        {...NOOP}
      />,
    );

    expect(screen.queryByText('Already placed')).not.toBeInTheDocument();
    expect(screen.queryByText('Finished')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing in Proposed or Unscheduled/)).toBeInTheDocument();
  });

  it('stamps a card drag with the task id the calendar drop handlers already read', async () => {
    renderWithProviders(
      <TaskSlate
        sections={backlog([task({ id: 'task-9', title: 'Call Mum', dueAt: '2026-08-25T17:00:00.000Z' })])}
        {...NOOP}
      />,
    );

    const card = (await screen.findByText('Call Mum')).closest('li') as HTMLElement;
    const data: Record<string, string> = {};
    const event = createEvent.dragStart(card, {
      dataTransfer: {
        setData: (key: string, value: string) => {
          data[key] = value;
        },
        effectAllowed: '',
        types: [],
        getData: () => '',
      },
    });
    fireEvent(card, event);

    expect(data[CANDIDATE_DRAG_TYPE]).toBe('task-9');
    expect(data['text/plain']).toBe('Call Mum');
  });

  it('offers dismiss only on proposed cards', async () => {
    const onDismissProposed = vi.fn();

    renderWithProviders(
      <TaskSlate
        sections={backlog([
          task({ id: 'p1', title: 'Try this', status: 'proposed' }),
          task({ id: 'u1', title: 'Call Mum', dueAt: '2026-08-25T17:00:00.000Z' }),
        ])}
        {...NOOP}
        onDismissProposed={onDismissProposed}
      />,
    );

    fireEvent.click(await screen.findByLabelText('Dismiss Try this'));
    expect(onDismissProposed).toHaveBeenCalledWith('p1');
    expect(screen.queryByLabelText('Dismiss Call Mum')).not.toBeInTheDocument();
  });

  it('lists overdue after upcoming instead of pinning it to the column foot', async () => {
    renderWithProviders(
      <TaskSlate
        sections={backlog([
          task({ id: 'u1', title: 'Call Mum', dueAt: '2026-08-25T17:00:00.000Z' }),
          task({ id: 'o1', title: 'Pay the bill', dueAt: '2026-08-20T17:00:00.000Z' }),
        ])}
        {...NOOP}
      />,
    );

    const upcoming = await screen.findByRole('heading', { name: /^upcoming/i });
    const overdue = screen.getByRole('heading', { name: /^overdue/i });

    expect(upcoming.compareDocumentPosition(overdue) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(overdue.parentElement).not.toHaveClass('mt-auto');
  });
});

describe('TaskSlate — the header hint', () => {
  it('tells you what to do with the cards that are there', () => {
    renderWithProviders(<TaskSlate sections={backlog([task({ status: 'proposed' })])} {...NOOP} />);

    expect(screen.getByText('drag one onto a day above')).toBeInTheDocument();
  });

  it('says nothing at all when the rail is empty', () => {
    renderWithProviders(<TaskSlate sections={[]} {...NOOP} />);

    expect(screen.queryByText('unplaced')).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing in Proposed or Unscheduled/)).toBeInTheDocument();
  });
});

describe('TaskSlate — failed and loading fetches', () => {
  it('shows the slate as failed rather than empty', () => {
    renderWithProviders(<TaskSlate sections={[]} loading={false} error />);

    expect(screen.getByText(/Could not load your plan/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing in Proposed or Unscheduled/)).not.toBeInTheDocument();
  });

  it('says it is loading only while there is nothing to show yet', () => {
    renderWithProviders(<TaskSlate sections={[]} loading />);

    expect(screen.getByText(/Loading your plan/)).toBeInTheDocument();
  });
});

describe('TaskSlate — phone tabs', () => {
  afterEach(() => {
    setViewport(false);
    cancelSchedulePointerDrag();
    vi.useRealTimers();
  });

  it('shows one Plan column at a time behind a tablist', async () => {
    setViewport(true);

    renderWithProviders(
      <TaskSlate
        sections={backlog([
          task({ id: 'p1', title: 'Try this', status: 'proposed' }),
          task({ id: 'u1', title: 'Call Mum', dueAt: '2026-08-20T17:00:00.000Z' }),
        ])}
        {...NOOP}
      />,
    );

    expect(await screen.findByRole('tablist')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^proposed/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Try this')).toBeInTheDocument();
    expect(screen.queryByText('Call Mum')).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: /unscheduled/i }), { button: 0 });

    expect(await screen.findByText('Call Mum')).toBeInTheDocument();
    expect(screen.queryByText('Try this')).not.toBeInTheDocument();
  });

  it('tells a phone to drag the handle rather than hold the card', async () => {
    setViewport(true);

    renderWithProviders(<TaskSlate sections={backlog([task({ status: 'proposed' })])} {...NOOP} />);

    expect(await screen.findByText('drag the handle onto the day above')).toBeInTheDocument();
  });

  it('picks a card up after a touch hold so it can be dropped on the calendar', async () => {
    setViewport(true);
    vi.useFakeTimers();

    renderWithProviders(
      <TaskSlate
        sections={backlog([task({ id: 'task-9', title: 'Call Mum', status: 'proposed' })])}
        {...NOOP}
      />,
    );

    const card = screen.getByText('Call Mum').closest('li') as HTMLElement;
    fireEvent.pointerDown(card, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
      button: 0,
    });

    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });

    expect(getSchedulePointerDrag()?.payload).toEqual({
      kind: 'candidate',
      id: 'task-9',
      title: 'Call Mum',
    });

    fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 });
    expect(getSchedulePointerDrag()).toBeNull();

    vi.useRealTimers();
  });

  it('starts a drag from the six-dot handle without waiting for a hold', async () => {
    setViewport(true);

    renderWithProviders(
      <TaskSlate
        sections={backlog([task({ id: 'task-9', title: 'Call Mum', status: 'proposed' })])}
        {...NOOP}
      />,
    );

    const handle = await screen.findByRole('button', { name: /drag call mum onto the calendar/i });
    fireEvent.pointerDown(handle, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
      button: 0,
    });

    expect(getSchedulePointerDrag()?.payload).toEqual({
      kind: 'candidate',
      id: 'task-9',
      title: 'Call Mum',
    });

    fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 80 });
    expect(getSchedulePointerDrag()).toBeNull();
  });
});

/**
 * On a phone the backlog moves off the calendar board entirely. It is reachable
 * — that is the point of the drawer — but it is not a second place to schedule
 * work, because the drawer covers the only day column the phone has.
 */
describe('TaskSlateDrawer — the phone drawer', () => {
  afterEach(() => setViewport(false));

  it('stays shut until it is asked for', () => {
    renderWithProviders(
      <TaskSlateDrawer
        open={false}
        onOpenChange={() => {}}
        sections={backlog([task({ status: 'proposed' })])}
        {...NOOP}
      />,
    );

    expect(screen.queryByText('Book the dentist')).not.toBeInTheDocument();
  });

  it('lists the backlog without offering a drag onto a calendar it covers', async () => {
    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        sections={backlog([task({ id: 'p1', title: 'Try this', status: 'proposed' })])}
        {...NOOP}
      />,
    );

    const card = (await screen.findByText('Try this')).closest('li') as HTMLElement;

    expect(card).toHaveAttribute('draggable', 'false');
    expect(
      screen.queryByRole('button', { name: /drag try this onto the calendar/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Schedule it on the Plan page/)).toBeInTheDocument();
  });

  it('still lets a proposed card be declined', async () => {
    const onDismissProposed = vi.fn();

    renderWithProviders(
      <TaskSlateDrawer
        open
        onOpenChange={() => {}}
        sections={backlog([task({ id: 'p1', title: 'Try this', status: 'proposed' })])}
        {...NOOP}
        onDismissProposed={onDismissProposed}
      />,
    );

    fireEvent.click(await screen.findByLabelText('Dismiss Try this'));
    expect(onDismissProposed).toHaveBeenCalledWith('p1');
  });

  it('says the plan failed rather than that there is nothing waiting', async () => {
    renderWithProviders(<TaskSlateDrawer open onOpenChange={() => {}} sections={[]} loading={false} error />);

    expect(await screen.findByText(/Could not load your plan/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing in Proposed or Unscheduled/)).not.toBeInTheDocument();
  });

  it('does not tell an empty drawer to drop anything on a day', async () => {
    renderWithProviders(<TaskSlateDrawer open onOpenChange={() => {}} sections={[]} {...NOOP} />);

    expect(await screen.findByText(/Nothing in Proposed or Unscheduled/)).toBeInTheDocument();
    expect(screen.queryByText(/drop onto a day/)).not.toBeInTheDocument();
  });
});

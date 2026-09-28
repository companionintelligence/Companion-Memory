import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { SELECT_HOLD_MS, Task } from './Task';

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

vi.mock('@/components/ChatWithAgent/AgentActionItems', () => ({
  AgentActionItems: () => null,
}));

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

/**
 * The decision row's layout contract. A Button is `whitespace-nowrap`, so a
 * button narrower than its label does not shrink the label — it spills into
 * the next button. That is how a narrow Proposed card came to read
 * "ScheduleDismiss". Each button must grow from a zero basis (equal widths when
 * they fit) and never go below its own label (so the row wraps instead).
 */
function expectWrappingDecisionRow(row: HTMLElement) {
  expect(row).toHaveClass('flex', 'flex-wrap', 'w-full');
  expect(row).not.toHaveClass('grid-cols-3');

  for (const button of row.querySelectorAll('button')) {
    expect(button).toHaveClass('min-w-fit', 'flex-1');
    expect(button).not.toHaveClass('min-w-0');
    expect(button).not.toHaveClass('w-full');
  }
}

describe('Task actions', () => {
  it('labels the proposed actions Plan and Schedule, short enough to share one row', () => {
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
    expectWrappingDecisionRow(screen.getByTestId('proposed-actions'));
    expect(screen.queryByRole('button', { name: /add to plan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add and schedule/i })).not.toBeInTheDocument();
  });

  it('keeps Plan, Schedule, and Dismiss in order even without a schedule handler', () => {
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
    expectWrappingDecisionRow(screen.getByTestId('pending-schedule-actions'));

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

  // ═══ SCHEDULING WORK YOU HANDED TO AN AGENT ═══
  //
  // `delegated` means an agent harness has the task. Offering to book a
  // calendar block for it puts a lie on the user's calendar, and the card
  // otherwise looks identical to an ordinary open task — so the status has to
  // read on the card, not just in the database.
  it('replaces Schedule with a Delegated marker once the task is handed off', () => {
    renderTask({ status: 'delegated' }, { onSchedule: vi.fn() });

    expect(screen.queryByRole('button', { name: /^schedule$/i })).not.toBeInTheDocument();
    expect(screen.getByText('Delegated')).toBeInTheDocument();
  });

  it('does not offer Reschedule on an overdue delegated task either', () => {
    // `isOverdue` is what gates the Reschedule button, and `sectionFor` keeps
    // a delegated task out of the Overdue lane — so this is the card-level
    // proof that the two agree.
    renderTask({ status: 'delegated', dueAt: '2020-01-02T12:00:00.000Z' }, { onReschedule: vi.fn() });

    expect(screen.queryByRole('button', { name: /reschedule write the migration/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^schedule$/i })).not.toBeInTheDocument();
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

  // Only prop-passing was ever asserted here: if Trash stopped calling
  // onDelete, or Pencil stopped calling onEdit, nothing failed.
  it('edits from the desktop pencil', () => {
    const onEdit = vi.fn();

    renderTask({ description: 'First draft', estimatedMinutes: 30 }, { onEdit });

    fireEvent.click(screen.getByRole('button', { name: /edit write the migration/i }));

    expect(onEdit).toHaveBeenCalledWith({
      id: 'dGFzazoxMTE=',
      title: 'Write the migration',
      description: 'First draft',
      dueAt: null,
      estimatedMinutes: 30,
    });
  });

  it('deletes from the desktop trash', () => {
    const onDelete = vi.fn();

    renderTask({}, { onDelete });

    fireEvent.click(screen.getByRole('button', { name: /delete write the migration/i }));

    expect(onDelete).toHaveBeenCalledWith('dGFzazoxMTE=');
  });

  it('keeps chat, edit and delete in the card head on a wide screen', () => {
    renderTask({}, { onEdit: vi.fn() });

    expect(screen.queryByTestId('task-action-layer')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('task-head')).getByTestId('task-overflow-actions')).toBeInTheDocument();
    expect(screen.getByTestId('plan-task')).toHaveClass('p-3');
  });

  // ═══ ONE CHARACTER PER LINE ═══
  //
  // A wide WINDOW used to mean the icons sat on the title row, whatever the
  // card's own width. The board splits the window four ways, so at ~1024px the
  // checkbox and three 36px icons took the whole of a ~140px card and the title
  // and rationale rendered one character per line. jsdom cannot lay anything
  // out, so this pins the classes that decide it: the card is a size container,
  // the lead (checkbox + text) takes a whole line of its head by default and
  // only shares it with the icons from 22rem of card, and the icons are the
  // lead's sibling — not inside it — so they are free to wrap below it.
  it('gives the title the full card width until the card itself is wide', () => {
    renderTask({}, { onEdit: vi.fn() });

    const card = screen.getByTestId('plan-task');
    const head = screen.getByTestId('task-head');
    const lead = screen.getByTestId('task-lead');
    const icons = screen.getByTestId('task-overflow-actions');

    expect(card).toHaveClass('@container/task', 'min-w-0');
    expect(head).toHaveClass('flex', 'flex-wrap');
    expect(lead).toHaveClass('min-w-0', 'basis-full', '@[22rem]/task:basis-0', '@[22rem]/task:grow');
    expect(icons.parentElement).toBe(head);
    expect(lead).not.toContainElement(icons);
    expect(icons).toHaveClass('shrink-0');
    expect(screen.getByText('Write the migration')).toHaveClass('min-w-0', 'flex-1', 'break-words');
  });

  // Schedule used to live inside the text column, under the title. Outside
  // it, a narrow card can put it on the icons' line; a wide card moves it to a
  // line of its own, indented to the text (checkbox 1rem + gap 0.75rem).
  it('lets Schedule join the icons on a narrow card and sit under the text on a wide one', () => {
    renderTask({});

    const buttons = screen.getByTestId('task-buttons');

    expect(buttons.parentElement).toBe(screen.getByTestId('task-head'));
    expect(screen.getByTestId('task-lead')).not.toContainElement(buttons);
    expect(buttons).toHaveClass('flex-wrap', 'min-w-0', '@[22rem]/task:basis-full', '@[22rem]/task:pl-7');
    expect(within(buttons).getByRole('button', { name: /^schedule$/i })).toBeInTheDocument();
  });

  it('wraps a pending change’s rationale inside the card instead of widening it', () => {
    renderTask(
      {},
      {
        pendingChangeId: 'change-1',
        pendingKind: 'schedule',
        pendingRationale: 'Place on the calendar on Mon, Sep 28 at 9:00 AM?',
        onAcceptPending: vi.fn(),
        onDeclinePending: vi.fn(),
      },
    );

    const rationale = screen.getByTestId('task-rationale');

    expect(rationale).toHaveTextContent('Place on the calendar on Mon, Sep 28 at 9:00 AM?');
    expect(rationale).toHaveClass('break-words');
    expect(screen.getByTestId('task-lead')).toContainElement(rationale);
  });

  it('reschedules to a day picked from the calendar input, not just the chips', () => {
    const onReschedule = vi.fn();

    renderTask({ dueAt: '2020-01-02T12:00:00.000Z' }, { onReschedule });

    fireEvent.click(screen.getByRole('button', { name: /reschedule write the migration/i }));
    fireEvent.change(screen.getByLabelText(/pick a day/i), { target: { value: '2099-03-05' } });

    expect(onReschedule).toHaveBeenCalledWith('dGFzazoxMTE=', '2099-03-05');
    expect(screen.queryByRole('group', { name: /reschedule to/i })).not.toBeInTheDocument();
  });

  it('backs out of the reschedule picker without moving the task', () => {
    const onReschedule = vi.fn();

    renderTask({ dueAt: '2020-01-02T12:00:00.000Z' }, { onReschedule });

    fireEvent.click(screen.getByRole('button', { name: /reschedule write the migration/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(onReschedule).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: /reschedule to/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reschedule write the migration/i })).toBeInTheDocument();
  });

  // 16px is well under any touch-target guidance, and completing a task is the
  // primary action on the card. The ::before keeps the box its own size while
  // growing its target, so a near-miss no longer lands on the title button and
  // opens the edit modal.
  it('gives the completion checkbox a tap target bigger than the box', () => {
    renderTask({});

    const checkbox = screen.getByRole('checkbox', { name: /complete write the migration/i });

    expect(checkbox).toHaveClass('relative', 'before:absolute');
    expect(tapTargetReach(checkbox, 'y')).toBeGreaterThanOrEqual(8);
    expect(tapTargetReach(checkbox, 'left')).toBeGreaterThanOrEqual(8);
  });
});

/** Tailwind spacing steps this file asserts on, in CSS pixels. */
const SPACING_PX: Record<string, number> = { '1': 4, '1.5': 6, '2': 8, '2.5': 10, '3': 12, '4': 16 };

function spacingOf(className: string | undefined): number {
  return SPACING_PX[className?.slice(className.lastIndexOf('-') + 1) ?? ''] ?? Number.NaN;
}

/**
 * How far the checkbox's `::before` tap target reaches past the box on one
 * side, in px — reading whichever utility actually governs that side, so a
 * uniform `-inset-*` is measured the same as a per-side one.
 */
function tapTargetReach(checkbox: HTMLElement, side: 'left' | 'right' | 'y'): number {
  const classes = [...checkbox.classList];
  const axis = side === 'y' ? 'y' : 'x';

  return spacingOf(
    classes.find((name) => name.startsWith(`before:-${side}-`)) ??
      classes.find((name) => name.startsWith(`before:-inset-${axis}-`)) ??
      classes.find((name) => /^before:-inset-(?![xy]-)/.test(name)),
  );
}

/** The flex `gap-*` separating the checkbox from what sits beside it, in px. */
function rowGap(checkbox: HTMLElement): number {
  const row = checkbox.parentElement as HTMLElement;

  return spacingOf([...row.classList].find((name) => /^gap-\d/.test(name)));
}

// `setup.ts` stubs matchMedia to never match, so every case above renders the
// desktop card and the phone half of this component was untested.
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

function holdTitle(init: Partial<PointerEventInit> = {}) {
  fireEvent.pointerDown(screen.getByRole('button', { name: /^write the migration$/i }), {
    pointerId: 1,
    pointerType: 'touch',
    clientX: 10,
    clientY: 10,
    button: 0,
    ...init,
  });
}

describe('Task on a phone', () => {
  afterEach(() => {
    setViewport(false);
    vi.useRealTimers();
  });

  it('edits from the action layer next to Schedule', () => {
    const onEdit = vi.fn();

    setViewport(true);
    renderTask({ description: 'First draft', estimatedMinutes: 30 }, { onEdit });

    const layer = screen.getByTestId('task-action-layer');

    expect(within(layer).getByRole('button', { name: /^schedule$/i })).toBeInTheDocument();
    fireEvent.click(within(layer).getByRole('button', { name: /edit write the migration/i }));

    expect(onEdit).toHaveBeenCalledWith({
      id: 'dGFzazoxMTE=',
      title: 'Write the migration',
      description: 'First draft',
      dueAt: null,
      estimatedMinutes: 30,
    });
  });

  // ═══ THE TAP TARGET USED TO EAT THE TITLE'S FIRST PIXELS ═══
  //
  // A uniform 10px `::before` is wider than the phone row's whole 8px gap, and
  // the checkbox is positioned while the title button was not — so the target
  // painted over the title's left edge and a tap there completed the task
  // instead of opening edit. The target may reach the padding on every other
  // side; to the right it may not out-reach the gap.
  it('keeps the checkbox tap target out of the title button', () => {
    setViewport(true);
    renderTask({});

    const checkbox = screen.getByRole('checkbox', { name: /complete write the migration/i });

    expect(rowGap(checkbox)).toBe(8);
    expect(tapTargetReach(checkbox, 'right')).toBeLessThanOrEqual(rowGap(checkbox));
    // Still a real target, not one shrunk back to the 16px box.
    expect(tapTargetReach(checkbox, 'y')).toBeGreaterThanOrEqual(8);
    // Belt and braces: the title is positioned too, so it paints above
    // anything that ever does reach over it.
    expect(screen.getByRole('button', { name: /^write the migration$/i })).toHaveClass('relative');
  });

  it('deletes from the action layer next to Schedule', () => {
    const onDelete = vi.fn();

    setViewport(true);
    renderTask({}, { onDelete });

    fireEvent.click(
      within(screen.getByTestId('task-action-layer')).getByRole('button', {
        name: /delete write the migration/i,
      }),
    );

    expect(onDelete).toHaveBeenCalledWith('dGFzazoxMTE=');
  });

  // The chevron is the ONLY way to read a description on a phone and used to be
  // shrunk to 32px next to a much larger title button that opens the edit modal.
  it('tightens the card and sits the overflow next to Schedule', () => {
    setViewport(true);
    renderTask({}, { onEdit: vi.fn() });

    const card = screen.getByTestId('plan-task');
    const layer = screen.getByTestId('task-action-layer');

    expect(card).toHaveClass('p-2');
    expect(card).not.toHaveClass('p-3');
    expect(within(layer).getByTestId('task-overflow-actions')).toBeInTheDocument();
    expect(within(layer).getByRole('button', { name: /^schedule$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
  });

  it('keeps the description chevron at the full icon-button size', () => {
    setViewport(true);
    renderTask({ description: 'First draft' });

    const chevron = screen.getByRole('button', { name: /show description for write the migration/i });

    expect(chevron).toHaveClass('size-9');
    expect(chevron).not.toHaveClass('h-8', 'w-8');
  });

  it('enters selection after a deliberate hold', () => {
    const onLongPressSelect = vi.fn();

    setViewport(true);
    renderTask({}, { onLongPressSelect });

    vi.useFakeTimers();
    holdTitle();
    act(() => vi.advanceTimersByTime(SELECT_HOLD_MS));

    expect(onLongPressSelect).toHaveBeenCalledWith('dGFzazoxMTE=');
  });

  // A mouse pointer used to bail out of the gesture entirely, so an iPad with a
  // trackpad — or any desktop window narrowed under the mobile breakpoint —
  // could never reach selection, and bulk delete was unreachable for the whole
  // session. The hold duration and the move threshold are what separate a
  // deliberate hold from a click, not the pointer type.
  it('enters selection from a mouse hold too', () => {
    const onLongPressSelect = vi.fn();

    setViewport(true);
    renderTask({}, { onLongPressSelect });

    vi.useFakeTimers();
    holdTitle({ pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(SELECT_HOLD_MS));

    expect(onLongPressSelect).toHaveBeenCalledWith('dGFzazoxMTE=');
  });

  it('cancels the hold once the pointer moves far enough to be a scroll', () => {
    const onLongPressSelect = vi.fn();

    setViewport(true);
    renderTask({}, { onLongPressSelect });

    vi.useFakeTimers();
    holdTitle();
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 60 });
    act(() => vi.advanceTimersByTime(SELECT_HOLD_MS));

    expect(onLongPressSelect).not.toHaveBeenCalled();
  });

  it('keeps a small wobble inside the hold', () => {
    const onLongPressSelect = vi.fn();

    setViewport(true);
    renderTask({}, { onLongPressSelect });

    vi.useFakeTimers();
    holdTitle();
    fireEvent.pointerMove(window, { pointerId: 1, pointerType: 'touch', clientX: 14, clientY: 14 });
    act(() => vi.advanceTimersByTime(SELECT_HOLD_MS));

    expect(onLongPressSelect).toHaveBeenCalledWith('dGFzazoxMTE=');
  });

  it('opens edit instead of selecting when the pointer lifts before the hold', () => {
    const onLongPressSelect = vi.fn();
    const onEdit = vi.fn();

    setViewport(true);
    renderTask({}, { onLongPressSelect, onEdit });

    vi.useFakeTimers();
    holdTitle();
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(SELECT_HOLD_MS));
    vi.useRealTimers();

    expect(onLongPressSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /^write the migration$/i }));

    expect(onEdit).toHaveBeenCalled();
  });

  // ═══ THE HOLD USED TO OUTLIVE THE CARD ═══
  //
  // Radix Tabs unmounts the inactive Kanban panel, so a hold begun just before
  // a tab switch still fired — selecting a task the user could no longer see
  // and popping the "1 selected" bar over a different column.
  it('drops a hold in progress when the card unmounts', () => {
    const onLongPressSelect = vi.fn();

    setViewport(true);

    const { unmount } = renderTask({}, { onLongPressSelect });

    vi.useFakeTimers();
    holdTitle();
    unmount();
    act(() => vi.advanceTimersByTime(SELECT_HOLD_MS));

    expect(onLongPressSelect).not.toHaveBeenCalled();
  });
});

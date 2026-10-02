import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { UPDATE_TASK } from './EditTaskModal';
import { PlanPage } from './PlanPage';
import { SELECT_HOLD_MS } from './Task';
import { addLocalDays, dueAtFromLocalDate, localDateOf } from './taskSections';
import { DELETE_TASK } from './useDeleteTasks';
import {
  ACCEPT_PROPOSED,
  DECLINE_PROPOSED,
  GET_TASKS,
  PLAN_TASK,
  SCHEDULE_TASK,
  SCHEDULE_TASK_AT,
} from './usePlanTasks';

const featureState = vi.hoisted(() => ({ emptyState: false }));
const toastError = vi.hoisted(() => vi.fn());
/** The owner's profile zone `useCurrentUser` reports. */
const profile = vi.hoisted(() => ({ timezone: 'America/Los_Angeles' as string | null }));

// The page words pending suggestions on the owner's clock. `useCurrentUser`
// reaches for the auth context, which `renderWithProviders` deliberately does
// not mount — SchedulePage's test stubs it the same way.
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { id: 'u1', timezone: profile.timezone },
    loading: false,
    error: undefined,
    refetch: vi.fn(),
  }),
}));

// Sonner's `toast.error(...)` only renders into the DOM behind a mounted
// `<Toaster>`, which this page does not own — mocking the hook directly is
// what the rest of this codebase does to assert a toast fired without
// fighting portal/animation timing (see AsksPage's equivalent).
// #2558 put ChatWithAgentMenu/AgentActionItems inside Task; both reach for the
// auth hook context, which this harness does not mount. Task.test.tsx already
// stubs them for the same reason — mirrored here so PlanPage renders at all.
vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

vi.mock('@/components/ChatWithAgent/AgentActionItems', () => ({
  AgentActionItems: () => null,
}));

vi.mock('@ci/shadcn', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, useToast: () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }) };
});

/**
 * ═══ THE BOARD DOES NOT TEST THE DISPATCH MENU ═══
 *
 * #2558 hung `<ChatWithAgentMenu>` off every task card. It calls `useAuth()`,
 * and `renderWithProviders` deliberately does not provide Auth context (it
 * fetches on mount), so from that commit onwards every test in this file threw
 * "undefined must be used within the associated Provider" before it could
 * assert anything — 18 of 30, red on `main` and unnoticed because CI here is
 * dispatch-only. `Task.test.tsx` stubs the same component for the same reason.
 *
 * Spread over `importOriginal()` rather than an allow-list: this is the barrel,
 * and a bare object would also blank `ChatAbout` / `useChatAboutActions` for
 * anything else in the tree that reaches them.
 */
vi.mock('@/components/ChatWithAgent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ChatWithAgentMenu: () => null,
}));

vi.mock('@/components/ChatWithAgent/AgentActionItems', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  AgentActionItems: () => null,
}));

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({
    isFeatureEnabled: (name: string) => (name === 'planning.emptyState' ? featureState.emptyState : false),
  }),
}));

const COMPLETE_TASK = gql(`
  mutation CompleteTask($id: ID!) {
    completeTask(id: $id) {
      id
      status
      completedAt
    }
  }
`);

const DECLINE_PENDING = gql(`
  mutation DeclineTaskPendingChange($id: ID!) {
    declineTaskPendingChange(id: $id) {
      success
    }
  }
`);

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

function pendingChange(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'TaskPendingChangeType',
    id: 'change-1',
    taskId: 'dGFzazoxMTE=',
    kind: 'schedule',
    patch: {
      startTime: '2026-08-29T16:00:00.000Z',
      endTime: '2026-08-29T16:30:00.000Z',
      estimatedMinutes: 30,
    },
    // Worded the way every row filed before the server fix still is.
    rationale: 'Place on the calendar at 2026-08-29T16:00:00.000Z?',
    confidence: 0.8,
    status: 'pending',
    ...overrides,
  };
}

function tasksMock(nodes: ReturnType<typeof node>[], changes: ReturnType<typeof pendingChange>[] = []) {
  return {
    request: { query: GET_TASKS, variables: { first: 200 } },
    result: {
      data: {
        tasks: {
          __typename: 'TaskConnection',
          edges: nodes.map((n) => ({ __typename: 'TaskEdge', node: n })),
          totalCount: nodes.length,
        },
        taskPendingChanges: changes,
      },
    },
    // `cache-and-network` issues the query again on mount in the test
    // environment; without this the second read has no mock to satisfy it.
    maxUsageCount: Number.POSITIVE_INFINITY,
  };
}

describe('PlanPage', () => {
  beforeEach(() => {
    featureState.emptyState = false;
    profile.timezone = 'America/Los_Angeles';
    toastError.mockClear();
  });

  it('invites the user to add something when there is nothing planned and the empty state is enabled', async () => {
    featureState.emptyState = true;
    renderWithProviders(<PlanPage />, { mocks: [tasksMock([])] });

    expect(await screen.findByText(/nothing planned yet/i)).toBeInTheDocument();
  });

  it('does not show the empty state message when the feature flag is off', async () => {
    renderWithProviders(<PlanPage />, { mocks: [tasksMock([])] });

    await screen.findByLabelText(/new task title/i);
    expect(screen.queryByText(/nothing planned yet/i)).not.toBeInTheDocument();
  });

  // The COLUMNS are not the empty-state message and are not behind its flag.
  // With no tasks the board used to render nothing at all: a first-time user
  // saw an add-task box over blank space, with no hint that Proposed /
  // Unscheduled / Scheduled / Done exist or that the system proposes into them.
  // `withAllColumns` was written to keep empty columns and was never reached on
  // this path. The columns ARE the explanation of what this page does.
  it('shows the four columns even with nothing planned', async () => {
    renderWithProviders(<PlanPage />, { mocks: [tasksMock([])] });

    for (const column of ['Proposed', 'Unscheduled', 'Scheduled', 'Done']) {
      expect(await screen.findByText(column)).toBeInTheDocument();
    }
  });

  // ═══ THE COLUMNS USED TO SQUEEZE EVERY CARD ═══
  //
  // Four `flex-1` columns with an 11rem floor: just past the phone breakpoint
  // all four sat at that floor and the cards collapsed to a character a line.
  // The floor is now wide enough for a card, and the board scrolls sideways
  // below it rather than squeezing. jsdom cannot lay out, so the classes are
  // the contract.
  it('gives every board column a usable floor and scrolls the board sideways below it', async () => {
    renderWithProviders(<PlanPage />, { mocks: [tasksMock([node()])] });

    const board = await screen.findByTestId('plan-board');
    const columns = [...board.children];

    expect(board).toHaveClass('flex', 'overflow-x-auto');
    expect(columns).toHaveLength(4);

    for (const column of columns) {
      expect(column).toHaveClass('min-w-[13rem]', 'flex-1');
      expect(column).not.toHaveClass('min-w-[11rem]');
    }
  });

  // ═══ THE RATIONALE USED TO BE A RAW UTC TIMESTAMP ═══
  //
  // "Place on the calendar at 2026-08-29T16:00:00.000Z?" — the server spliced
  // `toISOString()` into the sentence and the card printed it verbatim. Those
  // rows are still stored that way, so the card words a schedule suggestion
  // from its patch's start instant, on the owner's profile clock.
  it('words a calendar suggestion on the owner’s clock, not as a raw ISO timestamp', async () => {
    renderWithProviders(<PlanPage />, { mocks: [tasksMock([node()], [pendingChange()])] });

    const rationale = await screen.findByTestId('task-rationale');

    expect(rationale).toHaveTextContent(/^Place on the calendar on /);
    expect(rationale.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    // 16:00Z is 9:00 in Los Angeles (PDT) — not 16:00, and not 4:00 PM. Read
    // loosely enough to hold in a 24-hour locale ("09:00") as well.
    expect(rationale.textContent).toMatch(/(^|\D)0?9:00(\D|$)/);
    expect(rationale.textContent).not.toMatch(/(^|\D)(16|4):00(\D|$)/);
  });

  it('follows the owner’s profile zone rather than a fixed one', async () => {
    profile.timezone = 'America/New_York';

    renderWithProviders(<PlanPage />, { mocks: [tasksMock([node()], [pendingChange()])] });

    // 16:00Z is noon in New York (EDT).
    expect((await screen.findByTestId('task-rationale')).textContent).toMatch(/\b12:00\b/);
  });

  it('shows a non-schedule suggestion in its own words', async () => {
    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock(
          [node()],
          [pendingChange({ kind: 'complete', patch: {}, rationale: 'Looks like this may be done.' })],
        ),
      ],
    });

    expect(await screen.findByTestId('task-rationale')).toHaveTextContent('Looks like this may be done.');
  });

  // A failed query used to render NOTHING — it fell through to the zero-task
  // branch, whose message is flag-gated off by default, so `content` was null.
  // Someone with forty tasks saw the same screen as someone with none, with no
  // spinner, message or retry, and the reasonable conclusion is that their plan
  // was wiped. `usePlanTasks` always returned this flag; nothing read it.
  it('says the plan could not be loaded rather than rendering a blank page', async () => {
    renderWithProviders(<PlanPage />, {
      mocks: [
        {
          request: { query: GET_TASKS, variables: { first: 200 } },
          error: new Error('offline'),
          maxUsageCount: Number.POSITIVE_INFINITY,
        },
      ],
    });

    expect(await screen.findByText(/could not load your plan/i)).toBeInTheDocument();
    // And it must not claim the tasks are gone.
    expect(screen.queryByText(/nothing planned yet/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('groups tasks under Kanban columns and lane headings', async () => {
    // Fixed "today" is impossible without controlling the clock, so anchor the
    // fixtures on the real one: sectioning is proved exhaustively in
    // taskSections.node.test.ts, and this only checks the wiring.
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([
          node({ id: 'a', title: 'Overdue thing', dueAt: yesterday.toISOString() }),
          node({ id: 'b', title: 'Someday thing' }),
          node({ id: 'c', title: 'Finished thing', status: 'done' }),
          node({ id: 'p', title: 'Proposed thing', status: 'proposed' }),
        ]),
      ],
    });

    expect(await screen.findByText('Overdue thing')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^unscheduled/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^overdue/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^proposed \d/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^done/i })).toBeInTheDocument();
    // Anchored with a word boundary: "Unscheduled" contains "scheduled" too.
    expect(screen.getByRole('heading', { name: /^scheduled\b/i })).toBeInTheDocument();
    expect(screen.getByText('Someday thing')).toBeInTheDocument();
    expect(screen.getByText('Proposed thing')).toBeInTheDocument();
    expect(screen.getByText('Finished thing')).toBeInTheDocument();
    expect(screen.getByText('1 overdue')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('lists overdue after upcoming instead of pinning it to the column foot', async () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([
          node({ id: 'a', title: 'Overdue thing', dueAt: yesterday.toISOString() }),
          node({ id: 'b', title: 'Upcoming thing', dueAt: tomorrow.toISOString() }),
        ]),
      ],
    });

    const upcoming = await screen.findByRole('heading', { name: /^upcoming/i });
    const overdue = screen.getByRole('heading', { name: /^overdue/i });

    expect(upcoming.compareDocumentPosition(overdue) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(overdue.parentElement).not.toHaveClass('mt-auto');
  });

  it('renders a completed task as checked and struck through', async () => {
    renderWithProviders(<PlanPage />, {
      mocks: [tasksMock([node({ title: 'Finished thing', status: 'done' })])],
    });

    const checkbox = await screen.findByRole('checkbox', { name: /reopen finished thing/i });

    expect(checkbox).toBeChecked();
  });

  it('completes a task when its checkbox is ticked', async () => {
    const completed = node({ status: 'done', completedAt: new Date().toISOString() });

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node()]),
        {
          request: { query: COMPLETE_TASK, variables: { id: 'dGFzazoxMTE=' } },
          result: {
            data: {
              completeTask: {
                __typename: 'TaskType',
                id: completed.id,
                status: 'done',
                completedAt: completed.completedAt,
              },
            },
          },
        },
      ],
    });

    const checkbox = await screen.findByRole('checkbox', { name: /complete write the migration/i });

    fireEvent.click(checkbox);

    // The mutation result normalises into the cache, flipping the row.
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: /reopen write the migration/i })).toBeChecked();
    });
  });

  it('disables the add button until a title is typed', async () => {
    renderWithProviders(<PlanPage />, { mocks: [tasksMock([])] });

    const button = await screen.findByRole('button', { name: /add/i });

    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/new task title/i), { target: { value: 'Something' } });

    expect(button).toBeEnabled();
  });

  it('does not submit a whitespace-only title', async () => {
    renderWithProviders(<PlanPage />, { mocks: [tasksMock([])] });

    await screen.findByLabelText(/new task title/i);
    fireEvent.change(screen.getByLabelText(/new task title/i), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: /add/i })).toBeDisabled();
  });

  it('shows a Schedule button on open work', async () => {
    renderWithProviders(<PlanPage />, { mocks: [tasksMock([node()])] });

    const schedule = await screen.findByRole('button', { name: /^schedule$/i });
    expect(schedule).toBeInTheDocument();
    expect(schedule).toHaveClass('ci-primary-surface');
    expect(screen.getByRole('button', { name: /edit write the migration/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^scheduled 0$/i })).toBeInTheDocument();
  });

  // ═══ THE PAYLOAD USED TO BE DISCARDED HERE ═══
  //
  // `scheduleTask` can legitimately return `success: false` with a real
  // `status` — `no_gap` when the flex window is fully booked, `skipped` when
  // the task can no longer be scheduled — and the button used to `.then(refresh)`
  // regardless, which re-renders the identical board and says nothing. On the
  // week most likely to hit this (a genuinely full one) the button read as dead.
  it('tells the user why Schedule did nothing, instead of silently re-rendering', async () => {
    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node()]),
        {
          request: { query: SCHEDULE_TASK, variables: { id: 'dGFzazoxMTE=' } },
          result: {
            data: {
              scheduleTask: {
                __typename: 'ScheduleTaskPayload',
                success: false,
                status: 'no_gap',
                task: null,
              },
            },
          },
        },
        tasksMock([node()]),
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: /^schedule$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/no free slot/i)));
  });

  it('says nothing when Schedule actually succeeds', async () => {
    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node()]),
        {
          request: { query: SCHEDULE_TASK, variables: { id: 'dGFzazoxMTE=' } },
          result: {
            data: {
              scheduleTask: {
                __typename: 'ScheduleTaskPayload',
                success: true,
                status: 'placed',
                task: node({ scheduledFor: localDateOf(new Date()), placedOnCalendar: true }),
              },
            },
          },
        },
        tasksMock([node({ scheduledFor: localDateOf(new Date()), placedOnCalendar: true })]),
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: /^schedule$/i }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^schedule$/i })).not.toBeInTheDocument(),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it('offers Reschedule on overdue work instead of a date-less Schedule', async () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const todayDate = localDateOf(today);

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node({ id: 'a', title: 'Overdue thing', dueAt: yesterday.toISOString() })]),
        {
          request: {
            query: UPDATE_TASK,
            variables: { input: { id: 'a', dueAt: dueAtFromLocalDate(todayDate) } },
          },
          result: {
            data: {
              updateTask: {
                __typename: 'UpdateTaskPayload',
                success: true,
                task: node({
                  id: 'a',
                  title: 'Overdue thing',
                  dueAt: dueAtFromLocalDate(todayDate),
                  scheduledFor: todayDate,
                }),
              },
            },
          },
        },
        {
          request: { query: SCHEDULE_TASK, variables: { id: 'a', date: todayDate } },
          result: {
            data: {
              scheduleTask: {
                __typename: 'ScheduleTaskPayload',
                success: true,
                status: 'placed',
                task: node({
                  id: 'a',
                  title: 'Overdue thing',
                  dueAt: dueAtFromLocalDate(todayDate),
                  scheduledFor: todayDate,
                }),
              },
            },
          },
          maxUsageCount: Number.POSITIVE_INFINITY,
        },
        tasksMock([
          node({
            id: 'a',
            title: 'Overdue thing',
            dueAt: dueAtFromLocalDate(todayDate),
            scheduledFor: todayDate,
          }),
        ]),
      ],
    });

    const reschedule = await screen.findByRole('button', { name: /reschedule overdue thing/i });

    expect(reschedule).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^schedule$/i })).not.toBeInTheDocument();

    fireEvent.click(reschedule);

    expect(screen.getByRole('group', { name: /reschedule to/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^today$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /^overdue/i })).not.toBeInTheDocument();
    });
  });

  /**
   * ═══ RESCHEDULE USED TO MOVE THE DUE DATE AND NOTHING ELSE ═══
   *
   * Overdue work very often already has a planned block, and the date-only
   * `scheduleTask` cannot move one — the server finds the existing block and
   * answers `already_placed` without running the gap solver. The due date had
   * already been written by then, so the block stayed on the day that had
   * passed, the card stayed in Overdue, and `already_placed` was reported as a
   * success, i.e. said nothing at all. A placed task goes through
   * `SCHEDULE_TASK_AT`, which reschedules the block it finds.
   *
   * The mocks match on variables, so sending the old pair would find no mock,
   * throw, and toast — which is why `toastError` is asserted on too.
   */
  it('moves the calendar block when rescheduling an already-placed task', async () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayDate = localDateOf(yesterday);
    const tomorrowDate = addLocalDays(localDateOf(today), 1);
    const movedAt = vi.fn();
    let afterMove = false;

    const block = (overrides: Record<string, unknown>) =>
      node({ id: 'a', title: 'Overdue thing', placedOnCalendar: true, ...overrides });

    const stillOverdue = block({ dueAt: yesterday.toISOString(), scheduledFor: yesterdayDate });
    const rescheduled = block({
      dueAt: dueAtFromLocalDate(tomorrowDate),
      scheduledFor: tomorrowDate,
    });

    // The board is refetched after the move, and that read is what the user
    // ends up looking at — `newData` is the refetch's answer, so the fixture
    // has to move with the task rather than answering "still overdue" forever.
    const board = (task: ReturnType<typeof node>) => ({
      data: {
        tasks: {
          __typename: 'TaskConnection',
          edges: [{ __typename: 'TaskEdge', node: task }],
          totalCount: 1,
        },
        taskPendingChanges: [],
      },
    });

    renderWithProviders(<PlanPage />, {
      mocks: [
        {
          request: { query: GET_TASKS, variables: { first: 200 } },
          maxUsageCount: Number.POSITIVE_INFINITY,
          result: () => board(afterMove ? rescheduled : stillOverdue),
          newData: () => board(afterMove ? rescheduled : stillOverdue),
        },
        {
          request: {
            query: UPDATE_TASK,
            // `scheduledFor` travels with the due date on this path only:
            // moving the event leaves the task's own date untouched server-side,
            // and `sectionFor` takes the EARLIEST of the two, so without it the
            // card would sit in Overdue on the strength of the stale one.
            variables: {
              input: {
                id: 'a',
                dueAt: dueAtFromLocalDate(tomorrowDate),
                scheduledFor: tomorrowDate,
              },
            },
          },
          result: {
            data: {
              updateTask: {
                __typename: 'UpdateTaskPayload',
                success: true,
                task: rescheduled,
              },
            },
          },
        },
        {
          request: {
            query: SCHEDULE_TASK_AT,
            variables: { id: 'a', startTime: dueAtFromLocalDate(tomorrowDate) },
          },
          result: () => {
            movedAt();
            afterMove = true;

            return {
              data: {
                scheduleTask: {
                  __typename: 'ScheduleTaskPayload',
                  success: true,
                  status: 'placed',
                  task: rescheduled,
                  event: {
                    __typename: 'EventType',
                    id: 'event-1',
                    startTime: dueAtFromLocalDate(tomorrowDate),
                    endTime: dueAtFromLocalDate(tomorrowDate),
                  },
                },
              },
            };
          },
          maxUsageCount: Number.POSITIVE_INFINITY,
        },
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: /reschedule overdue thing/i }));
    fireEvent.click(screen.getByRole('button', { name: /^tomorrow$/i }));

    await waitFor(() => expect(movedAt).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /^overdue/i })).not.toBeInTheDocument();
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  /**
   * `already_placed` was silent alongside `placed`. It is not a success —
   * nothing moved — and the board reaching it means the card was stale, which
   * is precisely when the user needs telling rather than shown a dead button.
   */
  it('says so when the server refuses because the task is already on the calendar', async () => {
    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node()]),
        {
          request: { query: SCHEDULE_TASK, variables: { id: 'dGFzazoxMTE=' } },
          result: {
            data: {
              scheduleTask: {
                __typename: 'ScheduleTaskPayload',
                success: false,
                status: 'already_placed',
                task: null,
              },
            },
          },
        },
        tasksMock([node()]),
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: /^schedule$/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/already has a block/i)),
    );
  });

  it('moves a yellow-date pending schedule into Unscheduled when Plan is clicked', async () => {
    const dated = node({ scheduledFor: '2026-08-29', placedOnCalendar: true });
    const planned = node({ status: 'open', scheduledFor: null, placedOnCalendar: false });
    let afterPlan = false;

    const board = (nodes: ReturnType<typeof node>[], changes: ReturnType<typeof pendingChange>[] = []) => ({
      tasks: {
        __typename: 'TaskConnection',
        edges: nodes.map((item) => ({ __typename: 'TaskEdge', node: item })),
        totalCount: nodes.length,
      },
      taskPendingChanges: changes,
    });

    renderWithProviders(<PlanPage />, {
      mocks: [
        {
          request: { query: GET_TASKS, variables: { first: 200 } },
          maxUsageCount: Number.POSITIVE_INFINITY,
          result: () => ({
            data: afterPlan ? board([planned]) : board([dated], [pendingChange()]),
          }),
          newData: () => ({
            data: afterPlan ? board([planned]) : board([dated], [pendingChange()]),
          }),
        },
        {
          request: { query: PLAN_TASK, variables: { id: dated.id } },
          result: () => {
            afterPlan = true;

            return {
              data: {
                planTask: {
                  __typename: 'TaskType',
                  id: dated.id,
                  status: 'open',
                  dueAt: null,
                  scheduledFor: null,
                  placedOnCalendar: false,
                },
              },
            };
          },
        },
      ],
    });

    expect(await screen.findByText(/place on the calendar on/i)).toBeInTheDocument();
    expect(screen.getByTestId('pending-schedule-actions')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^plan$/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('pending-schedule-actions')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/place on the calendar/i)).not.toBeInTheDocument();
    expect(screen.getByText('Write the migration')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^unscheduled/i })).toBeInTheDocument();
  });

  it('Plans a proposed card with a past suggested time into undated Unscheduled', async () => {
    const yesterday = addLocalDays(localDateOf(new Date()), -1);
    const proposed = node({
      status: 'proposed',
      scheduledFor: yesterday,
      dueAt: dueAtFromLocalDate(yesterday),
    });
    const planned = node({ status: 'open', scheduledFor: null, dueAt: null, placedOnCalendar: false });
    let afterPlan = false;

    const board = (nodes: ReturnType<typeof node>[]) => ({
      tasks: {
        __typename: 'TaskConnection',
        edges: nodes.map((item) => ({ __typename: 'TaskEdge', node: item })),
        totalCount: nodes.length,
      },
      taskPendingChanges: [],
    });

    renderWithProviders(<PlanPage />, {
      mocks: [
        {
          request: { query: GET_TASKS, variables: { first: 200 } },
          maxUsageCount: Number.POSITIVE_INFINITY,
          result: () => ({
            data: afterPlan ? board([planned]) : board([proposed]),
          }),
          newData: () => ({
            data: afterPlan ? board([planned]) : board([proposed]),
          }),
        },
        {
          request: { query: PLAN_TASK, variables: { id: proposed.id } },
          result: () => {
            afterPlan = true;

            return {
              data: {
                planTask: {
                  __typename: 'TaskType',
                  id: proposed.id,
                  status: 'open',
                  dueAt: null,
                  scheduledFor: null,
                  placedOnCalendar: false,
                },
              },
            };
          },
        },
      ],
    });

    expect(await screen.findByText(/suggested/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^plan$/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('proposed-actions')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/suggested/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^due /i)).not.toBeInTheDocument();
    expect(screen.getByText('Write the migration')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^unscheduled/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^overdue/i })).not.toBeInTheDocument();
  });

  // ═══ A THROWN MUTATION USED TO SAY NOTHING AT ALL ═══
  //
  // None of these paths had a `.catch`. A network or GraphQL failure aborted
  // the async block: no toast, no refetch, and the card just snapped back —
  // indistinguishable from a dead button.
  it('says so when Schedule throws instead of failing silently', async () => {
    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node()]),
        {
          request: { query: SCHEDULE_TASK, variables: { id: 'dGFzazoxMTE=' } },
          error: new Error('offline'),
        },
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: /^schedule$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not/i)));
  });

  it('says so when a reschedule throws', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const todayDate = localDateOf(new Date());

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node({ id: 'a', title: 'Overdue thing', dueAt: yesterday.toISOString() })]),
        {
          request: {
            query: UPDATE_TASK,
            variables: { input: { id: 'a', dueAt: dueAtFromLocalDate(todayDate) } },
          },
          error: new Error('offline'),
        },
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: /reschedule overdue thing/i }));
    fireEvent.click(screen.getByRole('button', { name: /^today$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not/i)));
  });

  it('says so when accepting a proposal and scheduling it throws', async () => {
    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node({ status: 'proposed' })]),
        {
          request: { query: ACCEPT_PROPOSED, variables: { id: 'dGFzazoxMTE=' } },
          error: new Error('offline'),
        },
      ],
    });

    await screen.findByTestId('proposed-actions');
    fireEvent.click(screen.getByRole('button', { name: /^schedule$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not/i)));
  });

  it('says so when dismissing a calendar suggestion throws', async () => {
    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node()], [pendingChange()]),
        {
          request: { query: DECLINE_PENDING, variables: { id: 'change-1' } },
          error: new Error('offline'),
        },
      ],
    });

    await screen.findByTestId('pending-schedule-actions');
    fireEvent.click(screen.getByRole('button', { name: /^dismiss$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not/i)));
  });

  // ═══ WHICH PENDING CHANGES A PROPOSAL'S DISMISS MAY ANSWER ═══
  //
  // Task renders the proposed row INSTEAD of the pending-schedule row, so a
  // dismissed proposal used to leave its `schedule` change open on the server
  // with no UI left that could ever answer it.
  it('declines an orphaned schedule suggestion when its proposal is dismissed', async () => {
    let declinedChange = false;

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node({ status: 'proposed' })], [pendingChange()]),
        {
          request: { query: DECLINE_PENDING, variables: { id: 'change-1' } },
          maxUsageCount: Number.POSITIVE_INFINITY,
          result: () => {
            declinedChange = true;

            return {
              data: {
                declineTaskPendingChange: {
                  __typename: 'ResolveTaskPendingChangePayload',
                  success: true,
                },
              },
            };
          },
        },
        {
          request: { query: DECLINE_PROPOSED, variables: { id: 'dGFzazoxMTE=' } },
          maxUsageCount: Number.POSITIVE_INFINITY,
          result: {
            data: {
              declineProposedTask: { __typename: 'TaskType', id: 'dGFzazoxMTE=', status: 'skipped' },
            },
          },
        },
      ],
    });

    const actions = await screen.findByTestId('proposed-actions');
    fireEvent.click(within(actions).getByRole('button', { name: /^dismiss$/i }));

    await waitFor(() => expect(declinedChange).toBe(true));
    expect(toastError).not.toHaveBeenCalled();
  });

  // …but a `split` (or any non-schedule) change renders its OWN Confirm/Dismiss
  // row alongside the proposed row. The user is answering that one themselves,
  // so dismissing the proposal must not answer it for them.
  it('leaves a non-schedule pending change alone when the proposal is dismissed', async () => {
    let declinedChange = false;
    let declinedProposal = false;

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock(
          [node({ status: 'proposed' })],
          [pendingChange({ kind: 'split', rationale: 'Split this into two steps?' })],
        ),
        {
          request: { query: DECLINE_PENDING, variables: { id: 'change-1' } },
          maxUsageCount: Number.POSITIVE_INFINITY,
          result: () => {
            declinedChange = true;

            return {
              data: {
                declineTaskPendingChange: {
                  __typename: 'ResolveTaskPendingChangePayload',
                  success: true,
                },
              },
            };
          },
        },
        {
          request: { query: DECLINE_PROPOSED, variables: { id: 'dGFzazoxMTE=' } },
          maxUsageCount: Number.POSITIVE_INFINITY,
          result: () => {
            declinedProposal = true;

            return {
              data: {
                declineProposedTask: { __typename: 'TaskType', id: 'dGFzazoxMTE=', status: 'skipped' },
              },
            };
          },
        },
      ],
    });

    const actions = await screen.findByTestId('proposed-actions');

    // Both rows are on this card, so the Dismiss under test has to be the
    // proposal's own — not the pending change's.
    expect(screen.getAllByRole('button', { name: /^dismiss$/i })).toHaveLength(2);
    fireEvent.click(within(actions).getByRole('button', { name: /^dismiss$/i }));

    await waitFor(() => expect(declinedProposal).toBe(true));
    expect(declinedChange).toBe(false);
  });

  // Column badges used to count roots only, so a column of three roots with
  // nine live subtasks read "3" — and an overdue subtask was summarised as not
  // existing at all.
  it('counts nested subtasks into the column badge and its overdue hint', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([
          node({ id: 'root', title: 'Parent thing' }),
          node({ id: 'kid', title: 'Child thing', parentId: 'root', dueAt: yesterday.toISOString() }),
        ]),
      ],
    });

    expect(await screen.findByText('Child thing')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^unscheduled 2/i })).toBeInTheDocument();
    expect(screen.getByText('1 overdue')).toBeInTheDocument();
  });

  it('lets an overdue missed block be moved with the same when chips', async () => {
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const tomorrow = addLocalDays(localDateOf(today), 1);
    const yesterdayDay = localDateOf(yesterday);

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([
          node({
            id: 'd',
            title: 'Missed block',
            dueAt: yesterday.toISOString(),
            scheduledFor: yesterdayDay,
            placedOnCalendar: true,
          }),
        ]),
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: /reschedule missed block/i }));

    expect(screen.getByRole('button', { name: /^tomorrow$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^next week$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/pick a day/i)).toHaveAttribute('min', localDateOf(today));
    expect(tomorrow).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

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

describe('PlanPage mobile tabs', () => {
  afterEach(() => setViewport(false));

  it('shows one section at a time behind a tablist', async () => {
    setViewport(true);

    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayDay = yesterday.toISOString().slice(0, 10);

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([
          node({ id: 'a', title: 'Overdue thing', dueAt: yesterday.toISOString() }),
          node({
            id: 'd',
            title: 'Missed block',
            dueAt: yesterday.toISOString(),
            scheduledFor: yesterdayDay,
            placedOnCalendar: true,
          }),
          node({ id: 'b', title: 'Someday thing' }),
          node({ id: 'c', title: 'Finished thing', status: 'done' }),
          node({ id: 'p', title: 'Proposed thing', status: 'proposed' }),
        ]),
      ],
    });

    expect(await screen.findByRole('tablist')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^proposed/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /unscheduled/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^scheduled\b/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^done/i })).toBeInTheDocument();
    expect(screen.getByText('Proposed thing')).toBeInTheDocument();
    expect(screen.queryByText('Someday thing')).not.toBeInTheDocument();
    expect(screen.queryByText('Overdue thing')).not.toBeInTheDocument();
    expect(screen.queryByText('Finished thing')).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: /unscheduled/i }), { button: 0 });

    expect(await screen.findByText('Overdue thing')).toBeInTheDocument();
    expect(screen.getByText('Someday thing')).toBeInTheDocument();
    expect(screen.queryByText('Proposed thing')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /unscheduled/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: /^overdue/i })).toBeInTheDocument();
    expect(screen.getByText('1 overdue')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /unscheduled/i })).not.toHaveTextContent(/overdue/i);
    expect(screen.getByRole('tab', { name: /^scheduled\b/i })).not.toHaveTextContent(/overdue/i);
  });

  // ═══ THE FOURTH TAB USED TO SIT OFF THE EDGE OF THE PHONE ═══
  //
  // The strip was one non-wrapping row that scrolled sideways, and four tabs
  // were wider than a 390pt phone: "Scheduled on calendar" was clipped at the
  // edge and Done was out of sight behind a swipe nothing hinted at. The label
  // is now just "Scheduled", which helps but still leaves four tabs a little
  // wider than that row — so the strip also wraps instead of scrolling. jsdom
  // lays nothing out, so this pins the classes that decide it (`h-auto` on the
  // triggers is what keeps WebKit from stretching the first row over the
  // second), and that all four tabs under their short names are there to show.
  it('names the third tab Scheduled and wraps the strip so no tab is scrolled out of sight', async () => {
    setViewport(true);

    renderWithProviders(<PlanPage />, { mocks: [tasksMock([node({ id: 'b', title: 'Someday thing' })])] });

    const list = await screen.findByRole('tablist');

    const tabs = within(list).getAllByRole('tab');

    expect(list).toHaveClass('flex-wrap');
    expect(list).not.toHaveClass('overflow-x-auto');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Proposed0', 'Unscheduled1', 'Scheduled0', 'Done0']);

    for (const tab of tabs) {
      expect(tab).toHaveClass('h-auto');
    }
  });

  it('keeps every category tab even when some columns are empty', async () => {
    setViewport(true);

    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    renderWithProviders(<PlanPage />, {
      mocks: [tasksMock([node({ id: 'a', title: 'Overdue thing', dueAt: yesterday.toISOString() })])],
    });

    expect(await screen.findByRole('tab', { name: /unscheduled/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^proposed 0$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^scheduled 0$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^done 0$/i })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: /^proposed 0$/i }), { button: 0 });

    expect(await screen.findByRole('tab', { name: /^proposed 0$/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByText('Overdue thing')).not.toBeInTheDocument();
  });

  // ═══ THE TAB USED TO MOVE UNDER THE USER ═══
  //
  // `boardTab` starts null and almost nothing sets it, so the board fell back
  // to "first non-empty column" on EVERY render. Emptying the visible column —
  // Dismiss on the last Proposed card — swapped the pane to a column the user
  // had never chosen, mid-gesture.
  it('stays on the column the user is reading after its last card leaves', async () => {
    setViewport(true);

    const proposed = node({ id: 'p', title: 'Proposed thing', status: 'proposed' });
    const other = node({ id: 'b', title: 'Someday thing' });
    let dismissed = false;

    const board = (nodes: ReturnType<typeof node>[]) => ({
      tasks: {
        __typename: 'TaskConnection',
        edges: nodes.map((item) => ({ __typename: 'TaskEdge', node: item })),
        totalCount: nodes.length,
      },
      taskPendingChanges: [],
    });

    renderWithProviders(<PlanPage />, {
      mocks: [
        {
          request: { query: GET_TASKS, variables: { first: 200 } },
          maxUsageCount: Number.POSITIVE_INFINITY,
          result: () => ({ data: board(dismissed ? [other] : [proposed, other]) }),
          newData: () => ({ data: board(dismissed ? [other] : [proposed, other]) }),
        },
        {
          request: { query: DECLINE_PROPOSED, variables: { id: 'p' } },
          result: () => {
            dismissed = true;

            return { data: { declineProposedTask: { __typename: 'TaskType', id: 'p', status: 'skipped' } } };
          },
        },
      ],
    });

    expect(await screen.findByRole('tab', { name: /^proposed 1$/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: /^dismiss$/i }));

    await waitFor(() => expect(screen.getByRole('tab', { name: /^proposed 0$/i })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: /^proposed 0$/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('Someday thing')).not.toBeInTheDocument();
  });

  // `handlePlan` toasts on failure but still shows Unscheduled — the `finally`
  // is load-bearing UX, and moving `showUnscheduled()` into the `try` would
  // change it silently. No test supplied a rejecting PLAN_TASK before this one.
  it('still shows Unscheduled when Plan fails, and says that it failed', async () => {
    setViewport(true);

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node({ title: 'Proposed thing', status: 'proposed' })]),
        {
          request: { query: PLAN_TASK, variables: { id: 'dGFzazoxMTE=' } },
          error: new Error('offline'),
        },
      ],
    });

    await screen.findByTestId('proposed-actions');
    fireEvent.click(screen.getByRole('button', { name: /^plan$/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/could not move that task/i)),
    );
    expect(screen.getByRole('tab', { name: /^unscheduled/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^proposed 1$/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('keeps edit and delete off the title row, and opens edit from the card body', async () => {
    setViewport(true);

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([
          node({
            title: 'Write the migration',
            description: 'A long note that should not open edit by itself.',
          }),
        ]),
      ],
    });

    const layer = await screen.findByTestId('task-action-layer');

    expect(within(layer).getByRole('button', { name: /edit write the migration/i })).toBeInTheDocument();
    expect(within(layer).getByRole('button', { name: /delete write the migration/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/a long note/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /show description for write the migration/i }));
    expect(screen.getByText(/a long note/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /edit task/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^write the migration$/i }));
    expect(await screen.findByRole('dialog', { name: /edit task/i })).toBeInTheDocument();
  });

  it('enters selection on a long-press and bulk-deletes once the count is confirmed', async () => {
    setViewport(true);

    renderWithProviders(<PlanPage />, {
      mocks: [
        tasksMock([node({ id: 'a', title: 'First thing' }), node({ id: 'b', title: 'Second thing' })]),
        {
          request: { query: DELETE_TASK, variables: { input: { id: 'a' } } },
          result: {
            data: { deleteTask: { __typename: 'DeleteTaskPayload', success: true, deletedId: 'a' } },
          },
        },
        {
          request: { query: DELETE_TASK, variables: { input: { id: 'b' } } },
          result: {
            data: { deleteTask: { __typename: 'DeleteTaskPayload', success: true, deletedId: 'b' } },
          },
        },
      ],
    });

    const first = await screen.findByRole('button', { name: /^first thing$/i });
    vi.useFakeTimers();
    fireEvent.pointerDown(first, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 10,
      clientY: 10,
      button: 0,
    });
    act(() => {
      vi.advanceTimersByTime(SELECT_HOLD_MS);
    });
    vi.useRealTimers();

    expect(await screen.findByTestId('plan-selection-bar')).toHaveTextContent('1 selected');

    fireEvent.click(screen.getByRole('button', { name: /^second thing$/i }));
    expect(screen.getByTestId('plan-selection-bar')).toHaveTextContent('2 selected');

    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    // The per-row trash control still deletes on the click itself; only this
    // bulk path confirms, because nothing else says how many are about to go.
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Delete 2 tasks?');
    fireEvent.click(screen.getByRole('button', { name: /^delete 2 tasks$/i }));

    await waitFor(() => expect(screen.queryByTestId('plan-selection-bar')).not.toBeInTheDocument());
  });
});

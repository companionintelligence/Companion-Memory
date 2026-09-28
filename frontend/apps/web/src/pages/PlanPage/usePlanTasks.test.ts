import { useMutation, useQuery } from '@apollo/client';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePlanTasks } from './usePlanTasks';

// Same technique as useEntityService.test.tsx: mock Apollo's hooks directly so
// the exact variables a mutation call sends can be asserted without spinning
// up MockedProvider for a document this test does not otherwise care about.
vi.mock('@apollo/client', async (orig) => ({
  ...(await orig<typeof import('@apollo/client')>()),
  useQuery: vi.fn(),
  useMutation: vi.fn(),
}));

const mockedUseQuery = vi.mocked(useQuery);
const mockedUseMutation = vi.mocked(useMutation);

const refetch = vi.fn();
const acceptProposed = vi.fn().mockResolvedValue({ data: { acceptProposedTask: { id: 't1' } } });
const declineProposed = vi.fn();
const scheduleTaskAt = vi.fn();

function node(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'TaskType',
    id: 't1',
    status: 'open',
    priority: 3,
    parentId: null,
    dueAt: null,
    scheduledFor: null,
    deferUntil: null,
    title: 'Write the deck',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  refetch.mockResolvedValue(undefined);
  acceptProposed.mockResolvedValue({ data: { acceptProposedTask: { id: 't1' } } });
  scheduleTaskAt.mockResolvedValue({
    data: { scheduleTask: { success: true, status: 'placed', task: null, event: null } },
  });

  mockedUseQuery.mockReturnValue({
    data: {
      tasks: { edges: [{ node: node() }], totalCount: 1 },
      taskPendingChanges: [],
    },
    loading: false,
    error: undefined,
    refetch,
  } as unknown as ReturnType<typeof useQuery>);

  // Three useMutation calls happen in this order inside usePlanTasks:
  // acceptProposed, declineProposed, scheduleTaskAt.
  mockedUseMutation
    .mockReturnValueOnce([acceptProposed, {}] as unknown as ReturnType<typeof useMutation>)
    .mockReturnValueOnce([declineProposed, {}] as unknown as ReturnType<typeof useMutation>)
    .mockReturnValueOnce([scheduleTaskAt, {}] as unknown as ReturnType<typeof useMutation>);
});

describe('usePlanTasks — placeOnDay', () => {
  // The whole point of SCHEDULE_TASK_AT: a calendar drop sends the exact
  // instant under the cursor, not a date the gap solver re-derives its own
  // time within. `localDateOf` would collapse '15:15' clean off the wire.
  it('sends the exact dropped instant, not just its calendar date', async () => {
    const { result } = renderHook(() => usePlanTasks());
    const dropped = new Date('2026-09-03T15:15:00.000Z');

    await act(async () => {
      await result.current.placeOnDay('t1', dropped);
    });

    expect(scheduleTaskAt).toHaveBeenCalledWith({
      variables: { id: 't1', startTime: dropped.toISOString() },
    });
  });

  it('accepts a proposed task before placing it, then places at the dropped instant', async () => {
    mockedUseQuery.mockReturnValue({
      data: {
        tasks: { edges: [{ node: node({ status: 'proposed' }) }], totalCount: 1 },
        taskPendingChanges: [],
      },
      loading: false,
      error: undefined,
      refetch,
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => usePlanTasks());
    const dropped = new Date('2026-09-03T09:00:00.000Z');

    await act(async () => {
      await result.current.placeOnDay('t1', dropped);
    });

    expect(acceptProposed).toHaveBeenCalledWith({ variables: { id: 't1' } });
    expect(scheduleTaskAt).toHaveBeenCalledWith({
      variables: { id: 't1', startTime: dropped.toISOString() },
    });
  });

  // `no_gap` / `already_placed` (etc.) come back as `success: false` rather
  // than a thrown error — the caller (SchedulePage's `run`) is what turns
  // this into a toast, and it can only do that if the rejection actually
  // carries the server's status string.
  it('throws the server status when placement is refused, rather than resolving silently', async () => {
    scheduleTaskAt.mockResolvedValue({
      data: { scheduleTask: { success: false, status: 'no_gap', task: null, event: null } },
    });

    const { result } = renderHook(() => usePlanTasks());

    await expect(result.current.placeOnDay('t1', new Date('2026-09-03T09:00:00.000Z'))).rejects.toThrow(
      'no_gap',
    );
  });
});

describe('usePlanTasks — backlogCount', () => {
  // The nav badge and the board's column badge are the same claim about the
  // same two sections, so they cannot disagree. `section.tasks` is roots only;
  // `section.count` is the subtree the column actually renders, and the board
  // has been reading that one since the column badges were fixed.
  it('counts nested subtasks, matching the column badge on the board', () => {
    mockedUseQuery.mockReturnValue({
      data: {
        tasks: {
          edges: [
            { node: node({ id: 'root', title: 'Parent thing' }) },
            { node: node({ id: 'kid', title: 'Child thing', parentId: 'root' }) },
          ],
          totalCount: 2,
        },
        taskPendingChanges: [],
      },
      loading: false,
      error: undefined,
      refetch,
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => usePlanTasks());
    const unscheduled = result.current.sections.find((section) => section.key === 'unscheduled');

    expect(unscheduled?.tasks).toHaveLength(1);
    expect(unscheduled?.count).toBe(2);
    expect(result.current.backlogCount).toBe(2);
  });
});

describe('usePlanTasks — pending changes', () => {
  it('does not keep a declined calendar suggestion in Proposed', () => {
    mockedUseQuery.mockReturnValue({
      data: {
        tasks: {
          edges: [{ node: node({ scheduledFor: '2026-08-29', placedOnCalendar: false }) }],
          totalCount: 1,
        },
        taskPendingChanges: [
          {
            id: 'c1',
            taskId: 't1',
            kind: 'schedule',
            patch: { startTime: '2026-08-29T16:00:00.000Z', endTime: '2026-08-29T16:30:00.000Z' },
            rationale: 'Place on the calendar at 2026-08-29T16:00:00.000Z?',
            confidence: 0.8,
            status: 'declined',
          },
        ],
      },
      loading: false,
      error: undefined,
      refetch,
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => usePlanTasks());

    expect(result.current.nodes[0]?.hasPendingChange).toBe(false);
    expect(result.current.pendingByTask.size).toBe(0);
    expect(result.current.sections.find((section) => section.key === 'unscheduled')?.tasks).toHaveLength(1);
    expect(result.current.sections.find((section) => section.key === 'proposed')).toBeUndefined();
  });

  // The card words a schedule suggestion from its structured start, so the
  // hook must hand that start over — rows filed before the server stopped
  // writing it still carry a raw UTC ISO string as their rationale.
  it('carries a schedule change’s start instant alongside its rationale', () => {
    mockedUseQuery.mockReturnValue({
      data: {
        tasks: { edges: [{ node: node() }], totalCount: 1 },
        taskPendingChanges: [
          {
            id: 'c1',
            taskId: 't1',
            kind: 'schedule',
            patch: { startTime: '2026-09-28T16:00:00.000Z', endTime: '2026-09-28T16:30:00.000Z' },
            rationale: 'Place on the calendar at 2026-09-28T16:00:00.000Z?',
            confidence: 0.8,
            status: 'pending',
          },
        ],
      },
      loading: false,
      error: undefined,
      refetch,
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => usePlanTasks());

    expect(result.current.pendingByTask.get('t1')).toEqual({
      id: 'c1',
      kind: 'schedule',
      rationale: 'Place on the calendar at 2026-09-28T16:00:00.000Z?',
      startTime: '2026-09-28T16:00:00.000Z',
    });
  });

  it('reads no start from a change that is not a schedule, or a patch without one', () => {
    mockedUseQuery.mockReturnValue({
      data: {
        tasks: {
          edges: [{ node: node() }, { node: node({ id: 't2', title: 'Book the venue' }) }],
          totalCount: 2,
        },
        taskPendingChanges: [
          {
            id: 'c1',
            taskId: 't1',
            kind: 'mutate',
            patch: { startTime: '2026-09-28T16:00:00.000Z', title: 'Write the full deck' },
            rationale: 'Suggested update from memory.',
            confidence: 0.6,
            status: 'pending',
          },
          {
            id: 'c2',
            taskId: 't2',
            kind: 'schedule',
            patch: { startTime: 42 },
            rationale: null,
            confidence: 0.8,
            status: 'pending',
          },
        ],
      },
      loading: false,
      error: undefined,
      refetch,
    } as unknown as ReturnType<typeof useQuery>);

    const { result } = renderHook(() => usePlanTasks());

    expect(result.current.pendingByTask.get('t1')?.startTime).toBeNull();
    expect(result.current.pendingByTask.get('t2')?.startTime).toBeNull();
  });
});

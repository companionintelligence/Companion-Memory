import { useCallback, useMemo, useRef } from 'react';

import { useMutation, useQuery } from '@apollo/client';

import { gql } from '@/graphql';

import { groupIntoSections, localDateOf, type Section, type SectionedTask } from './taskSections';

export const GET_TASKS = gql(`
  query GetTasks($first: Int, $after: String) {
    tasks(first: $first, after: $after) {
      edges {
        node {
          id
          status
          priority
          parentId
          dueAt
          scheduledFor
          deferUntil
          title
          ...TaskRowFragment
        }
      }
      totalCount
    }
    taskPendingChanges {
      id
      taskId
      kind
      rationale
      confidence
      status
    }
  }
`);

export const ACCEPT_PROPOSED = gql(`
  mutation AcceptProposedTask($id: ID!) {
    acceptProposedTask(id: $id) {
      id
      status
    }
  }
`);

export const DECLINE_PROPOSED = gql(`
  mutation DeclineProposedTask($id: ID!) {
    declineProposedTask(id: $id) {
      id
      status
    }
  }
`);

export const SCHEDULE_TASK = gql(`
  mutation ScheduleTask($id: ID!, $date: String) {
    scheduleTask(id: $id, date: $date) {
      success
      status
      task {
        id
        scheduledFor
        estimatedMinutes
      }
    }
  }
`);

/**
 * The calendar-drop variant of {@link SCHEDULE_TASK} — an explicit instant,
 * not a preferred date.
 *
 * A calendar drop computes a 15-minute-snapped instant and paints it live
 * under the cursor while dragging (`VerticalCalendar`'s `dropInstant`), but
 * `placeOnDay` used to collapse it to a bare `YYYY-MM-DD` via `localDateOf`
 * and send THAT — the gap solver then re-derived its own time within the day,
 * so a drop at 3:15pm could land at 9:00am, and dropping on a past day
 * silently re-placed on today. `startTime` bypasses the gap solver server-side
 * entirely: the instant given is the instant placed at.
 */
export const SCHEDULE_TASK_AT = gql(`
  mutation ScheduleTaskAt($id: ID!, $startTime: DateTime!) {
    scheduleTask(id: $id, startTime: $startTime) {
      success
      status
      task {
        id
        scheduledFor
        estimatedMinutes
      }
      event {
        id
        startTime
        endTime
      }
    }
  }
`);

export type PlanTask = SectionedTask & {
  description?: string | null;
  estimatedMinutes?: number | null;
};

export type PendingChange = { id: string; rationale: string | null; kind: string };

const BACKLOG_KEYS = new Set(['proposed', 'unscheduled']);

/**
 * The Plan board's task list, plus the two writes Today uses to move a
 * backlog item onto a day.
 *
 * One query so Plan and Possibilities stay on the same cache; grouping is the
 * same `groupIntoSections` the Kanban uses, so a card in Proposed here is the
 * same row as Proposed there.
 */
export function usePlanTasks(onPlaced?: () => void) {
  const { data, loading, error, refetch } = useQuery(GET_TASKS, {
    variables: { first: 200 },
    fetchPolicy: 'cache-and-network',
  });

  const [acceptProposed] = useMutation(ACCEPT_PROPOSED);
  const [declineProposed] = useMutation(DECLINE_PROPOSED);
  const [scheduleTaskAt] = useMutation(SCHEDULE_TASK_AT);

  const pendingByTask = useMemo(() => {
    const map = new Map<string, PendingChange>();

    for (const change of data?.taskPendingChanges ?? []) {
      if (!map.has(change.taskId)) {
        map.set(change.taskId, {
          id: change.id,
          rationale: change.rationale ?? null,
          kind: change.kind,
        });
      }
    }

    return map;
  }, [data]);

  const nodes = useMemo((): PlanTask[] => {
    const edges = data?.tasks.edges.map((edge) => edge.node) ?? [];

    return edges.map((node) => ({
      ...node,
      hasPendingChange: pendingByTask.has(node.id),
    })) as unknown as PlanTask[];
  }, [data, pendingByTask]);

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // "Today" is the viewer's local day, not the server's. Recomputed per render
  // rather than memoised on [] so an open tab rolls over at local midnight.
  const sections = useMemo(
    () => groupIntoSections(nodes, localDateOf(new Date())),
    [nodes],
  );

  const backlog = useMemo(
    () => sections.filter((section): section is Section<PlanTask> => BACKLOG_KEYS.has(section.key)),
    [sections],
  );

  const backlogCount = useMemo(
    () => backlog.reduce((count, section) => count + section.tasks.length, 0),
    [backlog],
  );

  const placeOnDay = useCallback(
    async (id: string, at: Date) => {
      const task = nodesRef.current.find((node) => node.id === id);

      if (task?.status === 'proposed') {
        await acceptProposed({ variables: { id } });
      }

      // The exact dropped instant, not the date it falls on — see
      // SCHEDULE_TASK_AT. `at` already carries the 15-minute-snapped time of
      // day the calendar painted under the cursor.
      const result = await scheduleTaskAt({ variables: { id, startTime: at.toISOString() } });

      if (!result.data?.scheduleTask.success) {
        throw new Error(result.data?.scheduleTask.status ?? 'not placed');
      }

      await refetch();
      onPlaced?.();
    },
    [acceptProposed, onPlaced, refetch, scheduleTaskAt],
  );

  const dismissProposed = useCallback(
    async (id: string) => {
      await declineProposed({ variables: { id } });
      await refetch();
    },
    [declineProposed, refetch],
  );

  return {
    nodes,
    sections,
    backlog,
    backlogCount,
    pendingByTask,
    loading,
    error: Boolean(error),
    refetch,
    placeOnDay,
    dismissProposed,
  };
}

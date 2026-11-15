import { useCallback } from 'react';

import { gql } from '@apollo/client';
import { useQuery } from '@apollo/client/react';

import { useLiveChanges } from '@/hooks/useLiveChanges';
import { useRefetchOnReturn } from '@/hooks/useRefetchOnReturn';
import { openCount, type SectionedTask } from '@/pages/PlanPage/taskSections';

// Matches usePlanTasks' own cap (first: 200) — the badge should not claim
// more accuracy than the Plan page itself already has (see G5 in the audit:
// Possibilities silently truncates past 200).
export const PLAN_BADGE_TASK_LIMIT = 200;

export const GET_PLAN_BADGE_COUNT = gql`
  query GetPlanBadgeCount($first: Int) {
    tasks(first: $first) {
      edges {
        node {
          id
          status
        }
      }
    }
    taskPendingChanges {
      taskId
    }
  }
`;

interface PlanBadgeTaskNode {
  id: string;
  status: string;
}

interface PlanBadgeCountQueryResult {
  tasks: { edges: Array<{ node: PlanBadgeTaskNode }> };
  taskPendingChanges: Array<{ taskId: string }>;
}

/**
 * How much work still wants doing, for the Plan rail badge.
 *
 * Reuses `openCount` — the same function the Kanban board's own section
 * counts are built from — rather than a second, drifting definition of
 * "open".
 *
 * `enabled` is false when the Tasks row is hidden (`planning.page` off): the
 * count would be shown nowhere, so it neither asks the API nor holds the live
 * stream open on every page for it.
 */
export function usePlanBadgeCount(enabled = true): number {
  const { data, refetch } = useQuery<PlanBadgeCountQueryResult, { first: number }>(GET_PLAN_BADGE_COUNT, {
    variables: { first: PLAN_BADGE_TASK_LIMIT },
    skip: !enabled,
    fetchPolicy: 'no-cache',
    notifyOnNetworkStatusChange: true,
  });

  // `no-cache` means no other query's answer reaches this one, so it moved only
  // when a page remembered to refetch it by name. Adding a task did not, nor did
  // a task from another device or a scan. Re-read on the same signals as the
  // Plan board: the server's task change stream, and coming back to the tab.
  const reload = useCallback(() => {
    if (enabled) {
      void refetch();
    }
  }, [enabled, refetch]);

  useLiveChanges(enabled ? ['tasks'] : [], reload);
  useRefetchOnReturn(reload);

  if (!enabled || !data) {
    return 0;
  }

  const pendingTaskIds = new Set(data.taskPendingChanges.map((change) => change.taskId));
  const tasks: SectionedTask[] = data.tasks.edges.map(({ node }) => ({
    id: node.id,
    title: '',
    status: node.status,
    priority: 0,
    hasPendingChange: pendingTaskIds.has(node.id),
  }));

  return openCount(tasks);
}

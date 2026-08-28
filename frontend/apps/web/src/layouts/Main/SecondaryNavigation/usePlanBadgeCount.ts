import { gql, useQuery } from '@apollo/client';

import { openCount, type SectionedTask } from '@/pages/PlanPage/taskSections';

// Matches usePlanTasks' own cap (first: 200) — the badge should not claim
// more accuracy than the Plan page itself already has (see G5 in the audit:
// Possibilities silently truncates past 200).
const PLAN_BADGE_TASK_LIMIT = 200;

const GET_PLAN_BADGE_COUNT = gql`
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
 */
export function usePlanBadgeCount(): number {
  const { data } = useQuery<PlanBadgeCountQueryResult, { first: number }>(GET_PLAN_BADGE_COUNT, {
    variables: { first: PLAN_BADGE_TASK_LIMIT },
    fetchPolicy: 'no-cache',
    notifyOnNetworkStatusChange: true,
  });

  if (!data) {
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

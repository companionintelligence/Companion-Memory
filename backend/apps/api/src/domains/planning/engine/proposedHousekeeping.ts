import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import type { Task } from '../entities/TaskEntity';
import type { ProposedTaskReconcileService } from '../services/ProposedTaskReconcileService';
import { TaskService } from '../services/TaskService';

import { newerDuplicateIds } from './taskTitleSimilarity';

/**
 * What a scan does to the proposed tasks it already owns before it proposes
 * more. Both scans (memory, inbox) carried these verbatim.
 */

/** Decline the newer of any two proposed tasks that say the same thing; the survivors. */
export async function collapseDuplicateProposed(
  deps: { taskService: Pick<TaskService, 'declineProposed'>; logger: LoggerService },
  context: UserServiceContext,
  tracked: Task[],
): Promise<Task[]> {
  const dropIds = newerDuplicateIds(tracked);

  if (dropIds.length === 0) {
    return tracked;
  }

  for (const id of dropIds) {
    await deps.taskService.declineProposed(context, id);
  }

  deps.logger.log('Collapsed duplicate proposed tasks', {
    userId: context.userId,
    archived: dropIds.length,
  });

  const dropped = new Set(dropIds);

  return tracked.filter((task) => !dropped.has(task.id));
}

/**
 * Re-date or archive this scan's proposals that the current pass no longer
 * supports. `sourceKind` is the scan's own; the source refs are the ones its
 * proposals were minted under (inbox proposals carry an `inbox` hint).
 */
export async function sweepStaleProposed(
  reconcile: Pick<ProposedTaskReconcileService, 'reconcileStaleProposed'>,
  context: UserServiceContext,
  { sourceKind, titles }: { sourceKind: 'memory_scan' | 'inbox'; titles: readonly string[] },
): Promise<{ redated: number; archived: number }> {
  return reconcile.reconcileStaleProposed(context, {
    sourceKind,
    relevantTitles: titles,
    relevantSourceRefs: titles.map((title) =>
      TaskService.memoryScanSourceRef(title.trim(), sourceKind === 'inbox' ? 'inbox' : undefined),
    ),
  });
}

/** The titles of the proposed tasks a scan of `sourceKind` owns. */
export function proposedTitles(tasks: readonly Task[], sourceKind: string): string[] {
  return tasks
    .filter((task) => task.status === 'proposed' && task.sourceKind === sourceKind)
    .map((task) => task.title);
}

import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { shiftLocalDate } from '../engine/computePlacement';
import { SCAN_DEDUP_LIMIT, SCAN_DEDUP_STATUSES, titlesAreSimilar } from '../engine/taskTitleSimilarity';
import type { Task } from '../entities/TaskEntity';
import type { UpdateTaskDto } from '../types';

import { PlanningTimeService } from './PlanningTimeService';
import { TaskService } from './TaskService';

export interface ReconcileStaleProposedOptions {
  sourceKind: string;
  relevantTitles: Iterable<string>;
  relevantSourceRefs?: Iterable<string>;
}

export interface ReconcileStaleProposedResult {
  redated: number;
  archived: number;
}

/**
 * Sweep never-accepted `proposed` tasks whose window is already in the past.
 *
 * Scan jobs call this after a successful surface (or with an empty relevant
 * set when there was nothing to scan). Still-surfaced titles keep the row and
 * move `scheduledFor` / `dueAt` onto today; everything else is declined
 * (archived) so it leaves the Proposed inbox. Accepted work is never touched.
 */
@Injectable()
export class ProposedTaskReconcileService {
  constructor(
    private readonly taskService: TaskService,
    private readonly planningTime: PlanningTimeService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ProposedTaskReconcileService.name);
  }

  /** Owner-local today plus noon, used when a scan stamps a new proposed row. */
  async windowForToday(context: UserServiceContext): Promise<{ scheduledFor: string; dueAt: Date }> {
    const scheduledFor = await this.planningTime.today(context);

    return {
      scheduledFor,
      dueAt: await this.planningTime.toInstant(context, scheduledFor, '12:00'),
    };
  }

  async reconcileStaleProposed(
    context: UserServiceContext,
    options: ReconcileStaleProposedOptions,
  ): Promise<ReconcileStaleProposedResult> {
    const titles = new Set(
      [...options.relevantTitles].map(normalizeTitle).filter((title) => title.length > 0),
    );
    const refs = new Set([...(options.relevantSourceRefs ?? [])].filter(Boolean));
    const today = await this.planningTime.today(context);
    // Callers (InboxScanService, TodoScanService) build `relevantTitles` from a
    // `tracked` set that is itself `findAll({ status: SCAN_DEDUP_STATUSES, limit:
    // SCAN_DEDUP_LIMIT })` — capped at 300 rows, ordered `due_at ASC NULLS
    // LAST`. Fetching an UNCAPPED `status: ['proposed']` here let a proposed
    // task that simply fell outside that top-300 window (because 300+ other
    // due/created/whatever-status rows sorted ahead of it) be treated as
    // "no longer relevant" and auto-declined, even though nothing about it had
    // actually changed. Issuing the identical capped/ordered query here means a
    // proposed row is only ever a reconcile candidate when it is also a
    // candidate for `tracked` — so both sides agree on what "currently
    // tracked" means, and a row outside the shared window is left untouched
    // (neither redated nor archived) instead of being wrongly declined.
    const proposed = (
      await this.taskService.findAll(context, {
        status: [...SCAN_DEDUP_STATUSES],
        limit: SCAN_DEDUP_LIMIT,
      })
    ).filter((task) => task.status === 'proposed');
    let redated = 0;
    let archived = 0;

    for (const task of proposed) {
      if (task.sourceKind !== options.sourceKind) {
        continue;
      }

      if (task.deferUntil != null && task.deferUntil > today) {
        continue;
      }

      if (!(await this.isPast(context, task, today))) {
        continue;
      }

      const stillRelevant =
        titles.has(normalizeTitle(task.title)) ||
        [...options.relevantTitles].some((title) => titlesAreSimilar(task.title, title)) ||
        (task.sourceRef != null && refs.has(task.sourceRef));

      if (stillRelevant) {
        await this.taskService.update(context, task.id, await this.redatePatch(context, task, today));
        redated += 1;
      } else {
        await this.taskService.declineProposed(context, task.id);
        archived += 1;
      }
    }

    if (redated > 0 || archived > 0) {
      this.logger.log('Reconciled stale proposed tasks', {
        userId: context.userId,
        sourceKind: options.sourceKind,
        redated,
        archived,
      });
    }

    return { redated, archived };
  }

  private async isPast(context: UserServiceContext, task: Task, today: string): Promise<boolean> {
    if (task.scheduledFor != null && task.scheduledFor < today) {
      return true;
    }

    if (task.dueAt != null) {
      const dueDate = await this.planningTime.localDate(context, task.dueAt);

      if (dueDate < today) {
        return true;
      }
    }

    if (task.scheduledFor == null && task.dueAt == null) {
      const created = await this.planningTime.localDate(context, task.createdAt);

      return created < today;
    }

    return false;
  }

  private async redatePatch(context: UserServiceContext, task: Task, today: string): Promise<UpdateTaskDto> {
    if (task.dueAt == null) {
      return {
        scheduledFor: today,
        dueAt: await this.planningTime.toInstant(context, today, '12:00'),
      };
    }

    const oldDueDate = await this.planningTime.localDate(context, task.dueAt);
    let newDueDate = oldDueDate < today ? today : oldDueDate;

    if (task.scheduledFor != null) {
      const spanDays = daysBetween(task.scheduledFor, oldDueDate);

      newDueDate = shiftLocalDate(today, Math.max(0, spanDays));
    }

    return {
      scheduledFor: today,
      dueAt: await this.planningTime.toInstant(context, newDueDate, '12:00'),
    };
  }
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

function daysBetween(from: string, to: string): number {
  const start = new Date(`${from}T12:00:00Z`).getTime();
  const end = new Date(`${to}T12:00:00Z`).getTime();

  return Math.round((end - start) / 86_400_000);
}

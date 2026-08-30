import { Injectable } from '@nestjs/common';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { shiftLocalDate } from '../engine/computePlacement';
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
    const proposed = await this.taskService.findAll(context, { status: ['proposed'] });
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
        titles.has(normalizeTitle(task.title)) || (task.sourceRef != null && refs.has(task.sourceRef));

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

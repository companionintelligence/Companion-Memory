import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  EventEntity,
  CalendarEventService,
  PersonService,
  UserContextService,
  type Event,
  platformIdentity,
} from '@ci/domains/memory';
import { PersonalizationService } from '@ci/domains/personalization';

import {
  computePlacement,
  DEFAULT_ESTIMATED_MINUTES,
  parseWallClock,
  shiftLocalDate,
  type OccupiedSpan,
  type PlacementPlan,
} from '../engine/computePlacement';
import type { Task } from '../entities/TaskEntity';

import { PlanningTimeService } from './PlanningTimeService';
import { TaskService } from './TaskService';

const DEFAULT_WORK_START = '09:00';
const DEFAULT_WORK_END = '17:00';
const FLEX_DAYS = 7;
const PLANNED_BLOCK = 'planned_block';

/**
 * Statuses an accepted `event_revise` confirmation may write to a planned
 * block. `EventNowService` only ever proposes `cancelled`; the other two are
 * the same "this did not happen" family the block queries already filter on
 * (`status NOT IN ('cancelled', 'no_show', 'skipped')`). Anything else is a
 * patch this pathway did not author, and is refused rather than written blind
 * into a CHECK-constrained column.
 */
const REVISABLE_BLOCK_STATUSES = new Set(['cancelled', 'no_show', 'skipped']);

export type PlaceOutcome =
  | { status: 'placed'; event: Event; task: Task }
  | { status: 'proposed'; task: Task }
  | { status: 'already_placed'; event: Event; task: Task }
  | { status: 'no_gap'; task: Task }
  | { status: 'skipped'; task: Task | null };

@Injectable()
export class PlannedBlockService {
  constructor(
    @InjectRepository(EventEntity)
    private readonly eventRepository: Repository<EventEntity>,
    private readonly eventService: CalendarEventService,
    private readonly taskService: TaskService,
    private readonly planningTime: PlanningTimeService,
    private readonly personalizationService: PersonalizationService,
    private readonly personService: PersonService,
    private readonly userContextService: UserContextService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PlannedBlockService.name);
  }

  /**
   * SQL-pushdown of `event_type = 'planned_block'` overlapping [from, to).
   * Not CalendarEventService.findAll — that path is unbounded and explorer-facing.
   */
  async list(context: UserServiceContext, from: Date, to: Date): Promise<Event[]> {
    const rows = await this.eventRepository
      .createQueryBuilder('event')
      .where('event.user_id = :userId', { userId: context.userId })
      .andWhere('event.event_type = :type', { type: PLANNED_BLOCK })
      .andWhere('event.is_deleted = false')
      .andWhere("event.status NOT IN ('cancelled', 'no_show', 'skipped')")
      .andWhere('event.start_time < :to', { to })
      .andWhere('COALESCE(event.end_time, event.start_time) >= :from', { from })
      .orderBy('event.start_time', 'ASC')
      .addOrderBy('event.event_id', 'ASC')
      .take(200)
      .getMany();

    if (rows.length === 0) {
      return [];
    }

    const events = await this.eventService.findByIds(
      context,
      rows.map((row) => row.id),
    );

    return events.filter((event): event is Event => event != null);
  }

  async findActiveForTask(context: UserServiceContext, taskId: string): Promise<Event | null> {
    const row = await this.eventRepository
      .createQueryBuilder('event')
      .where('event.user_id = :userId', { userId: context.userId })
      .andWhere('event.task_id = :taskId', { taskId })
      .andWhere('event.event_type = :type', { type: PLANNED_BLOCK })
      .andWhere('event.is_deleted = false')
      .andWhere("event.status NOT IN ('cancelled', 'no_show', 'skipped')")
      .orderBy('event.start_time', 'ASC')
      .getOne();

    if (!row) {
      return null;
    }

    return this.eventService.findById(context, row.id);
  }

  /** Task ids in `taskIds` that currently have an active planned block. */
  async listActiveTaskIds(context: UserServiceContext, taskIds: string[]): Promise<Set<string>> {
    if (taskIds.length === 0) {
      return new Set();
    }

    const rows = await this.eventRepository
      .createQueryBuilder('event')
      .select('event.task_id', 'taskId')
      .where('event.user_id = :userId', { userId: context.userId })
      .andWhere('event.task_id IN (:...taskIds)', { taskIds })
      .andWhere('event.event_type = :type', { type: PLANNED_BLOCK })
      .andWhere('event.is_deleted = false')
      .andWhere("event.status NOT IN ('cancelled', 'no_show', 'skipped')")
      .getRawMany<{ taskId?: string; task_id?: string }>();

    return new Set(rows.map((row) => row.taskId ?? row.task_id).filter((id): id is string => Boolean(id)));
  }

  /**
   * User-triggered schedule: always place if a gap exists. The click is consent.
   */
  async scheduleTask(
    context: UserServiceContext,
    taskId: string,
    opts: { estimatedMinutes?: number; date?: string } = {},
  ): Promise<PlaceOutcome> {
    const task = await this.taskService.findById(context, taskId);

    if (!task || task.status === 'done' || task.status === 'archived' || task.status === 'skipped') {
      return { status: 'skipped', task };
    }

    return this.place(context, task, {
      estimatedMinutes: opts.estimatedMinutes ?? task.estimatedMinutes,
      preferDate: opts.date ?? task.scheduledFor,
      source: 'user',
    });
  }

  /**
   * User-triggered schedule at an EXPLICIT instant — a calendar drop, not a
   * "put this somewhere" click.
   *
   * ═══ WHY THIS EXISTS SEPARATELY FROM `scheduleTask` ═══
   *
   * `scheduleTask` takes only a preferred DATE and runs the gap solver
   * (`propose`) to pick a time within working hours. That is correct for the
   * Plan page's Schedule button, which has no time to offer — but the calendar
   * grid computes an exact 15-minute-snapped instant under the cursor and
   * paints it live while dragging, then this method used to be bypassed
   * entirely: the frontend collapsed the instant to a bare date and let the
   * gap solver re-derive a time, so a drop at 3:15pm could land at 9:00am.
   * This method places (or moves) the block at exactly the instant given —
   * the gap solver never runs, because the drop already IS the placement
   * decision.
   *
   * ═══ AN EXISTING BLOCK IS MOVED, NOT REFUSED ═══
   *
   * `place()`'s `already_placed` status is correct for `scheduleTask`, whose
   * only lever is "put this somewhere" — there is nothing to move TO, so a
   * second click is rightly a no-op. A drag names a destination. Dropping an
   * already-placed task's card again is the same gesture the grid's own
   * event-drag uses to MOVE a committed block (`rescheduleEvent`), so this
   * reuses that path (`CalendarEventService.reschedule`, which preserves duration when
   * `end` is omitted) rather than reporting nothing happened.
   *
   * Past dates are accepted deliberately. The date-only path clamps a
   * preferred date earlier than today up to today, which is right for "put
   * this somewhere in the next 7 working days" — but wrong here, where the
   * instant is what the user pointed at. Backfilling a task onto a day already
   * gone is a legitimate use of this method, and refusing it would just move
   * the same silent-surprise bug from "always today" to "always refused".
   */
  async scheduleTaskAt(
    context: UserServiceContext,
    taskId: string,
    start: Date,
    end?: Date,
    estimatedMinutes?: number,
  ): Promise<PlaceOutcome> {
    const task = await this.taskService.findById(context, taskId);

    if (!task || task.status === 'done' || task.status === 'archived' || task.status === 'skipped') {
      return { status: 'skipped', task };
    }

    const existing = await this.findActiveForTask(context, task.id);

    if (existing) {
      const moved = await this.eventService.reschedule(context, existing.id, start, end);

      // `reschedule` returns null only on a race (the block vanished between
      // `findActiveForTask` and here) or a cross-user id — both genuinely
      // "nothing to place", so falling back to the old already_placed status
      // is honest rather than claiming a move that did not happen.
      return moved
        ? { status: 'placed', event: moved, task }
        : { status: 'already_placed', event: existing, task };
    }

    const minutes = estimatedMinutes ?? task.estimatedMinutes ?? undefined;
    const placedEnd =
      end ??
      new Date(start.getTime() + (minutes && minutes > 0 ? minutes : DEFAULT_ESTIMATED_MINUTES) * 60_000);

    return this.placeAt(context, task, start, placedEnd, estimatedMinutes ?? task.estimatedMinutes);
  }

  /**
   * Automation path. Trust dial decides auto-place vs a Plan-page confirmation.
   */
  async tryPlaceAfterOpen(context: UserServiceContext, task: Task, confidence = 0.8): Promise<PlaceOutcome> {
    if (task.status !== 'open' && task.status !== 'in_progress') {
      return { status: 'skipped', task };
    }

    const decision = await this.personalizationService.decideAction(context.userId, {
      kind: 'schedule_accept',
      confidence,
      hasUserInput: false,
    });

    if (decision === 'skip') {
      return { status: 'skipped', task };
    }

    const proposal = await this.propose(context, task);

    if (proposal.kind === 'no_gap') {
      return { status: 'no_gap', task };
    }

    if (decision === 'review') {
      await this.taskService.createPendingChange(context, {
        taskId: task.id,
        kind: 'schedule',
        patch: {
          startTime: proposal.start.toISOString(),
          endTime: proposal.end.toISOString(),
          estimatedMinutes: task.estimatedMinutes ?? DEFAULT_ESTIMATED_MINUTES,
        },
        rationale: `Place on the calendar at ${proposal.start.toISOString()}?`,
        confidence,
      });

      return { status: 'proposed', task };
    }

    return this.placeAt(context, task, proposal.start, proposal.end);
  }

  async applyPendingSchedule(
    context: UserServiceContext,
    taskId: string,
    patch: Record<string, unknown>,
  ): Promise<PlaceOutcome> {
    const task = await this.taskService.findById(context, taskId);

    if (!task) {
      return { status: 'skipped', task: null };
    }

    const start = parseInstant(patch.startTime);
    const end = parseInstant(patch.endTime);

    if (!start || !end || end.getTime() <= start.getTime()) {
      return this.scheduleTask(context, taskId);
    }

    return this.placeAt(context, task, start, end);
  }

  /**
   * Apply an accepted `event_revise` confirmation to the linked planned block.
   *
   * ═══ WHAT THIS USED TO DO ═══
   *
   * Nothing at all. `EventNowService` files an `event_revise` change carrying
   * `{ eventStatus: 'cancelled', eventId }`, and accepting it fell through to
   * `TaskService.acceptPendingChange`, which treats a patch as a TASK patch:
   * `eventStatus` was destructured away and `eventId` was handed to
   * `taskRepository.save` as a column that exists on neither UpdateTaskDto nor
   * TaskEntity, so TypeORM dropped it. Nothing anywhere read either key. The
   * change flipped to `accepted` and the appointment the user had just
   * confirmed as cancelled kept showing on the calendar.
   *
   * Owner-scoped like every other planning write, and it names only `status` —
   * `duration_minutes` is `GENERATED ALWAYS`, so writing it is a hard Postgres
   * error (docs/architecture/planning-roadmap.md, guardrail 1).
   */
  async applyPendingEventRevision(
    context: UserServiceContext,
    taskId: string,
    patch: Record<string, unknown>,
  ): Promise<Event | null> {
    const status = typeof patch.eventStatus === 'string' ? patch.eventStatus : null;

    if (!status || !REVISABLE_BLOCK_STATUSES.has(status)) {
      return null;
    }

    const eventId = typeof patch.eventId === 'string' && patch.eventId ? patch.eventId : null;
    const block = eventId
      ? await this.eventService.findById(context, eventId)
      : await this.findActiveForTask(context, taskId);

    // The proposal named a block; a patch that points at some other task's
    // block (or at a plain calendar event) is not this confirmation's to
    // revise, however it got into the row.
    if (!block || block.taskId !== taskId || block.eventType !== PLANNED_BLOCK) {
      return null;
    }

    const updated = await this.eventService.update(context, block.id, { status });

    this.logger.log('Applied pending event revision', {
      userId: context.userId,
      taskId,
      eventId: block.id,
      status,
    });

    return updated;
  }

  async unschedule(context: UserServiceContext, taskId: string): Promise<Task | null> {
    const existing = await this.findActiveForTask(context, taskId);

    if (existing) {
      await this.eventService.remove(context, existing.id);
    }

    return this.taskService.update(context, taskId, { scheduledFor: null });
  }

  /**
   * Plan-page Plan: keep the work, put it in the unscheduled backlog.
   * Drops pending confirmations, opens a proposal, and removes any calendar
   * block. A proposed time that is already in the past is stripped entirely
   * (including the scan-stamped dueAt) so the row is ordinary undated work.
   */
  async planAsUnscheduled(context: UserServiceContext, taskId: string): Promise<Task | null> {
    const task = await this.taskService.findById(context, taskId);

    if (!task) {
      return null;
    }

    const pending = await this.taskService.findPendingChanges(context, { taskId });

    for (const change of pending) {
      await this.taskService.declinePendingChange(context, change.id);
    }

    if (task.status === 'proposed') {
      await this.taskService.acceptProposed(context, taskId);
    }

    const existing = await this.findActiveForTask(context, taskId);

    if (existing) {
      await this.eventService.remove(context, existing.id);
    }

    const stripPastWindow = await this.proposedTimeIsPast(context, task, pending);

    return this.taskService.update(context, taskId, {
      scheduledFor: null,
      ...(stripPastWindow ? { dueAt: null } : {}),
    });
  }

  private async proposedTimeIsPast(
    context: UserServiceContext,
    task: Task,
    pending: ReadonlyArray<{ kind: string; patch?: Record<string, unknown> }>,
  ): Promise<boolean> {
    const today = await this.planningTime.today(context);

    if (task.scheduledFor != null && task.scheduledFor < today) {
      return true;
    }

    if (task.status === 'proposed' && task.dueAt != null) {
      const dueDate = await this.planningTime.localDate(context, task.dueAt);

      if (dueDate < today) {
        return true;
      }
    }

    const now = Date.now();

    return pending.some((change) => {
      if (change.kind !== 'schedule') {
        return false;
      }

      const start = parseInstant(change.patch?.startTime);

      return start != null && start.getTime() < now;
    });
  }

  private async place(
    context: UserServiceContext,
    task: Task,
    opts: { estimatedMinutes?: number | null; preferDate?: string | null; source: 'user' | 'automation' },
  ): Promise<PlaceOutcome> {
    const existing = await this.findActiveForTask(context, task.id);

    if (existing) {
      return { status: 'already_placed', event: existing, task };
    }

    const proposal = await this.propose(context, task, opts.preferDate, opts.estimatedMinutes);

    if (proposal.kind === 'no_gap') {
      this.logger.log('No gap for task', { userId: context.userId, taskId: task.id, source: opts.source });

      return { status: 'no_gap', task };
    }

    return this.placeAt(context, task, proposal.start, proposal.end, opts.estimatedMinutes);
  }

  private async placeAt(
    context: UserServiceContext,
    task: Task,
    start: Date,
    end: Date,
    estimatedMinutes?: number | null,
  ): Promise<PlaceOutcome> {
    const existing = await this.findActiveForTask(context, task.id);

    if (existing) {
      return { status: 'already_placed', event: existing, task };
    }

    const minutes =
      estimatedMinutes && estimatedMinutes > 0
        ? Math.round(estimatedMinutes)
        : Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000));

    const [event] = await this.eventService.create(context, {
      title: task.title,
      description: task.description ?? undefined,
      event_type: PLANNED_BLOCK,
      start_time: start,
      end_time: end,
      status: 'planned',
      is_predicted: false,
      created_by: 'planning.placer',
      source_type: 'planning',
      ...(() => {
        const identity = platformIdentity('planning', 'task', task.id);

        return { source_system: identity.system, source_id: identity.id };
      })(),
      task_id: task.id,
      planned_minutes: minutes,
      metadata: { generator: 'planning.placer', taskId: task.id },
    });

    const scheduledFor = await this.planningTime.localDate(context, start);
    const updated =
      (await this.taskService.update(context, task.id, {
        scheduledFor,
        estimatedMinutes: task.estimatedMinutes ?? minutes,
      })) ?? task;

    this.logger.log('Placed planned block', {
      userId: context.userId,
      taskId: task.id,
      eventId: event.id,
      start: start.toISOString(),
    });

    return { status: 'placed', event, task: updated };
  }

  private async propose(
    context: UserServiceContext,
    task: Task,
    preferDate?: string | null,
    estimatedMinutes?: number | null,
  ): Promise<PlacementPlan> {
    const timezone = await this.planningTime.timezoneFor(context.userId);
    const today = await this.planningTime.today(context);
    const hours = await this.workdayHours(context);
    const now = new Date();
    const estimate = estimatedMinutes && estimatedMinutes > 0 ? estimatedMinutes : DEFAULT_ESTIMATED_MINUTES;

    const startDate = preferDate && preferDate >= today ? preferDate : today;
    const windowStart = await this.planningTime.toInstant(context, startDate, hours.start);
    const windowEnd = await this.planningTime.toInstant(
      context,
      shiftLocalDate(startDate, FLEX_DAYS),
      hours.start,
    );

    const occupiedEvents = await this.eventService.findInRange(context, windowStart, windowEnd);
    const occupied: OccupiedSpan[] = occupiedEvents.map((event) => ({
      start: event.startTime,
      end: event.endTime ?? new Date(event.startTime.getTime() + (event.plannedMinutes ?? estimate) * 60_000),
    }));

    for (let day = 0; day < FLEX_DAYS; day += 1) {
      const date = shiftLocalDate(startDate, day);
      const workdayStart = await this.planningTime.toInstant(context, date, hours.start);
      const workdayEnd = await this.planningTime.toInstant(context, date, hours.end);

      if (workdayEnd.getTime() <= workdayStart.getTime()) {
        continue;
      }

      const plan = computePlacement({
        workdayStart,
        workdayEnd,
        occupied,
        estimatedMinutes: estimate,
        now,
      });

      if (plan.kind === 'placed') {
        return plan;
      }
    }

    this.logger.debug('Placement found no gap in flex window', {
      timezone,
      startDate,
      taskId: task.id,
    });

    return { kind: 'no_gap' };
  }

  private async workdayHours(context: UserServiceContext): Promise<{ start: string; end: string }> {
    const self = await this.userContextService.getSelfIdentity(context.userId);

    if (!self) {
      return { start: DEFAULT_WORK_START, end: DEFAULT_WORK_END };
    }

    const person = await this.personService.findById(context, self.entityId);
    const schedule = (person?.properties?.schedule ?? {}) as Record<string, unknown>;
    const start = parseWallClock(typeof schedule.work_start === 'string' ? schedule.work_start : null);
    const end = parseWallClock(typeof schedule.work_end === 'string' ? schedule.work_end : null);

    return {
      start: start ?? DEFAULT_WORK_START,
      end: end ?? DEFAULT_WORK_END,
    };
  }
}

function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

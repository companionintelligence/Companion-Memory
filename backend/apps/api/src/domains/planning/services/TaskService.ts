import { createHash } from 'crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import { type Task, TaskEntity } from '../entities/TaskEntity';
import { type TaskPendingChange, TaskPendingChangeEntity } from '../entities/TaskPendingChangeEntity';
import { TaskCreatedEvent, TaskUpdatedEvent, TaskRemovedEvent } from '../events';
import { TITLE_MATCH_TASK_STATUSES } from '../taskStatus';
import type { CreateTaskDto, CreateTaskPendingChangeDto, FindTasksOptions, UpdateTaskDto } from '../types';

/**
 * Owner-scoped CRUD for planning tasks.
 *
 * Every method takes `UserServiceContext`, never `ServiceContext`. That is
 * deliberate and is an invariant of the planning domain: `SYSTEM_USER` is not a
 * legitimate planning identity, so the
 * `...(context.userId !== SYSTEM_USER && { userId })` idiom used elsewhere in
 * the codebase must not appear here — it would silently widen a tenant-scoped
 * query to every user's tasks. Cron fan-out enqueuers resolve a real user id
 * before calling in.
 */
@Injectable()
export class TaskService {
  constructor(
    @InjectRepository(TaskEntity)
    private readonly taskRepository: Repository<TaskEntity>,
    @InjectRepository(TaskPendingChangeEntity)
    private readonly pendingChangeRepository: Repository<TaskPendingChangeEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(TaskService.name);
  }

  /**
   * Stable provenance key for memory-scan intake. Same normalized title → same
   * source_ref so create vs append is idempotent across scan runs.
   */
  static memoryScanSourceRef(title: string, entityHint?: string | null): string {
    const normalized = title.trim().toLowerCase().replace(/\s+/g, ' ');
    const material = entityHint ? `${normalized}|${entityHint}` : normalized;

    return createHash('sha256').update(material).digest('hex').slice(0, 32);
  }

  /**
   * `parent_id`'s FK targets `ci.tasks(id)` with no `user_id` component, so the
   * database alone will happily attach a task under another tenant's row.
   * `ON DELETE CASCADE` makes that more than a display glitch: the parent
   * owner deleting their own task would silently delete a subtask they never
   * had access to. Confirm the parent is one of the caller's own tasks first.
   */
  private async assertOwnsParent(context: UserServiceContext, parentId: string): Promise<void> {
    const parent = await this.taskRepository.findOne({
      where: { id: parentId, userId: context.userId },
      select: { id: true },
    });

    if (parent == null) {
      throw new NotFoundException(`Parent task ${parentId} not found`);
    }
  }

  async create(context: UserServiceContext, data: CreateTaskDto): Promise<Task | null> {
    if (data.parentId != null) {
      await this.assertOwnsParent(context, data.parentId);
    }

    const record = this.taskRepository.create({
      ...data,
      id: data.id || uuidv7(),
      userId: context.userId,
    });

    const entity = await this.taskRepository.save(record);

    await this.eventService.send(TaskCreatedEvent, { taskId: entity.id, userId: entity.userId });

    return TaskEntity.toEgressType(entity);
  }

  async createMany(context: UserServiceContext, data: CreateTaskDto[]): Promise<Task[]> {
    const results = await Promise.all(data.map((item) => this.create(context, item)));

    return results.filter((task): task is Task => task != null);
  }

  async findById(context: UserServiceContext, id: string): Promise<Task | null> {
    const entity = await this.taskRepository.findOne({
      where: { id, userId: context.userId },
    });

    return entity ? TaskEntity.toEgressType(entity) : null;
  }

  async findByIds(context: UserServiceContext, ids: string[]): Promise<(Task | null)[]> {
    const results = await this.taskRepository.find({
      where: { id: In(ids), userId: context.userId },
    });

    const map = new Map(results.map((entity) => [entity.id, TaskEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async findBySourceRef(
    context: UserServiceContext,
    sourceKind: string,
    sourceRef: string,
  ): Promise<Task | null> {
    const entity = await this.taskRepository.findOne({
      where: { userId: context.userId, sourceKind, sourceRef },
    });

    return entity ? TaskEntity.toEgressType(entity) : null;
  }

  /**
   * Title match across open/proposed/done so scan can append knowledge instead
   * of spawning a duplicate. Case-insensitive exact match on trimmed title.
   */
  async findByTitleMatch(context: UserServiceContext, title: string): Promise<Task | null> {
    const normalized = title.trim().toLowerCase();

    if (!normalized) {
      return null;
    }

    const entity = await this.taskRepository
      .createQueryBuilder('task')
      .where('task.user_id = :userId', { userId: context.userId })
      .andWhere('task.status IN (:...statuses)', {
        statuses: [...TITLE_MATCH_TASK_STATUSES],
      })
      .andWhere('lower(trim(task.title)) = :title', { title: normalized })
      .orderBy('task.updated_at', 'DESC')
      .getOne();

    return entity ? TaskEntity.toEgressType(entity) : null;
  }

  /**
   * Open work first, then by soonest deadline. Tasks without a due date sort
   * last rather than first — `NULLS LAST` is explicit because Postgres defaults
   * to `NULLS FIRST` for ascending order.
   */
  async findAll(context: UserServiceContext, options: FindTasksOptions = {}): Promise<Task[]> {
    let query = this.taskRepository
      .createQueryBuilder('task')
      .where('task.user_id = :userId', { userId: context.userId });

    if (options.status?.length) {
      query = query.andWhere('task.status IN (:...status)', { status: options.status });
    }

    if (options.scheduledFor) {
      query = query.andWhere('task.scheduled_for = :scheduledFor', {
        scheduledFor: options.scheduledFor,
      });
    }

    if (options.parentId !== undefined) {
      query =
        options.parentId === null
          ? query.andWhere('task.parent_id IS NULL')
          : query.andWhere('task.parent_id = :parentId', { parentId: options.parentId });
    }

    query = query
      .orderBy('task.due_at', 'ASC', 'NULLS LAST')
      .addOrderBy('task.priority', 'ASC')
      .addOrderBy('task.created_at', 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const results = await query.getMany();

    return results.map((entity) => TaskEntity.toEgressType(entity));
  }

  async findChildren(context: UserServiceContext, parentId: string): Promise<Task[]> {
    return this.findAll(context, { parentId });
  }

  async update(context: UserServiceContext, id: string, data: UpdateTaskDto): Promise<Task | null> {
    const record = await this.taskRepository.findOne({
      where: { id, userId: context.userId },
    });

    if (record == null) {
      return null;
    }

    if (data.parentId != null) {
      await this.assertOwnsParent(context, data.parentId);
    }

    Object.assign(record, data);

    const entity = await this.taskRepository.save(record);

    await this.eventService.send(TaskUpdatedEvent, { taskId: entity.id, userId: entity.userId });

    return TaskEntity.toEgressType(entity);
  }

  /**
   * Append knowledge to notes without wiping existing text. Idempotent on the
   * exact fragment: callers (todo/inbox scan loops) redeliver the whole batch
   * on a mid-loop failure under pg-boss retry, and re-running an already-applied
   * append must not duplicate the note text.
   */
  async appendNotes(context: UserServiceContext, id: string, fragment: string): Promise<Task | null> {
    const record = await this.taskRepository.findOne({
      where: { id, userId: context.userId },
    });

    if (record == null) {
      return null;
    }

    const trimmed = fragment.trim();

    if (!trimmed || record.notes?.includes(trimmed)) {
      return TaskEntity.toEgressType(record);
    }

    record.notes = record.notes ? `${record.notes.trimEnd()}\n\n${trimmed}` : trimmed;

    const entity = await this.taskRepository.save(record);

    await this.eventService.send(TaskUpdatedEvent, { taskId: entity.id, userId: entity.userId });

    return TaskEntity.toEgressType(entity);
  }

  /**
   * Marks a task done and stamps `completedAt`. Idempotent: completing an
   * already-done task keeps the original completion instant rather than moving
   * it, so "when did I finish this?" stays answerable.
   */
  async complete(context: UserServiceContext, id: string, actualMinutes?: number): Promise<Task | null> {
    const record = await this.taskRepository.findOne({
      where: { id, userId: context.userId },
    });

    if (record == null) {
      return null;
    }

    record.status = 'done';
    record.completedAt = record.completedAt ?? new Date();

    if (actualMinutes != null) {
      record.actualMinutes = actualMinutes;
    }

    const entity = await this.taskRepository.save(record);

    await this.eventService.send(TaskUpdatedEvent, { taskId: entity.id, userId: entity.userId });

    return TaskEntity.toEgressType(entity);
  }

  async reopen(context: UserServiceContext, id: string): Promise<Task | null> {
    const record = await this.taskRepository.findOne({
      where: { id, userId: context.userId },
    });

    if (record == null) {
      return null;
    }

    record.status = 'open';
    record.completedAt = null;

    const entity = await this.taskRepository.save(record);

    await this.eventService.send(TaskUpdatedEvent, { taskId: entity.id, userId: entity.userId });

    return TaskEntity.toEgressType(entity);
  }

  /** Promote a proposed task into the real backlog. */
  async acceptProposed(context: UserServiceContext, id: string): Promise<Task | null> {
    const record = await this.taskRepository.findOne({
      where: { id, userId: context.userId },
    });

    if (record == null || record.status !== 'proposed') {
      return null;
    }

    record.status = 'open';

    const entity = await this.taskRepository.save(record);

    await this.eventService.send(TaskUpdatedEvent, { taskId: entity.id, userId: entity.userId });

    return TaskEntity.toEgressType(entity);
  }

  /** Decline a proposed task (archive so it does not resurface as open work). */
  async declineProposed(context: UserServiceContext, id: string): Promise<Task | null> {
    const record = await this.taskRepository.findOne({
      where: { id, userId: context.userId },
    });

    if (record == null || record.status !== 'proposed') {
      return null;
    }

    record.status = 'archived';

    const entity = await this.taskRepository.save(record);

    await this.eventService.send(TaskUpdatedEvent, { taskId: entity.id, userId: entity.userId });

    return TaskEntity.toEgressType(entity);
  }

  /**
   * Pushes a task out to a later local date and counts the push. `deferCount`
   * is what later milestones use to notice a task nobody intends to do.
   */
  async defer(context: UserServiceContext, id: string, until: string): Promise<Task | null> {
    const record = await this.taskRepository.findOne({
      where: { id, userId: context.userId },
    });

    if (record == null) {
      return null;
    }

    record.deferUntil = until;
    record.deferCount += 1;

    const entity = await this.taskRepository.save(record);

    await this.eventService.send(TaskUpdatedEvent, { taskId: entity.id, userId: entity.userId });

    return TaskEntity.toEgressType(entity);
  }

  async remove(context: UserServiceContext, id: string): Promise<boolean> {
    const result = await this.taskRepository.delete({ id, userId: context.userId });

    if (result.affected != null && result.affected > 0) {
      await this.eventService.send(TaskRemovedEvent, { taskId: id, userId: context.userId });

      return true;
    }

    return false;
  }

  async createPendingChange(
    context: UserServiceContext,
    data: CreateTaskPendingChangeDto,
  ): Promise<TaskPendingChange | null> {
    const task = await this.taskRepository.findOne({
      where: { id: data.taskId, userId: context.userId },
      select: { id: true },
    });

    if (task == null) {
      return null;
    }

    const existing = await this.pendingChangeRepository.findOne({
      where: { taskId: data.taskId, userId: context.userId, status: 'pending', kind: data.kind },
    });

    if (existing) {
      existing.patch = data.patch ?? existing.patch;
      existing.rationale = data.rationale ?? existing.rationale;
      existing.confidence = data.confidence ?? existing.confidence;

      const updated = await this.pendingChangeRepository.save(existing);

      return TaskPendingChangeEntity.toEgressType(updated);
    }

    const record = this.pendingChangeRepository.create({
      id: uuidv7(),
      userId: context.userId,
      taskId: data.taskId,
      kind: data.kind,
      patch: data.patch ?? {},
      rationale: data.rationale ?? null,
      confidence: data.confidence ?? null,
      status: 'pending',
    });

    const entity = await this.pendingChangeRepository.save(record);

    return TaskPendingChangeEntity.toEgressType(entity);
  }

  async findPendingChanges(
    context: UserServiceContext,
    options: { taskId?: string } = {},
  ): Promise<TaskPendingChange[]> {
    let query = this.pendingChangeRepository
      .createQueryBuilder('change')
      .where('change.user_id = :userId', { userId: context.userId })
      .andWhere('change.status = :status', { status: 'pending' });

    if (options.taskId) {
      query = query.andWhere('change.task_id = :taskId', { taskId: options.taskId });
    }

    const results = await query.orderBy('change.created_at', 'DESC').getMany();

    return results.map((entity) => TaskPendingChangeEntity.toEgressType(entity));
  }

  async acceptPendingChange(
    context: UserServiceContext,
    changeId: string,
  ): Promise<{ task: Task | null; change: TaskPendingChange | null }> {
    const change = await this.pendingChangeRepository.findOne({
      where: { id: changeId, userId: context.userId, status: 'pending' },
    });

    if (change == null) {
      return { task: null, change: null };
    }

    let task: Task | null = null;

    if (change.kind === 'complete') {
      task = await this.complete(context, change.taskId);
    } else if (change.kind === 'mutate' || change.kind === 'event_revise') {
      const patch = change.patch as UpdateTaskDto & {
        appendNotes?: string;
        eventStatus?: string;
        eventId?: string;
      };

      if (typeof patch.appendNotes === 'string' && patch.appendNotes.trim()) {
        await this.appendNotes(context, change.taskId, patch.appendNotes);
      }

      // `eventStatus`/`eventId` address the linked planned block, not the task.
      // They are stripped here and applied by
      // `PlannedBlockService.applyPendingEventRevision`, which owns ci.events
      // writes. A bare `eventId` left in the patch used to reach
      // `taskRepository.save` as a column that exists on neither UpdateTaskDto
      // nor TaskEntity, where TypeORM silently dropped it — which is how an
      // accepted cancellation left the block on the calendar.
      const { appendNotes: _append, eventStatus: _eventStatus, eventId: _eventId, ...taskPatch } = patch;
      const hasTaskFields = Object.keys(taskPatch).length > 0;

      task = hasTaskFields
        ? await this.update(context, change.taskId, taskPatch as UpdateTaskDto)
        : await this.findById(context, change.taskId);
    } else {
      task = await this.findById(context, change.taskId);
    }

    change.status = 'accepted';
    change.resolvedAt = new Date();
    const saved = await this.pendingChangeRepository.save(change);

    return { task, change: TaskPendingChangeEntity.toEgressType(saved) };
  }

  async declinePendingChange(
    context: UserServiceContext,
    changeId: string,
  ): Promise<TaskPendingChange | null> {
    const change = await this.pendingChangeRepository.findOne({
      where: { id: changeId, userId: context.userId, status: 'pending' },
    });

    if (change == null) {
      return null;
    }

    change.status = 'declined';
    change.resolvedAt = new Date();

    const saved = await this.pendingChangeRepository.save(change);

    return TaskPendingChangeEntity.toEgressType(saved);
  }
}

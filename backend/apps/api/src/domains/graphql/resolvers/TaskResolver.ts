import { BadRequestException, ForbiddenException, UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { TaskService, PlannedBlockService, type Task, type TaskStatus } from '@ci/domains/planning';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { TagLoader } from '../loaders/TagLoader';
import { CreateTaskInput } from '../types/CreateTaskInput';
import { CreateTaskPayload } from '../types/CreateTaskPayload';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { EntityTagType } from '../types/EntityTagType';
import { EventType } from '../types/EventType';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { ResolveTaskPendingChangePayload } from '../types/ResolveTaskPendingChangePayload';
import { ScheduleTaskPayload } from '../types/ScheduleTaskPayload';
import { TaskConnection } from '../types/TaskConnection';
import { TaskEdge } from '../types/TaskEdge';
import { TaskPendingChangeType } from '../types/TaskPendingChangeType';
import { TaskStatusEnum, TaskType } from '../types/TaskType';
import { UpdateTaskInput } from '../types/UpdateTaskInput';
import { UpdateTaskPayload } from '../types/UpdateTaskPayload';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => TaskType)
export class TaskResolver {
  constructor(
    private readonly taskService: TaskService,
    private readonly plannedBlockService: PlannedBlockService,
    private readonly featureService: FeatureService,
    private readonly tagLoader: TagLoader,
  ) {}

  /**
   * `planning.enabled` is the backend gate for ci.tasks. `planning.page` only
   * hides the Plan route; with this off the GraphQL surface must not read or
   * write tasks either.
   */
  private async isPlanningEnabled(): Promise<boolean> {
    return this.featureService.isFeatureEnabled('planning.enabled');
  }

  private async assertPlanningEnabled(): Promise<void> {
    if (!(await this.isPlanningEnabled())) {
      throw new ForbiddenException('The planning surface is disabled');
    }
  }

  private toTaskType(task: Task, placedOnCalendar: boolean): TaskType {
    return { ...TaskType.toType(task), placedOnCalendar };
  }

  /**
   * The bounds `ci.tasks` enforces, restated in front of the write.
   *
   * Postgres is otherwise the first thing to check these arguments, and it
   * answers with a CHECK / NOT NULL violation that formatError reduces to a
   * bare `Internal server error` — so `priority: 9` is refused without ever
   * naming the field, let alone the range the argument's own description
   * states. Rejected here by name instead, the way PeerLinkService.upsert
   * rejects an unknown trust tier in front of its `trust_tier` CHECK.
   *
   * `null` is schema-legal for each of these (the inputs declare them
   * nullable) but is not a legal column value, so the null-means-clear
   * contract the other updatable fields follow — dueAt, taskTime,
   * scheduledFor, deferUntil, estimatedMinutes — stops here.
   *
   * Keep in step with `tasks_priority_check` / `tasks_estimated_minutes_check`
   * in db/postgres/migrations/20260808150000_schedule_planning_and_hbpe.sql.
   */
  private assertTaskFields(input: {
    title?: string | null;
    status?: TaskStatusEnum | null;
    priority?: number | null;
    estimatedMinutes?: number | null;
    actualMinutes?: number | null;
  }): void {
    if (input.title === null) {
      throw new BadRequestException('`title` must not be null');
    }

    if (input.status === null) {
      throw new BadRequestException('`status` must not be null');
    }

    if (input.priority === null) {
      throw new BadRequestException('`priority` must not be null');
    }

    if (input.priority !== undefined && (input.priority < 0 || input.priority > 5)) {
      throw new BadRequestException('`priority` must be between 0 and 5');
    }

    if (input.estimatedMinutes != null && input.estimatedMinutes < 1) {
      throw new BadRequestException('`estimatedMinutes` must be at least 1');
    }

    if (input.actualMinutes === null) {
      throw new BadRequestException('`actualMinutes` must not be null');
    }
  }

  @ResolveField(() => Boolean)
  async placedOnCalendar(@Context() context: RequestContext, @Parent() parent: TaskType): Promise<boolean> {
    if (typeof parent.placedOnCalendar === 'boolean') {
      return parent.placedOnCalendar;
    }

    if (!(await this.isPlanningEnabled())) {
      return false;
    }

    const event = await this.plannedBlockService.findActiveForTask(
      toServiceContext(context),
      GlobalUID.parse('task', parent.id),
    );

    return event != null;
  }

  @ResolveField(() => [TaskType])
  async children(@Context() context: RequestContext, @Parent() parent: TaskType): Promise<TaskType[]> {
    if (!(await this.isPlanningEnabled())) {
      return [];
    }

    const serviceContext = toServiceContext(context);
    const parentId = GlobalUID.parse('task', parent.id);
    const children = await this.taskService.findChildren(serviceContext, parentId);

    return children.map((task) => TaskType.toType(task));
  }

  @Mutation(() => CreateTaskPayload)
  @GraphqlPrivacy({ destructive: false })
  async createTask(
    @Context() context: RequestContext,
    @Args('input') input: CreateTaskInput,
  ): Promise<CreateTaskPayload> {
    await this.assertPlanningEnabled();
    this.assertTaskFields(input);
    const serviceContext = toServiceContext(context);
    const task = await this.taskService.create(serviceContext, {
      title: input.title,
      description: input.description,
      notes: input.notes,
      status: input.status as TaskStatus | undefined,
      priority: input.priority,
      parentId: input.parentId ? GlobalUID.parse('task', input.parentId) : undefined,
      dueAt: input.dueAt,
      taskTime: input.taskTime,
      scheduledFor: input.scheduledFor,
      deferUntil: input.deferUntil,
      estimatedMinutes: input.estimatedMinutes,
    });

    if (task == null) {
      return { success: false };
    }

    return { success: true, task: TaskType.toType(task) };
  }

  @Mutation(() => UpdateTaskPayload)
  @GraphqlPrivacy({ destructive: false })
  async updateTask(
    @Context() context: RequestContext,
    @Args('input') input: UpdateTaskInput,
  ): Promise<UpdateTaskPayload> {
    await this.assertPlanningEnabled();
    this.assertTaskFields(input);
    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('task', input.id);
    const task = await this.taskService.update(serviceContext, id, {
      title: input.title,
      description: input.description,
      notes: input.notes,
      status: input.status as TaskStatus | undefined,
      priority: input.priority,
      // Three-way, not two: `undefined` is "leave the parent alone" and `null`
      // is "detach". The old `input.parentId ? … : undefined` collapsed both
      // onto a no-op, so promoting a subtask to top level answered
      // `success: true` and changed nothing — there was no argument value that
      // could ever clear parent_id. Same shape as the `tasks` query's own
      // parentId filter below, and as PlaceResolver's parent_place_id.
      parentId:
        input.parentId !== undefined
          ? input.parentId
            ? GlobalUID.parse('task', input.parentId)
            : null
          : undefined,
      dueAt: input.dueAt,
      taskTime: input.taskTime,
      scheduledFor: input.scheduledFor,
      deferUntil: input.deferUntil,
      estimatedMinutes: input.estimatedMinutes,
      actualMinutes: input.actualMinutes,
    });

    if (task == null) {
      return { success: false };
    }

    return { success: true, task: TaskType.toType(task) };
  }

  @Mutation(() => DeleteByIdPayload)
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async deleteTask(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
    await this.assertPlanningEnabled();
    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('task', input.id);
    const success = await this.taskService.remove(serviceContext, id);

    if (!success) {
      return { success: false };
    }

    return { success, deletedId: input.id };
  }

  @Mutation(() => TaskType, {
    nullable: true,
    description: 'Mark a task done. Idempotent — the original completion instant is preserved.',
  })
  // Reversible via reopenTask, which exists in this same resolver — unlike the mergePeople/deleteTag
  // family, this status transition has a real undo path in the schema.
  @GraphqlPrivacy({ destructive: false })
  async completeTask(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
    @Args('actualMinutes', { type: () => Int, nullable: true }) actualMinutes?: number,
  ): Promise<TaskType | null> {
    if (!(await this.isPlanningEnabled())) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const task = await this.taskService.complete(serviceContext, GlobalUID.parse('task', gid), actualMinutes);

    return task ? TaskType.toType(task) : null;
  }

  @Mutation(() => TaskType, { nullable: true, description: 'Move a completed task back to open.' })
  @GraphqlPrivacy({ destructive: false })
  async reopenTask(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<TaskType | null> {
    if (!(await this.isPlanningEnabled())) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const task = await this.taskService.reopen(serviceContext, GlobalUID.parse('task', gid));

    return task ? TaskType.toType(task) : null;
  }

  @Mutation(() => TaskType, {
    nullable: true,
    description:
      'Accept a proposed task into the open backlog. Keeps any preferred date as a hint; does not place a calendar block.',
  })
  @GraphqlPrivacy({ destructive: false })
  async acceptProposedTask(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<TaskType | null> {
    if (!(await this.isPlanningEnabled())) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const task = await this.taskService.acceptProposed(serviceContext, GlobalUID.parse('task', gid));

    return task ? this.toTaskType(task, false) : null;
  }

  @Mutation(() => TaskType, {
    nullable: true,
    description: 'Decline a proposed task (archives it).',
  })
  // Archives the task with no unarchive mutation exposed anywhere in this schema — irreversible
  // through this surface, the same standard PlanningCompleteTaskTool uses ("nothing exposes an
  // uncomplete path" -> destructive:true) even though the row itself is never hard-deleted.
  @GraphqlPrivacy({ destructive: true })
  async declineProposedTask(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<TaskType | null> {
    if (!(await this.isPlanningEnabled())) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const task = await this.taskService.declineProposed(serviceContext, GlobalUID.parse('task', gid));

    return task ? TaskType.toType(task) : null;
  }

  @Mutation(() => ResolveTaskPendingChangePayload, {
    description: 'Apply a pending automation change (mutate / complete / event revise).',
  })
  @GraphqlPrivacy({ destructive: false })
  async acceptTaskPendingChange(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ResolveTaskPendingChangePayload> {
    await this.assertPlanningEnabled();
    const serviceContext = toServiceContext(context);
    const { task, change } = await this.taskService.acceptPendingChange(
      serviceContext,
      GlobalUID.parse('taskPendingChange', gid),
    );

    if (change?.kind === 'schedule' && task) {
      await this.plannedBlockService.applyPendingSchedule(serviceContext, task.id, change.patch);
    } else if (change?.kind === 'event_revise' && task) {
      await this.plannedBlockService.applyPendingEventRevision(serviceContext, task.id, change.patch);
    }

    const refreshed = task ? await this.taskService.findById(serviceContext, task.id) : null;

    return {
      success: change != null,
      task: (refreshed ?? task) ? TaskType.toType(refreshed ?? task!) : null,
      change: change ? TaskPendingChangeType.toType(change) : null,
    };
  }

  @Mutation(() => ResolveTaskPendingChangePayload, {
    description: 'Dismiss a pending automation change without applying it.',
  })
  // Discards a queued automation suggestion, not user-entered data; the task itself is untouched.
  @GraphqlPrivacy({ destructive: false })
  async declineTaskPendingChange(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<ResolveTaskPendingChangePayload> {
    await this.assertPlanningEnabled();
    const serviceContext = toServiceContext(context);
    const change = await this.taskService.declinePendingChange(
      serviceContext,
      GlobalUID.parse('taskPendingChange', gid),
    );

    return {
      success: change != null,
      task: null,
      change: change ? TaskPendingChangeType.toType(change) : null,
    };
  }

  @Mutation(() => TaskType, {
    nullable: true,
    description: 'Push a task to a later user-local date (`YYYY-MM-DD`) and count the push.',
  })
  @GraphqlPrivacy({ destructive: false })
  async deferTask(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
    @Args('until') until: string,
  ): Promise<TaskType | null> {
    if (!(await this.isPlanningEnabled())) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const task = await this.taskService.defer(serviceContext, GlobalUID.parse('task', gid), until);

    return task ? TaskType.toType(task) : null;
  }

  @Mutation(() => ScheduleTaskPayload, {
    description:
      'Place an open task into the next free workday gap as a planned calendar block. The click is consent — trust dial does not re-ask.',
  })
  // scheduleTaskAt (the startTime-given path) moves an existing block via eventService.reschedule
  // — an in-place update, not delete-then-recreate. Unlike unscheduleTask/planTask below, no block
  // row is ever removed here.
  @GraphqlPrivacy({ destructive: false })
  async scheduleTask(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
    @Args('estimatedMinutes', { type: () => Int, nullable: true }) estimatedMinutes?: number,
    @Args('date', { nullable: true, description: 'Owner-local YYYY-MM-DD to prefer.' }) date?: string,
    @Args('startTime', {
      type: () => Date,
      nullable: true,
      description:
        'An exact instant to place at — a calendar drop, not a "put this somewhere" click. ' +
        'When given, the gap solver is bypassed entirely and `date` is ignored.',
    })
    startTime?: Date,
    @Args('endTime', {
      type: () => Date,
      nullable: true,
      description:
        'Paired with `startTime`. Omit to keep the task’s own estimate (or the existing block’s duration, if moving one).',
    })
    endTime?: Date,
  ): Promise<ScheduleTaskPayload> {
    await this.assertPlanningEnabled();

    // `ci.events` carries `valid_time_range CHECK (start_time <= end_time)`,
    // and formatError masks the 23514 it raises as a bare `Internal server
    // error`. A resize handle dragged past its own start is user input, not a
    // server fault — and the byte-identical mistake sent to the sibling
    // `rescheduleEvent` already gets a clean 400, so answer it with the same
    // message here rather than 500-ing on one of the two mutations that back
    // the same gesture.
    if (startTime && endTime && endTime < startTime) {
      throw new BadRequestException('`endTime` must not precede `startTime`');
    }

    const serviceContext = toServiceContext(context);
    const taskId = GlobalUID.parse('task', gid);

    const outcome = startTime
      ? await this.plannedBlockService.scheduleTaskAt(
          serviceContext,
          taskId,
          startTime,
          endTime,
          estimatedMinutes,
        )
      : await this.plannedBlockService.scheduleTask(serviceContext, taskId, { estimatedMinutes, date });

    const placed = outcome.status === 'placed' || outcome.status === 'already_placed';

    return {
      success: placed,
      status: outcome.status,
      task: outcome.task ? this.toTaskType(outcome.task, placed) : undefined,
      event: 'event' in outcome && outcome.event ? EventType.toType(outcome.event) : undefined,
    };
  }

  @Mutation(() => TaskType, {
    nullable: true,
    description:
      'Accept into Unscheduled: open if proposed, drop pending suggestions, remove any calendar block.',
  })
  // Own description says "remove any calendar block", and PlannedBlockService.planAsUnscheduled
  // confirms it: it calls the exact same `eventService.remove(context, existing.id)` unscheduleTask
  // uses, plus discards every pending automation change on the task. Same destructive operation as
  // unscheduleTask, reachable through a mutation named like a constructive "accept into backlog"
  // action — the same bug class this audit exists to close.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async planTask(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<TaskType | null> {
    if (!(await this.isPlanningEnabled())) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const task = await this.plannedBlockService.planAsUnscheduled(
      serviceContext,
      GlobalUID.parse('task', gid),
    );

    return task ? this.toTaskType(task, false) : null;
  }

  @Mutation(() => TaskType, {
    nullable: true,
    description: 'Remove the planned block for this task and clear scheduledFor.',
  })
  // Deletes the planned block row. Its own description starts "Remove the planned block" — but the
  // heuristic reads the FIELD NAME, not the description.
  @GraphqlPrivacy({ access: 'delete', destructive: true })
  async unscheduleTask(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<TaskType | null> {
    if (!(await this.isPlanningEnabled())) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const task = await this.plannedBlockService.unschedule(serviceContext, GlobalUID.parse('task', gid));

    return task ? this.toTaskType(task, false) : null;
  }

  @Query(() => [EventType], {
    description:
      'Planned blocks (`event_type = planned_block`) overlapping [from, to). SQL-pushdown, not the explorer events() feed.',
  })
  async plannedBlocks(
    @Context() context: RequestContext,
    @Args('from', { type: () => Date }) from: Date,
    @Args('to', { type: () => Date }) to: Date,
  ): Promise<EventType[]> {
    if (!(await this.isPlanningEnabled())) {
      return [];
    }

    const serviceContext = toServiceContext(context);
    const events = await this.plannedBlockService.list(serviceContext, from, to);

    return events.map((event) => EventType.toType(event));
  }

  @Query(() => TaskConnection)
  async tasks(
    @Context() context: RequestContext,
    @Args() pagination: PaginationArgs,
    @Args('status', { type: () => [TaskStatusEnum], nullable: true }) status?: TaskStatusEnum[],
    @Args('scheduledFor', {
      nullable: true,
      description: 'User-local calendar date, `YYYY-MM-DD`.',
    })
    scheduledFor?: string,
    @Args('parentId', {
      type: () => ID,
      nullable: true,
      description: 'Only direct children of this task. Pass null (omit) for no parent filter.',
    })
    parentId?: string | null,
  ): Promise<TaskConnection> {
    if (!(await this.isPlanningEnabled())) {
      return {
        edges: [],
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: 0,
      };
    }

    const serviceContext = toServiceContext(context);
    const entities = await this.taskService.findAll(serviceContext, {
      status: status as TaskStatus[] | undefined,
      scheduledFor,
      parentId: parentId === undefined ? undefined : parentId ? GlobalUID.parse('task', parentId) : null,
    });

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('task', entity.id),
    });

    const placedIds = await this.plannedBlockService.listActiveTaskIds(
      serviceContext,
      slice.map((entity) => entity.id),
    );

    const edges: TaskEdge[] = slice.map((entity) => {
      const node = this.toTaskType(entity, placedIds.has(entity.id));

      return { node, cursor: node.id };
    });

    return { edges, pageInfo, totalCount };
  }

  @Query(() => [TaskPendingChangeType], {
    description: 'Pending trust-dial confirmations for mutate/complete/revise/schedule.',
  })
  async taskPendingChanges(
    @Context() context: RequestContext,
    @Args('taskId', { type: () => ID, nullable: true }) taskId?: string,
  ): Promise<TaskPendingChangeType[]> {
    if (!(await this.isPlanningEnabled())) {
      return [];
    }

    const serviceContext = toServiceContext(context);
    const changes = await this.taskService.findPendingChanges(serviceContext, {
      taskId: taskId ? GlobalUID.parse('task', taskId) : undefined,
    });

    return changes.map((change) => TaskPendingChangeType.toType(change));
  }

  @Query(() => TaskType, { nullable: true })
  async task(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<TaskType | null> {
    if (!(await this.isPlanningEnabled())) {
      return null;
    }

    const serviceContext = toServiceContext(context);
    const task = await this.taskService.findById(serviceContext, GlobalUID.parse('task', gid));

    if (!task) {
      return null;
    }

    const placed = (await this.plannedBlockService.findActiveForTask(serviceContext, task.id)) != null;

    return this.toTaskType(task, placed);
  }

  /**
   * Tags carry a task's direction and life-balance categories, so this is the
   * edge the placement and balance work reads from. Batched through TagLoader
   * for the same reason every other taggable type is: a Plan board renders
   * dozens of tasks in one query.
   */
  @ResolveField(() => [EntityTagType])
  async tags(@Context() context: RequestContext, @Parent() parent: TaskType): Promise<EntityTagType[]> {
    const serviceContext = toServiceContext(context);

    const tags = await this.tagLoader.load(serviceContext, {
      type: 'task',
      id: parent.__source.id,
    });

    return tags.map((tag) => EntityTagType.toType(tag));
  }
}

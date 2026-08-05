import { UseGuards } from '@nestjs/common';
import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { TaskService, type TaskStatus } from '@ci/domains/planning';

import { CreateTaskInput } from '../types/CreateTaskInput';
import { CreateTaskPayload } from '../types/CreateTaskPayload';
import { DeleteByIdInput } from '../types/DeleteByIdInput';
import { DeleteByIdPayload } from '../types/DeleteByIdPayload';
import { GlobalUID } from '../types/GlobalUID';
import { PaginationArgs } from '../types/PaginationArgs';
import { TaskConnection } from '../types/TaskConnection';
import { TaskEdge } from '../types/TaskEdge';
import { TaskStatusEnum, TaskType } from '../types/TaskType';
import { UpdateTaskInput } from '../types/UpdateTaskInput';
import { UpdateTaskPayload } from '../types/UpdateTaskPayload';
import { Paginator } from '../utils/Paginator';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => TaskType)
export class TaskResolver {
  constructor(private readonly taskService: TaskService) {}

  @Mutation(() => CreateTaskPayload)
  async createTask(
    @Context() context: RequestContext,
    @Args('input') input: CreateTaskInput,
  ): Promise<CreateTaskPayload> {
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
  async updateTask(
    @Context() context: RequestContext,
    @Args('input') input: UpdateTaskInput,
  ): Promise<UpdateTaskPayload> {
    const serviceContext = toServiceContext(context);
    const id = GlobalUID.parse('task', input.id);
    const task = await this.taskService.update(serviceContext, id, {
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
      actualMinutes: input.actualMinutes,
    });

    if (task == null) {
      return { success: false };
    }

    return { success: true, task: TaskType.toType(task) };
  }

  @Mutation(() => DeleteByIdPayload)
  async deleteTask(
    @Context() context: RequestContext,
    @Args('input') input: DeleteByIdInput,
  ): Promise<DeleteByIdPayload> {
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
  async completeTask(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
    @Args('actualMinutes', { type: () => Int, nullable: true }) actualMinutes?: number,
  ): Promise<TaskType | null> {
    const serviceContext = toServiceContext(context);
    const task = await this.taskService.complete(serviceContext, GlobalUID.parse('task', gid), actualMinutes);

    return task ? TaskType.toType(task) : null;
  }

  @Mutation(() => TaskType, { nullable: true, description: 'Move a completed task back to open.' })
  async reopenTask(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<TaskType | null> {
    const serviceContext = toServiceContext(context);
    const task = await this.taskService.reopen(serviceContext, GlobalUID.parse('task', gid));

    return task ? TaskType.toType(task) : null;
  }

  @Mutation(() => TaskType, {
    nullable: true,
    description: 'Push a task to a later user-local date (`YYYY-MM-DD`) and count the push.',
  })
  async deferTask(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
    @Args('until') until: string,
  ): Promise<TaskType | null> {
    const serviceContext = toServiceContext(context);
    const task = await this.taskService.defer(serviceContext, GlobalUID.parse('task', gid), until);

    return task ? TaskType.toType(task) : null;
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
  ): Promise<TaskConnection> {
    const serviceContext = toServiceContext(context);
    const entities = await this.taskService.findAll(serviceContext, {
      status: status as TaskStatus[] | undefined,
      scheduledFor,
    });

    const { slice, pageInfo, totalCount } = Paginator.paginate(entities, {
      ...pagination,
      getId: (entity) => GlobalUID.encode('task', entity.id),
    });

    const edges: TaskEdge[] = slice.map((entity) => {
      const node = TaskType.toType(entity);

      return { node, cursor: node.id };
    });

    return { edges, pageInfo, totalCount };
  }

  @Query(() => TaskType, { nullable: true })
  async task(
    @Context() context: RequestContext,
    @Args('id', { type: () => ID }) gid: string,
  ): Promise<TaskType | null> {
    const serviceContext = toServiceContext(context);
    const task = await this.taskService.findById(serviceContext, GlobalUID.parse('task', gid));

    return task ? TaskType.toType(task) : null;
  }
}

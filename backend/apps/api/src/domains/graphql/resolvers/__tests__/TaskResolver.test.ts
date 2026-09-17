import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { type RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
import { TaskType } from '../../types/TaskType';
import { TaskResolver } from '../TaskResolver';

const ownerCtx = { userId: 'owner-1' } as unknown as RequestContext;

function makeResolver(enabled = true) {
  const taskService = {
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    complete: jest.fn(),
    reopen: jest.fn(),
    defer: jest.fn(),
    findAll: jest.fn().mockResolvedValue([]),
    findById: jest.fn(),
    acceptProposed: jest.fn(),
    acceptPendingChange: jest.fn(),
    declinePendingChange: jest.fn(),
  };
  const plannedBlockService = {
    tryPlaceAfterOpen: jest.fn(),
    scheduleTask: jest.fn(),
    scheduleTaskAt: jest.fn(),
    unschedule: jest.fn(),
    planAsUnscheduled: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
    listActiveTaskIds: jest.fn().mockResolvedValue(new Set()),
    findActiveForTask: jest.fn().mockResolvedValue(null),
    applyPendingSchedule: jest.fn(),
    applyPendingEventRevision: jest.fn(),
  };
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(enabled) };
  const tagLoader = { load: jest.fn().mockResolvedValue([]) };

  return {
    resolver: new TaskResolver(
      taskService as never,
      plannedBlockService as never,
      featureService as never,
      tagLoader as never,
    ),
    taskService,
    plannedBlockService,
    featureService,
    tagLoader,
  };
}

describe('TaskResolver feature gating', () => {
  it('gates reads on planning.enabled', async () => {
    const { resolver, featureService } = makeResolver();

    await resolver.tasks(ownerCtx, {});

    expect(featureService.isFeatureEnabled).toHaveBeenCalledWith('planning.enabled');
  });

  it('returns an empty connection without reading when the flag is off', async () => {
    const { resolver, taskService } = makeResolver(false);

    await expect(resolver.tasks(ownerCtx, {})).resolves.toEqual({
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      totalCount: 0,
    });
    expect(taskService.findAll).not.toHaveBeenCalled();
  });

  it('refuses writes when the flag is off', async () => {
    const { resolver, taskService } = makeResolver(false);

    await expect(resolver.createTask(ownerCtx, { title: 'Call the dentist' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(taskService.create).not.toHaveBeenCalled();
  });
});

describe('TaskResolver placedOnCalendar field resolver', () => {
  const TASK_ID = '11111111-1111-1111-1111-111111111111';

  const task = {
    id: TASK_ID,
    userId: 'owner-1',
    title: 'Dentist appointment',
    description: null,
    notes: null,
    status: 'open',
    priority: 3,
    parentId: null,
    dueAt: null,
    taskTime: null,
    scheduledFor: '2026-08-29',
    deferUntil: null,
    deferCount: 0,
    estimatedMinutes: 30,
    actualMinutes: 0,
    completedAt: null,
    sourceKind: 'inbox',
    sourceRef: null,
    l0Class: null,
    l1ClusterId: null,
    metadata: {},
    createdAt: new Date('2026-08-29T00:00:00.000Z'),
    updatedAt: new Date('2026-08-29T00:00:00.000Z'),
  };

  it('runs the fallback lookup for a bare TaskType.toType(...) parent, instead of short-circuiting on a hardcoded false', async () => {
    const { resolver, plannedBlockService } = makeResolver();
    const event = { id: '22222222-2222-2222-2222-222222222222' };
    plannedBlockService.findActiveForTask.mockResolvedValue(event);

    const placed = await resolver.placedOnCalendar(ownerCtx, TaskType.toType(task as never));

    expect(plannedBlockService.findActiveForTask).toHaveBeenCalled();
    expect(placed).toBe(true);
  });

  it('reports a scheduled task as placed after updateTask, which returns a bare TaskType.toType(...)', async () => {
    const { resolver, taskService, plannedBlockService } = makeResolver();
    const event = { id: '22222222-2222-2222-2222-222222222222' };
    taskService.update.mockResolvedValue(task);
    plannedBlockService.findActiveForTask.mockResolvedValue(event);

    const payload = await resolver.updateTask(ownerCtx, {
      id: GlobalUID.encode('task', TASK_ID),
      title: 'x',
    });
    const placed = await resolver.placedOnCalendar(ownerCtx, payload.task!);

    expect(placed).toBe(true);
  });
});

describe('TaskResolver acceptProposedTask', () => {
  it('opens the task and does not place a calendar block', async () => {
    const { resolver, taskService, plannedBlockService } = makeResolver();
    const opened = {
      id: '11111111-1111-1111-1111-111111111111',
      userId: 'owner-1',
      title: 'Call the dentist',
      description: null,
      notes: null,
      status: 'open',
      priority: 3,
      parentId: null,
      dueAt: null,
      taskTime: null,
      scheduledFor: '2026-08-29',
      deferUntil: null,
      deferCount: 0,
      estimatedMinutes: 30,
      actualMinutes: 0,
      completedAt: null,
      sourceKind: 'inbox',
      sourceRef: null,
      l0Class: null,
      l1ClusterId: null,
      metadata: {},
      createdAt: new Date('2026-08-29T00:00:00.000Z'),
      updatedAt: new Date('2026-08-29T00:00:00.000Z'),
    };
    taskService.acceptProposed.mockResolvedValue(opened);

    const result = await resolver.acceptProposedTask(ownerCtx, GlobalUID.encode('task', opened.id));

    expect(plannedBlockService.tryPlaceAfterOpen).not.toHaveBeenCalled();
    expect(result?.placedOnCalendar).toBe(false);
    expect(result?.status).toBe('open');
  });
});

describe('TaskResolver acceptTaskPendingChange', () => {
  const TASK_ID = '11111111-1111-1111-1111-111111111111';
  const BLOCK_ID = '22222222-2222-2222-2222-222222222222';
  const CHANGE_ID = '33333333-3333-3333-3333-333333333333';

  const task = {
    id: TASK_ID,
    userId: 'owner-1',
    title: 'Dentist appointment',
    description: null,
    notes: null,
    status: 'open',
    priority: 3,
    parentId: null,
    dueAt: null,
    taskTime: null,
    scheduledFor: '2026-08-29',
    deferUntil: null,
    deferCount: 0,
    estimatedMinutes: 30,
    actualMinutes: 0,
    completedAt: null,
    sourceKind: 'inbox',
    sourceRef: null,
    l0Class: null,
    l1ClusterId: null,
    metadata: {},
    createdAt: new Date('2026-08-29T00:00:00.000Z'),
    updatedAt: new Date('2026-08-29T00:00:00.000Z'),
  };

  /**
   * A fake events table, which flips only when the resolver forwards BOTH the
   * change's task id and its `eventId`/`eventStatus` — so the assertion below
   * covers the arguments, not just that a method was called.
   *
   * It is still the mock doing the writing. That the ci.events row itself
   * moves, past the status CHECK constraint and the CTI base/detail
   * transaction, is proved against real Postgres in
   * `planning/services/__tests__/TaskService.tenancy.integration.test.ts`.
   */
  function wire(kind: 'event_revise' | 'schedule', patch: Record<string, unknown>) {
    const harness = makeResolver();
    const block = { id: BLOCK_ID, taskId: TASK_ID, status: 'confirmed' };

    harness.taskService.acceptPendingChange.mockResolvedValue({
      task,
      change: { id: CHANGE_ID, taskId: TASK_ID, kind, patch, status: 'accepted' },
    });
    harness.taskService.findById.mockResolvedValue(task);
    harness.plannedBlockService.applyPendingEventRevision.mockImplementation(
      async (_ctx: unknown, taskId: string, applied: Record<string, unknown>) => {
        if (taskId === block.taskId && applied.eventId === block.id) {
          block.status = String(applied.eventStatus);
        }

        return block;
      },
    );

    return { ...harness, block };
  }

  it('cancels the linked calendar block when an event_revise change is accepted', async () => {
    const { resolver, block } = wire('event_revise', { eventStatus: 'cancelled', eventId: BLOCK_ID });

    const result = await resolver.acceptTaskPendingChange(
      ownerCtx,
      GlobalUID.encode('taskPendingChange', CHANGE_ID),
    );

    // Accepting used to mark the change 'accepted' and touch nothing else, so
    // the appointment the user had just confirmed as cancelled kept showing.
    expect(block.status).toBe('cancelled');
    expect(result.success).toBe(true);
  });

  it('does not route a schedule change through the event-revision path', async () => {
    const { resolver, plannedBlockService } = wire('schedule', {
      startTime: '2026-08-29T09:00:00.000Z',
      endTime: '2026-08-29T09:30:00.000Z',
    });

    await resolver.acceptTaskPendingChange(ownerCtx, GlobalUID.encode('taskPendingChange', CHANGE_ID));

    expect(plannedBlockService.applyPendingSchedule).toHaveBeenCalled();
    expect(plannedBlockService.applyPendingEventRevision).not.toHaveBeenCalled();
  });
});

describe('TaskResolver planTask', () => {
  it('returns the task off the calendar', async () => {
    const { resolver, plannedBlockService } = makeResolver();
    const opened = {
      id: '11111111-1111-1111-1111-111111111111',
      userId: 'owner-1',
      title: 'Call the dentist',
      description: null,
      notes: null,
      status: 'open',
      priority: 3,
      parentId: null,
      dueAt: null,
      taskTime: null,
      scheduledFor: null,
      deferUntil: null,
      deferCount: 0,
      estimatedMinutes: 30,
      actualMinutes: 0,
      completedAt: null,
      sourceKind: 'inbox',
      sourceRef: null,
      l0Class: null,
      l1ClusterId: null,
      metadata: {},
      createdAt: new Date('2026-08-29T00:00:00.000Z'),
      updatedAt: new Date('2026-08-29T00:00:00.000Z'),
    };
    plannedBlockService.planAsUnscheduled.mockResolvedValue(opened);

    const result = await resolver.planTask(ownerCtx, GlobalUID.encode('task', opened.id));

    expect(plannedBlockService.planAsUnscheduled).toHaveBeenCalled();
    expect(result?.placedOnCalendar).toBe(false);
    expect(result?.scheduledFor).toBeNull();
    expect(result?.status).toBe('open');
  });
});

describe('TaskResolver.tags', () => {
  // Tags are how a task inherits its direction and life-balance categories, so
  // this edge is what the placement and balance work will read from. It must go
  // through TagLoader: a Plan board renders dozens of tasks in one query, and a
  // per-task query here is the N+1 the loader exists to prevent.
  it('hydrates tags for the task through the batching loader', async () => {
    const { resolver, tagLoader } = makeResolver();

    tagLoader.load.mockResolvedValue([
      { id: 'tag-1', label: 'work', entityType: 'task', entityId: 'task-1' },
    ]);

    const parent = { __source: { id: 'task-1' } } as never;
    const tags = await resolver.tags(ownerCtx, parent);

    expect(tagLoader.load).toHaveBeenCalledWith({ userId: 'owner-1' }, { type: 'task', id: 'task-1' });
    expect(tags).toHaveLength(1);
  });

  it('returns an empty list for an untagged task rather than throwing', async () => {
    const { resolver, tagLoader } = makeResolver();

    tagLoader.load.mockResolvedValue([]);

    const tags = await resolver.tags(ownerCtx, { __source: { id: 'task-2' } } as never);

    expect(tags).toEqual([]);
  });
});

describe('TaskResolver.updateTask parentId', () => {
  const TASK_ID = '11111111-1111-1111-1111-111111111111';
  const PARENT_ID = '22222222-2222-2222-2222-222222222222';

  // `null` and `undefined` are two different instructions here, and the
  // resolver used to collapse both onto "leave it alone" — so a subtask could
  // never be promoted to top level by any argument value at all.
  it('forwards parentId: null as null so a subtask can be detached', async () => {
    const { resolver, taskService } = makeResolver();
    taskService.update.mockResolvedValue(null);

    await resolver.updateTask(ownerCtx, {
      id: GlobalUID.encode('task', TASK_ID),
      parentId: null as unknown as string,
    });

    expect(taskService.update).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      TASK_ID,
      expect.objectContaining({ parentId: null }),
    );
  });

  it('leaves the parent alone when parentId is absent', async () => {
    const { resolver, taskService } = makeResolver();
    taskService.update.mockResolvedValue(null);

    await resolver.updateTask(ownerCtx, { id: GlobalUID.encode('task', TASK_ID), title: 'x' });

    expect(taskService.update).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      TASK_ID,
      expect.objectContaining({ parentId: undefined }),
    );
  });

  it('decodes a supplied parentId to its raw uuid', async () => {
    const { resolver, taskService } = makeResolver();
    taskService.update.mockResolvedValue(null);

    await resolver.updateTask(ownerCtx, {
      id: GlobalUID.encode('task', TASK_ID),
      parentId: GlobalUID.encode('task', PARENT_ID),
    });

    expect(taskService.update).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      TASK_ID,
      expect.objectContaining({ parentId: PARENT_ID }),
    );
  });
});

describe('TaskResolver.scheduleTask time ordering', () => {
  const TASK_ID = '11111111-1111-1111-1111-111111111111';

  // ci.events' valid_time_range CHECK is the only thing that used to catch
  // this, and formatError masks the 23514 as a bare `Internal server error`.
  // The identical drag sent to EventResolver.rescheduleEvent has always
  // answered 400, so the two mutations must not disagree.
  it('rejects an endTime that precedes startTime without touching the writer', async () => {
    const { resolver, plannedBlockService } = makeResolver();

    await expect(
      resolver.scheduleTask(
        ownerCtx,
        GlobalUID.encode('task', TASK_ID),
        undefined,
        undefined,
        new Date('2026-09-10T10:00:00Z'),
        new Date('2026-09-10T08:00:00Z'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(plannedBlockService.scheduleTaskAt).not.toHaveBeenCalled();
  });

  it('places a well-ordered interval', async () => {
    const { resolver, plannedBlockService } = makeResolver();
    plannedBlockService.scheduleTaskAt.mockResolvedValue({ status: 'placed', task: null, event: null });

    const start = new Date('2026-09-10T10:00:00Z');
    const end = new Date('2026-09-10T11:00:00Z');
    const result = await resolver.scheduleTask(
      ownerCtx,
      GlobalUID.encode('task', TASK_ID),
      undefined,
      undefined,
      start,
      end,
    );

    expect(plannedBlockService.scheduleTaskAt).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      TASK_ID,
      start,
      end,
      undefined,
    );
    expect(result.success).toBe(true);
  });
});

describe('TaskResolver input bounds', () => {
  const TASK_ID = '11111111-1111-1111-1111-111111111111';

  // Every one of these is schema-legal but violates a ci.tasks CHECK or NOT
  // NULL, and formatError turns that QueryFailedError into an unclassified
  // 500 that never names the offending argument.
  it.each([
    ['priority above the CHECK range', { title: 'Call the dentist', priority: 9 }],
    ['priority below the CHECK range', { title: 'Call the dentist', priority: -1 }],
    ['estimatedMinutes of zero', { title: 'Call the dentist', estimatedMinutes: 0 }],
    ['a null priority', { title: 'Call the dentist', priority: null as unknown as number }],
  ])('createTask rejects %s', async (_label, input) => {
    const { resolver, taskService } = makeResolver();

    await expect(resolver.createTask(ownerCtx, input)).rejects.toBeInstanceOf(BadRequestException);
    expect(taskService.create).not.toHaveBeenCalled();
  });

  it('createTask accepts both endpoints of the priority range', async () => {
    const { resolver, taskService } = makeResolver();
    taskService.create.mockResolvedValue(null);

    await resolver.createTask(ownerCtx, { title: 'Call the dentist', priority: 0, estimatedMinutes: 1 });
    await resolver.createTask(ownerCtx, { title: 'Call the dentist', priority: 5 });

    expect(taskService.create).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a null title', { title: null as unknown as string }],
    ['a null status', { status: null as unknown as undefined }],
    ['a null actualMinutes', { actualMinutes: null as unknown as number }],
    ['an out-of-range priority', { priority: 6 }],
  ])('updateTask rejects %s', async (_label, patch) => {
    const { resolver, taskService } = makeResolver();

    await expect(
      resolver.updateTask(ownerCtx, { id: GlobalUID.encode('task', TASK_ID), ...patch }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(taskService.update).not.toHaveBeenCalled();
  });

  // estimatedMinutes IS nullable in ci.tasks — null clears the estimate, and
  // must not be swept up by the bounds check.
  it('updateTask still lets estimatedMinutes be cleared', async () => {
    const { resolver, taskService } = makeResolver();
    taskService.update.mockResolvedValue(null);

    await resolver.updateTask(ownerCtx, {
      id: GlobalUID.encode('task', TASK_ID),
      estimatedMinutes: null as unknown as number,
    });

    expect(taskService.update).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      TASK_ID,
      expect.objectContaining({ estimatedMinutes: null }),
    );
  });
});

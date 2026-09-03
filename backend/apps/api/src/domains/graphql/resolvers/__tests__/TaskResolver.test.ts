import { ForbiddenException } from '@nestjs/common';

import { type RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
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
    unschedule: jest.fn(),
    planAsUnscheduled: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
    listActiveTaskIds: jest.fn().mockResolvedValue(new Set()),
    findActiveForTask: jest.fn().mockResolvedValue(null),
    applyPendingSchedule: jest.fn(),
    applyPendingEventRevision: jest.fn(),
  };
  const featureService = { isFeatureEnabled: jest.fn().mockResolvedValue(enabled) };

  return {
    resolver: new TaskResolver(taskService as never, plannedBlockService as never, featureService as never),
    taskService,
    plannedBlockService,
    featureService,
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

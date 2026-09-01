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

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import type { Task } from '../../entities/TaskEntity';
import type { PlanningTimeService } from '../PlanningTimeService';
import { ProposedTaskReconcileService } from '../ProposedTaskReconcileService';
import type { TaskService } from '../TaskService';

const CTX = { userId: 'user-1' } as UserServiceContext;
const TODAY = '2026-08-26';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    userId: CTX.userId,
    title: 'Call the vet',
    description: null,
    notes: null,
    status: 'proposed',
    priority: 3,
    parentId: null,
    dueAt: null,
    taskTime: null,
    scheduledFor: null,
    deferUntil: null,
    deferCount: 0,
    estimatedMinutes: null,
    actualMinutes: 0,
    completedAt: null,
    sourceKind: 'memory_scan',
    sourceRef: 'ref-vet',
    metadata: {},
    createdAt: new Date('2026-08-20T12:00:00.000Z'),
    updatedAt: new Date('2026-08-20T12:00:00.000Z'),
    ...overrides,
  } as Task;
}

function makePlanningTime(): PlanningTimeService {
  return {
    today: jest.fn(async () => TODAY),
    localDate: jest.fn(async (_ctx: unknown, instant: Date) => instant.toISOString().slice(0, 10)),
    toInstant: jest.fn(
      async (_ctx: unknown, date: string, wall: string) => new Date(`${date}T${wall}:00.000Z`),
    ),
  } as unknown as PlanningTimeService;
}

function makeLogger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
}

describe('ProposedTaskReconcileService', () => {
  let taskService: {
    findAll: jest.Mock;
    update: jest.Mock;
    declineProposed: jest.Mock;
  };
  let planningTime: PlanningTimeService;
  let service: ProposedTaskReconcileService;

  beforeEach(() => {
    taskService = {
      findAll: jest.fn(async () => []),
      update: jest.fn(async (_ctx: unknown, id: string, data: Record<string, unknown>) => ({
        id,
        ...data,
      })),
      declineProposed: jest.fn(async (_ctx: unknown, id: string) => ({ id, status: 'archived' })),
    };
    planningTime = makePlanningTime();
    service = new ProposedTaskReconcileService(
      taskService as unknown as TaskService,
      planningTime,
      makeLogger(),
    );
  });

  it('redates a past proposed task that this scan still surfaces', async () => {
    const task = makeTask({
      scheduledFor: '2026-08-20',
      dueAt: new Date('2026-08-22T12:00:00.000Z'),
    });
    taskService.findAll.mockResolvedValue([task]);

    const result = await service.reconcileStaleProposed(CTX, {
      sourceKind: 'memory_scan',
      relevantTitles: ['Call the vet'],
    });

    expect(result).toEqual({ redated: 1, archived: 0 });
    expect(taskService.declineProposed).not.toHaveBeenCalled();
    expect(taskService.update).toHaveBeenCalledWith(CTX, task.id, {
      scheduledFor: TODAY,
      // Original planned→due span was 2 days; keep it when shifting onto today.
      dueAt: new Date('2026-08-28T12:00:00.000Z'),
    });
  });

  it('keeps a past proposal when this scan resurfaces a near-duplicate title', async () => {
    taskService.findAll.mockResolvedValue([
      makeTask({
        title: "Register for 'Network On Zoom'",
        scheduledFor: '2026-08-20',
        dueAt: new Date('2026-08-20T12:00:00.000Z'),
      }),
    ]);

    await service.reconcileStaleProposed(CTX, {
      sourceKind: 'memory_scan',
      relevantTitles: ['Register for Network On Zoom'],
    });

    expect(taskService.update).toHaveBeenCalled();
    expect(taskService.declineProposed).not.toHaveBeenCalled();
  });

  it('matches resurfaced titles case-insensitively', async () => {
    taskService.findAll.mockResolvedValue([
      makeTask({ scheduledFor: '2026-08-20', dueAt: new Date('2026-08-20T12:00:00.000Z') }),
    ]);

    await service.reconcileStaleProposed(CTX, {
      sourceKind: 'memory_scan',
      relevantTitles: ['  CALL THE VET  '],
    });

    expect(taskService.update).toHaveBeenCalled();
    expect(taskService.declineProposed).not.toHaveBeenCalled();
  });

  it('treats a matching sourceRef as still relevant', async () => {
    taskService.findAll.mockResolvedValue([
      makeTask({
        title: 'Old wording',
        scheduledFor: '2026-08-20',
        dueAt: new Date('2026-08-20T12:00:00.000Z'),
        sourceRef: 'ref-vet',
      }),
    ]);

    await service.reconcileStaleProposed(CTX, {
      sourceKind: 'memory_scan',
      relevantTitles: [],
      relevantSourceRefs: ['ref-vet'],
    });

    expect(taskService.update).toHaveBeenCalled();
    expect(taskService.declineProposed).not.toHaveBeenCalled();
  });

  it('archives a past proposed task that this scan did not resurface', async () => {
    const task = makeTask({ scheduledFor: '2026-08-20' });
    taskService.findAll.mockResolvedValue([task]);

    const result = await service.reconcileStaleProposed(CTX, {
      sourceKind: 'memory_scan',
      relevantTitles: ['Something else'],
    });

    expect(result).toEqual({ redated: 0, archived: 1 });
    expect(taskService.declineProposed).toHaveBeenCalledWith(CTX, task.id);
    expect(taskService.update).not.toHaveBeenCalled();
  });

  it('leaves future-dated proposed tasks untouched', async () => {
    taskService.findAll.mockResolvedValue([
      makeTask({
        scheduledFor: '2026-09-01',
        dueAt: new Date('2026-09-02T12:00:00.000Z'),
      }),
    ]);

    const result = await service.reconcileStaleProposed(CTX, {
      sourceKind: 'memory_scan',
      relevantTitles: [],
    });

    expect(result).toEqual({ redated: 0, archived: 0 });
    expect(taskService.update).not.toHaveBeenCalled();
    expect(taskService.declineProposed).not.toHaveBeenCalled();
  });

  it('leaves proposed tasks from other source kinds untouched', async () => {
    taskService.findAll.mockResolvedValue([
      makeTask({ sourceKind: 'manual', scheduledFor: '2026-08-20' }),
      makeTask({ id: 'task-inbox', sourceKind: 'inbox', scheduledFor: '2026-08-20' }),
    ]);

    const result = await service.reconcileStaleProposed(CTX, {
      sourceKind: 'memory_scan',
      relevantTitles: [],
    });

    expect(result).toEqual({ redated: 0, archived: 0 });
    expect(taskService.declineProposed).not.toHaveBeenCalled();
  });

  it('leaves proposed tasks deferred into the future untouched', async () => {
    taskService.findAll.mockResolvedValue([
      makeTask({ scheduledFor: '2026-08-20', deferUntil: '2026-09-01' }),
    ]);

    const result = await service.reconcileStaleProposed(CTX, {
      sourceKind: 'memory_scan',
      relevantTitles: [],
    });

    expect(result).toEqual({ redated: 0, archived: 0 });
    expect(taskService.declineProposed).not.toHaveBeenCalled();
  });

  it('archives an undated proposed task created before today unless the title matches', async () => {
    const stale = makeTask({
      id: 'stale',
      title: 'Buy milk',
      scheduledFor: null,
      dueAt: null,
      createdAt: new Date('2026-08-25T18:00:00.000Z'),
    });
    const stillOpen = makeTask({
      id: 'keep',
      title: 'File taxes',
      scheduledFor: null,
      dueAt: null,
      createdAt: new Date('2026-08-25T18:00:00.000Z'),
    });
    taskService.findAll.mockResolvedValue([stale, stillOpen]);

    const result = await service.reconcileStaleProposed(CTX, {
      sourceKind: 'memory_scan',
      relevantTitles: ['File taxes'],
    });

    expect(result).toEqual({ redated: 1, archived: 1 });
    expect(taskService.declineProposed).toHaveBeenCalledWith(CTX, 'stale');
    expect(taskService.update).toHaveBeenCalledWith(CTX, 'keep', {
      scheduledFor: TODAY,
      dueAt: new Date('2026-08-26T12:00:00.000Z'),
    });
  });

  it('does not treat an undated proposed task created today as past', async () => {
    taskService.findAll.mockResolvedValue([
      makeTask({
        scheduledFor: null,
        dueAt: null,
        createdAt: new Date('2026-08-26T08:00:00.000Z'),
      }),
    ]);

    const result = await service.reconcileStaleProposed(CTX, {
      sourceKind: 'memory_scan',
      relevantTitles: [],
    });

    expect(result).toEqual({ redated: 0, archived: 0 });
  });

  it('fills a missing due date with noon today when redating', async () => {
    taskService.findAll.mockResolvedValue([makeTask({ scheduledFor: '2026-08-20', dueAt: null })]);

    await service.reconcileStaleProposed(CTX, {
      sourceKind: 'memory_scan',
      relevantTitles: ['Call the vet'],
    });

    expect(taskService.update).toHaveBeenCalledWith(CTX, 'task-1', {
      scheduledFor: TODAY,
      dueAt: new Date('2026-08-26T12:00:00.000Z'),
    });
  });

  it('windowForToday is owner-local today at noon', async () => {
    await expect(service.windowForToday(CTX)).resolves.toEqual({
      scheduledFor: TODAY,
      dueAt: new Date('2026-08-26T12:00:00.000Z'),
    });
  });
});

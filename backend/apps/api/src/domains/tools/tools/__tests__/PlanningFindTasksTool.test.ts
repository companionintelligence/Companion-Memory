import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { Task, TaskService } from '@ci/domains/planning/task.module';

import { PlanningFindTasksTool } from '../PlanningFindTasksTool';

const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    userId: CONTEXT.userId,
    title: 'Untitled',
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
    estimatedMinutes: null,
    actualMinutes: 0,
    completedAt: null,
    sourceKind: 'manual',
    sourceRef: null,
    l0Class: null,
    l1ClusterId: null,
    metadata: {},
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  } as Task;
}

function makeTool(findAll: jest.Mock) {
  return new PlanningFindTasksTool({ findAll } as unknown as TaskService, logger());
}

describe('PlanningFindTasksTool', () => {
  it('defaults to open/in_progress/delegated when no status is given', async () => {
    const findAll = jest.fn().mockResolvedValue([]);
    const tool = makeTool(findAll);

    await tool.execute(CONTEXT, {});

    expect(findAll).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      { status: ['open', 'in_progress', 'delegated'] },
    );
  });

  it('passes an explicit status filter straight through', async () => {
    const findAll = jest.fn().mockResolvedValue([]);
    const tool = makeTool(findAll);

    await tool.execute(CONTEXT, { status: ['proposed'] });

    expect(findAll).toHaveBeenCalledWith({ userId: CONTEXT.userId }, { status: ['proposed'] });
  });

  it('filters by a case-insensitive title substring', async () => {
    const findAll = jest
      .fn()
      .mockResolvedValue([
        task({ id: 'a', title: 'Draft the Fenwick contract' }),
        task({ id: 'b', title: 'Buy milk' }),
      ]);
    const tool = makeTool(findAll);

    const result = await tool.execute(CONTEXT, { query: 'fenwick' });

    expect(result.success).toBe(true);
    expect(result.data?.map((t) => t.id)).toEqual(['a']);
  });

  it('excludes tasks with no dueAt when a due-date bound is given', async () => {
    const findAll = jest
      .fn()
      .mockResolvedValue([
        task({ id: 'a', dueAt: new Date('2026-09-20T00:00:00.000Z') }),
        task({ id: 'b', dueAt: null }),
        task({ id: 'c', dueAt: new Date('2026-10-05T00:00:00.000Z') }),
      ]);
    const tool = makeTool(findAll);

    const result = await tool.execute(CONTEXT, { dueBefore: '2026-09-30T00:00:00.000Z' });

    expect(result.data?.map((t) => t.id)).toEqual(['a']);
  });

  it('applies dueAfter as an inclusive lower bound', async () => {
    const findAll = jest
      .fn()
      .mockResolvedValue([
        task({ id: 'a', dueAt: new Date('2026-09-20T00:00:00.000Z') }),
        task({ id: 'b', dueAt: new Date('2026-09-25T00:00:00.000Z') }),
      ]);
    const tool = makeTool(findAll);

    const result = await tool.execute(CONTEXT, { dueAfter: '2026-09-25T00:00:00.000Z' });

    expect(result.data?.map((t) => t.id)).toEqual(['b']);
  });

  it('caps results at limit (default 25)', async () => {
    const tasks = Array.from({ length: 30 }, (_, i) => task({ id: `t${i}` }));
    const findAll = jest.fn().mockResolvedValue(tasks);
    const tool = makeTool(findAll);

    const result = await tool.execute(CONTEXT, {});

    expect(result.data).toHaveLength(25);

    const limited = await tool.execute(CONTEXT, { limit: 2 });
    expect(limited.data).toHaveLength(2);
  });

  it('fails cleanly via BaseTool error handling when the execution context has no userId', async () => {
    const findAll = jest.fn();
    const tool = makeTool(findAll);

    const result = await tool.execute({} as RequestContext, {});

    expect(result.success).toBe(false);
    expect(findAll).not.toHaveBeenCalled();
  });

  it('rejects an empty status array at validation time', async () => {
    const findAll = jest.fn();
    const tool = makeTool(findAll);

    const result = await tool.execute(CONTEXT, { status: [] });

    expect(result.success).toBe(false);
    expect(findAll).not.toHaveBeenCalled();
  });
});

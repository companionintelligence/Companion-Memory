import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { Task, TaskService } from '@ci/domains/planning/task.module';

import { PlanningCreateTaskTool } from '../PlanningCreateTaskTool';

const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;
const PARENT_ID = '22222222-2222-2222-2222-222222222222';

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;
}

function makeTool(create: jest.Mock) {
  return new PlanningCreateTaskTool({ create } as unknown as TaskService, logger());
}

describe('PlanningCreateTaskTool', () => {
  it('creates a task through TaskService.create with a resolved UserServiceContext', async () => {
    const created = { id: 'new-task', title: 'Draft the Fenwick contract redline' } as Task;
    const create = jest.fn().mockResolvedValue(created);
    const tool = makeTool(create);

    const result = await tool.execute(CONTEXT, {
      title: 'Draft the Fenwick contract redline',
      priority: 1,
      dueAt: '2026-09-20T17:00:00.000Z',
      scheduledFor: '2026-09-18',
      taskTime: '09:30',
      estimatedMinutes: 45,
      parentId: PARENT_ID,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(created);
    expect(create).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      expect.objectContaining({
        title: 'Draft the Fenwick contract redline',
        priority: 1,
        dueAt: new Date('2026-09-20T17:00:00.000Z'),
        scheduledFor: '2026-09-18',
        taskTime: '09:30',
        estimatedMinutes: 45,
        parentId: PARENT_ID,
      }),
    );
  });

  it('never sends a status field — a direct create always lands in the open backlog', async () => {
    const create = jest.fn().mockResolvedValue({ id: 't', title: 'x' } as Task);
    const tool = makeTool(create);

    await tool.execute(CONTEXT, { title: 'x', status: 'proposed' } as unknown as Record<string, unknown>);

    const [, dto] = create.mock.calls[0];
    expect(dto).not.toHaveProperty('status');
  });

  it('rejects a priority outside 0-5 at validation time', async () => {
    const create = jest.fn();
    const tool = makeTool(create);

    const result = await tool.execute(CONTEXT, { title: 'x', priority: 9 });

    expect(result.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a malformed scheduledFor at validation time', async () => {
    const create = jest.fn();
    const tool = makeTool(create);

    const result = await tool.execute(CONTEXT, { title: 'x', scheduledFor: 'next tuesday' });

    expect(result.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a missing title at validation time', async () => {
    const create = jest.fn();
    const tool = makeTool(create);

    const result = await tool.execute(CONTEXT, {});

    expect(result.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('fails cleanly via BaseTool error handling when the execution context has no userId', async () => {
    const create = jest.fn();
    const tool = makeTool(create);

    const result = await tool.execute({} as RequestContext, { title: 'x' });

    expect(result.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it('surfaces a clear error if TaskService.create resolves null', async () => {
    const create = jest.fn().mockResolvedValue(null);
    const tool = makeTool(create);

    const result = await tool.execute(CONTEXT, { title: 'x' });

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Failed to create task');
  });
});

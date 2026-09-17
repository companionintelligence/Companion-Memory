import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { Task, TaskService } from '@ci/domains/planning/task.module';

import { PlanningUpdateTaskTool } from '../PlanningUpdateTaskTool';

const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;
const TASK_ID = '11111111-1111-1111-1111-111111111111';
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

function makeTool(update: jest.Mock) {
  return new PlanningUpdateTaskTool({ update } as unknown as TaskService, logger());
}

describe('PlanningUpdateTaskTool', () => {
  it('updates a task through TaskService.update with a resolved UserServiceContext', async () => {
    const updated = { id: TASK_ID, title: 'Redraft the Fenwick contract' } as Task;
    const update = jest.fn().mockResolvedValue(updated);
    const tool = makeTool(update);

    const result = await tool.execute(CONTEXT, {
      taskId: TASK_ID,
      title: 'Redraft the Fenwick contract',
      priority: 0,
      dueAt: '2026-09-20T17:00:00.000Z',
      scheduledFor: '2026-09-18',
      taskTime: '09:30',
      deferUntil: '2026-09-19',
      estimatedMinutes: 45,
      actualMinutes: 10,
      parentId: PARENT_ID,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(updated);
    expect(update).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      TASK_ID,
      expect.objectContaining({
        title: 'Redraft the Fenwick contract',
        priority: 0,
        dueAt: new Date('2026-09-20T17:00:00.000Z'),
        scheduledFor: '2026-09-18',
        taskTime: '09:30',
        deferUntil: '2026-09-19',
        estimatedMinutes: 45,
        actualMinutes: 10,
        parentId: PARENT_ID,
      }),
    );
  });

  it('omits dueAt from the patch entirely when not provided, rather than sending undefined', async () => {
    const update = jest.fn().mockResolvedValue({ id: TASK_ID } as Task);
    const tool = makeTool(update);

    await tool.execute(CONTEXT, { taskId: TASK_ID, title: 'x' });

    const [, , patch] = update.mock.calls[0];
    expect(patch).not.toHaveProperty('dueAt');
  });

  it('never sends a status field — status changes are excluded from this tool', async () => {
    const update = jest.fn().mockResolvedValue({ id: TASK_ID } as Task);
    const tool = makeTool(update);

    await tool.execute(CONTEXT, {
      taskId: TASK_ID,
      title: 'x',
      status: 'archived',
    } as unknown as Record<string, unknown>);

    const [, , patch] = update.mock.calls[0];
    expect(patch).not.toHaveProperty('status');
  });

  it('never sends a metadata field — excluded from this tool', async () => {
    const update = jest.fn().mockResolvedValue({ id: TASK_ID } as Task);
    const tool = makeTool(update);

    await tool.execute(CONTEXT, {
      taskId: TASK_ID,
      title: 'x',
      metadata: { hacked: true },
    } as unknown as Record<string, unknown>);

    const [, , patch] = update.mock.calls[0];
    expect(patch).not.toHaveProperty('metadata');
  });

  it('rejects a patch with no fields besides taskId at validation time', async () => {
    const update = jest.fn();
    const tool = makeTool(update);

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID });

    expect(result.success).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a priority outside 0-5 at validation time', async () => {
    const update = jest.fn();
    const tool = makeTool(update);

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID, priority: 9 });

    expect(result.success).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a malformed scheduledFor at validation time', async () => {
    const update = jest.fn();
    const tool = makeTool(update);

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID, scheduledFor: 'next tuesday' });

    expect(result.success).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a missing taskId at validation time', async () => {
    const update = jest.fn();
    const tool = makeTool(update);

    const result = await tool.execute(CONTEXT, { title: 'x' });

    expect(result.success).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('fails cleanly via BaseTool error handling when the execution context has no userId', async () => {
    const update = jest.fn();
    const tool = makeTool(update);

    const result = await tool.execute({} as RequestContext, { taskId: TASK_ID, title: 'x' });

    expect(result.success).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('surfaces a clear error if TaskService.update resolves null (task not found)', async () => {
    const update = jest.fn().mockResolvedValue(null);
    const tool = makeTool(update);

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID, title: 'x' });

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe(`Task ${TASK_ID} not found`);
  });
});

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { Task, TaskService } from '@ci/domains/planning/task.module';

import {
  PlanningAcceptProposedTaskTool,
  PlanningCompleteTaskTool,
  PlanningDeclineProposedTaskTool,
} from '../PlanningCompleteTaskTool';

const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;
const TASK_ID = '11111111-1111-1111-1111-111111111111';

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;
}

function makeTool(complete: jest.Mock) {
  return new PlanningCompleteTaskTool({ complete } as unknown as TaskService, logger());
}

describe('PlanningCompleteTaskTool', () => {
  it('completes a task through TaskService.complete with a resolved UserServiceContext', async () => {
    const completed = { id: TASK_ID, status: 'done' } as Task;
    const complete = jest.fn().mockResolvedValue(completed);
    const tool = makeTool(complete);

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID, actualMinutes: 30 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(completed);
    expect(complete).toHaveBeenCalledWith({ userId: CONTEXT.userId }, TASK_ID, 30);
  });

  it('completes a task without actualMinutes when it is omitted', async () => {
    const completed = { id: TASK_ID, status: 'done' } as Task;
    const complete = jest.fn().mockResolvedValue(completed);
    const tool = makeTool(complete);

    await tool.execute(CONTEXT, { taskId: TASK_ID });

    expect(complete).toHaveBeenCalledWith({ userId: CONTEXT.userId }, TASK_ID, undefined);
  });

  it('rejects a non-uuid taskId at validation time', async () => {
    const complete = jest.fn();
    const tool = makeTool(complete);

    const result = await tool.execute(CONTEXT, { taskId: 'not-a-uuid' });

    expect(result.success).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects a negative actualMinutes at validation time', async () => {
    const complete = jest.fn();
    const tool = makeTool(complete);

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID, actualMinutes: -5 });

    expect(result.success).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('fails cleanly via BaseTool error handling when the execution context has no userId', async () => {
    const complete = jest.fn();
    const tool = makeTool(complete);

    const result = await tool.execute({} as RequestContext, { taskId: TASK_ID });

    expect(result.success).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('surfaces a clear error if TaskService.complete resolves null (task not found)', async () => {
    const complete = jest.fn().mockResolvedValue(null);
    const tool = makeTool(complete);

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID });

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe(`Task ${TASK_ID} not found`);
  });
});

describe('PlanningAcceptProposedTaskTool', () => {
  it('accepts a proposed task through TaskService.acceptProposed with a resolved UserServiceContext', async () => {
    const accepted = { id: TASK_ID, status: 'open' } as Task;
    const acceptProposed = jest.fn().mockResolvedValue(accepted);
    const tool = new PlanningAcceptProposedTaskTool({ acceptProposed } as unknown as TaskService, logger());

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(accepted);
    expect(acceptProposed).toHaveBeenCalledWith({ userId: CONTEXT.userId }, TASK_ID);
  });

  it('rejects a non-uuid taskId at validation time', async () => {
    const acceptProposed = jest.fn();
    const tool = new PlanningAcceptProposedTaskTool({ acceptProposed } as unknown as TaskService, logger());

    const result = await tool.execute(CONTEXT, { taskId: 'not-a-uuid' });

    expect(result.success).toBe(false);
    expect(acceptProposed).not.toHaveBeenCalled();
  });

  it('surfaces a clear error if TaskService.acceptProposed resolves null (task not found)', async () => {
    const acceptProposed = jest.fn().mockResolvedValue(null);
    const tool = new PlanningAcceptProposedTaskTool({ acceptProposed } as unknown as TaskService, logger());

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID });

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe(`Task ${TASK_ID} not found`);
  });
});

describe('PlanningDeclineProposedTaskTool', () => {
  it('declines a proposed task through TaskService.declineProposed with a resolved UserServiceContext', async () => {
    const declined = { id: TASK_ID, status: 'archived' } as Task;
    const declineProposed = jest.fn().mockResolvedValue(declined);
    const tool = new PlanningDeclineProposedTaskTool(
      { declineProposed } as unknown as TaskService,
      logger(),
    );

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(declined);
    expect(declineProposed).toHaveBeenCalledWith({ userId: CONTEXT.userId }, TASK_ID);
  });

  it('marks the tool destructive and server-only so balanced/cautious presets gate it properly', () => {
    const tool = new PlanningDeclineProposedTaskTool(
      { declineProposed: jest.fn() } as unknown as TaskService,
      logger(),
    );
    expect(tool.schema.privacy.destructive).toBe(true);
    expect(tool.schema.localCapable).toBe(false);
  });

  it('surfaces a clear error if TaskService.declineProposed resolves null (task not found)', async () => {
    const declineProposed = jest.fn().mockResolvedValue(null);
    const tool = new PlanningDeclineProposedTaskTool(
      { declineProposed } as unknown as TaskService,
      logger(),
    );

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID });

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe(`Task ${TASK_ID} not found`);
  });
});

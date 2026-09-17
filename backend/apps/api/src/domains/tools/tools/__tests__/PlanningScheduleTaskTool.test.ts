import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { PlaceOutcome, PlannedBlockService } from '@ci/domains/planning/task.module';

import { PlanningScheduleTaskTool } from '../PlanningScheduleTaskTool';

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

function makeTool(scheduleTask: jest.Mock, scheduleTaskAt: jest.Mock) {
  return new PlanningScheduleTaskTool(
    { scheduleTask, scheduleTaskAt } as unknown as PlannedBlockService,
    logger(),
  );
}

describe('PlanningScheduleTaskTool', () => {
  it('auto-places through scheduleTask when no startAt is given', async () => {
    const outcome = { status: 'placed' } as unknown as PlaceOutcome;
    const scheduleTask = jest.fn().mockResolvedValue(outcome);
    const scheduleTaskAt = jest.fn();
    const tool = makeTool(scheduleTask, scheduleTaskAt);

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID, date: '2026-09-18', estimatedMinutes: 30 });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(outcome);
    expect(scheduleTask).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      TASK_ID,
      { estimatedMinutes: 30, date: '2026-09-18' },
    );
    expect(scheduleTaskAt).not.toHaveBeenCalled();
  });

  it('auto-places with no date/estimate when neither is given', async () => {
    const scheduleTask = jest.fn().mockResolvedValue({ status: 'placed' } as unknown as PlaceOutcome);
    const scheduleTaskAt = jest.fn();
    const tool = makeTool(scheduleTask, scheduleTaskAt);

    await tool.execute(CONTEXT, { taskId: TASK_ID });

    expect(scheduleTask).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      TASK_ID,
      { estimatedMinutes: undefined, date: undefined },
    );
  });

  it('places at an explicit instant through scheduleTaskAt when startAt is given', async () => {
    const outcome = { status: 'placed' } as unknown as PlaceOutcome;
    const scheduleTask = jest.fn();
    const scheduleTaskAt = jest.fn().mockResolvedValue(outcome);
    const tool = makeTool(scheduleTask, scheduleTaskAt);

    const result = await tool.execute(CONTEXT, {
      taskId: TASK_ID,
      startAt: '2026-09-18T15:00:00.000Z',
      endAt: '2026-09-18T15:30:00.000Z',
      estimatedMinutes: 30,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(outcome);
    expect(scheduleTaskAt).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      TASK_ID,
      new Date('2026-09-18T15:00:00.000Z'),
      new Date('2026-09-18T15:30:00.000Z'),
      30,
    );
    expect(scheduleTask).not.toHaveBeenCalled();
  });

  it('places at an explicit instant with no endAt', async () => {
    const scheduleTask = jest.fn();
    const scheduleTaskAt = jest.fn().mockResolvedValue({ status: 'placed' } as unknown as PlaceOutcome);
    const tool = makeTool(scheduleTask, scheduleTaskAt);

    await tool.execute(CONTEXT, { taskId: TASK_ID, startAt: '2026-09-18T15:00:00.000Z' });

    expect(scheduleTaskAt).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      TASK_ID,
      new Date('2026-09-18T15:00:00.000Z'),
      undefined,
      undefined,
    );
  });

  it('rejects providing both startAt and date at validation time', async () => {
    const scheduleTask = jest.fn();
    const scheduleTaskAt = jest.fn();
    const tool = makeTool(scheduleTask, scheduleTaskAt);

    const result = await tool.execute(CONTEXT, {
      taskId: TASK_ID,
      startAt: '2026-09-18T15:00:00.000Z',
      date: '2026-09-18',
    });

    expect(result.success).toBe(false);
    expect(scheduleTask).not.toHaveBeenCalled();
    expect(scheduleTaskAt).not.toHaveBeenCalled();
  });

  it('rejects endAt without startAt at validation time', async () => {
    const scheduleTask = jest.fn();
    const scheduleTaskAt = jest.fn();
    const tool = makeTool(scheduleTask, scheduleTaskAt);

    const result = await tool.execute(CONTEXT, { taskId: TASK_ID, endAt: '2026-09-18T15:30:00.000Z' });

    expect(result.success).toBe(false);
    expect(scheduleTask).not.toHaveBeenCalled();
  });

  it('rejects an endAt at or before startAt at validation time', async () => {
    const scheduleTask = jest.fn();
    const scheduleTaskAt = jest.fn();
    const tool = makeTool(scheduleTask, scheduleTaskAt);

    const result = await tool.execute(CONTEXT, {
      taskId: TASK_ID,
      startAt: '2026-09-18T15:00:00.000Z',
      endAt: '2026-09-18T15:00:00.000Z',
    });

    expect(result.success).toBe(false);
    expect(scheduleTaskAt).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid taskId at validation time', async () => {
    const scheduleTask = jest.fn();
    const scheduleTaskAt = jest.fn();
    const tool = makeTool(scheduleTask, scheduleTaskAt);

    const result = await tool.execute(CONTEXT, { taskId: 'not-a-uuid' });

    expect(result.success).toBe(false);
    expect(scheduleTask).not.toHaveBeenCalled();
  });

  it('fails cleanly via BaseTool error handling when the execution context has no userId', async () => {
    const scheduleTask = jest.fn();
    const scheduleTaskAt = jest.fn();
    const tool = makeTool(scheduleTask, scheduleTaskAt);

    const result = await tool.execute({} as RequestContext, { taskId: TASK_ID });

    expect(result.success).toBe(false);
    expect(scheduleTask).not.toHaveBeenCalled();
  });
});

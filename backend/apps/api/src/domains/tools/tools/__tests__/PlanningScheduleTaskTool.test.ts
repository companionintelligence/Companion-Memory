import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { zonedWallTimeToUTC } from '@ci/common/time/zoned';
import type {
  PlaceOutcome,
  PlannedBlockService,
  PlanningTimeService,
} from '@ci/domains/planning/task.module';

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

/** The owner lives in Los Angeles; the real wall-clock conversion, so daylight saving is real too. */
const planningTime = {
  toInstant: jest.fn(async (_context: unknown, date: string, time: string) =>
    zonedWallTimeToUTC(date, time, 'America/Los_Angeles'),
  ),
} as unknown as PlanningTimeService;

function makeTool(scheduleTask: jest.Mock, scheduleTaskAt: jest.Mock) {
  return new PlanningScheduleTaskTool(
    { scheduleTask, scheduleTaskAt } as unknown as PlannedBlockService,
    planningTime,
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
    expect(scheduleTask).toHaveBeenCalledWith({ userId: CONTEXT.userId }, TASK_ID, {
      estimatedMinutes: 30,
      date: '2026-09-18',
    });
    expect(scheduleTaskAt).not.toHaveBeenCalled();
  });

  it('auto-places with no date/estimate when neither is given', async () => {
    const scheduleTask = jest.fn().mockResolvedValue({ status: 'placed' } as unknown as PlaceOutcome);
    const scheduleTaskAt = jest.fn();
    const tool = makeTool(scheduleTask, scheduleTaskAt);

    await tool.execute(CONTEXT, { taskId: TASK_ID });

    expect(scheduleTask).toHaveBeenCalledWith({ userId: CONTEXT.userId }, TASK_ID, {
      estimatedMinutes: undefined,
      date: undefined,
    });
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

  it("reads a zoneless startAt as the owner's wall clock, daylight saving included", async () => {
    const scheduleTaskAt = jest.fn().mockResolvedValue({ status: 'placed' } as unknown as PlaceOutcome);
    const tool = makeTool(jest.fn(), scheduleTaskAt);

    // 6 PM on 16 November is PST (-8); OpenClaw sent 01:00Z, PDT's -7, and the block landed at 5 PM.
    await tool.execute(CONTEXT, { taskId: TASK_ID, startAt: '2026-11-16T18:00', endAt: '2026-11-16T18:30' });

    expect(scheduleTaskAt).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      TASK_ID,
      new Date('2026-11-17T02:00:00.000Z'),
      new Date('2026-11-17T02:30:00.000Z'),
      undefined,
    );

    // The same wall clock in September is PDT (-7).
    await tool.execute(CONTEXT, { taskId: TASK_ID, startAt: '2026-09-18T18:00:00' });

    expect(scheduleTaskAt).toHaveBeenLastCalledWith(
      { userId: CONTEXT.userId },
      TASK_ID,
      new Date('2026-09-19T01:00:00.000Z'),
      undefined,
      undefined,
    );
  });

  it('reads a zoneless startAt in the timeZone the caller names, instead of the saved one', async () => {
    const scheduleTaskAt = jest.fn().mockResolvedValue({ status: 'placed' } as unknown as PlaceOutcome);
    const tool = makeTool(jest.fn(), scheduleTaskAt);

    // A Los Angeles owner travelling in New York: 6 PM there is 23:00Z (EST, -5), 3 PM at home.
    await tool.execute(CONTEXT, {
      taskId: TASK_ID,
      startAt: '2026-11-16T18:00',
      endAt: '2026-11-16T18:30',
      timeZone: 'America/New_York',
    });

    expect(scheduleTaskAt).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      TASK_ID,
      new Date('2026-11-16T23:00:00.000Z'),
      new Date('2026-11-16T23:30:00.000Z'),
      undefined,
    );
  });

  it('leaves an instant with an offset alone even when timeZone is given', async () => {
    const scheduleTaskAt = jest.fn().mockResolvedValue({ status: 'placed' } as unknown as PlaceOutcome);
    const tool = makeTool(jest.fn(), scheduleTaskAt);

    await tool.execute(CONTEXT, {
      taskId: TASK_ID,
      startAt: '2026-11-17T02:00:00Z',
      timeZone: 'America/New_York',
    });

    expect(scheduleTaskAt).toHaveBeenCalledWith(
      { userId: CONTEXT.userId },
      TASK_ID,
      new Date('2026-11-17T02:00:00.000Z'),
      undefined,
      undefined,
    );
  });

  it('rejects a timeZone that is not an IANA zone, and one without startAt', async () => {
    const scheduleTask = jest.fn();
    const scheduleTaskAt = jest.fn();
    const tool = makeTool(scheduleTask, scheduleTaskAt);

    const badZone = await tool.execute(CONTEXT, {
      taskId: TASK_ID,
      startAt: '2026-11-16T18:00',
      timeZone: 'Eastern',
    });
    const noStart = await tool.execute(CONTEXT, {
      taskId: TASK_ID,
      date: '2026-11-16',
      timeZone: 'America/New_York',
    });

    expect(badZone.success).toBe(false);
    expect(noStart.success).toBe(false);
    expect(scheduleTask).not.toHaveBeenCalled();
    expect(scheduleTaskAt).not.toHaveBeenCalled();
  });

  it('rejects an endAt at or before startAt', async () => {
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

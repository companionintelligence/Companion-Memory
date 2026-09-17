import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { Event } from '@ci/domains/memory';
import type { PlannedBlockService } from '@ci/domains/planning/task.module';

import { PlanningPlannedBlocksTool } from '../PlanningPlannedBlocksTool';

const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;
const FROM = '2026-09-16T00:00:00.000Z';
const TO = '2026-09-23T00:00:00.000Z';

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;
}

function makeTool(list: jest.Mock) {
  return new PlanningPlannedBlocksTool({ list } as unknown as PlannedBlockService, logger());
}

describe('PlanningPlannedBlocksTool', () => {
  it('lists planned blocks through PlannedBlockService.list with a resolved UserServiceContext', async () => {
    const blocks = [{ id: 'e1' } as Event];
    const list = jest.fn().mockResolvedValue(blocks);
    const tool = makeTool(list);

    const result = await tool.execute(CONTEXT, { from: FROM, to: TO });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(blocks);
    expect(list).toHaveBeenCalledWith({ userId: CONTEXT.userId }, new Date(FROM), new Date(TO));
  });

  it('rejects a range where to is not after from at validation time', async () => {
    const list = jest.fn();
    const tool = makeTool(list);

    const result = await tool.execute(CONTEXT, { from: TO, to: FROM });

    expect(result.success).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects an equal from/to range at validation time', async () => {
    const list = jest.fn();
    const tool = makeTool(list);

    const result = await tool.execute(CONTEXT, { from: FROM, to: FROM });

    expect(result.success).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects a malformed from at validation time', async () => {
    const list = jest.fn();
    const tool = makeTool(list);

    const result = await tool.execute(CONTEXT, { from: 'not-a-date', to: TO });

    expect(result.success).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects a missing to at validation time', async () => {
    const list = jest.fn();
    const tool = makeTool(list);

    const result = await tool.execute(CONTEXT, { from: FROM });

    expect(result.success).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it('fails cleanly via BaseTool error handling when the execution context has no userId', async () => {
    const list = jest.fn();
    const tool = makeTool(list);

    const result = await tool.execute({} as RequestContext, { from: FROM, to: TO });

    expect(result.success).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });
});

import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { Event } from '@ci/domains/memory';
import type { PlannedBlockService } from '@ci/domains/planning/task.module';

import { PlanningPlannedBlocksTool } from '../PlanningPlannedBlocksTool';

import { losAngelesPlanningTime } from './losAngelesPlanningTime';

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
  return new PlanningPlannedBlocksTool(
    { list } as unknown as PlannedBlockService,
    losAngelesPlanningTime(),
    logger(),
  );
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

  it("reads a bare-date range as whole local days, in the owner's zone or the one given", async () => {
    const list = jest.fn().mockResolvedValue([]);
    const tool = makeTool(list);

    await tool.execute(CONTEXT, { from: '2026-11-16', to: '2026-11-17' });
    await tool.execute(CONTEXT, {
      from: '2026-11-16T18:00',
      to: '2026-11-16T21:00',
      timeZone: 'America/New_York',
    });

    expect(list.mock.calls.map(([, from, to]) => [from, to])).toEqual([
      [new Date('2026-11-16T08:00:00.000Z'), new Date('2026-11-17T08:00:00.000Z')],
      [new Date('2026-11-16T23:00:00.000Z'), new Date('2026-11-17T02:00:00.000Z')],
    ]);
  });

  it('rejects a range where to is not after from', async () => {
    const list = jest.fn();
    const tool = makeTool(list);

    const result = await tool.execute(CONTEXT, { from: TO, to: FROM });

    expect(result.success).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects an equal from/to range', async () => {
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

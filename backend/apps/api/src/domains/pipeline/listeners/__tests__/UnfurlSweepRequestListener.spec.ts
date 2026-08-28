import { STAGE_IDS } from '../../constants';
import { stageSchedule } from '../../schedule';
import { UnfurlSweepRequestListener } from '../UnfurlSweepRequestListener';

function makeListener() {
  const dispatchService = { startSweep: jest.fn(async () => undefined) };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const listener = new UnfurlSweepRequestListener(dispatchService as any, logger as any);

  return { listener, dispatchService, logger };
}

const USER = '00000000-0000-0000-0000-0000000000aa';

describe('UnfurlSweepRequestListener', () => {
  it('starts one user-scoped enrich.unfurl sweep', async () => {
    const { listener, dispatchService } = makeListener();

    await listener.handleRequest({ userId: USER, requestedBy: 'import-run:r1' });

    expect(dispatchService.startSweep).toHaveBeenCalledTimes(1);
    expect(dispatchService.startSweep).toHaveBeenCalledWith({
      stage: STAGE_IDS.ENRICH_UNFURL,
      userId: USER,
      maxIds: stageSchedule(STAGE_IDS.ENRICH_UNFURL).perRunCap,
    });
    expect(stageSchedule(STAGE_IDS.ENRICH_UNFURL).perRunCap).toBeGreaterThan(0);
  });

  it('ignores a request with no user rather than sweeping everyone', async () => {
    const { listener, dispatchService, logger } = makeListener();

    await listener.handleRequest({ requestedBy: 'import-run:r2' });

    expect(dispatchService.startSweep).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});

import {
  DEFAULT_ESTIMATE_SOURCE_SYSTEMS,
  DEFAULT_MAX_GAP_HOURS,
} from '../../services/LocationEstimateService';
import {
  DEFAULT_ESTIMATE_BATCH_LIMIT,
  EstimateLocationBatchListener,
} from '../EstimateLocationBatchListener';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeListener() {
  const estimateService = { estimateBatch: jest.fn(async () => ({ candidates: 3, estimated: 2 })) };
  const listener = new EstimateLocationBatchListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    estimateService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeLogger() as any,
  );

  return { listener, estimateService };
}

const USER = '00000000-0000-0000-0000-0000000000aa';

describe('EstimateLocationBatchListener', () => {
  it('applies the Balanced defaults when the payload omits them', async () => {
    const { listener, estimateService } = makeListener();

    await listener.handleBatch({ userId: USER });

    expect(estimateService.estimateBatch).toHaveBeenCalledWith(USER, {
      limit: DEFAULT_ESTIMATE_BATCH_LIMIT,
      maxGapHours: DEFAULT_MAX_GAP_HOURS,
      sourceSystems: [...DEFAULT_ESTIMATE_SOURCE_SYSTEMS],
      forced: false,
    });
  });

  it('passes explicit overrides straight through', async () => {
    const { listener, estimateService } = makeListener();

    await listener.handleBatch({ userId: USER, limit: 10, maxGapHours: 6, sourceSystems: ['uber'] });

    expect(estimateService.estimateBatch).toHaveBeenCalledWith(USER, {
      limit: 10,
      maxGapHours: 6,
      sourceSystems: ['uber'],
      forced: false,
    });
  });

  it('forwards forced=true so the service runs a re-sweep including prior estimates', async () => {
    const { listener, estimateService } = makeListener();

    await listener.handleBatch({ userId: USER, forced: true });

    expect(estimateService.estimateBatch).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ forced: true }),
    );
  });

  it('excludes messages/social posts by default (physical-presence allowlist only)', () => {
    // Guard the "Balanced" contract: a 3am email must never be estimable.
    for (const s of ['email', 'sms', 'twitter', 'linkedin', 'facebook', 'instagram', 'reddit']) {
      expect(DEFAULT_ESTIMATE_SOURCE_SYSTEMS).not.toContain(s);
    }

    expect(DEFAULT_ESTIMATE_SOURCE_SYSTEMS).toContain('calendar');
  });
});

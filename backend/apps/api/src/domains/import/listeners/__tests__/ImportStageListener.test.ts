import { ImportStageListener } from '../ImportStageListener';

/**
 * The worker owns everything a stage runner is not allowed to care about, so
 * what is tested here is the bookkeeping around the work rather than the work:
 *
 *  - a redelivered job does NOT run a stage someone else owns, and does not run
 *    one that already failed. Both would mean doing a 40GB unpack twice;
 *  - a cancelled or deleted run stops the chain rather than reviving it;
 *  - a failure is recorded against the stage BEFORE it is rethrown, so the run
 *    says what happened instead of stranding at `running`;
 *  - scratch is reclaimed exactly once, when the last stage completes.
 */

const payload = {
  runId: '11111111-1111-4111-8111-111111111111',
  stageId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
};

function makeListener(
  overrides: {
    stage?: Record<string, unknown> | null;
    finished?: boolean;
    claimed?: boolean;
    next?: Record<string, unknown> | null;
    run?: jest.Mock;
    pulled?: boolean;
  } = {},
) {
  const runs = {
    pulledRecords: jest.fn(async () => overrides.pulled ?? true),
    getStage: jest.fn(async () =>
      overrides.stage === undefined
        ? { id: payload.stageId, runId: payload.runId, kind: 'unpack', seq: 0, status: 'queued' }
        : overrides.stage,
    ),
    isFinished: jest.fn(async () => overrides.finished ?? false),
    beginStage: jest.fn(async () => overrides.claimed ?? true),
    completeStage: jest.fn(async () => undefined),
    failStage: jest.fn(async () => undefined),
    advance: jest.fn(async () => overrides.next ?? null),
    recordProgress: jest.fn(async () => undefined),
  };

  const scratch = {
    ensureDir: jest.fn(async () => '/var/tmp/ci-import/user/run'),
    reclaim: jest.fn(async () => true),
  };

  const unpackStage = {
    kind: 'unpack' as const,
    run: overrides.run ?? jest.fn(async () => ({ processed: 1, total: 1, detail: {} })),
  };

  const parseStage = {
    kind: 'parse' as const,
    run: jest.fn(async () => ({ processed: 0, total: 0, detail: {} })),
  };

  const mediaStage = {
    kind: 'media' as const,
    run: jest.fn(async () => ({ processed: 0, total: 0, detail: {} })),
  };

  const pushStage = {
    kind: 'push' as const,
    run: jest.fn(async () => ({ processed: 0, total: 0, detail: {} })),
  };

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  return {
    listener: new ImportStageListener(
      runs as never,
      scratch as never,
      unpackStage as never,
      parseStage as never,
      mediaStage as never,
      pushStage as never,
      logger as never,
    ),
    runs,
    scratch,
    unpackStage,
  };
}

describe('ImportStageListener claiming', () => {
  beforeEach(() => jest.clearAllMocks());

  it('runs the stage when it wins the claim', async () => {
    const { listener, runs, unpackStage } = makeListener();

    await listener.runStage(payload);

    expect(runs.beginStage).toHaveBeenCalledWith(payload.stageId);
    expect(unpackStage.run).toHaveBeenCalledTimes(1);
    expect(runs.completeStage).toHaveBeenCalledTimes(1);
  });

  it('does no work when another worker already owns the stage', async () => {
    const { listener, runs, unpackStage, scratch } = makeListener({ claimed: false });

    await listener.runStage(payload);

    expect(unpackStage.run).not.toHaveBeenCalled();
    expect(runs.completeStage).not.toHaveBeenCalled();
    expect(scratch.reclaim).not.toHaveBeenCalled();
  });

  it('drops the job when the run was deleted out from under it', async () => {
    const { listener, runs, unpackStage } = makeListener({ stage: null });

    await listener.runStage(payload);

    expect(runs.beginStage).not.toHaveBeenCalled();
    expect(unpackStage.run).not.toHaveBeenCalled();
  });

  it('refuses to start a stage whose run is already finished or cancelled', async () => {
    const { listener, runs, unpackStage } = makeListener({ finished: true });

    await listener.runStage(payload);

    expect(runs.beginStage).not.toHaveBeenCalled();
    expect(unpackStage.run).not.toHaveBeenCalled();
  });

  it('fails a stage whose kind this build cannot run, rather than stranding it', async () => {
    // A kind from a future release, or a replayed job from one: the worker must
    // say so against the stage instead of leaving the run stuck at `queued`.
    const { listener, runs } = makeListener({
      stage: { id: payload.stageId, runId: payload.runId, kind: 'enrich', seq: 3, status: 'queued' },
    });

    await listener.runStage(payload);

    expect(runs.failStage).toHaveBeenCalledWith(payload.stageId, expect.stringContaining('enrich'));
    expect(runs.beginStage).not.toHaveBeenCalled();
  });

  it('rejects a payload that is not a stage job', async () => {
    const { listener } = makeListener();

    await expect(listener.runStage({ runId: 'not-a-uuid' })).rejects.toThrow();
  });
});

describe('ImportStageListener advancing', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reclaims the scratch tree only once the last stage is done', async () => {
    const { listener, scratch } = makeListener({ next: null });

    await listener.runStage(payload);

    expect(scratch.reclaim).toHaveBeenCalledWith(payload.userId, payload.runId);
  });

  it('keeps the scratch tree while a later stage still needs it', async () => {
    const { listener, scratch } = makeListener({ next: { id: 'next', kind: 'parse', seq: 1 } });

    await listener.runStage(payload);

    // The parse stage reads what unpack extracted; reclaiming here would delete
    // the tree between the two jobs.
    expect(scratch.reclaim).not.toHaveBeenCalled();
  });

  it('keeps the scratch tree when the run pulled no records out of it', async () => {
    // The data-loss path: a tree this appliance has no parser for still closes
    // as `partial` (ParseStage calls that an honest report, not a failure), and
    // unpack acquired it by rename — so for an inbox unit this IS the user's
    // only copy. Reclaiming here destroyed it with no way back, because
    // retryStage only accepts failed/cancelled runs.
    const { listener, scratch } = makeListener({ next: null, pulled: false });

    await listener.runStage(payload);

    expect(scratch.reclaim).not.toHaveBeenCalled();
  });
});

describe('ImportStageListener failure', () => {
  beforeEach(() => jest.clearAllMocks());

  it('records the reason against the stage and then rethrows for pg-boss', async () => {
    const { listener, runs } = makeListener({
      run: jest.fn(async () => {
        throw new Error('unzip: cannot find central directory');
      }),
    });

    await expect(listener.runStage(payload)).rejects.toThrow('central directory');

    expect(runs.failStage).toHaveBeenCalledWith(payload.stageId, 'unzip: cannot find central directory');
    expect(runs.completeStage).not.toHaveBeenCalled();
  });

  it('leaves the scratch tree in place after a failure, for the retry to inspect', async () => {
    const { listener, scratch } = makeListener({
      run: jest.fn(async () => {
        throw new Error('boom');
      }),
    });

    await expect(listener.runStage(payload)).rejects.toThrow('boom');

    expect(scratch.reclaim).not.toHaveBeenCalled();
  });
});

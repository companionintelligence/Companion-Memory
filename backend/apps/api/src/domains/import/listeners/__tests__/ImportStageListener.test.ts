import type { TransientRetryPolicy } from '@ci/common/persistence';

import { DatabaseCrashedDuringPushError } from '../../stages/DatabaseCrashedDuringPushError';
import { ImportStageListener } from '../ImportStageListener';

/**
 * The worker owns everything a stage runner is not allowed to care about, so
 * what is tested here is the bookkeeping around the work rather than the work:
 *
 *  - a redelivered job does NOT run a stage someone else owns, and does not run
 *    one that already failed. Both would mean doing a 40GB unpack twice;
 *  - a cancelled or deleted run stops the chain rather than reviving it;
 *  - a failure is recorded against the stage BEFORE it is rethrown, so the run
 *    says what happened instead of stranding at `running` — waiting out a
 *    database that is away to record it, because a stage left `running` is
 *    one the recovery sweep runs again;
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
    pushRun?: jest.Mock;
    pulled?: boolean;
    unstoredMedia?: boolean;
    runBelongsTo?: boolean;
  } = {},
) {
  const runs = {
    runBelongsTo: jest.fn(async () => overrides.runBelongsTo ?? true),
    pulledRecords: jest.fn(async () => overrides.pulled ?? true),
    hasUnstoredMedia: jest.fn(async () => overrides.unstoredMedia ?? false),
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
    resumeInterrupted: jest.fn(async () => undefined),
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
    run: overrides.pushRun ?? jest.fn(async () => ({ processed: 0, total: 0, detail: {} })),
  };

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  const listener = new ImportStageListener(
    runs as never,
    scratch as never,
    unpackStage as never,
    parseStage as never,
    mediaStage as never,
    pushStage as never,
    logger as never,
  );
  const clock = fakeClock();

  listener.failureRecordRetry = clock;

  return { listener, runs, scratch, unpackStage, pushStage, logger, clock };
}

/** A clock that never really sleeps, with the listener's own budget and crash rule. */
function fakeClock(): TransientRetryPolicy & { slept: number[] } {
  let at = 0;
  const slept: number[] = [];

  return {
    initialDelayMs: 1_000,
    maxDelayMs: 30_000,
    budgetMs: 600_000,
    resendAfterCrash: true,
    slept,
    now: () => at,
    sleep: async (ms) => {
      slept.push(ms);
      at += ms;
    },
  };
}

/** TypeORM's QueryFailedError, as the listener actually receives it. */
function queryFailed(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: 'QueryFailedError',
    code,
    driverError: Object.assign(new Error(message), { code }),
  });
}

const inRecovery = () => queryFailed('57P03', 'the database system is in recovery mode');

describe('ImportStageListener claiming', () => {
  beforeEach(() => jest.clearAllMocks());

  it('runs the stage when it wins the claim', async () => {
    const { listener, runs, unpackStage } = makeListener();

    await listener.runStage(payload);

    expect(runs.beginStage).toHaveBeenCalledWith(payload.stageId);
    expect(unpackStage.run).toHaveBeenCalledTimes(1);
    expect(runs.completeStage).toHaveBeenCalledTimes(1);
  });

  /**
   * The stage row is the authority on whose import this is; the payload is a
   * convenience copy written when the job was enqueued. Every row the pipeline
   * writes carries `payload.userId`, so running a job whose payload names a
   * different user than its run files one account's export under another's.
   * There is no reading of a mismatch under which the work should proceed.
   */
  it('refuses a job whose payload names a different user than its run', async () => {
    const { listener, runs, unpackStage } = makeListener({ runBelongsTo: false });

    await listener.runStage(payload);

    expect(unpackStage.run).not.toHaveBeenCalled();
    expect(runs.beginStage).not.toHaveBeenCalled();
    expect(runs.failStage).toHaveBeenCalledWith(payload.stageId, expect.stringMatching(/different user/));
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

  it('keeps the scratch tree while any media bytes are still unstored', async () => {
    // The wizard requested [unpack, parse] and the deferred push appended a
    // bare `push`, so `media` never ran and every photo was reclaimed with the
    // tree — leaving content rows pointing at files that were never stored,
    // with no recovery path. Checked against the ROWS rather than the run's
    // stage list, because a run whose stages omit `media` is exactly the case
    // that lost the bytes.
    const { listener, scratch } = makeListener({ next: null, pulled: true, unstoredMedia: true });

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

    // Two records now, not one: the greppable line a person reads (prefixed
    // with the stage kind, and with whatever the runner knew it was working
    // on) and the same facts as fields, for anything that would otherwise have
    // to regex the prose. The exception's own message is unchanged inside
    // both — see telemetry/stageError.
    expect(runs.failStage).toHaveBeenCalledWith(
      payload.stageId,
      'unpack unzip: cannot find central directory',
      expect.objectContaining({
        stage: 'unpack',
        name: 'Error',
        message: 'unzip: cannot find central directory',
      }),
    );
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

  /**
   * `LoggerService.resolveArgs` reads arg1 as the pino `msg`. Passing the Error
   * there puts its raw text in `msg` and pushes the human sentence down into
   * `data.message`, so these lines grep differently from every sibling's — the
   * same defect `StagedUploadPurgeCron` and `ImportRetentionCron` were moved
   * off. The Error still has to reach the call under `err`, which the logger
   * hoists so pino serializes the stack rather than writing `{}`.
   */
  it('logs the failure with the sentence as the message and the error beside the context', async () => {
    const failure = new Error('unzip: cannot find central directory');
    const { listener, logger } = makeListener({
      run: jest.fn(async () => {
        throw failure;
      }),
    });

    await expect(listener.runStage(payload)).rejects.toThrow(failure);

    expect(logger.error).toHaveBeenCalledWith(
      'Import stage failed',
      expect.objectContaining({ err: failure, runId: payload.runId, kind: 'unpack' }),
    );
  });
});

/**
 * The failure most likely to meet an absent database is the one the database
 * caused: a push stage fails with DatabaseCrashedDuringPushError the moment
 * Postgres crashes under it, and the listener's next statement — recording
 * that — reaches a server in crash recovery. Unrecorded, the stage stays
 * `running`; ten silent minutes later the recovery sweep re-queues it, the push
 * runs again, and the poison write crashes the database again. Every sweep.
 */
describe('ImportStageListener recording a failure while the database is away', () => {
  beforeEach(() => jest.clearAllMocks());

  const pushStageRow = { id: payload.stageId, runId: payload.runId, kind: 'push', seq: 2, status: 'queued' };
  const crashedPush = () =>
    new DatabaseCrashedDuringPushError(
      payload.runId,
      'writing 500 communications record(s)',
      new Error('Connection terminated unexpectedly'),
    );

  it('waits for the database to come back, then records the crash against the stage', async () => {
    const failure = crashedPush();
    const { listener, runs, pushStage, clock } = makeListener({
      stage: pushStageRow,
      pushRun: jest.fn(async () => {
        throw failure;
      }),
    });

    runs.failStage.mockRejectedValueOnce(inRecovery()).mockRejectedValueOnce(inRecovery());

    // The STAGE's error goes to pg-boss, not what the bookkeeping met.
    await expect(listener.runStage(payload)).rejects.toBe(failure);

    expect(pushStage.run).toHaveBeenCalledTimes(1);
    expect(runs.failStage).toHaveBeenCalledTimes(3);
    expect(runs.failStage).toHaveBeenLastCalledWith(
      payload.stageId,
      expect.stringContaining(`ci push --run ${payload.runId} --retry-failed`),
      expect.objectContaining({ stage: 'push', name: 'DatabaseCrashedDuringPushError' }),
    );
    expect(clock.slept).toEqual([1_000, 2_000]);
  });

  it('waits through a crash under the record itself — bookkeeping cannot be what crashed it', async () => {
    const { listener, runs, clock } = makeListener({
      stage: pushStageRow,
      pushRun: jest.fn(async () => {
        throw crashedPush();
      }),
    });

    runs.failStage
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockRejectedValueOnce(inRecovery());

    await expect(listener.runStage(payload)).rejects.toBeInstanceOf(DatabaseCrashedDuringPushError);

    expect(runs.failStage).toHaveBeenCalledTimes(3);
    expect(clock.slept).toEqual([1_000, 2_000]);
  });

  it('reads the failed stage for its phase through the same wait', async () => {
    const { listener, runs } = makeListener({
      stage: pushStageRow,
      pushRun: jest.fn(async () => {
        throw crashedPush();
      }),
    });

    // The first read finds the stage; the one after the failure meets recovery.
    runs.getStage
      .mockResolvedValueOnce(pushStageRow as never)
      .mockRejectedValueOnce(inRecovery())
      .mockResolvedValueOnce({ ...pushStageRow, status: 'running', phase: 'pushing' } as never);

    await expect(listener.runStage(payload)).rejects.toBeInstanceOf(DatabaseCrashedDuringPushError);

    expect(runs.failStage).toHaveBeenCalledTimes(1);
    expect(runs.failStage).toHaveBeenCalledWith(
      payload.stageId,
      expect.stringMatching(/^push \[phase=pushing\] the database crashed/),
      expect.objectContaining({ phase: 'pushing' }),
    );
  });

  it('gives up inside its budget, says so, and still rethrows the stage error', async () => {
    const failure = crashedPush();
    const { listener, runs, logger, clock } = makeListener({
      stage: pushStageRow,
      pushRun: jest.fn(async () => {
        throw failure;
      }),
    });

    runs.failStage.mockRejectedValue(inRecovery());

    await expect(listener.runStage(payload)).rejects.toBe(failure);

    expect(clock.slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(600_000);
    expect(clock.slept.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThan(500_000);
    expect(logger.error).toHaveBeenCalledWith(
      'Could not record the import stage failure; the stage stays running until the recovery sweep reclaims it',
      expect.objectContaining({ runId: payload.runId, stageId: payload.stageId, kind: 'push' }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Import stage failed',
      expect.objectContaining({ err: failure, failure: null }),
    );
  });

  it('does not run the push again when pg-boss redelivers the job for the failed stage', async () => {
    const { listener, runs, pushStage } = makeListener({
      stage: pushStageRow,
      pushRun: jest.fn(async () => {
        throw crashedPush();
      }),
    });

    await expect(listener.runStage(payload)).rejects.toBeInstanceOf(DatabaseCrashedDuringPushError);

    // What the service answers once the failure is recorded: the run is
    // finished (failed), and the stage is no longer `queued` to be claimed.
    runs.isFinished.mockResolvedValue(true);
    runs.beginStage.mockResolvedValue(false);

    await expect(listener.runStage(payload)).resolves.toBeUndefined();
    expect(pushStage.run).toHaveBeenCalledTimes(1);
  });
});

describe('ImportStageListener recovery', () => {
  beforeEach(() => jest.clearAllMocks());

  it('swallows a failing resume and logs it in the same shape as everything else', async () => {
    const failure = new Error('database is down');
    const { listener, runs, logger } = makeListener();

    runs.resumeInterrupted.mockRejectedValueOnce(failure);

    await expect(listener.sweepOnSchedule()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('Could not resume interrupted import runs', failure);
  });
});

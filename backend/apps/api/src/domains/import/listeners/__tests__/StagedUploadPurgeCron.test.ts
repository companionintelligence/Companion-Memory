import { StagedUploadPurgeCron, STAGED_UPLOAD_PURGE_CRON } from '../StagedUploadPurgeCron';

/**
 * The schedule that keeps the uploads directory honest. Without it, nothing
 * reclaims an abandoned upload OR the crash-window orphans, and multi-GB
 * archives pile up forever.
 */

function build() {
  const sources = {
    purgeExpired: jest.fn(async () => 2),
    sweepUploadOrphans: jest.fn(async () => 1),
  };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
  const cron = new StagedUploadPurgeCron(sources as never, logger as never);

  return { cron, sources, logger };
}

describe('StagedUploadPurgeCron', () => {
  it('runs hourly', () => {
    expect(STAGED_UPLOAD_PURGE_CRON).toBe('0 17 * * * *');
  });

  it('runs both sweeps and reports how many it reclaimed', async () => {
    const { cron, sources } = build();

    expect(await cron.purgeOnce()).toBe(3);
    expect(sources.purgeExpired).toHaveBeenCalled();
    expect(sources.sweepUploadOrphans).toHaveBeenCalled();
  });

  it('swallows a failing sweep — a crashed cron exits the process, a missed sweep costs an hour', async () => {
    const { cron, sources, logger } = build();

    sources.purgeExpired.mockRejectedValueOnce(new Error('database is down'));

    await expect(cron.runOnSchedule()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  // The sentence has to be the first argument: LoggerService.resolveArgs takes
  // a leading Error as the message and puts the second argument under `data`,
  // so the reversed call logged the raw error text as `msg` and buried the
  // sentence in `data.message` — this cron's failures then grepped differently
  // from every sibling cron's.
  it('logs the failure with the human sentence as the message and the error beside it', async () => {
    const { cron, sources, logger } = build();
    const failure = new Error('database is down');

    sources.purgeExpired.mockRejectedValueOnce(failure);

    await cron.runOnSchedule();

    expect(logger.error).toHaveBeenCalledWith(
      'Staged upload purge failed; will retry on the next sweep',
      failure,
    );
  });
});

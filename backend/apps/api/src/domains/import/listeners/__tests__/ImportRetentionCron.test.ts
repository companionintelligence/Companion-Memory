import { ImportRetentionCron, IMPORT_RETENTION_CRON } from '../ImportRetentionCron';

/**
 * The schedule that bounds `ci_import`. Without it nothing ever deletes an
 * import run, and every parsed record's staging row outlives the `ci.*` row it
 * produced — measured at 1678 MB of staging against 1274 MB of durable data on
 * a dev appliance that imported one Takeout three times.
 *
 * What it deletes is asserted against real Postgres in
 * `__tests__/importRetention.integration.spec.ts`; this covers the wrapper.
 */

const EMPTY = { payloadPurgedRuns: 0, stagedRowsDeleted: 0, runsDeleted: 0, skipped: {} };

function build() {
  const retention = { sweep: jest.fn(async () => EMPTY) };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
  const cron = new ImportRetentionCron(retention as never, logger as never);

  return { cron, retention, logger };
}

describe('ImportRetentionCron', () => {
  it('runs nightly, off the crowded second-0 slot and after the enrichment window', () => {
    expect(IMPORT_RETENTION_CRON).toBe('50 40 6 * * *');

    const [second, minute, hour] = IMPORT_RETENTION_CRON.split(' ');

    expect(second).not.toBe('0');
    expect(`${hour}:${minute}`).toBe('6:40');
  });

  it('sweeps and reports what it reclaimed', async () => {
    const { cron, retention } = build();

    retention.sweep.mockResolvedValueOnce({
      payloadPurgedRuns: 2,
      stagedRowsDeleted: 4200,
      runsDeleted: 1,
      skipped: { unstored_media: 1 },
    });

    await expect(cron.sweepOnce()).resolves.toEqual({
      payloadPurgedRuns: 2,
      stagedRowsDeleted: 4200,
      runsDeleted: 1,
      skipped: { unstored_media: 1 },
    });
    expect(retention.sweep).toHaveBeenCalled();
  });

  it('swallows a failing sweep — a crashed cron exits the process, a missed sweep costs a day', async () => {
    const { cron, retention, logger } = build();

    retention.sweep.mockRejectedValueOnce(new Error('database is down'));

    await expect(cron.runOnSchedule()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  /**
   * `LoggerService.resolveArgs` reads arg1 as the pino `msg` and serializes an
   * Error in arg2 under `err`. Handing it (err, { message }) instead puts the
   * raw error text in `msg` and the sentence in `data.message`, which is how
   * one cron's failures stop matching the grep that finds every other's.
   */
  it('logs the sentence as the message and the error as the error', async () => {
    const { cron, retention, logger } = build();

    retention.sweep.mockRejectedValueOnce(new Error('database is down'));

    await cron.runOnSchedule();

    const [message, detail] = logger.error.mock.calls[0] as [unknown, unknown];

    expect(message).toBe('Import retention sweep failed; will retry on the next sweep');
    expect(detail).toBeInstanceOf(Error);
    expect((detail as Error).message).toBe('database is down');
  });
});

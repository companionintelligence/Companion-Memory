import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { ImportRetentionService, type RetentionSweepResult } from '../services/ImportRetentionService';

/**
 * Nightly at 06:40:50.
 *
 * Daily, not hourly: the windows are measured in days, so a sweep that misses
 * a night costs one more night of disk and nothing else — while the work it
 * does is bulk `DELETE`s over the appliance's only database.
 *
 * 06:40 sits just after the enrichment window closes (`enrichment.window`
 * defaults to 01:00 + 300 minutes) and before anyone is likely to be using the
 * appliance, so the vacuum churn this generates does not land on top of the
 * night's embedding backlog.
 *
 * Second 50, not second 0: twelve schedules already fire on second 0 of their
 * minute, and a bulk delete does not need to join them.
 */
export const IMPORT_RETENTION_CRON = '50 40 6 * * *';

/**
 * Schedule {@link ImportRetentionService}.
 *
 * Structurally identical to {@link StagedUploadPurgeCron} next door, and for
 * the same reasons: the same swallow-and-retry contract, and the same role.
 * `worker` because this deletes staged rows and stats scratch directories,
 * which is the worker's duty in a split deployment — the process that owns the
 * importer's filesystem is the one that should own reclaiming it.
 */
@Injectable()
export class ImportRetentionCron {
  constructor(
    private readonly retention: ImportRetentionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ImportRetentionCron.name);
  }

  /**
   * Swallows everything.
   *
   * The next sweep is a day away and will retry from the same predicate — this
   * job holds no cursor and no partial state, so a lost tick costs one day of
   * disk. An unhandled rejection out of a cron is a strictly worse outcome.
   *
   * Sentence first, error second: `LoggerService.resolveArgs` takes arg1 as the
   * pino `msg` and serializes an Error in arg2 under `err`. Passing them the
   * other way round puts the raw error text in `msg` and buries the sentence in
   * `data.message`, so this cron's failures would not grep with any other's.
   */
  // `exclusive`: the sweep has no guard of its own, and a second one deleting
  // the same expired rows buys nothing.
  @Cron(IMPORT_RETENTION_CRON, { name: 'ImportRetentionCron.runOnSchedule', role: 'worker', exclusive: true })
  async runOnSchedule(): Promise<void> {
    try {
      await this.sweepOnce();
    } catch (err: unknown) {
      this.logger.error(
        'Import retention sweep failed; will retry on the next sweep',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /** Public so a test can sweep without waiting a day. */
  async sweepOnce(now?: Date): Promise<RetentionSweepResult> {
    return this.retention.sweep(now);
  }
}

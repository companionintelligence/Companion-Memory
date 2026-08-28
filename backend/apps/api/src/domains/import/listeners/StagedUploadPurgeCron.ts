import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { StagedSourceService } from '../services/StagedSourceService';

/**
 * Hourly. The TTL is a day, so the sweep only has to be frequent enough that an
 * expired upload is reclaimed the same afternoon rather than the same minute —
 * and infrequent enough that it is never the reason the disk is busy.
 */
export const STAGED_UPLOAD_PURGE_CRON = '0 17 * * * *';

/**
 * Reclaim upload bytes nobody will ever import.
 *
 * Two sweeps, because two different things go stale:
 *
 *  - `purgeExpired` — registered uploads past their TTL. This is the
 *    registry's promise made true: an archive can sit staged between being
 *    uploaded and being imported, because the purge only reclaims uploads it
 *    can see registered AND past their TTL.
 *  - `sweepUploadOrphans` — bytes in the uploads directory NO row accounts
 *    for: an `incoming/` file whose request died before the rename, or a drop
 *    directory whose request died before the registration. Registration
 *    cannot cover its own crash windows; the sweep is what makes "staged
 *    bytes cannot leak" structural rather than a happy-path claim.
 *
 * The inbox is deliberately not swept: its folder belongs to the user, and
 * its contents wait until a batch consumes them.
 */
@Injectable()
export class StagedUploadPurgeCron {
  constructor(
    private readonly sources: StagedSourceService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(StagedUploadPurgeCron.name);
  }

  /**
   * Swallows everything.
   *
   * The next sweep is an hour away and will retry, and an expired upload that
   * survives one extra hour costs disk. An unhandled rejection out of a cron
   * exits the process, which is a strictly worse outcome than one missed sweep.
   */
  // Runs where the stages run: the purge deletes staged bytes, and that is
  // the worker's filesystem duty in a split deployment.
  @Cron(STAGED_UPLOAD_PURGE_CRON, { name: 'StagedUploadPurgeCron.runOnSchedule', role: 'worker' })
  async runOnSchedule(): Promise<void> {
    try {
      await this.purgeOnce();
    } catch (err: unknown) {
      this.logger.error(
        'Staged upload purge failed; will retry on the next sweep',
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  /** Public so a test can sweep without waiting an hour. */
  async purgeOnce(): Promise<number> {
    const expired = await this.sources.purgeExpired();
    const orphans = await this.sources.sweepUploadOrphans();

    return expired + orphans;
  }
}

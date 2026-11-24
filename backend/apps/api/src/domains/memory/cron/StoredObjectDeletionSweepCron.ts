import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import {
  type DrainedObjectDeletes,
  drainStoredObjectDeletes,
  STORED_OBJECTS,
  type StoredObjects,
} from '../services/filePurge';

/**
 * xx:41:07 UTC, every hour. Second 7 is unclaimed in
 * `common/schedule/__tests__/cronSecondOffsets.test.ts`, which lists it for this schedule.
 */
export const STORED_OBJECT_DELETION_SWEEP_CRON = '7 41 * * * *';

/** How many batches one tick drains at most, so a tick cannot run into the next one. */
export const MAX_BATCHES_PER_TICK = 20;

/**
 * Retries the stored-object deletions that a committed delete of content could not finish.
 *
 * Deleting a photo or a document queues its objects in `ci.stored_object_deletions` in the same
 * transaction that deletes its rows, and deletes them from the object store once that transaction
 * commits (`queueStoredObjectDeletes`, `drainStoredObjectDeletes`). When the store fails then, times
 * out (the deadline does not cancel the call) or deletes only part of a batch, the queue rows stay,
 * and this is what deletes their objects later. A retry is always safe: the store answers a key that
 * is already gone as deleted, and a key that a `ci.files` row names again is dropped from the queue
 * and kept.
 *
 * `role: 'worker'` like the other maintenance sweeps, and `exclusive`, so two ticks never take the
 * same rows at once.
 */
@Injectable()
export class StoredObjectDeletionSweepCron {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
    @Optional() @Inject(STORED_OBJECTS) private readonly storedObjects?: StoredObjects,
  ) {
    this.logger.setContext(StoredObjectDeletionSweepCron.name);
  }

  @Cron(STORED_OBJECT_DELETION_SWEEP_CRON, {
    name: 'StoredObjectDeletionSweepCron.sweepOnSchedule',
    role: 'worker',
    exclusive: true,
  })
  async sweepOnSchedule(): Promise<void> {
    await this.sweep();
  }

  /** @internal Exposed for the spec; the cron body is a one-line delegate. */
  async sweep(): Promise<DrainedObjectDeletes> {
    const totals: DrainedObjectDeletes = { deleted: 0, skipped: 0, pending: 0, errors: [] };

    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
      const drained = await drainStoredObjectDeletes(this.dataSource.manager, this.storedObjects);

      totals.deleted += drained.deleted;
      totals.skipped += drained.skipped;
      totals.pending += drained.pending;
      totals.errors.push(...drained.errors);

      // Nothing left, or the store is failing: the rest wait for the next tick.
      if (drained.deleted + drained.skipped === 0 || drained.pending > 0) {
        break;
      }
    }

    if (totals.pending > 0) {
      this.logger.warn('Some stored objects could not be deleted; they stay queued for the next sweep', {
        pending: totals.pending,
        errors: totals.errors,
      });
    } else if (totals.deleted + totals.skipped > 0) {
      this.logger.log('Queued stored-object deletions drained', {
        deleted: totals.deleted,
        skipped: totals.skipped,
      });
    }

    return totals;
  }
}

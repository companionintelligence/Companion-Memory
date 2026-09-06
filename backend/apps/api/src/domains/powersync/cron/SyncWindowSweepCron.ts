import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

/**
 * Daily, at 03:40:20.
 *
 * The window only has to be accurate to the day — a row a few hours past the
 * boundary costs one device row, not correctness — so this is the cheapest
 * schedule that holds it. Off second 0 and off the top of the hour for the same
 * reason `ConsumptionSweepCron` is: everything else that fires daily contends
 * for midnight, and this sweep does not need to join them.
 */
export const SYNC_WINDOW_SWEEP_CRON = '20 40 3 * * *';

/**
 * How far back the device sync window reaches.
 *
 * 30 days is the horizon CI-Capture's lanes were sized against: at the default
 * 300s tick that is a few thousand rows per device, and it stays bounded at the
 * 30s floor. Widening it is a one-constant change, but read the note on cost in
 * the class doc first — this is the ONLY thing bounding what a phone holds.
 */
export const SYNC_WINDOW_DAYS = 30;

/** What one sweep evicted. */
export interface SyncWindowSweepSummary {
  /** `ci.events` rows whose marker was cleared. */
  events: number;
  /** `ci.entities` rows whose marker was cleared. */
  entities: number;
}

/**
 * Ages rows out of the PowerSync device window by clearing `sync_period`.
 *
 * This is the whole retention mechanism for synced events, and it exists
 * because PowerSync cannot express a rolling cutoff itself: a bucket parameter
 * is only usable in an equality, and a client-supplied parameter may not filter
 * a table-based parameter query at all. So the sync rules test the one thing a
 * data query can test unaided — `sync_period IS NOT NULL` — and the window is
 * decided here instead. See infrastructure/powersync/sync-rules.yaml.
 *
 * Nothing is deleted. Clearing the marker drops the row out of the sync rule's
 * predicate, and PowerSync evicts a row from a client bucket when it stops
 * matching; the row itself stays on the server and stays queryable over
 * GraphQL. Re-widening the window is a backfill, not a restore.
 *
 * `role: 'worker'`, matching the appliance's other reaper crons — reclamation
 * is worker work, and in a split deployment only one process should issue these
 * writes.
 *
 * The @Cron NAME is not decoration: `@ci/common/schedule`'s decorator falls back
 * to `Class.method` for the `ci.cron_runs` key, but `@nestjs/schedule` gives an
 * unnamed job a random UUID in the SchedulerRegistry, so an unnamed cron is
 * un-addressable across restarts and cannot be deduped.
 */
@Injectable()
export class SyncWindowSweepCron {
  private running = false;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SyncWindowSweepCron.name);
  }

  @Cron(SYNC_WINDOW_SWEEP_CRON, { name: 'SyncWindowSweepCron.sweepOnSchedule', role: 'worker' })
  async sweepOnSchedule(): Promise<void> {
    // A slow sweep must not stack: two overlapping runs would contend on the
    // same rows and buy nothing, since whatever this run leaves behind is still
    // outside the window tomorrow.
    if (this.running) {
      this.logger.warn('Skipping sync-window sweep; previous run still in progress');

      return;
    }

    this.running = true;

    try {
      const swept = await this.sweepOnce();

      this.logger.log('Sync-window sweep complete', { events: swept.events, entities: swept.entities });
    } catch (err) {
      this.logger.error(
        'Sync-window sweep failed',
        err instanceof Error ? err : new Error(String(err)),
      );
    } finally {
      this.running = false;
    }
  }

  /** Public so a test — or an operator — can sweep without waiting a day. */
  async sweepOnce(windowDays: number = SYNC_WINDOW_DAYS): Promise<SyncWindowSweepSummary> {
    // Both statements are driven by the partial indexes the migration added, so
    // they touch only rows still inside the window rather than the whole table.
    //
    // COALESCE mirrors the insert trigger's precedence exactly: observed_at is
    // when a capture happened, and is NULL for events that did not come from
    // one. Diverging from the trigger here would age rows out on a different
    // clock than the one that admitted them.
    const events: { count: string }[] = await this.dataSource.query(
      `WITH aged AS (
         UPDATE ci.events
            SET sync_period = NULL
          WHERE sync_period IS NOT NULL
            AND COALESCE(observed_at, start_time, created_at) < now() - ($1 || ' days')::interval
          RETURNING 1
       )
       SELECT count(*)::text AS count FROM aged`,
      [windowDays],
    );

    const entities: { count: string }[] = await this.dataSource.query(
      `WITH aged AS (
         UPDATE ci.entities
            SET sync_period = NULL
          WHERE sync_period IS NOT NULL
            AND COALESCE(created_at, now()) < now() - ($1 || ' days')::interval
          RETURNING 1
       )
       SELECT count(*)::text AS count FROM aged`,
      [windowDays],
    );

    return {
      events: Number(events[0]?.count ?? 0),
      entities: Number(entities[0]?.count ?? 0),
    };
  }
}
